import { describe, expect, test } from "bun:test";

import {
  evidencePromptBlock,
  normalizeEvidenceRecord,
  type EvidenceCheckpointRecord,
} from "../../src/application/evidence-cache.ts";

describe("evidence cache", () => {
  test("keys reusable evidence by every strict equivalence dimension", () => {
    const base = evidenceRecord();
    const key = normalizeEvidenceRecord(base)?.cacheKey;

    expect(key).toBeString();
    expect(normalizeEvidenceRecord({ ...base, gateVersion: "v2" })?.cacheKey).not.toBe(key);
    expect(
      normalizeEvidenceRecord({ ...base, relevantInputDigest: "inputs-2" })?.cacheKey,
    ).not.toBe(key);
    expect(
      normalizeEvidenceRecord({ ...base, environmentFingerprint: "env-2" })?.cacheKey,
    ).not.toBe(key);
    expect(normalizeEvidenceRecord({ ...base, headSha: "def456" })?.cacheKey).not.toBe(key);
  });

  test("requires either exact head or stable patch identity", () => {
    expect(normalizeEvidenceRecord(evidenceRecord({ headSha: null, stablePatchId: null }))).toBe(
      null,
    );
    expect(
      normalizeEvidenceRecord(evidenceRecord({ headSha: null, stablePatchId: "patch-1" }))
        ?.cacheKey,
    ).toBeString();
  });

  test("redacts compact summaries and renders rerun guidance", () => {
    const evidence = normalizeEvidenceRecord(
      evidenceRecord({
        result: "failed",
        reusableFailureSignature: "same sk-secret123 failure",
        summary: "failed with github_pat_secret123",
      }),
    );

    expect(evidence?.summary).toContain("[redacted-secret]");
    expect(evidence?.reusableFailureSignature).toContain("[redacted-secret]");
    if (evidence === null) {
      throw new Error("expected cacheable evidence");
    }

    const prompt = evidencePromptBlock([
      {
        ...evidence,
        createdAt: "2026-07-11T00:00:00.000Z",
        lastUsedAt: "2026-07-11T00:00:00.000Z",
        repoKey: "repo-key",
        runId: "run-1",
      },
    ]);
    expect(prompt).toContain("Exact reusable evidence");
    expect(prompt).toContain("cache miss");
  });
});

function evidenceRecord(
  overrides: Partial<EvidenceCheckpointRecord> = {},
): EvidenceCheckpointRecord {
  return {
    environmentFingerprint: "env-1",
    gateName: "bun run verify",
    gateVersion: "package-json:v1",
    headSha: "abc123",
    kind: "gate",
    relevantInputDigest: "inputs-1",
    result: "passed",
    reusableFailureSignature: null,
    stablePatchId: null,
    summary: "verify passed",
    ...overrides,
  };
}
