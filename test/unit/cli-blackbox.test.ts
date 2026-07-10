import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { runCli } from "../../src/cli.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENTLOOP_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("CLI black-box exit codes", () => {
  test("covers help, version, and unsupported command", async () => {
    await expect(runCli(["--help"], undefined, quietIo())).resolves.toBe(0);
    await expect(runCli(["--version"], undefined, quietIo())).resolves.toBe(0);
    await expect(runCli(["unknown"], undefined, quietIo())).resolves.toBe(64);
  });

  test("covers doctor success and failure", async () => {
    await expect(
      runCli(
        ["doctor", "--repo", ".", "--json"],
        createDependencies(new BatchCodexRunner([])),
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["doctor"], createDependencies(new BatchCodexRunner([])), quietIo()),
    ).resolves.toBe(64);
  });

  test("covers run, worker, events, status, and cancel", async () => {
    const stateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const dependencies = createDependencies(new BatchCodexRunner([]));

    await expect(
      runCli(
        ["run", "--repo", ".", "--goal", "queued", "--trust-repo", "--detach"],
        dependencies,
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["run", "--repo", ".", "--goal", "missing trust"], dependencies, quietIo()),
    ).resolves.toBe(64);
    await expect(runCli(["status", "id-1", "--json"], dependencies, quietIo())).resolves.toBe(0);
    await expect(runCli(["status", "missing"], dependencies, quietIo())).resolves.toBe(64);
    await expect(runCli(["events", "id-1"], dependencies, quietIo())).resolves.toBe(0);
    await expect(runCli(["events"], dependencies, quietIo())).resolves.toBe(64);
    await expect(
      runCli(["worker", "--poll-interval", "bad"], dependencies, quietIo()),
    ).resolves.toBe(64);
    await expect(
      runCli(["cancel", "id-1", "--reason", "blackbox"], dependencies, quietIo()),
    ).resolves.toBe(0);
    await expect(runCli(["cancel"], dependencies, quietIo())).resolves.toBe(64);

    await expect(
      runCli(
        ["run", "--repo", ".", "--goal", "worker", "--trust-repo", "--detach"],
        dependencies,
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["worker", "--once"],
        createDependencies(new BatchCodexRunner([completeEvents()])),
        quietIo(),
      ),
    ).resolves.toBe(0);
  });

  test("covers dispatch no-work, queue, and usage failures", async () => {
    const noWorkStateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = noWorkStateDir;
    await expect(
      runCli(
        ["dispatch", "--repo", ".", "--trust-repo"],
        createDependencies(new BatchCodexRunner([]), { readyIssues: [] }),
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["dispatch", "--repo", "."], createDependencies(new BatchCodexRunner([])), quietIo()),
    ).resolves.toBe(64);

    const queueStateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = queueStateDir;
    const codexRunner = new BatchCodexRunner([]);
    const stdout: string[] = [];
    await expect(
      runCli(
        ["dispatch", "--repo", ".", "--trust-repo", "--json"],
        createDependencies(codexRunner, {
          readyIssues: [{ number: 7, url: "https://github.com/acme/repo/issues/7" }],
        }),
        {
          stdout: (message) => stdout.push(message),
          stderr: () => {},
        },
      ),
    ).resolves.toBe(0);

    expect(codexRunner.inputs).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      issueNumbers: [7],
      runId: "id-1",
      status: "queued",
    });
  });

  test("covers resume success and failure", async () => {
    const stateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await expect(
      runCli(
        ["run", "--repo", ".", "--goal", "fail first", "--trust-repo"],
        createDependencies(new BatchCodexRunner([malformedEvents()])),
        quietIo(),
      ),
    ).resolves.toBe(70);
    await expect(
      runCli(
        ["resume", "id-1"],
        createDependencies(new BatchCodexRunner([completeEvents()])),
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["resume", "id-1"], createDependencies(new BatchCodexRunner([])), quietIo()),
    ).resolves.toBe(64);
  });

  test("covers approve and reject success and failure", async () => {
    const approveStateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = approveStateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "approve", "--trust-repo"],
      createDependencies(new BatchCodexRunner([waitingApprovalEvents()])),
      quietIo(),
    );
    await expect(
      runCli(
        ["approve", "id-1", "--message", "approved"],
        createDependencies(new BatchCodexRunner([completeWithoutThreadStartedEvents()])),
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["approve", "id-1"], createDependencies(new BatchCodexRunner([])), quietIo()),
    ).resolves.toBe(64);

    const rejectStateDir = await tempStateDir();
    process.env.AGENTLOOP_STATE_DIR = rejectStateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "reject", "--trust-repo"],
      createDependencies(new BatchCodexRunner([waitingApprovalEvents()])),
      quietIo(),
    );
    await expect(
      runCli(
        ["reject", "id-1", "--message", "rejected"],
        createDependencies(new BatchCodexRunner([])),
        quietIo(),
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["reject", "id-1"], createDependencies(new BatchCodexRunner([])), quietIo()),
    ).resolves.toBe(64);
  });
});

async function tempStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "agentloop-blackbox-test-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function createDependencies(
  codexRunner: CodexRunner,
  options: { readyIssues?: readonly unknown[] } = {},
) {
  const homeDir = "/home/alex";
  const repoPath = "/work/agentloop";
  const fileSystem = new FakeFileSystem();
  fileSystem.addDirectory(repoPath);

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

  return {
    clock: new FixedClock(),
    codexRunner,
    commandRunner: new FakeCommandRunner((command, args) => {
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
        return { exitCode: 0, stdout: "codex-cli 0.144.1\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "--version") {
        return { exitCode: 0, stdout: "gh version 2.96.0\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "auth") {
        return { exitCode: 0, stdout: "github.com\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "label") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: "agentloop:ready" },
            { name: "agentloop:running" },
            { name: "agentloop:blocked" },
          ]),
          stderr: "",
        };
      }

      if (command === "gh" && args[0] === "issue" && args[1] === "list") {
        return { exitCode: 0, stdout: JSON.stringify(options.readyIssues ?? []), stderr: "" };
      }

      if (command === "gh" && (args[0] === "issue" || args[0] === "pr")) {
        return { exitCode: 0, stdout: "[]\n", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    }),
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
            operation: {
              action: "merge pull request",
              details: "Merge after all required checks pass",
              target: "pull request 123",
            },
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

function malformedEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    {
      item: { id: "message-1", text: "not json", type: "agent_message" },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 1,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ];
}

class BatchCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];
  private nextBatch = 0;

  constructor(private readonly eventBatches: readonly (readonly ThreadEvent[])[]) {}

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    const events = this.eventBatches[this.nextBatch] ?? [];
    this.nextBatch += 1;
    return this.eventStream(events);
  }

  private async *eventStream(events: readonly ThreadEvent[]): AsyncGenerator<ThreadEvent> {
    for (const event of events) {
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
