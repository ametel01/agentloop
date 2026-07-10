import type { RunStatus } from "./run.ts";

const ALLOWED_TRANSITIONS: ReadonlyMap<RunStatus, readonly RunStatus[]> = new Map([
  ["queued", ["running", "cancelled"]],
  [
    "running",
    [
      "continuing",
      "waiting_approval",
      "externally_blocked",
      "complete",
      "stuck",
      "budget_exhausted",
      "failed",
      "cancelled",
    ],
  ],
  ["continuing", ["running", "waiting_approval", "cancelled"]],
  ["waiting_approval", ["continuing", "cancelled"]],
  ["externally_blocked", ["continuing", "cancelled"]],
  ["stuck", ["continuing", "cancelled"]],
  ["budget_exhausted", ["continuing", "cancelled"]],
  ["failed", ["continuing", "cancelled"]],
  ["complete", []],
  ["cancelled", []],
]);

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.includes(to) ?? false;
}
