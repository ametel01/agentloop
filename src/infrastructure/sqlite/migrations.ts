import type { Database } from "bun:sqlite";

export const CURRENT_SCHEMA_VERSION = 3;

export function migrate(database: Database): void {
  applyPragmas(database);
  database.run("BEGIN IMMEDIATE");
  try {
    database.run(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    const latest = database
      .query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const version = latest?.version ?? 0;

    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported future schema version: ${version}`);
    }

    if (version < 1) {
      applyMigration1(database);
      database
        .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    }

    if (version < 2) {
      applyMigration2(database);
      database
        .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString());
    }

    if (version < 3) {
      applyMigration3(database);
      database
        .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(3, new Date().toISOString());
    }

    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

function applyMigration2(database: Database): void {
  database.run("ALTER TABLE turns ADD COLUMN abort_reason TEXT NULL");
  database.run("ALTER TABLE turns ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 1");
  database.run(`
    CREATE TABLE checkpoints(
      run_id TEXT NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL,
      turn_id TEXT NOT NULL REFERENCES turns(id),
      status TEXT NOT NULL,
      abort_reason TEXT NULL,
      usage_complete INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    )
  `);
  database.run("CREATE INDEX checkpoints_turn_idx ON checkpoints(turn_id)");
}

function applyMigration3(database: Database): void {
  database.run("ALTER TABLE runs ADD COLUMN last_useful_outcome_at TEXT NULL");
  database.run(`
    CREATE TABLE outcomes(
      run_id TEXT NOT NULL REFERENCES runs(id),
      key TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(run_id, key)
    )
  `);
  database.run("CREATE INDEX outcomes_type_idx ON outcomes(run_id, type)");
}

export function applyPragmas(database: Database): void {
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA synchronous = NORMAL");
}

function applyMigration1(database: Database): void {
  database.run(`
    CREATE TABLE runs(
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      repo_key TEXT NOT NULL,
      objective TEXT NOT NULL,
      objective_hash TEXT NOT NULL,
      thread_id TEXT NULL,
      status TEXT NOT NULL,
      model TEXT NULL,
      reasoning_effort TEXT NULL,
      approval_mode TEXT NOT NULL,
      worktree_root TEXT NOT NULL,
      skill_fingerprint TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      turns_completed INTEGER NOT NULL,
      total_input_tokens INTEGER NOT NULL,
      total_cached_input_tokens INTEGER NOT NULL,
      total_output_tokens INTEGER NOT NULL,
      total_reasoning_tokens INTEGER NOT NULL,
      no_progress_count INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL,
      state_fingerprint TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NULL,
      finished_at TEXT NULL,
      last_error TEXT NULL
    )
  `);

  database.run(`
    CREATE TABLE turns(
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      turn_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NULL,
      fingerprint_before TEXT NULL,
      fingerprint_after TEXT NULL,
      response_json TEXT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      error_json TEXT NULL,
      UNIQUE(run_id, turn_number)
    )
  `);

  database.run(`
    CREATE TABLE events(
      run_id TEXT NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL,
      turn_id TEXT NULL REFERENCES turns(id),
      event_type TEXT NOT NULL,
      item_id TEXT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    )
  `);

  database.run(`
    CREATE TABLE approvals(
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      risk TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT NULL,
      response TEXT NULL
    )
  `);

  database.run(`
    CREATE TABLE leases(
      repo_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  database.run("CREATE INDEX runs_status_idx ON runs(status)");
  database.run("CREATE INDEX runs_repo_status_idx ON runs(repo_key, status)");
  database.run("CREATE INDEX events_order_idx ON events(run_id, sequence)");
  database.run("CREATE INDEX approvals_status_idx ON approvals(run_id, status)");
  database.run("CREATE INDEX leases_expiry_idx ON leases(expires_at)");
  database.run(`
    CREATE UNIQUE INDEX runs_one_open_per_repo_idx ON runs(repo_key)
    WHERE status IN (
      'queued',
      'running',
      'continuing',
      'waiting_approval',
      'externally_blocked',
      'stuck',
      'budget_exhausted',
      'review_cycle_exhausted',
      'failed'
    )
  `);
}
