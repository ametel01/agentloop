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
  | "failed"
  | "cancelled";

export interface RunLimits {
  maxOuterTurns: number;
  maxTotalTokens: number;
  maxWallDurationMs: number;
  maxConsecutiveTurnFailures: number;
  maxNoProgressTurns: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  eventStallWarningMs: number;
}

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
}
