export type RunId = string;

export type RunStatus =
  | "queued"
  | "running"
  | "continuing"
  | "waiting_approval"
  | "externally_blocked"
  | "complete"
  | "stuck"
  | "budget_exhausted"
  | "review_cycle_exhausted"
  | "failed"
  | "cancelled";

export interface RunLimits {
  maxOuterTurns: number;
  maxTotalTokens: number;
  maxWallDurationMs: number;
  cooperativeTrancheMs: number;
  hardTurnDeadlineMs: number;
  maxConsecutiveTurnFailures: number;
  maxConsecutiveStalls: number;
  maxNoProgressTurns: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  eventStallWarningMs: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxOuterTurns: 25,
  maxTotalTokens: 5_000_000,
  maxWallDurationMs: 8 * 60 * 60 * 1000,
  cooperativeTrancheMs: 10 * 60 * 1000,
  hardTurnDeadlineMs: 11 * 60 * 1000,
  maxConsecutiveTurnFailures: 2,
  maxConsecutiveStalls: 2,
  maxNoProgressTurns: 2,
  leaseTtlMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  eventStallWarningMs: 4 * 60 * 1000,
};

export interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRequest {
  id: string;
  runId: RunId;
  kind: string;
  question: string;
  risk: string;
  operation: unknown;
  evidence: unknown;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  response: string | null;
}

export interface TurnRecord {
  id: string;
  runId: RunId;
  turnNumber: number;
  kind: string;
  status: string;
  abortReason: string | null;
  promptHash: string;
  startedAt: string;
  finishedAt: string | null;
  fingerprintBefore: string | null;
  fingerprintAfter: string | null;
  responseJson: string | null;
  usage: RunUsage;
  usageComplete: boolean;
  errorJson: string | null;
}

export interface CheckpointRecord {
  runId: RunId;
  sequence: number;
  turnId: string;
  status: string;
  abortReason: string | null;
  usageComplete: boolean;
  payload: unknown;
  createdAt: string;
}

export interface OutcomeRecord {
  runId: RunId;
  key: string;
  type: string;
  payload: unknown;
  observedAt: string;
}

export interface EventRecord {
  runId: RunId;
  sequence: number;
  turnId: string | null;
  eventType: string;
  itemId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface LeaseRecord {
  repoKey: string;
  runId: RunId;
  ownerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface RunRecord {
  id: RunId;
  repoPath: string;
  repoKey: string;
  objective: string;
  objectiveHash: string;
  threadId: string | null;
  status: RunStatus;
  model: string | null;
  reasoningEffort: string | null;
  approvalMode: "agent-approved" | "human-merge";
  worktreeRoot: string;
  skillFingerprint: string;
  limits: RunLimits;
  turnsCompleted: number;
  usage: RunUsage;
  noProgressCount: number;
  consecutiveFailures: number;
  stateFingerprint: string | null;
  lastUsefulOutcomeAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export interface CreateRunInput {
  id: RunId;
  repoPath: string;
  repoKey: string;
  objective: string;
  objectiveHash: string;
  status: "queued";
  model: string | null;
  reasoningEffort: string | null;
  approvalMode: "agent-approved" | "human-merge";
  worktreeRoot: string;
  skillFingerprint: string;
  limits: RunLimits;
  now: string;
}

export const OPEN_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "continuing",
  "waiting_approval",
  "externally_blocked",
  "stuck",
  "budget_exhausted",
  "review_cycle_exhausted",
  "failed",
];
