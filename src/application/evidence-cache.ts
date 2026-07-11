import type {
  EvidenceCacheRecord,
  EvidenceRecordKind,
  EvidenceRecordResult,
} from "../domain/run.ts";
import { redactText } from "../codex/redaction.ts";
import { sha256Hex } from "../infrastructure/hash.ts";

export interface EvidenceCheckpointRecord {
  kind: EvidenceRecordKind;
  gateName: string;
  gateVersion: string;
  headSha: string | null;
  stablePatchId: string | null;
  relevantInputDigest: string;
  environmentFingerprint: string;
  result: EvidenceRecordResult;
  summary: string;
  reusableFailureSignature: string | null;
}

export interface CacheableEvidenceRecord extends EvidenceCheckpointRecord {
  cacheKey: string;
  payload: unknown;
}

export function normalizeEvidenceRecord(
  record: EvidenceCheckpointRecord,
): CacheableEvidenceRecord | null {
  const gateName = normalizeToken(record.gateName);
  const gateVersion = normalizeToken(record.gateVersion);
  const headSha = normalizeNullableToken(record.headSha);
  const stablePatchId = normalizeNullableToken(record.stablePatchId);
  const relevantInputDigest = normalizeToken(record.relevantInputDigest);
  const environmentFingerprint = normalizeToken(record.environmentFingerprint);

  if (
    gateName === null ||
    gateVersion === null ||
    relevantInputDigest === null ||
    environmentFingerprint === null ||
    (headSha === null && stablePatchId === null)
  ) {
    return null;
  }

  const normalized = {
    environmentFingerprint,
    gateName,
    gateVersion,
    headSha,
    kind: record.kind,
    relevantInputDigest,
    stablePatchId,
  };

  return {
    cacheKey: sha256Hex(JSON.stringify(normalized)),
    environmentFingerprint,
    gateName,
    gateVersion,
    headSha,
    kind: record.kind,
    payload: normalized,
    relevantInputDigest,
    result: record.result,
    reusableFailureSignature: compactNullable(record.reusableFailureSignature, 240),
    stablePatchId,
    summary: compact(record.summary, 500),
  };
}

export function evidenceReference(record: EvidenceCacheRecord): string {
  const ref = record.headSha ?? record.stablePatchId ?? "unknown-ref";
  const signature =
    record.reusableFailureSignature === null
      ? ""
      : `; failureSignature=${record.reusableFailureSignature}`;
  return `${record.kind}:${record.gateName}@${record.gateVersion} ${record.result} for ${ref}; input=${record.relevantInputDigest}; env=${record.environmentFingerprint}; summary=${record.summary}${signature}`;
}

export function evidencePromptBlock(records: readonly EvidenceCacheRecord[]): string | null {
  if (records.length === 0) {
    return null;
  }

  return [
    "Exact reusable evidence available only for matching head/stable patch, relevant-input digest, environment fingerprint, and gate version:",
    ...records.slice(0, 5).map((record) => `- ${evidenceReference(record)}`),
    "Treat every absent or changed key as a cache miss and rerun the gate or blocker check.",
  ].join("\n");
}

function normalizeToken(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeNullableToken(value: string | null): string | null {
  return value === null ? null : normalizeToken(value);
}

function compactNullable(value: string | null, maxLength: number): string | null {
  return value === null ? null : compact(value, maxLength);
}

function compact(value: string, maxLength: number): string {
  const redacted = redactText(value).replace(/\s+/g, " ").trim();
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}
