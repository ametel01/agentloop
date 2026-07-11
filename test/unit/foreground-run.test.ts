import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { runCli } from "../../src/cli.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/run.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { SqliteRunStore } from "../../src/infrastructure/sqlite/run-store.ts";
import {
  ControlledAsyncStream,
  FakeCommandRunner,
  FakeFileSystem,
  FakeScheduler,
} from "../support/fakes.ts";

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

  test("renders coordinator decisions, commands, plans, and subagent lifecycle details", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-observable-events-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "show useful activity", "--trust-repo"],
      createDependencies(new FakeCodexRunner(observableEvents())),
      {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      },
    );

    const output = stdout.join("");
    expect(exitCode).toBe(0);
    expect(output).toContain("run: id-1");
    expect(output).toContain("update [continue] › I found two independent issues");
    expect(output).toContain("agents: 2 active · 1 running · 1 waiting · 0 blocked");
    expect(output).toContain("coordinator [working] — Coordinate issues 42 and 43.");
    expect(output).toContain(
      "/root/builder_42 [builder-agent, running] — Implement issue 42 in an isolated worktree.",
    );
    expect(output).toContain(
      "/root/checker_43 [checker-agent, waiting] — Wait for the issue 43 builder handoff.",
    );
    expect(output).toContain("coordinator decision › Issues 42 and 43 can run in parallel");
    expect(output).toContain("orchestrator › starting subagent issue_42");
    expect(output).toContain("objective: Implement issue 42 in an isolated worktree.");
    expect(output).toContain("orchestrator ✓ started subagent issue_42");
    expect(output).toContain("orchestrator plan › [ ] Implement issue 42");
    expect(output).toContain("update [complete] › done");
    expect(output).not.toContain("command[item-command]");
    expect(output).not.toContain("file changes · update src/example.ts");
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

  test("keeps an interactive foreground monitor attached after a recoverable failure", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-failure-monitor-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const foreground = runCli(
      ["run", "--repo", ".", "--goal", "recover while attached", "--trust-repo"],
      {
        ...createDependencies(new ThrowingCodexRunner("spawn failed")),
        monitorPollIntervalMs: 1,
      },
      {
        interactive: true,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    await waitFor(() => stdout.join("").includes("monitor: attached to id-1"));

    const resumeExit = await runCli(
      ["resume", "id-1", "--message", "retry from another terminal"],
      createDependencies(new FakeCodexRunner(completeEvents())),
      quietIo(),
    );

    expect(resumeExit).toBe(0);
    expect(await foreground).toBe(0);
    expect(stderr.join("")).toContain("execution: failed; spawn failed");
    expect(stdout.join("")).toContain("status: failed");
    expect(stdout.join("")).toContain("operator: agentloop resume id-1");
    expect(stdout.join("")).toContain("status: failed -> complete");
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

  test("keeps an interactive foreground monitor attached across approval", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-monitor-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stdout: string[] = [];
    const foregroundDependencies = {
      ...createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      monitorPollIntervalMs: 1,
    };
    const foreground = runCli(
      ["run", "--repo", ".", "--goal", "stay observable", "--trust-repo"],
      foregroundDependencies,
      {
        interactive: true,
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      },
    );

    await waitFor(() => stdout.join("").includes("monitor: attached to id-1"));

    const approveExit = await runCli(
      ["approve", "id-1", "--message", "approved from another terminal"],
      createDependencies(new FakeCodexRunner(completeWithoutThreadStartedEvents())),
      quietIo(),
    );

    expect(approveExit).toBe(0);
    expect(await foreground).toBe(0);
    expect(stdout.join("")).toContain("update [waiting_approval]");
    expect(stdout.join("")).toContain("status: waiting_approval");
    expect(stdout.join("")).toContain("status: waiting_approval -> complete");
    expect(stdout.join("")).toContain("operator: agentloop approve id-1");
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

  test("marks a run stuck after repeated turns with no new material outcomes", async () => {
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

  test("does not increment no-progress count when outcome sources are unavailable", async () => {
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

  test("characterizes SDK failure after thread.started as failed with saved thread and zero usage", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "fail after thread", "--trust-repo"],
      createDependencies(new FakeCodexRunner(threadStartedThenErrorEvents())),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(70);
    expect(stderr.join("")).toContain("stream failed after durable thread");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      consecutiveFailures: number;
      latestCheckpoint: { abortReason: string | null; usageComplete: boolean } | null;
      status: string;
      threadId: string | null;
      turns: Array<{
        abortReason: string | null;
        errorJson: string | null;
        status: string;
        usage: { inputTokens: number };
        usageComplete: boolean;
      }>;
      turnsCompleted: number;
      usage: { inputTokens: number };
    };

    expect(run.status).toBe("failed");
    expect(run.threadId).toBe("thread-1");
    expect(run.consecutiveFailures).toBe(1);
    expect(run.turnsCompleted).toBe(0);
    expect(run.usage.inputTokens).toBe(0);
    expect(run.turns[0]?.status).toBe("failed");
    expect(run.turns[0]?.abortReason).toBe("sdk_failed");
    expect(run.turns[0]?.usageComplete).toBe(false);
    expect(run.turns[0]?.usage.inputTokens).toBe(0);
    expect(run.turns[0]?.errorJson).toContain("stream failed after durable thread");
    expect(run.latestCheckpoint?.abortReason).toBe("sdk_failed");
    expect(run.latestCheckpoint?.usageComplete).toBe(false);
  });

  test("characterizes missing official usage as a completed zero-usage turn", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "missing usage", "--trust-repo"],
      createDependencies(new FakeCodexRunner(completeWithoutUsageEvents())),
      quietIo(),
    );

    expect(exitCode).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      latestCheckpoint: { usageComplete: boolean } | null;
      status: string;
      turns: Array<{ status: string; usage: { inputTokens: number }; usageComplete: boolean }>;
      turnsCompleted: number;
      usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
    };

    expect(run.status).toBe("complete");
    expect(run.turnsCompleted).toBe(1);
    expect(run.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    expect(run.turns[0]?.status).toBe("completed");
    expect(run.turns[0]?.usageComplete).toBe(false);
    expect(run.turns[0]?.usage.inputTokens).toBe(0);
    expect(run.latestCheckpoint?.usageComplete).toBe(false);
  });

  test("supervised cooperative tranche continues without cancellation or SDK failure", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const firstStream = new ControlledAsyncStream<ThreadEvent>();
    const codexRunner = new ScriptedCodexRunner([
      firstStream,
      arrayStream(completeWithoutThreadStartedEvents()),
    ]);
    const scheduler = new FakeScheduler();

    const foreground = runCli(
      ["run", "--repo", ".", "--goal", "bounded tranche", "--trust-repo"],
      { ...createDependencies(codexRunner), scheduler },
      quietIo(),
    );

    await waitFor(() => codexRunner.inputs.length === 1);
    scheduler.advanceNextMatching(DEFAULT_RUN_LIMITS.cooperativeTrancheMs);

    expect(await foreground).toBe(0);
    expect(codexRunner.inputs).toHaveLength(2);
    expect(codexRunner.inputs[1]?.threadId).toBeNull();

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      consecutiveFailures: number;
      latestCheckpoint: { abortReason: string | null; usageComplete: boolean } | null;
      status: string;
      turns: Array<{
        abortReason: string | null;
        errorJson: string | null;
        status: string;
        usageComplete: boolean;
      }>;
      turnsCompleted: number;
    };

    expect(run.status).toBe("complete");
    expect(run.consecutiveFailures).toBe(0);
    expect(run.turnsCompleted).toBe(1);
    expect(run.turns[0]?.status).toBe("aborted");
    expect(run.turns[0]?.abortReason).toBe("tranche_elapsed");
    expect(run.turns[0]?.usageComplete).toBe(false);
    expect(run.turns[0]?.errorJson).toContain("tranche_elapsed");
    expect(run.turns[1]?.status).toBe("completed");
    expect(run.latestCheckpoint?.abortReason).toBeNull();
    expect(run.latestCheckpoint?.usageComplete).toBe(true);
  });

  test("supervised event stall records a distinct recoverable failure reason", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const codexRunner = new ScriptedCodexRunner([new ControlledAsyncStream<ThreadEvent>()]);
    const scheduler = new FakeScheduler();

    const foreground = runCli(
      ["run", "--repo", ".", "--goal", "stall stream", "--trust-repo"],
      { ...createDependencies(codexRunner), scheduler },
      quietIo(),
    );

    await waitFor(() => codexRunner.inputs.length === 1);
    scheduler.advanceNextMatching(DEFAULT_RUN_LIMITS.eventStallWarningMs);

    expect(await foreground).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      consecutiveFailures: number;
      lastError: string | null;
      latestCheckpoint: { abortReason: string | null; usageComplete: boolean } | null;
      status: string;
      turns: Array<{
        abortReason: string | null;
        errorJson: string | null;
        status: string;
        usageComplete: boolean;
      }>;
    };

    expect(run.status).toBe("failed");
    expect(run.consecutiveFailures).toBe(1);
    expect(run.lastError).toContain("event_stalled");
    expect(run.turns[0]?.status).toBe("aborted");
    expect(run.turns[0]?.abortReason).toBe("event_stalled");
    expect(run.turns[0]?.usageComplete).toBe(false);
    expect(run.turns[0]?.errorJson).toContain("event_stalled");
    expect(run.latestCheckpoint?.abortReason).toBe("event_stalled");
    expect(run.latestCheckpoint?.usageComplete).toBe(false);
  });

  test("supervised hard deadline records a distinct failure reason", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const codexRunner = new ScriptedCodexRunner([new ControlledAsyncStream<ThreadEvent>()]);
    const scheduler = new FakeScheduler();

    const foreground = runCli(
      ["run", "--repo", ".", "--goal", "hard deadline", "--trust-repo"],
      { ...createDependencies(codexRunner), scheduler },
      quietIo(),
    );

    await waitFor(() => codexRunner.inputs.length === 1);
    scheduler.advanceNextMatching(DEFAULT_RUN_LIMITS.hardTurnDeadlineMs);

    expect(await foreground).toBe(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      lastError: string | null;
      latestCheckpoint: { abortReason: string | null } | null;
      status: string;
      turns: Array<{ abortReason: string | null; errorJson: string | null; status: string }>;
    };

    expect(run.status).toBe("failed");
    expect(run.lastError).toContain("hard_deadline");
    expect(run.turns[0]?.status).toBe("aborted");
    expect(run.turns[0]?.abortReason).toBe("hard_deadline");
    expect(run.turns[0]?.errorJson).toContain("hard_deadline");
    expect(run.latestCheckpoint?.abortReason).toBe("hard_deadline");
  });

  test("maxConsecutiveTurnFailures stops a failed run before another SDK turn starts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "failure cap", "--trust-repo"],
      createDependencies(new ThrowingCodexRunner("first failure")),
      quietIo(),
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    database
      .query("UPDATE runs SET limits_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...DEFAULT_RUN_LIMITS, maxConsecutiveTurnFailures: 1 }), "id-1");
    database.close();

    const resumeRunner = new FakeCodexRunner(completeEvents());
    const exitCode = await runCli(["resume", "id-1"], createDependencies(resumeRunner), quietIo());

    expect(exitCode).toBe(0);
    expect(resumeRunner.inputs).toHaveLength(0);

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { lastError: string | null; status: string };
    expect(run.status).toBe("budget_exhausted");
    expect(run.lastError).toContain("maximum consecutive turn failures exhausted");
  });

  test("worker --once executes a detached queued run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-worker-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const queuedStdout: string[] = [];
    const queuedExit = await runCli(
      ["run", "--repo", ".", "--goal", "worker queue", "--trust-repo", "--detach"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: (message) => queuedStdout.push(message),
        stderr: () => {},
      },
    );

    expect(queuedExit).toBe(0);
    expect(queuedStdout.join("").trim()).toBe("id-1");

    const workerRunner = new FakeCodexRunner(completeEvents());
    const workerStdout: string[] = [];
    const workerExit = await runCli(["worker", "--once"], createDependencies(workerRunner), {
      stdout: (message) => workerStdout.push(message),
      stderr: () => {},
    });

    expect(workerExit).toBe(0);
    expect(workerStdout.join("")).toContain("claimed: id-1");
    expect(workerRunner.inputs).toHaveLength(1);
    expect(workerRunner.inputs[0]?.threadId).toBeNull();

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string; threadId: string | null };
    expect(run.status).toBe("complete");
    expect(run.threadId).toBe("thread-1");
  });

  test("atomic queued claims prevent two workers from taking the same run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-worker-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "single claim", "--trust-repo", "--detach"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const store = new SqliteRunStore(database);
    const first = store.claimOldestQueued({
      now: "2026-07-10T00:00:01.000Z",
      ownerId: "worker-1",
    });
    const second = store.claimOldestQueued({
      now: "2026-07-10T00:00:01.000Z",
      ownerId: "worker-2",
    });
    const leaseCount = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM leases")
      .get()?.count;
    database.close();

    expect(first?.id).toBe("id-1");
    expect(second).toBeNull();
    expect(leaseCount).toBe(1);
  });

  test("worker --once reclaims an expired active lease with a recovery prompt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-worker-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "stale worker", "--trust-repo", "--detach"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const store = new SqliteRunStore(database);
    const stale = store.claimOldestQueued({
      now: "2026-07-10T00:00:00.000Z",
      ownerId: "stale-worker",
    });
    database
      .query("UPDATE leases SET expires_at = ? WHERE repo_key = ?")
      .run("2026-07-09T23:59:59.000Z", stale?.repoKey ?? "");
    database.close();

    const workerRunner = new FakeCodexRunner(completeEvents());
    const workerExit = await runCli(
      ["worker", "--once"],
      createDependencies(workerRunner),
      quietIo(),
    );

    expect(workerExit).toBe(0);
    expect(workerRunner.inputs).toHaveLength(1);
    expect(workerRunner.inputs[0]?.threadId).toBeNull();
    expect(workerRunner.inputs[0]?.prompt).toContain("This is a recovery turn");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as { status: string };
    expect(run.status).toBe("complete");
  });

  test("worker --once does not auto-claim waiting approval or terminal runs", async () => {
    const waitingStateDir = await mkdtemp(join(tmpdir(), "agentloop-worker-waiting-test-"));
    tempDirs.push(waitingStateDir);
    process.env.AGENTLOOP_STATE_DIR = waitingStateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "needs operator", "--trust-repo"],
      createDependencies(new FakeCodexRunner(waitingApprovalEvents())),
      quietIo(),
    );

    const waitingWorker = new FakeCodexRunner(completeEvents());
    const waitingExit = await runCli(
      ["worker", "--once"],
      createDependencies(waitingWorker),
      quietIo(),
    );

    expect(waitingExit).toBe(0);
    expect(waitingWorker.inputs).toHaveLength(0);

    const waitingStatusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => waitingStatusJson.push(message),
      stderr: () => {},
    });
    const waitingRun = JSON.parse(waitingStatusJson.join("")) as { status: string };
    expect(waitingRun.status).toBe("waiting_approval");

    const terminalStateDir = await mkdtemp(join(tmpdir(), "agentloop-worker-terminal-test-"));
    tempDirs.push(terminalStateDir);
    process.env.AGENTLOOP_STATE_DIR = terminalStateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "already done", "--trust-repo", "--detach"],
      createDependencies(new FakeCodexRunner([])),
      quietIo(),
    );

    const terminalDatabase = await openDatabase({
      path: join(terminalStateDir, "agentloop.sqlite"),
    });
    const terminalStore = new SqliteRunStore(terminalDatabase);
    const terminalClaim = terminalStore.claimOldestQueued({
      now: "2026-07-10T00:00:00.000Z",
      ownerId: "terminal-worker",
    });
    if (terminalClaim === null) {
      throw new Error("expected terminal test run to be claimed");
    }
    terminalStore.transitionRun({
      expectedStatus: "running",
      id: terminalClaim.id,
      nextStatus: "complete",
      now: "2026-07-10T00:00:01.000Z",
      reason: "terminal test fixture",
    });
    terminalDatabase
      .query("UPDATE leases SET expires_at = ? WHERE repo_key = ?")
      .run("2026-07-09T23:59:59.000Z", terminalClaim.repoKey);
    terminalDatabase.close();

    const terminalWorker = new FakeCodexRunner(completeEvents());
    const terminalExit = await runCli(
      ["worker", "--once"],
      createDependencies(terminalWorker),
      quietIo(),
    );

    expect(terminalExit).toBe(0);
    expect(terminalWorker.inputs).toHaveLength(0);
  });

  test("events replays ordered JSONL and stable text output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-events-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "inspect events", "--trust-repo"],
      createDependencies(new FakeCodexRunner(completeEvents())),
      quietIo(),
    );

    const jsonOutput: string[] = [];
    const jsonExit = await runCli(
      ["events", "id-1", "--json"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: (message) => jsonOutput.push(message),
        stderr: () => {},
      },
    );

    expect(jsonExit).toBe(0);
    const jsonEvents = jsonOutput
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; eventType: string });
    expect(jsonEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(jsonEvents.map((event) => event.eventType)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);

    const textOutput: string[] = [];
    const textExit = await runCli(["events", "id-1"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => textOutput.push(message),
      stderr: () => {},
    });

    expect(textExit).toBe(0);
    expect(textOutput.join("")).toContain("orchestrator · thread started");
    expect(textOutput.join("")).toContain("update [complete]");
    expect(textOutput.join("")).toContain("input=10");
  });

  test("status includes turns, usage, lease, blocker, and harness labels", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-status-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "status details", "--trust-repo"],
      createDependencies(new FakeCodexRunner(completeEvents())),
      quietIo(),
    );

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const status = JSON.parse(statusJson.join("")) as {
      heartbeatAgeMs: number | null;
      latestCheckpoint: { status: string; usageComplete: boolean } | null;
      latestBlocker: unknown;
      lease: unknown;
      status: string;
      turns: Array<{ kind: string; usage: { inputTokens: number }; usageComplete: boolean }>;
      usage: { inputTokens: number };
    };

    expect(status.status).toBe("complete");
    expect(status.usage.inputTokens).toBe(10);
    expect(status.turns).toHaveLength(1);
    expect(status.turns[0]?.kind).toBe("initial");
    expect(status.turns[0]?.usage.inputTokens).toBe(10);
    expect(status.turns[0]?.usageComplete).toBe(true);
    expect(status.latestCheckpoint?.status).toBe("completed");
    expect(status.latestCheckpoint?.usageComplete).toBe(true);
    expect(status.lease).toBeNull();
    expect(status.heartbeatAgeMs).toBeNull();
    expect(status.latestBlocker).toBeNull();

    const statusText: string[] = [];
    await runCli(["status", "id-1"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusText.push(message),
      stderr: () => {},
    });
    expect(statusText.join("")).toContain("harness.status: complete");
    expect(statusText.join("")).toContain("checkpoint.latest: 1 completed usageComplete=true");
    expect(statusText.join("")).toContain("turn.usageComplete: true");
    expect(statusText.join("")).toContain("turn.usage: input=10");
  });

  test("events follow mode exits cleanly on signal after replay", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-events-follow-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    await runCli(
      ["run", "--repo", ".", "--goal", "follow events", "--trust-repo"],
      createDependencies(new FakeCodexRunner(completeEvents())),
      quietIo(),
    );

    const output: string[] = [];
    const follow = runCli(
      ["events", "id-1", "--follow"],
      createDependencies(new FakeCodexRunner([])),
      {
        stdout: (message) => output.push(message),
        stderr: () => {},
      },
    );
    setTimeout(() => process.emit("SIGINT"), 0);

    await expect(follow).resolves.toBe(0);
    expect(output.join("")).toContain("orchestrator · thread started");
  });

  test("secret fixtures are redacted in database, event output, and status output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-redaction-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;
    const secret = "sk-secret123";

    await runCli(
      ["run", "--repo", ".", "--goal", "redact outputs", "--trust-repo"],
      createDependencies(new FakeCodexRunner(secretCompleteEvents(secret))),
      quietIo(),
    );

    const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
    const persisted = [
      ...database
        .query<{ value: string }, []>("SELECT payload_json AS value FROM events")
        .all()
        .map((row) => row.value),
      ...database
        .query<{ value: string | null }, []>("SELECT response_json AS value FROM turns")
        .all()
        .map((row) => row.value ?? ""),
    ].join("\n");
    database.close();
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[redacted-secret]");

    const eventsJson: string[] = [];
    await runCli(["events", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => eventsJson.push(message),
      stderr: () => {},
    });
    expect(eventsJson.join("")).not.toContain(secret);
    expect(eventsJson.join("")).toContain("[redacted-secret]");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    expect(statusJson.join("")).not.toContain(secret);
    expect(statusJson.join("")).toContain("[redacted-secret]");
  });
});

function createDependencies<TCodexRunner extends CodexRunner>(
  codexRunner: TCodexRunner,
  skillVersion = "v1",
  outcomeSourcesAvailable = false,
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
      if (command === "git" && args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return { exitCode: 0, stdout: `${repoPath}\n`, stderr: "" };
      }

      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
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
        return outcomeSourcesAvailable
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

function noActiveAgents() {
  return {
    coordinator: { status: "complete", task: "Finish the current coordinator turn." },
    subagents: [],
  } as const;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error("timed out waiting for foreground monitor output");
}

function completeEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: true, status: "complete" });
}

function observableEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    { type: "turn.started" },
    {
      item: {
        id: "item-plan",
        items: [{ completed: false, text: "Implement issue 42" }],
        type: "todo_list",
      },
      type: "item.started",
    },
    {
      item: {
        id: "item-progress",
        text: JSON.stringify({
          agents: {
            coordinator: {
              status: "working",
              task: "Coordinate issues 42 and 43.",
            },
            subagents: [
              {
                name: "/root/builder_42",
                role: "builder-agent",
                status: "running",
                task: "Implement issue 42 in an isolated worktree.",
              },
              {
                name: "/root/checker_43",
                role: "checker-agent",
                status: "waiting",
                task: "Wait for the issue 43 builder handoff.",
              },
            ],
          },
          approval: null,
          blocker: null,
          closureGatePassed: false,
          evidence: { issueUrls: [], prUrls: [], reviewUrls: [], statusPath: "STATUS.md" },
          status: "continue",
          summary: "I found two independent issues and assigned their current work.",
        }),
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      item: {
        id: "item-reasoning",
        text: "Issues 42 and 43 can run in parallel because they touch separate packages.",
        type: "reasoning",
      },
      type: "item.completed",
    },
    {
      item: {
        aggregated_output: "",
        command: "/bin/zsh -lc 'git status --short'",
        id: "item-command",
        status: "in_progress",
        type: "command_execution",
      },
      type: "item.started",
    },
    {
      item: {
        aggregated_output: "## main...origin/main\n",
        command: "/bin/zsh -lc 'git status --short'",
        exit_code: 0,
        id: "item-command",
        status: "completed",
        type: "command_execution",
      },
      type: "item.completed",
    },
    {
      item: {
        arguments: {
          message: "Implement issue 42 in an isolated worktree.",
          task_name: "issue_42",
        },
        id: "item-agent",
        server: "collaboration",
        status: "in_progress",
        tool: "spawn_agent",
        type: "mcp_tool_call",
      },
      type: "item.started",
    },
    {
      item: {
        arguments: {
          message: "Implement issue 42 in an isolated worktree.",
          task_name: "issue_42",
        },
        id: "item-agent",
        result: {
          content: [],
          structured_content: { agent_id: "agent-42", task_name: "issue_42" },
        },
        server: "collaboration",
        status: "completed",
        tool: "spawn_agent",
        type: "mcp_tool_call",
      },
      type: "item.completed",
    },
    {
      item: {
        changes: [{ kind: "update", path: "src/example.ts" }],
        id: "item-files",
        status: "completed",
        type: "file_change",
      },
      type: "item.completed",
    },
    ...completeWithoutThreadStartedEvents().slice(1),
  ];
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
          agents: noActiveAgents(),
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
          agents: noActiveAgents(),
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

function secretCompleteEvents(secret: string): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    { type: "turn.started" },
    {
      item: {
        id: "message-1",
        text: JSON.stringify({
          agents: noActiveAgents(),
          approval: null,
          blocker: null,
          closureGatePassed: true,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          status: "complete",
          summary: `done without leaking ${secret}`,
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

function completeWithoutUsageEvents(): ThreadEvent[] {
  return completeEnvelopeEvents({ includeThreadStarted: true, status: "complete" }).filter(
    (event) => event.type !== "turn.completed",
  );
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

function threadStartedThenErrorEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    { type: "turn.started" },
    {
      message: "stream failed after durable thread",
      type: "error",
    },
  ];
}

async function* arrayStream(events: readonly ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

class ScriptedCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];
  private nextBatch = 0;

  constructor(private readonly streams: readonly AsyncIterable<ThreadEvent>[]) {}

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    const stream = this.streams[this.nextBatch];
    this.nextBatch += 1;
    if (stream === undefined) {
      throw new Error("No scripted Codex stream");
    }

    return stream;
  }
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
