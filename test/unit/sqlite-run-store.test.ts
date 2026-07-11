import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { OpenRunConflictError, StateConflictError } from "../../src/domain/errors.ts";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/run.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.ts";
import { SqliteRunStore } from "../../src/infrastructure/sqlite/run-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("SQLite run store", () => {
  test("runs migration idempotently", async () => {
    const databasePath = await tempDatabasePath();
    const first = await openDatabase({ path: databasePath });
    first.close();

    const second = await openDatabase({ path: databasePath });
    const version = second
      .query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    second.close();

    expect(version?.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("migrations add usage completeness, checkpoints, and outcomes", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });

    const turnColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((column) => column.name);
    const checkpointTable = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'",
      )
      .get();
    const outcomeTable = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outcomes'",
      )
      .get();

    expect(turnColumns).toContain("abort_reason");
    expect(turnColumns).toContain("usage_complete");
    expect(checkpointTable?.name).toBe("checkpoints");
    expect(outcomeTable?.name).toBe("outcomes");
    database.close();
  });

  test("sets restrictive directory and database permissions", async () => {
    const databasePath = await tempDatabasePath();
    const database = await openDatabase({ path: databasePath });
    database.close();

    const stateMode = (await stat(join(databasePath, ".."))).mode & 0o777;
    const databaseMode = (await stat(databasePath)).mode & 0o777;

    expect(stateMode).toBe(0o700);
    expect(databaseMode).toBe(0o600);
  });

  test("rejects unknown future schema versions", async () => {
    const databasePath = await tempDatabasePath();
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    database
      .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(999, "now");
    database.close();

    await expect(openDatabase({ path: databasePath })).rejects.toThrow(
      "Unsupported future schema version: 999",
    );
  });

  test("prevents duplicate open runs for a repository", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);

    store.createRun(createRunInput({ id: "run-1" }));

    expect(store.getOpenRunByRepoKey("repo-key")?.id).toBe("run-1");
    expect(() => store.createRun(createRunInput({ id: "run-2" }))).toThrow(OpenRunConflictError);
    database.close();
  });

  test("reads version-1 run limit payloads without losing persisted policy", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);
    store.createRun(createRunInput({ id: "run-1" }));
    const version1Limits = {
      eventStallWarningMs: 123_456,
      leaseRenewIntervalMs: DEFAULT_RUN_LIMITS.leaseRenewIntervalMs,
      leaseTtlMs: DEFAULT_RUN_LIMITS.leaseTtlMs,
      maxConsecutiveTurnFailures: DEFAULT_RUN_LIMITS.maxConsecutiveTurnFailures,
      maxNoProgressTurns: DEFAULT_RUN_LIMITS.maxNoProgressTurns,
      maxOuterTurns: 3,
      maxTotalTokens: DEFAULT_RUN_LIMITS.maxTotalTokens,
      maxWallDurationMs: DEFAULT_RUN_LIMITS.maxWallDurationMs,
    };
    database
      .query("UPDATE runs SET limits_json = ? WHERE id = ?")
      .run(JSON.stringify(version1Limits), "run-1");

    const run = store.getRun("run-1");
    expect(run?.limits.maxOuterTurns).toBe(3);
    expect(run?.limits.eventStallWarningMs).toBe(123_456);
    expect(run?.limits.cooperativeTrancheMs).toBe(DEFAULT_RUN_LIMITS.cooperativeTrancheMs);
    expect(run?.limits.hardTurnDeadlineMs).toBe(DEFAULT_RUN_LIMITS.hardTurnDeadlineMs);
    expect(run?.limits.leaseTtlMs).toBe(DEFAULT_RUN_LIMITS.leaseTtlMs);
    database.close();
  });

  test("rejects invalid state transitions without modifying the run", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);
    store.createRun(createRunInput({ id: "run-1" }));

    expect(() =>
      store.transitionRun({
        id: "run-1",
        expectedStatus: "queued",
        nextStatus: "complete",
        now: "2026-07-10T00:00:01.000Z",
        reason: "invalid",
      }),
    ).toThrow(StateConflictError);
    expect(store.getRun("run-1")?.status).toBe("queued");
    database.close();
  });

  test("persists checkpoints and incomplete turn usage state", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);
    store.createRun(createRunInput({ id: "run-1" }));
    store.createTurn({
      fingerprintBefore: null,
      id: "turn-1",
      kind: "initial",
      promptHash: "prompt-hash",
      runId: "run-1",
      startedAt: "2026-07-10T00:00:00.000Z",
      status: "running",
      turnNumber: 1,
    });
    store.completeTurn({
      abortReason: "event_stalled",
      errorJson: JSON.stringify({ message: "stalled" }),
      fingerprintAfter: null,
      finishedAt: "2026-07-10T00:00:01.000Z",
      id: "turn-1",
      responseJson: null,
      status: "aborted",
      usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      usageComplete: false,
    });

    const checkpoint = store.createCheckpoint({
      abortReason: "event_stalled",
      createdAt: "2026-07-10T00:00:01.000Z",
      payloadJson: JSON.stringify({ summary: "stalled" }),
      runId: "run-1",
      status: "aborted",
      turnId: "turn-1",
      usageComplete: false,
    });

    expect(checkpoint.sequence).toBe(1);
    expect(checkpoint.usageComplete).toBe(false);
    expect(store.listTurns("run-1")[0]?.usageComplete).toBe(false);
    expect(store.listTurns("run-1")[0]?.abortReason).toBe("event_stalled");
    expect(store.getLatestCheckpoint("run-1")?.abortReason).toBe("event_stalled");
    expect(store.listCheckpoints("run-1")).toHaveLength(1);
    database.close();
  });

  test("records unique outcomes and last useful outcome time idempotently", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);
    store.createRun(createRunInput({ id: "run-1" }));

    const first = store.recordOutcomes({
      observedAt: "2026-07-10T00:00:01.000Z",
      outcomes: [
        {
          key: "git-head:abc123",
          payloadJson: JSON.stringify({ sha: "abc123" }),
          type: "git_head",
        },
      ],
      runId: "run-1",
    });
    const second = store.recordOutcomes({
      observedAt: "2026-07-10T00:00:02.000Z",
      outcomes: [
        {
          key: "git-head:abc123",
          payloadJson: JSON.stringify({ sha: "abc123" }),
          type: "git_head",
        },
      ],
      runId: "run-1",
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.listOutcomes("run-1")).toHaveLength(1);
    expect(store.getRun("run-1")?.lastUsefulOutcomeAt).toBe("2026-07-10T00:00:01.000Z");
    database.close();
  });

  test("acquires and conditionally releases repository leases", async () => {
    const database = await openDatabase({ path: await tempDatabasePath() });
    const store = new SqliteRunStore(database);
    store.createRun(createRunInput({ id: "run-1" }));

    store.acquireLease({
      acquiredAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-10T00:02:00.000Z",
      ownerId: "owner-1",
      repoKey: "repo-key",
      runId: "run-1",
    });
    store.releaseLease("repo-key", "wrong-owner");
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM leases").get()?.count,
    ).toBe(1);

    store.releaseLease("repo-key", "owner-1");
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM leases").get()?.count,
    ).toBe(0);
    database.close();
  });
});

function createRunInput(overrides: { id: string; limits?: typeof DEFAULT_RUN_LIMITS }) {
  return {
    approvalMode: "agent-approved" as const,
    id: overrides.id,
    limits: overrides.limits ?? DEFAULT_RUN_LIMITS,
    model: null,
    now: "2026-07-10T00:00:00.000Z",
    objective: "test objective",
    objectiveHash: "objective-hash",
    reasoningEffort: null,
    repoKey: "repo-key",
    repoPath: "/repo",
    skillFingerprint: "skill-fingerprint",
    status: "queued" as const,
    worktreeRoot: "/worktrees/repo",
  };
}

async function tempDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentloop-sqlite-test-"));
  tempDirs.push(dir);
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  return join(stateDir, "agentloop.sqlite");
}
