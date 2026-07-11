import type { Database } from "bun:sqlite";

import { OpenRunConflictError, StateConflictError } from "../../domain/errors.ts";
import type {
  ApprovalRequest,
  CheckpointRecord,
  CreateRunInput,
  EventRecord,
  LeaseRecord,
  OutcomeRecord,
  RunLimits,
  RunRecord,
  RunStatus,
  RunUsage,
  TurnRecord,
} from "../../domain/run.ts";
import { DEFAULT_RUN_LIMITS } from "../../domain/run.ts";
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
  last_useful_outcome_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  kind: string;
  question: string;
  risk: string;
  operation_json: string;
  evidence_json: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  resolved_at: string | null;
  response: string | null;
}

export interface RunStore {
  createRun(input: CreateRunInput): RunRecord;
  getOpenRunByRepoKey(repoKey: string): RunRecord | null;
  getRun(id: string): RunRecord | null;
  countEvents(runId: string): number;
  countTurns(runId: string): number;
  listRuns(limit: number): RunRecord[];
  listTurns(runId: string): TurnRecord[];
  listEvents(runId: string, afterSequence: number, limit: number): EventRecord[];
  getLeaseForRun(runId: string): LeaseRecord | null;
  transitionRun(input: TransitionRunInput): RunRecord;
  updateSkillFingerprint(input: UpdateSkillFingerprintInput): RunRecord;
  updateProgress(input: UpdateProgressInput): RunRecord;
  updateUsage(input: UpdateUsageInput): RunRecord;
  recordOutcomes(input: RecordOutcomesInput): OutcomeRecord[];
  listOutcomes(runId: string): OutcomeRecord[];
  createTurn(input: CreateTurnInput): TurnRecord;
  completeTurn(input: CompleteTurnInput): TurnRecord;
  createCheckpoint(input: CreateCheckpointInput): CheckpointRecord;
  getLatestCheckpoint(runId: string): CheckpointRecord | null;
  listCheckpoints(runId: string): CheckpointRecord[];
  appendEvent(input: AppendEventInput): EventRecord;
  recordThreadStarted(input: RecordThreadStartedInput): EventRecord;
  createApproval(input: CreateApprovalInput): ApprovalRequest;
  listPendingApprovals(runId: string): ApprovalRequest[];
  resolveApproval(input: ResolveApprovalInput): ApprovalRequest;
  claimOldestQueued(input: ClaimRunInput): RunRecord | null;
  claimExpiredActive(input: ClaimRunInput): RunRecord | null;
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

export interface UpdateProgressInput {
  id: string;
  stateFingerprint: string;
  noProgressCount: number;
  consecutiveFailures: number;
  now: string;
}

export interface UpdateUsageInput {
  id: string;
  usageDelta: RunUsage;
  now: string;
}

export interface RecordOutcomesInput {
  runId: string;
  outcomes: Array<{
    key: string;
    type: string;
    payloadJson: string;
  }>;
  observedAt: string;
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
  abortReason: string | null;
  finishedAt: string;
  fingerprintAfter: string | null;
  responseJson: string | null;
  usage: RunUsage;
  usageComplete: boolean;
  errorJson: string | null;
}

export interface CreateCheckpointInput {
  runId: string;
  turnId: string;
  status: string;
  abortReason: string | null;
  usageComplete: boolean;
  payloadJson: string;
  createdAt: string;
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

export interface ResolveApprovalInput {
  id: string;
  status: "approved" | "rejected";
  response: string;
  resolvedAt: string;
}

export interface AcquireLeaseInput {
  repoKey: string;
  runId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ClaimRunInput {
  ownerId: string;
  now: string;
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
              'review_cycle_exhausted',
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
            last_useful_outcome_at,
            created_at,
            updated_at,
            started_at,
            finished_at,
            last_error
          ) VALUES (
            ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, NULL, NULL, NULL
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

  getOpenRunByRepoKey(repoKey: string): RunRecord | null {
    const row = this.database
      .query<RunRow, [string]>(
        `
        SELECT * FROM runs
        WHERE repo_key = ?
          AND status IN (
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
        ORDER BY created_at ASC
        LIMIT 1
      `,
      )
      .get(repoKey);

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

  listTurns(runId: string): TurnRecord[] {
    return this.database
      .query<TurnRow, [string]>("SELECT * FROM turns WHERE run_id = ? ORDER BY turn_number ASC")
      .all(runId)
      .map(mapTurn);
  }

  listEvents(runId: string, afterSequence: number, limit: number): EventRecord[] {
    return this.database
      .query<EventRow, [string, number, number]>(
        `
        SELECT * FROM events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `,
      )
      .all(runId, afterSequence, limit)
      .map(mapEvent);
  }

  getLeaseForRun(runId: string): LeaseRecord | null {
    const row = this.database
      .query<LeaseRow, [string]>("SELECT * FROM leases WHERE run_id = ?")
      .get(runId);
    return row === null ? null : mapLease(row);
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
                WHEN ? IN ('failed', 'cancelled', 'stuck', 'budget_exhausted', 'review_cycle_exhausted') THEN ?
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

  updateProgress(input: UpdateProgressInput): RunRecord {
    this.database
      .query(
        `
        UPDATE runs
        SET state_fingerprint = ?,
            no_progress_count = ?,
            consecutive_failures = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        input.stateFingerprint,
        input.noProgressCount,
        input.consecutiveFailures,
        input.now,
        input.id,
      );

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

  recordOutcomes(input: RecordOutcomesInput): OutcomeRecord[] {
    if (input.outcomes.length === 0) {
      return [];
    }

    this.database.run("BEGIN IMMEDIATE");
    try {
      const inserted: OutcomeRecord[] = [];
      for (const outcome of input.outcomes) {
        const result = this.database
          .query(
            `
            INSERT OR IGNORE INTO outcomes(run_id, key, type, payload_json, observed_at)
            VALUES (?, ?, ?, ?, ?)
          `,
          )
          .run(input.runId, outcome.key, outcome.type, outcome.payloadJson, input.observedAt);

        if (result.changes === 1) {
          inserted.push({
            key: outcome.key,
            observedAt: input.observedAt,
            payload: JSON.parse(outcome.payloadJson),
            runId: input.runId,
            type: outcome.type,
          });
        }
      }

      if (inserted.length > 0) {
        this.database
          .query("UPDATE runs SET last_useful_outcome_at = ?, updated_at = ? WHERE id = ?")
          .run(input.observedAt, input.observedAt, input.runId);
      }

      this.database.run("COMMIT");
      return inserted;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  listOutcomes(runId: string): OutcomeRecord[] {
    return this.database
      .query<OutcomeRow, [string]>(
        `
        SELECT * FROM outcomes
        WHERE run_id = ?
        ORDER BY observed_at ASC, key ASC
      `,
      )
      .all(runId)
      .map(mapOutcome);
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
            abort_reason = ?,
            finished_at = ?,
            fingerprint_after = ?,
            response_json = ?,
            input_tokens = ?,
            cached_input_tokens = ?,
            output_tokens = ?,
            reasoning_tokens = ?,
            usage_complete = ?,
            error_json = ?
        WHERE id = ?
      `,
      )
      .run(
        input.status,
        input.abortReason,
        input.finishedAt,
        input.fingerprintAfter,
        input.responseJson,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.outputTokens,
        input.usage.reasoningTokens,
        input.usageComplete ? 1 : 0,
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

  createCheckpoint(input: CreateCheckpointInput): CheckpointRecord {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const last = this.database
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM checkpoints WHERE run_id = ?",
        )
        .get(input.runId);
      const sequence = (last?.sequence ?? 0) + 1;

      this.database
        .query(
          `
          INSERT INTO checkpoints(
            run_id,
            sequence,
            turn_id,
            status,
            abort_reason,
            usage_complete,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.runId,
          sequence,
          input.turnId,
          input.status,
          input.abortReason,
          input.usageComplete ? 1 : 0,
          input.payloadJson,
          input.createdAt,
        );

      this.database.run("COMMIT");
      return {
        abortReason: input.abortReason,
        createdAt: input.createdAt,
        payload: JSON.parse(input.payloadJson),
        runId: input.runId,
        sequence,
        status: input.status,
        turnId: input.turnId,
        usageComplete: input.usageComplete,
      };
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  getLatestCheckpoint(runId: string): CheckpointRecord | null {
    const row = this.database
      .query<CheckpointRow, [string]>(
        `
        SELECT * FROM checkpoints
        WHERE run_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `,
      )
      .get(runId);

    return row === null ? null : mapCheckpoint(row);
  }

  listCheckpoints(runId: string): CheckpointRecord[] {
    return this.database
      .query<CheckpointRow, [string]>(
        `
        SELECT * FROM checkpoints
        WHERE run_id = ?
        ORDER BY sequence ASC
      `,
      )
      .all(runId)
      .map(mapCheckpoint);
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

    const approval = this.database
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
      .get(input.id);
    if (approval === null) {
      throw new StateConflictError(`Approval ${input.id} could not be created`);
    }

    return mapApproval(approval);
  }

  listPendingApprovals(runId: string): ApprovalRequest[] {
    return this.database
      .query<ApprovalRow, [string]>(
        "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY requested_at ASC",
      )
      .all(runId)
      .map(mapApproval);
  }

  resolveApproval(input: ResolveApprovalInput): ApprovalRequest {
    const result = this.database
      .query(
        `
        UPDATE approvals
        SET status = ?,
            resolved_at = ?,
            response = ?
        WHERE id = ? AND status = 'pending'
      `,
      )
      .run(input.status, input.resolvedAt, input.response, input.id);

    if (result.changes !== 1) {
      throw new StateConflictError(`Approval ${input.id} is not pending`);
    }

    const approval = this.database
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
      .get(input.id);
    if (approval === null) {
      throw new StateConflictError(`Approval ${input.id} does not exist`);
    }

    return mapApproval(approval);
  }

  claimOldestQueued(input: ClaimRunInput): RunRecord | null {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const candidate = this.database
        .query<{ id: string; repo_key: string; limits_json: string }, []>(
          `
          SELECT id, repo_key, limits_json
          FROM runs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get();
      if (candidate === null) {
        this.database.run("COMMIT");
        return null;
      }

      const expiresAt = leaseExpiresAt(input.now, candidate.limits_json);
      this.database
        .query(
          `
          INSERT INTO leases(repo_key, run_id, owner_id, acquired_at, heartbeat_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(candidate.repo_key, candidate.id, input.ownerId, input.now, input.now, expiresAt);
      this.database
        .query("UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?")
        .run(input.now, input.now, candidate.id);

      const run = this.getRun(candidate.id);
      this.database.run("COMMIT");
      return run;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  claimExpiredActive(input: ClaimRunInput): RunRecord | null {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const candidate = this.database
        .query<{ id: string; repo_key: string; limits_json: string }, [string]>(
          `
          SELECT runs.id, runs.repo_key, runs.limits_json
          FROM runs
          INNER JOIN leases ON leases.repo_key = runs.repo_key
          WHERE leases.expires_at <= ?
            AND runs.status IN ('running', 'continuing')
            AND (
              runs.thread_id IS NOT NULL
              OR NOT EXISTS (SELECT 1 FROM events WHERE events.run_id = runs.id)
            )
          ORDER BY leases.expires_at ASC
          LIMIT 1
        `,
        )
        .get(input.now);
      if (candidate === null) {
        this.database.run("COMMIT");
        return null;
      }

      const expiresAt = leaseExpiresAt(input.now, candidate.limits_json);
      this.database.query("DELETE FROM leases WHERE repo_key = ?").run(candidate.repo_key);
      this.database
        .query(
          `
          INSERT INTO leases(repo_key, run_id, owner_id, acquired_at, heartbeat_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(candidate.repo_key, candidate.id, input.ownerId, input.now, input.now, expiresAt);
      this.database
        .query("UPDATE runs SET updated_at = ? WHERE id = ?")
        .run(input.now, candidate.id);

      const run = this.getRun(candidate.id);
      this.database.run("COMMIT");
      return run;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
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

  renewLease(repoKey: string, ownerId: string, heartbeatAt: string, expiresAt: string): void {
    this.database
      .query(
        "UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE repo_key = ? AND owner_id = ?",
      )
      .run(heartbeatAt, expiresAt, repoKey, ownerId);
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
  abort_reason: string | null;
  prompt_hash: string;
  started_at: string;
  finished_at: string | null;
  fingerprint_before: string | null;
  fingerprint_after: string | null;
  response_json: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  usage_complete: number;
  error_json: string | null;
}

interface CheckpointRow {
  run_id: string;
  sequence: number;
  turn_id: string;
  status: string;
  abort_reason: string | null;
  usage_complete: number;
  payload_json: string;
  created_at: string;
}

interface OutcomeRow {
  run_id: string;
  key: string;
  type: string;
  payload_json: string;
  observed_at: string;
}

interface EventRow {
  run_id: string;
  sequence: number;
  turn_id: string | null;
  event_type: string;
  item_id: string | null;
  payload_json: string;
  created_at: string;
}

interface LeaseRow {
  repo_key: string;
  run_id: string;
  owner_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
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
    limits: normalizeRunLimits(row.limits_json),
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
    lastUsefulOutcomeAt: row.last_useful_outcome_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    errorJson: row.error_json,
    fingerprintAfter: row.fingerprint_after,
    fingerprintBefore: row.fingerprint_before,
    id: row.id,
    runId: row.run_id,
    responseJson: row.response_json,
    turnNumber: row.turn_number,
    abortReason: row.abort_reason,
    kind: row.kind,
    status: row.status,
    promptHash: row.prompt_hash,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usage: {
      cachedInputTokens: row.cached_input_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
    },
    usageComplete: row.usage_complete === 1,
  };
}

function mapCheckpoint(row: CheckpointRow): CheckpointRecord {
  return {
    abortReason: row.abort_reason,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json),
    runId: row.run_id,
    sequence: row.sequence,
    status: row.status,
    turnId: row.turn_id,
    usageComplete: row.usage_complete === 1,
  };
}

function mapOutcome(row: OutcomeRow): OutcomeRecord {
  return {
    key: row.key,
    observedAt: row.observed_at,
    payload: JSON.parse(row.payload_json),
    runId: row.run_id,
    type: row.type,
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    createdAt: row.created_at,
    eventType: row.event_type,
    itemId: row.item_id,
    payloadJson: row.payload_json,
    runId: row.run_id,
    sequence: row.sequence,
    turnId: row.turn_id,
  };
}

function mapLease(row: LeaseRow): LeaseRecord {
  return {
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    ownerId: row.owner_id,
    repoKey: row.repo_key,
    runId: row.run_id,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRequest {
  return {
    evidence: JSON.parse(row.evidence_json),
    id: row.id,
    kind: row.kind,
    operation: JSON.parse(row.operation_json),
    question: row.question,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    response: row.response,
    risk: row.risk,
    runId: row.run_id,
    status: row.status,
  };
}

function leaseExpiresAt(now: string, limitsJson: string): string {
  const limits = normalizeRunLimits(limitsJson);
  return new Date(Date.parse(now) + limits.leaseTtlMs).toISOString();
}

function normalizeRunLimits(limitsJson: string): RunLimits {
  const parsed = JSON.parse(limitsJson) as Partial<RunLimits>;
  return {
    cooperativeTrancheMs: positiveNumberOrDefault(
      parsed.cooperativeTrancheMs,
      DEFAULT_RUN_LIMITS.cooperativeTrancheMs,
    ),
    eventStallWarningMs: positiveNumberOrDefault(
      parsed.eventStallWarningMs,
      DEFAULT_RUN_LIMITS.eventStallWarningMs,
    ),
    hardTurnDeadlineMs: positiveNumberOrDefault(
      parsed.hardTurnDeadlineMs,
      DEFAULT_RUN_LIMITS.hardTurnDeadlineMs,
    ),
    leaseRenewIntervalMs: positiveNumberOrDefault(
      parsed.leaseRenewIntervalMs,
      DEFAULT_RUN_LIMITS.leaseRenewIntervalMs,
    ),
    leaseTtlMs: positiveNumberOrDefault(parsed.leaseTtlMs, DEFAULT_RUN_LIMITS.leaseTtlMs),
    maxConsecutiveStalls: positiveNumberOrDefault(
      parsed.maxConsecutiveStalls,
      DEFAULT_RUN_LIMITS.maxConsecutiveStalls,
    ),
    maxConsecutiveTurnFailures: positiveNumberOrDefault(
      parsed.maxConsecutiveTurnFailures,
      DEFAULT_RUN_LIMITS.maxConsecutiveTurnFailures,
    ),
    maxNoProgressTurns: positiveNumberOrDefault(
      parsed.maxNoProgressTurns,
      DEFAULT_RUN_LIMITS.maxNoProgressTurns,
    ),
    maxOuterTurns: positiveNumberOrDefault(parsed.maxOuterTurns, DEFAULT_RUN_LIMITS.maxOuterTurns),
    maxTotalTokens: positiveNumberOrDefault(
      parsed.maxTotalTokens,
      DEFAULT_RUN_LIMITS.maxTotalTokens,
    ),
    maxWallDurationMs: positiveNumberOrDefault(
      parsed.maxWallDurationMs,
      DEFAULT_RUN_LIMITS.maxWallDurationMs,
    ),
  };
}

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
