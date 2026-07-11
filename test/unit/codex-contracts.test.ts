import { describe, expect, test } from "bun:test";

import {
  buildApprovalResponsePrompt,
  buildContinuationPrompt,
  buildInitialPrompt,
  buildRecoveryPrompt,
} from "../../src/codex/prompt-builder.ts";
import { CONTROL_ENVELOPE_SCHEMA, parseControlEnvelope } from "../../src/codex/control-envelope.ts";
import { buildThreadOptions } from "../../src/codex/thread-options.ts";
import { DEFAULT_RUN_LIMITS, type RunRecord } from "../../src/domain/run.ts";

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
          agents: noActiveAgents(),
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
          agents: noActiveAgents(),
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
        agents: noActiveAgents(),
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
        agents: noActiveAgents(),
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

  test("parses an exact active subagent roster", () => {
    const envelope = parseControlEnvelope(
      JSON.stringify({
        agents: {
          coordinator: { status: "working", task: "Route completed builder work." },
          subagents: [
            {
              name: "/root/checker_238",
              role: "checker-agent",
              status: "running",
              task: "Verify PR 251 at the exact pushed head.",
            },
          ],
        },
        approval: null,
        blocker: null,
        closureGatePassed: false,
        evidence: { issueUrls: [], prUrls: [], reviewUrls: [], statusPath: "STATUS.md" },
        status: "continue",
        summary: "Checker 238 is active.",
      }),
    );

    expect(envelope.agents.subagents).toEqual([
      {
        name: "/root/checker_238",
        role: "checker-agent",
        status: "running",
        task: "Verify PR 251 at the exact pushed head.",
      },
    ]);
  });

  test("adds durable run identity to every coordinator prompt header", () => {
    const run = createRunRecord();
    const prompts = [
      buildInitialPrompt(run),
      buildContinuationPrompt(run),
      buildRecoveryPrompt(run, "operator context"),
      buildApprovalResponsePrompt(run, "approval-1", "approved"),
    ];

    for (const prompt of prompts) {
      expect(countOccurrences(prompt, "Run ID: run-123")).toBe(1);
      expect(prompt.indexOf("Run ID: run-123")).toBeLessThan(prompt.indexOf("<target_work>"));
      expect(prompt).toContain("Keep the human operator informed during the turn");
      expect(prompt).toContain("every active subagent's canonical name, role, current task");
      expect(prompt).toContain("do not expose private chain-of-thought");
      expect(prompt).not.toContain("process.env");
      expect(prompt).not.toContain("OPENAI_API_KEY");
      expect(prompt).not.toContain("GITHUB_TOKEN");
    }
  });
});

function createRunRecord(): RunRecord {
  return {
    approvalMode: "agent-approved",
    consecutiveFailures: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    finishedAt: null,
    id: "run-123",
    lastError: null,
    lastUsefulOutcomeAt: null,
    limits: DEFAULT_RUN_LIMITS,
    model: null,
    noProgressCount: 0,
    objective: "Close dispatched issue #12.",
    objectiveHash: "objective-hash",
    reasoningEffort: null,
    repoKey: "repo-key",
    repoPath: "/repo",
    skillFingerprint: "skill-fingerprint",
    startedAt: null,
    stateFingerprint: null,
    status: "queued",
    threadId: "thread-123",
    turnsCompleted: 0,
    updatedAt: "2026-07-10T00:00:00.000Z",
    usage: {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    worktreeRoot: "/worktrees/repo",
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function noActiveAgents() {
  return {
    coordinator: { status: "working", task: "Coordinate the current dev-team turn." },
    subagents: [],
  } as const;
}

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
