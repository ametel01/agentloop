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
    const version1Limits = {
      ...DEFAULT_RUN_LIMITS,
      eventStallWarningMs: 123_456,
      maxOuterTurns: 3,
    };

    store.createRun(createRunInput({ id: "run-1", limits: version1Limits }));

    const run = store.getRun("run-1");
    expect(run?.limits.maxOuterTurns).toBe(3);
    expect(run?.limits.eventStallWarningMs).toBe(123_456);
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
