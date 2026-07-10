import type { Database } from "bun:sqlite";

import { OpenRunConflictError, StateConflictError } from "../../domain/errors.ts";
import type {
  ApprovalRequest,
  CreateRunInput,
  EventRecord,
  RunLimits,
  RunRecord,
  RunStatus,
  RunUsage,
  TurnRecord,
} from "../../domain/run.ts";
import { canTransition } from "../../domain/state-machine.ts";

interface RunRow {
  id: string;
  repo_path: string;
  repo_key: string;
  objective: string;
  objective_hash: string;
  thread_id: string | null;
  status: RunStatus;
  model: string | null;
  reasoning_effort: string | null;
  approval_mode: "agent-approved" | "human-merge";
  worktree_root: string;
  skill_fingerprint: string;
  limits_json: string;
  turns_completed: number;
  total_input_tokens: number;
  total_cached_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  no_progress_count: number;
  consecutive_failures: number;
  state_fingerprint: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}

export interface RunStore {
  createRun(input: CreateRunInput): RunRecord;
  getRun(id: string): RunRecord | null;
  countEvents(runId: string): number;
  countTurns(runId: string): number;
  listRuns(limit: number): RunRecord[];
  transitionRun(input: TransitionRunInput): RunRecord;
  updateSkillFingerprint(input: UpdateSkillFingerprintInput): RunRecord;
  updateUsage(input: UpdateUsageInput): RunRecord;
  createTurn(input: CreateTurnInput): TurnRecord;
  completeTurn(input: CompleteTurnInput): TurnRecord;
  appendEvent(input: AppendEventInput): EventRecord;
  recordThreadStarted(input: RecordThreadStartedInput): EventRecord;
  createApproval(input: CreateApprovalInput): ApprovalRequest;
  acquireLease(input: AcquireLeaseInput): void;
  releaseLease(repoKey: string, ownerId: string): void;
}

export interface TransitionRunInput {
  id: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
  reason: string;
  now: string;
}

export interface UpdateSkillFingerprintInput {
  id: string;
  skillFingerprint: string;
  now: string;
}

export interface UpdateUsageInput {
  id: string;
  usageDelta: RunUsage;
  now: string;
}

export interface CreateTurnInput {
  id: string;
  runId: string;
  turnNumber: number;
  kind: string;
  status: string;
  promptHash: string;
  startedAt: string;
  fingerprintBefore: string | null;
}

export interface CompleteTurnInput {
  id: string;
  status: string;
  finishedAt: string;
  fingerprintAfter: string | null;
  responseJson: string | null;
  usage: RunUsage;
  errorJson: string | null;
}

export interface AppendEventInput {
  runId: string;
  turnId: string | null;
  eventType: string;
  itemId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface RecordThreadStartedInput extends AppendEventInput {
  threadId: string;
}

export interface CreateApprovalInput {
  id: string;
  runId: string;
  kind: string;
  question: string;
  risk: string;
  operationJson: string;
  evidenceJson: string;
  requestedAt: string;
}

export interface AcquireLeaseInput {
  repoKey: string;
  runId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly database: Database) {}

  createRun(input: CreateRunInput): RunRecord {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .query<{ id: string }, [string]>(
          `
          SELECT id FROM runs
          WHERE repo_key = ?
            AND status IN (
              'queued',
              'running',
              'continuing',
              'waiting_approval',
              'externally_blocked',
              'stuck',
              'budget_exhausted',
              'failed'
            )
          LIMIT 1
        `,
        )
        .get(input.repoKey);

      if (existing !== null) {
        throw new OpenRunConflictError(existing.id);
      }

      this.database
        .query(
          `
          INSERT INTO runs(
            id,
            repo_path,
            repo_key,
            objective,
            objective_hash,
            thread_id,
            status,
            model,
            reasoning_effort,
            approval_mode,
            worktree_root,
            skill_fingerprint,
            limits_json,
            turns_completed,
            total_input_tokens,
            total_cached_input_tokens,
            total_output_tokens,
            total_reasoning_tokens,
            no_progress_count,
            consecutive_failures,
            state_fingerprint,
            created_at,
            updated_at,
            started_at,
            finished_at,
            last_error
          ) VALUES (
            ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?, ?, NULL, NULL, NULL
          )
        `,
        )
        .run(
          input.id,
          input.repoPath,
          input.repoKey,
          input.objective,
          input.objectiveHash,
          input.status,
          input.model,
          input.reasoningEffort,
          input.approvalMode,
          input.worktreeRoot,
          input.skillFingerprint,
          JSON.stringify(input.limits),
          input.now,
          input.now,
        );

      const created = this.getRun(input.id);
      if (created === null) {
        throw new Error("Inserted run could not be read back");
      }

      this.database.run("COMMIT");
      return created;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): RunRecord | null {
    const row = this.database.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return row === null ? null : mapRun(row);
  }

  countEvents(runId: string): number {
    return (
      this.database
        .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM events WHERE run_id = ?")
        .get(runId)?.count ?? 0
    );
  }

  countTurns(runId: string): number {
    return (
      this.database
        .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM turns WHERE run_id = ?")
        .get(runId)?.count ?? 0
    );
  }

  listRuns(limit: number): RunRecord[] {
    return this.database
      .query<RunRow, [number]>("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(mapRun);
  }

  transitionRun(input: TransitionRunInput): RunRecord {
    if (!canTransition(input.expectedStatus, input.nextStatus)) {
      throw new StateConflictError(
        `Transition ${input.expectedStatus} -> ${input.nextStatus} is not allowed`,
      );
    }

    this.database.run("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .query(
          `
          UPDATE runs
          SET status = ?,
              updated_at = ?,
              finished_at = CASE WHEN ? IN ('complete', 'cancelled') THEN ? ELSE finished_at END,
              last_error = CASE
                WHEN ? IN ('failed', 'cancelled', 'stuck', 'budget_exhausted') THEN ?
                ELSE last_error
              END
          WHERE id = ? AND status = ?
        `,
        )
        .run(
          input.nextStatus,
          input.now,
          input.nextStatus,
          input.now,
          input.nextStatus,
          input.reason,
          input.id,
          input.expectedStatus,
        );

      if (result.changes !== 1) {
        throw new StateConflictError(
          `Run ${input.id} was not in expected state ${input.expectedStatus}`,
        );
      }

      const updated = this.getRun(input.id);
      if (updated === null) {
        throw new Error("Updated run could not be read back");
      }

      this.database.run("COMMIT");
      return updated;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  updateSkillFingerprint(input: UpdateSkillFingerprintInput): RunRecord {
    this.database
      .query("UPDATE runs SET skill_fingerprint = ?, updated_at = ? WHERE id = ?")
      .run(input.skillFingerprint, input.now, input.id);

    const run = this.getRun(input.id);
    if (run === null) {
      throw new StateConflictError(`Run ${input.id} does not exist`);
    }

    return run;
  }

  updateUsage(input: UpdateUsageInput): RunRecord {
    this.database
      .query(
        `
        UPDATE runs
        SET total_input_tokens = total_input_tokens + ?,
            total_cached_input_tokens = total_cached_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_reasoning_tokens = total_reasoning_tokens + ?,
            turns_completed = turns_completed + 1,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        input.usageDelta.inputTokens,
        input.usageDelta.cachedInputTokens,
        input.usageDelta.outputTokens,
        input.usageDelta.reasoningTokens,
        input.now,
        input.id,
      );

    const run = this.getRun(input.id);
    if (run === null) {
      throw new StateConflictError(`Run ${input.id} does not exist`);
    }

    return run;
  }

  createTurn(input: CreateTurnInput): TurnRecord {
    this.database
      .query(
        `
        INSERT INTO turns(
          id,
          run_id,
          turn_number,
          kind,
          status,
          prompt_hash,
          started_at,
          fingerprint_before,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
      `,
      )
      .run(
        input.id,
        input.runId,
        input.turnNumber,
        input.kind,
        input.status,
        input.promptHash,
        input.startedAt,
        input.fingerprintBefore,
      );

    const row = this.database
      .query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?")
      .get(input.id);
    if (row === null) {
      throw new StateConflictError(`Turn ${input.id} could not be created`);
    }

    return mapTurn(row);
  }

  completeTurn(input: CompleteTurnInput): TurnRecord {
    this.database
      .query(
        `
        UPDATE turns
        SET status = ?,
            finished_at = ?,
            fingerprint_after = ?,
            response_json = ?,
            input_tokens = ?,
            cached_input_tokens = ?,
            output_tokens = ?,
            reasoning_tokens = ?,
            error_json = ?
        WHERE id = ?
      `,
      )
      .run(
        input.status,
        input.finishedAt,
        input.fingerprintAfter,
        input.responseJson,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.outputTokens,
        input.usage.reasoningTokens,
        input.errorJson,
        input.id,
      );

    const row = this.database
      .query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?")
      .get(input.id);
    if (row === null) {
      throw new StateConflictError(`Turn ${input.id} does not exist`);
    }

    return mapTurn(row);
  }

  appendEvent(input: AppendEventInput): EventRecord {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const last = this.database
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?",
        )
        .get(input.runId);
      const sequence = (last?.sequence ?? 0) + 1;

      this.database
        .query(
          `
          INSERT INTO events(run_id, sequence, turn_id, event_type, item_id, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.runId,
          sequence,
          input.turnId,
          input.eventType,
          input.itemId,
          input.payloadJson,
          input.createdAt,
        );

      this.database.run("COMMIT");
      return { ...input, sequence };
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  recordThreadStarted(input: RecordThreadStartedInput): EventRecord {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const last = this.database
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?",
        )
        .get(input.runId);
      const sequence = (last?.sequence ?? 0) + 1;

      this.database
        .query("UPDATE runs SET thread_id = ?, updated_at = ? WHERE id = ?")
        .run(input.threadId, input.createdAt, input.runId);
      this.database
        .query(
          `
          INSERT INTO events(run_id, sequence, turn_id, event_type, item_id, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.runId,
          sequence,
          input.turnId,
          input.eventType,
          input.itemId,
          input.payloadJson,
          input.createdAt,
        );

      this.database.run("COMMIT");
      return {
        createdAt: input.createdAt,
        eventType: input.eventType,
        itemId: input.itemId,
        payloadJson: input.payloadJson,
        runId: input.runId,
        sequence,
        turnId: input.turnId,
      };
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  createApproval(input: CreateApprovalInput): ApprovalRequest {
    this.database
      .query(
        `
        INSERT INTO approvals(
          id,
          run_id,
          kind,
          question,
          risk,
          operation_json,
          evidence_json,
          status,
          requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `,
      )
      .run(
        input.id,
        input.runId,
        input.kind,
        input.question,
        input.risk,
        input.operationJson,
        input.evidenceJson,
        input.requestedAt,
      );

    return {
      id: input.id,
      runId: input.runId,
      kind: input.kind,
      question: input.question,
      risk: input.risk,
      operation: JSON.parse(input.operationJson),
      evidence: JSON.parse(input.evidenceJson),
      status: "pending",
    };
  }

  acquireLease(input: AcquireLeaseInput): void {
    this.database
      .query(
        `
        INSERT INTO leases(repo_key, run_id, owner_id, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.repoKey,
        input.runId,
        input.ownerId,
        input.acquiredAt,
        input.acquiredAt,
        input.expiresAt,
      );
  }

  releaseLease(repoKey: string, ownerId: string): void {
    this.database
      .query("DELETE FROM leases WHERE repo_key = ? AND owner_id = ?")
      .run(repoKey, ownerId);
  }
}

interface TurnRow {
  id: string;
  run_id: string;
  turn_number: number;
  kind: string;
  status: string;
  prompt_hash: string;
  started_at: string;
  finished_at: string | null;
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    repoPath: row.repo_path,
    repoKey: row.repo_key,
    objective: row.objective,
    objectiveHash: row.objective_hash,
    threadId: row.thread_id,
    status: row.status,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    approvalMode: row.approval_mode,
    worktreeRoot: row.worktree_root,
    skillFingerprint: row.skill_fingerprint,
    limits: JSON.parse(row.limits_json) as RunLimits,
    turnsCompleted: row.turns_completed,
    usage: {
      inputTokens: row.total_input_tokens,
      cachedInputTokens: row.total_cached_input_tokens,
      outputTokens: row.total_output_tokens,
      reasoningTokens: row.total_reasoning_tokens,
    } satisfies RunUsage,
    noProgressCount: row.no_progress_count,
    consecutiveFailures: row.consecutive_failures,
    stateFingerprint: row.state_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    runId: row.run_id,
    turnNumber: row.turn_number,
    kind: row.kind,
    status: row.status,
    promptHash: row.prompt_hash,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
