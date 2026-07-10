import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { runCli } from "../../src/cli.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { SqliteRunStore } from "../../src/infrastructure/sqlite/run-store.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENTLOOP_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("foreground run", () => {
  test("streams a fake Codex turn and persists the thread ID before completion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const dependencies = createDependencies(new FakeCodexRunner(completeEvents()));
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "finish queue", "--trust-repo"],
      dependencies,
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(dependencies.codexRunner.inputs).toHaveLength(1);
    expect(dependencies.codexRunner.inputs[0]?.prompt.startsWith("Use $codex-dev-team-goal.")).toBe(
      true,
    );

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });

    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      threadId: string | null;
      turnsCompleted: number;
      usage: { inputTokens: number };
    };
    expect(run.status).toBe("complete");
    expect(run.threadId).toBe("thread-1");
    expect(run.turnsCompleted).toBe(1);
    expect(run.usage.inputTokens).toBe(10);
  });

  test("marks the run failed when the final envelope is malformed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "bad envelope", "--trust-repo"],
      createDependencies(new FakeCodexRunner(malformedEvents())),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(70);
    expect(stderr.join("")).toContain("Malformed control envelope JSON");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });

    const run = JSON.parse(statusJson.join("")) as { status: string; lastError: string };
    expect(run.status).toBe("failed");
    expect(run.lastError).toContain("Malformed control envelope JSON");
  });

  test("continues on the same durable thread after a continue envelope", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const codexRunner = new FakeCodexRunner([
      continueEvents(),
      completeWithoutThreadStartedEvents(),
    ]);
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "continue once", "--trust-repo"],
      createDependencies(codexRunner),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(codexRunner.inputs).toHaveLength(2);
    expect(codexRunner.inputs[0]?.threadId).toBeNull();
    expect(codexRunner.inputs[1]?.threadId).toBe("thread-1");
    expect(codexRunner.inputs[1]?.prompt).toContain("Continue the same dev-team goal");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string; turnsCompleted: number };
    expect(run.status).toBe("complete");
    expect(run.turnsCompleted).toBe(2);
  });

  test("resumes a failed run with a saved thread ID using the recovery prompt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "recover saved thread", "--trust-repo"],
      createDependencies(new FakeCodexRunner(malformedEvents())),
      quietIo(),
    );

    const resumeRunner = new FakeCodexRunner(completeWithoutThreadStartedEvents());
    const exitCode = await runCli(
      ["resume", "id-1", "--message", "operator context"],
      createDependencies(resumeRunner),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(resumeRunner.inputs).toHaveLength(1);
    expect(resumeRunner.inputs[0]?.threadId).toBe("thread-1");
    expect(resumeRunner.inputs[0]?.prompt).toContain("This is a recovery turn");
    expect(resumeRunner.inputs[0]?.prompt).toContain("operator context");
  });

  test("starts a new recovery thread when interruption happened before thread.started", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "recover before thread", "--trust-repo"],
      createDependencies(new ThrowingCodexRunner("spawn failed")),
      quietIo(),
    );

    const resumeRunner = new FakeCodexRunner(completeEvents());
    const exitCode = await runCli(["resume", "id-1"], createDependencies(resumeRunner), quietIo());

    expect(exitCode).toBe(0);
    expect(resumeRunner.inputs[0]?.threadId).toBeNull();
    expect(resumeRunner.inputs[0]?.prompt).toContain("This is a recovery turn");
  });

  test("refuses resume when SDK events exist without a durable thread ID", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "unsafe resume", "--trust-repo"],
      createDependencies(new FakeCodexRunner(eventThenErrorEvents())),
      quietIo(),
    );

    const stderr: string[] = [];
    const exitCode = await runCli(["resume", "id-1"], createDependencies(new FakeCodexRunner([])), {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(64);
    expect(stderr.join("")).toContain("events but no durable thread ID");
  });

  test("blocks resume with a durable approval when skill fingerprints changed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "skill drift", "--trust-repo"],
      createDependencies(new ThrowingCodexRunner("spawn failed"), "v1"),
      quietIo(),
    );

    const exitCode = await runCli(
      ["resume", "id-1"],
      createDependencies(new FakeCodexRunner([]), "v2"),
      quietIo(),
    );

    expect(exitCode).toBe(2);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([]), "v2"), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string };
    expect(run.status).toBe("waiting_approval");
  });

  test("persists waiting approval envelopes without continuing Codex work", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const codexRunner = new FakeCodexRunner(waitingApprovalEvents());
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "needs approval", "--trust-repo"],
      createDependencies(codexRunner),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(codexRunner.inputs).toHaveLength(1);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      pendingApprovals: Array<{ kind: string; question: string }>;
    };
    expect(run.status).toBe("waiting_approval");
    expect(run.pendingApprovals).toHaveLength(1);
    expect(run.pendingApprovals[0]?.kind).toBe("human_merge");
  });

  test("approves exactly one pending approval and resumes with approval-response prompt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "approve me", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );

    const approveRunner = new FakeCodexRunner(completeWithoutThreadStartedEvents());
    const exitCode = await runCli(
      ["approve", "id-1", "--message", "approved for test"],
      createDependencies(approveRunner),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(approveRunner.inputs).toHaveLength(1);
    expect(approveRunner.inputs[0]?.threadId).toBe("thread-1");
    expect(approveRunner.inputs[0]?.prompt).toContain("Approval ID: id-4");
    expect(approveRunner.inputs[0]?.prompt).toContain("approved for test");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      pendingApprovals: unknown[];
    };
    expect(run.status).toBe("complete");
    expect(run.pendingApprovals).toHaveLength(0);
  });

  test("rejects a pending approval and cancels the run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "reject me", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );

    const exitCode = await runCli(
      ["reject", "id-1", "--message", "not approved"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );

    expect(exitCode).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string };
    expect(run.status).toBe("cancelled");
  });

  test("fails stale approval commands without state mutation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "stale approval", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );
    await runCli(
      ["reject", "id-1", "--message", "no"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["approve", "id-1", "--message", "too late"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(64);
    expect(stderr.join("")).toContain("not waiting for approval");
  });

  test("fails ambiguous approval commands without state mutation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "ambiguous approval", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const store = new SqliteRunStore(database);
    store.createApproval({
      evidenceJson: "{}",
      id: "manual-approval",
      kind: "manual",
      operationJson: "{}",
      question: "Second approval?",
      requestedAt: "2026-07-10T00:00:00.000Z",
      risk: "Ambiguous",
      runId: "id-1",
    });
    database.close();

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["approve", "id-1", "--message", "approved"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(64);
    expect(stderr.join("")).toContain("found 2");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      pendingApprovals: unknown[];
    };
    expect(run.status).toBe("waiting_approval");
    expect(run.pendingApprovals).toHaveLength(2);
  });

  test("stops before a continuation when the turn budget is exhausted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const codexRunner = new FakeCodexRunner([
      continueEvents(),
      completeWithoutThreadStartedEvents(),
    ]);
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "turn budget", "--trust-repo", "--max-turns", "1"],
      createDependencies(codexRunner, "v1", true),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(codexRunner.inputs).toHaveLength(1);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string };
    expect(run.status).toBe("budget_exhausted");
  });

  test("excludes cached tokens from the hard token budget", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "cached tokens", "--trust-repo", "--max-tokens", "17"],
      createDependencies(new FakeCodexRunner(cachedHeavyCompleteEvents()), "v1", true),
      quietIo(),
    );

    expect(exitCode).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      usage: { cachedInputTokens: number };
    };
    expect(run.status).toBe("complete");
    expect(run.usage.cachedInputTokens).toBe(999);
  });

  test("marks a run stuck after repeated unchanged available fingerprints", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const codexRunner = new FakeCodexRunner([continueEvents(), continueEvents(), continueEvents()]);
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "no progress", "--trust-repo"],
      createDependencies(codexRunner, "v1", true),
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(codexRunner.inputs).toHaveLength(3);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string; noProgressCount: number };
    expect(run.status).toBe("stuck");
    expect(run.noProgressCount).toBe(2);
  });

  test("does not increment no-progress count when GitHub fingerprint collection fails", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "github unavailable", "--trust-repo"],
      createDependencies(
        new FakeCodexRunner([
          continueEvents(),
          continueEvents(),
          completeWithoutThreadStartedEvents(),
        ]),
      ),
      quietIo(),
    );

    expect(exitCode).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string; noProgressCount: number };
    expect(run.status).toBe("complete");
    expect(run.noProgressCount).toBe(0);
  });

  test("persists cancellation when a signal aborts the active turn", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "cancel signal", "--trust-repo"],
      createDependencies(new SignalAbortingCodexRunner()),
      quietIo(),
    );

    expect(exitCode).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string };
    expect(run.status).toBe("cancelled");
  });
});

function createDependencies<TCodexRunner extends CodexRunner>(
  codexRunner: TCodexRunner,
  skillVersion = "v1",
  fingerprintAvailable = false,
) {
  const homeDir = "/home/alex";
  const repoPath = "/work/agentloop";
  const fileSystem = new FakeFileSystem();
  fileSystem.addDirectory(repoPath);

  for (const skillName of REQUIRED_SKILLS) {
    fileSystem.addFile(
      resolve(homeDir, ".agents", "skills", skillName, "SKILL.md"),
      `---\nname: ${skillName}\nversion: ${skillVersion}\n---\n`,
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

      if (command === "gh" && (args[0] === "issue" || args[0] === "pr")) {
        return fingerprintAvailable
          ? { exitCode: 0, stdout: "[]\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "GitHub unavailable" };
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
  return completeEnvelopeEvents({ includeThreadStarted: true, status: "complete" });
}

function completeWithoutThreadStartedEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: false, status: "complete" });
}

function continueEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: true, status: "continue" });
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
          evidence: {
            issueUrls: [],
            prUrls: ["https://github.com/example/repo/pull/123"],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
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

function completeEnvelopeEvents(options: {
  includeThreadStarted: boolean;
  status: "complete" | "continue";
  cachedInputTokens?: number;
}): ThreadEvent[] {
  const events: ThreadEvent[] = [
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
          closureGatePassed: options.status === "complete",
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          status: options.status,
          summary: options.status === "complete" ? "done" : "continue",
        }),
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: options.cachedInputTokens ?? 2,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    },
  ];
  return events;
}

function cachedHeavyCompleteEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({
    cachedInputTokens: 999,
    includeThreadStarted: true,
    status: "complete",
  });
}

function malformedEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    {
      item: {
        id: "message-1",
        text: "not json",
        type: "agent_message",
      },
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

function eventThenErrorEvents(): ThreadEvent[] {
  return [
    { type: "turn.started" },
    {
      message: "stream failed after event",
      type: "error",
    },
  ];
}

class FakeCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];
  private nextBatch = 0;

  constructor(events: readonly ThreadEvent[] | readonly (readonly ThreadEvent[])[]) {
    this.eventBatches = Array.isArray(events[0])
      ? (events as readonly (readonly ThreadEvent[])[])
      : [events as readonly ThreadEvent[]];
  }

  private readonly eventBatches: readonly (readonly ThreadEvent[])[];

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

class ThrowingCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];

  constructor(private readonly message: string) {}

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    throw new Error(this.message);
  }
}

class SignalAbortingCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    process.emit("SIGINT");
    throw new Error("aborted by signal");
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
