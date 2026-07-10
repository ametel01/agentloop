import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { runCli } from "../../src/cli.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENTLOOP_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("security and failure-mode hardening", () => {
  test("passes adversarial repo paths as structured git arguments with timeouts", async () => {
    const repoInput = "../agentloop; rm -rf /\n../../tmp";
    const dependencies = createDependencies(new FakeCodexRunner([]));
    const exitCode = await runCli(
      ["doctor", "--repo", repoInput, "--json"],
      dependencies,
      quietIo(),
    );

    expect(exitCode).toBe(0);
    const calls = dependencies.commandRunner.calls;
    const gitRoot = calls.find((call) => call.command === "git" && call.args.includes("rev-parse"));
    expect(gitRoot?.args[0]).toBe("-C");
    expect(gitRoot?.args).toContain(resolve(dependencies.cwd, repoInput));
    expect(calls.every((call) => call.options?.timeoutMs === 10_000)).toBe(true);
  });

  test("run preflight stops before Codex when required tools are unavailable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-security-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const codexRunner = new FakeCodexRunner(completeEvents());
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "must not start", "--trust-repo"],
      createDependencies(codexRunner, { codexUnavailable: true }),
      quietIo(),
    );

    expect(exitCode).toBe(64);
    expect(codexRunner.inputs).toHaveLength(0);
  });

  test("doctor warns for repository hooks, MCP config, and executable surfaces", async () => {
    const dependencies = createDependencies(new FakeCodexRunner([]), {
      repoSurfaces: [".git/hooks", ".mcp.json", "scripts", "bin", "Makefile"],
    });
    const stdout: string[] = [];

    const exitCode = await runCli(["doctor", "--repo", ".", "--json"], dependencies, {
      stdout: (message) => stdout.push(message),
      stderr: () => {},
    });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.join("")) as { checks: Array<{ name: string }> };
    const names = report.checks.map((check) => check.name);
    expect(names).toContain("repo-surface:.git/hooks");
    expect(names).toContain("repo-surface:.mcp.json");
    expect(names).toContain("repo-surface:scripts");
    expect(names).toContain("repo-surface:bin");
    expect(names).toContain("repo-surface:Makefile");
  });

  test("malicious approval messages are persisted redacted and never reach command args", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-security-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "needs approval", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );

    const approveRunner = new FakeCodexRunner(completeWithoutThreadStartedEvents());
    const dependencies = createDependencies(approveRunner);
    const message = "approved sk-secret123 $(touch /tmp/agentloop-owned)";
    const exitCode = await runCli(
      ["approve", "id-1", "--message", message],
      dependencies,
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(dependencies.commandRunner.calls.some((call) => call.args.includes(message))).toBe(
      false,
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const response = database
      .query<{ response: string | null }, []>("SELECT response FROM approvals LIMIT 1")
      .get()?.response;
    database.close();
    expect(response).not.toContain("sk-secret123");
    expect(response).toContain("[redacted-secret]");
  });

  test("invalid run ids and token-shaped usage errors are redacted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-security-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const stderr: string[] = [];

    const exitCode = await runCli(
      ["events", "../bad\nid-sk-secret123"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(64);
    expect(stderr.join("")).not.toContain("sk-secret123");
    expect(stderr.join("")).toContain("[redacted-secret]");
  });

  test("corrupt or unwritable SQLite state fails closed", async () => {
    const corruptDir = await mkdtemp(join(tmpdir(), "agentloop-corrupt-test-"));
    tempDirs.push(corruptDir);
    process.env.AGENTLOOP_STATE_DIR = corruptDir;
    await writeFile(join(corruptDir, "agentloop.sqlite"), "not a sqlite database");

    const corruptExit = await runCli(
      ["status", "--json"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );
    expect(corruptExit).toBe(70);

    const fileBackedState = join(
      await mkdtemp(join(tmpdir(), "agentloop-unwritable-test-")),
      "state",
    );
    tempDirs.push(join(fileBackedState, ".."));
    await writeFile(fileBackedState, "not a directory");
    process.env.AGENTLOOP_STATE_DIR = fileBackedState;

    const unwritableExit = await runCli(
      ["status", "--json"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );
    expect(unwritableExit).toBe(70);
  });

  test("secret-shaped stream failures are redacted in stderr and durable state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-security-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "redact failure", "--trust-repo"],
      createDependencies(new FakeCodexRunner(secretErrorEvents())),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(70);
    expect(stderr.join("")).not.toContain("sk-secret123");
    expect(stderr.join("")).toContain("[redacted-secret]");

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const persisted = [
      database.query<{ last_error: string | null }, []>("SELECT last_error FROM runs").get()
        ?.last_error ?? "",
      database.query<{ error_json: string | null }, []>("SELECT error_json FROM turns").get()
        ?.error_json ?? "",
    ].join("\n");
    database.close();
    expect(persisted).not.toContain("sk-secret123");
    expect(persisted).toContain("[redacted-secret]");
  });
});

function createDependencies<TCodexRunner extends CodexRunner>(
  codexRunner: TCodexRunner,
  options: { codexUnavailable?: boolean; repoSurfaces?: readonly string[] } = {},
) {
  const homeDir = "/home/alex";
  const repoPath = "/work/agentloop";
  const fileSystem = new FakeFileSystem();
  fileSystem.addDirectory(repoPath);

  for (const surface of options.repoSurfaces ?? []) {
    if (surface.includes(".")) {
      fileSystem.addFile(resolve(repoPath, surface), "surface\n");
    } else {
      fileSystem.addDirectory(resolve(repoPath, surface));
    }
  }

  for (const skillName of REQUIRED_SKILLS) {
    fileSystem.addFile(
      resolve(homeDir, ".agents", "skills", skillName, "SKILL.md"),
      `---\nname: ${skillName}\n---\n`,
    );
  }

  fileSystem.addFile(
    resolve(
      homeDir,
      ".agents",
      "skills",
      "codex-dev-team-goal",
      "references",
      "sub-agent-prompts.md",
    ),
    "# prompts\n",
  );

  const commandRunner = new FakeCommandRunner((command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${repoPath}\n`, stderr: "" };
    }

    if (command === "git" && args[0] === "status") {
      return { exitCode: 0, stdout: "## main\n", stderr: "" };
    }

    if (command === "git" && args[0] === "worktree") {
      return { exitCode: 0, stdout: `worktree ${repoPath}\n`, stderr: "" };
    }

    if (command === "codex") {
      return options.codexUnavailable
        ? { exitCode: 127, stdout: "", stderr: "missing codex" }
        : { exitCode: 0, stdout: "codex-cli 0.144.1\n", stderr: "" };
    }

    if (command === "gh" && args[0] === "--version") {
      return { exitCode: 0, stdout: "gh version 2.96.0\n", stderr: "" };
    }

    if (command === "gh" && args[0] === "auth") {
      return { exitCode: 0, stdout: "github.com\n", stderr: "" };
    }

    if (command === "gh" && (args[0] === "issue" || args[0] === "pr")) {
      return { exitCode: 0, stdout: "[]\n", stderr: "" };
    }

    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  });

  return {
    clock: new FixedClock(),
    codexRunner,
    commandRunner,
    cwd: repoPath,
    fileSystem,
    homeDir,
    idGenerator: new SequenceIdGenerator(),
  };
}

function quietIo() {
  return {
    stdout: () => {},
    stderr: () => {},
  };
}

function completeEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: true });
}

function completeWithoutThreadStartedEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: false });
}

function completeEnvelopeEvents(options: { includeThreadStarted: boolean }): ThreadEvent[] {
  return [
    ...(options.includeThreadStarted
      ? ([{ thread_id: "thread-1", type: "thread.started" }] satisfies ThreadEvent[])
      : []),
    { type: "turn.started" },
    {
      item: {
        id: "message-1",
        text: JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: true,
          evidence: { issueUrls: [], prUrls: [], reviewUrls: [], statusPath: "STATUS.md" },
          status: "complete",
          summary: "done",
        }),
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    },
  ];
}

function waitingApprovalEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    { type: "turn.started" },
    {
      item: {
        id: "message-1",
        text: JSON.stringify({
          approval: {
            kind: "human_merge",
            operation: { merge: true, pr: 123 },
            question: "Approve merge?",
            risk: "Merges code",
          },
          blocker: null,
          closureGatePassed: false,
          evidence: { issueUrls: [], prUrls: [], reviewUrls: [], statusPath: "STATUS.md" },
          status: "waiting_approval",
          summary: "Needs merge approval",
        }),
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    },
  ];
}

function secretErrorEvents(): ThreadEvent[] {
  return [
    { type: "turn.started" },
    {
      message: "failed with sk-secret123",
      type: "error",
    },
  ];
}

class FakeCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];

  constructor(private readonly events: readonly ThreadEvent[]) {}

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    return this.eventStream();
  }

  private async *eventStream(): AsyncGenerator<ThreadEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-10T00:00:00.000Z");
  }
}

class SequenceIdGenerator implements IdGenerator {
  private nextId = 1;

  randomId(): string {
    const id = `id-${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}
