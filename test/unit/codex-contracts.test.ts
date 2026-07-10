import { describe, expect, test } from "bun:test";

import { CONTROL_ENVELOPE_SCHEMA, parseControlEnvelope } from "../../src/codex/control-envelope.ts";
import { buildThreadOptions } from "../../src/codex/thread-options.ts";

describe("Codex contracts", () => {
  test("omits model overrides when not supplied", () => {
    expect(
      buildThreadOptions({
        model: null,
        reasoningEffort: null,
        repoPath: "/repo",
        worktreeRoot: "/worktrees/repo",
      }),
    ).toEqual({
      additionalDirectories: ["/worktrees/repo"],
      approvalPolicy: "never",
      networkAccessEnabled: true,
      sandboxMode: "workspace-write",
      webSearchMode: "disabled",
      workingDirectory: "/repo",
    });
  });

  test("rejects complete envelopes without closure evidence", () => {
    expect(() =>
      parseControlEnvelope(
        JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: false,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          status: "complete",
          summary: "not really done",
        }),
      ),
    ).toThrow("closureGatePassed is false");
  });

  test("rejects additional properties", () => {
    expect(() =>
      parseControlEnvelope(
        JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: false,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          extra: true,
          status: "continue",
          summary: "continue",
        }),
      ),
    ).toThrow("Unexpected control envelope keys");
  });

  test("uses only strict structured-output schema nodes", () => {
    expect(() => assertStrictSchema(CONTROL_ENVELOPE_SCHEMA, "$")).not.toThrow();
  });

  test("parses structured approval operations", () => {
    const envelope = parseControlEnvelope(
      JSON.stringify({
        approval: {
          kind: "human_merge",
          operation: {
            action: "merge pull request",
            details: "Merge after all required checks pass",
            target: "pull request 123",
          },
          question: "Approve merge?",
          risk: "Merges code",
        },
        blocker: null,
        closureGatePassed: false,
        evidence: {
          issueUrls: [],
          prUrls: ["https://github.com/example/repo/pull/123"],
          reviewUrls: [],
          statusPath: "STATUS.md",
        },
        status: "waiting_approval",
        summary: "Needs merge approval",
      }),
    );

    expect(envelope.approval?.operation.action).toBe("merge pull request");
  });

  test("parses blocker evidence as a list of exact observations", () => {
    const envelope = parseControlEnvelope(
      JSON.stringify({
        approval: null,
        blocker: {
          attemptedOperation: "gh pr merge 123",
          evidence: ["permission denied", "https://github.com/example/repo/pull/123"],
          kind: "missing_permission",
          message: "The authenticated account cannot merge this pull request.",
        },
        closureGatePassed: false,
        evidence: {
          issueUrls: [],
          prUrls: ["https://github.com/example/repo/pull/123"],
          reviewUrls: [],
          statusPath: "STATUS.md",
        },
        status: "externally_blocked",
        summary: "Merge permission is required",
      }),
    );

    expect(envelope.blocker?.evidence).toEqual([
      "permission denied",
      "https://github.com/example/repo/pull/123",
    ]);
  });
});

function assertStrictSchema(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a schema object`);
  }

  if ("$ref" in value) {
    return;
  }

  if (Array.isArray(value.anyOf)) {
    for (const [index, branch] of value.anyOf.entries()) {
      assertStrictSchema(branch, `${path}.anyOf[${index}]`);
    }
    return;
  }

  if (typeof value.type !== "string") {
    throw new Error(`${path} must declare a type`);
  }

  if (value.type === "object") {
    if (value.additionalProperties !== false) {
      throw new Error(`${path} must set additionalProperties to false`);
    }
    if (!isRecord(value.properties) || !Array.isArray(value.required)) {
      throw new Error(`${path} must declare properties and required fields`);
    }

    const propertyNames = Object.keys(value.properties).sort();
    const requiredNames = value.required
      .filter((item): item is string => typeof item === "string")
      .sort();
    if (propertyNames.join("\0") !== requiredNames.join("\0")) {
      throw new Error(`${path} must require every property`);
    }

    for (const [name, property] of Object.entries(value.properties)) {
      assertStrictSchema(property, `${path}.properties.${name}`);
    }
  }

  if (value.type === "array") {
    assertStrictSchema(value.items, `${path}.items`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
