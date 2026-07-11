export interface ControlCheckpoint {
  kind: "checkpoint";
  summary: string;
  agents: ControlEnvelope["agents"];
  outcomes: string[];
  approval: ControlEnvelope["approval"];
  blocker: ControlEnvelope["blocker"];
  reviewCycle: null | {
    prUrl: string;
    currentCycle: number;
    maxCycles: number;
  };
  nextAction: string;
  ownedStatusShard: string | null;
}

export interface ControlEnvelope {
  kind: "final";
  status: "complete" | "continue" | "waiting_approval" | "externally_blocked";
  summary: string;
  agents: {
    coordinator: {
      status: "working" | "waiting" | "blocked" | "complete";
      task: string;
    };
    subagents: Array<{
      name: string;
      role: string;
      status: "running" | "waiting" | "blocked";
      task: string;
    }>;
  };
  closureGatePassed: boolean;
  evidence: {
    statusPath: string;
    issueUrls: string[];
    prUrls: string[];
    reviewUrls: string[];
  };
  approval: null | {
    kind: string;
    question: string;
    risk: string;
    operation: {
      action: string;
      target: string;
      details: string;
    };
  };
  blocker: null | {
    kind: string;
    message: string;
    attemptedOperation: string;
    evidence: string[];
  };
}

export type ControlMessage = ControlCheckpoint | ControlEnvelope;

function agentsSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["coordinator", "subagents"],
    properties: {
      coordinator: {
        type: "object",
        additionalProperties: false,
        required: ["status", "task"],
        properties: {
          status: {
            type: "string",
            enum: ["working", "waiting", "blocked", "complete"],
          },
          task: { type: "string" },
        },
      },
      subagents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "status", "task"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            status: {
              type: "string",
              enum: ["running", "waiting", "blocked"],
            },
            task: { type: "string" },
          },
        },
      },
    },
  } as const;
}

function approvalSchema() {
  return {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "question", "risk", "operation"],
        properties: {
          kind: { type: "string" },
          question: { type: "string" },
          risk: { type: "string" },
          operation: {
            type: "object",
            additionalProperties: false,
            required: ["action", "target", "details"],
            properties: {
              action: { type: "string" },
              target: { type: "string" },
              details: { type: "string" },
            },
          },
        },
      },
    ],
  } as const;
}

function blockerSchema() {
  return {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "message", "attemptedOperation", "evidence"],
        properties: {
          kind: { type: "string" },
          message: { type: "string" },
          attemptedOperation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
      },
    ],
  } as const;
}

export const CONTROL_ENVELOPE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "summary",
        "agents",
        "outcomes",
        "approval",
        "blocker",
        "reviewCycle",
        "nextAction",
        "ownedStatusShard",
      ],
      properties: {
        kind: { type: "string", enum: ["checkpoint"] },
        summary: { type: "string" },
        agents: agentsSchema(),
        outcomes: { type: "array", items: { type: "string" } },
        approval: approvalSchema(),
        blocker: blockerSchema(),
        reviewCycle: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["prUrl", "currentCycle", "maxCycles"],
              properties: {
                prUrl: { type: "string" },
                currentCycle: { type: "number" },
                maxCycles: { type: "number" },
              },
            },
          ],
        },
        nextAction: { type: "string" },
        ownedStatusShard: { anyOf: [{ type: "null" }, { type: "string" }] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "status",
        "summary",
        "agents",
        "closureGatePassed",
        "evidence",
        "approval",
        "blocker",
      ],
      properties: {
        kind: { type: "string", enum: ["final"] },
        status: {
          type: "string",
          enum: ["complete", "continue", "waiting_approval", "externally_blocked"],
        },
        summary: { type: "string" },
        agents: agentsSchema(),
        closureGatePassed: { type: "boolean" },
        evidence: {
          type: "object",
          additionalProperties: false,
          required: ["statusPath", "issueUrls", "prUrls", "reviewUrls"],
          properties: {
            statusPath: { type: "string" },
            issueUrls: { type: "array", items: { type: "string" } },
            prUrls: { type: "array", items: { type: "string" } },
            reviewUrls: { type: "array", items: { type: "string" } },
          },
        },
        approval: approvalSchema(),
        blocker: blockerSchema(),
      },
    },
  ],
} as const;

export function parseControlMessage(text: string): ControlMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed control message JSON: ${errorMessage(error)}`);
  }

  assertControlMessage(value);
  if (value.kind === "final") {
    validateFinalEnvelope(value);
  }
  return value;
}

export function parseControlEnvelope(text: string): ControlEnvelope {
  const value = parseControlMessage(text);
  if (value.kind !== "final") {
    throw new Error("Codex turn completed without a final control message");
  }

  return value;
}

function validateFinalEnvelope(value: ControlEnvelope): void {
  if (value.status === "complete" && !value.closureGatePassed) {
    throw new Error("Complete envelope rejected because closureGatePassed is false");
  }

  if (value.status === "waiting_approval" && value.approval === null) {
    throw new Error("waiting_approval envelope requires approval details");
  }

  if (value.status === "externally_blocked" && value.blocker === null) {
    throw new Error("externally_blocked envelope requires blocker details");
  }
}

function assertControlMessage(value: unknown): asserts value is ControlMessage {
  if (!isRecord(value)) {
    throw new Error("Control message must be an object");
  }

  if (value.kind === "checkpoint") {
    assertCheckpoint(value);
    return;
  }

  if (value.kind === "final") {
    assertEnvelope(value);
    return;
  }

  throw new Error("Control message kind must be checkpoint or final");
}

function assertCheckpoint(value: unknown): asserts value is ControlCheckpoint {
  if (!isRecord(value)) {
    throw new Error("checkpoint must be an object");
  }

  assertExactKeys(value, [
    "agents",
    "approval",
    "blocker",
    "kind",
    "nextAction",
    "outcomes",
    "ownedStatusShard",
    "reviewCycle",
    "summary",
  ]);
  assertString(value.summary, "summary");
  assertAgents(value.agents);
  assertStringArray(value.outcomes, "outcomes");
  assertApproval(value.approval);
  assertBlocker(value.blocker);
  assertReviewCycle(value.reviewCycle);
  assertString(value.nextAction, "nextAction");
  if (value.ownedStatusShard !== null) {
    assertString(value.ownedStatusShard, "ownedStatusShard");
  }
}

function assertEnvelope(value: unknown): asserts value is ControlEnvelope {
  if (!isRecord(value)) {
    throw new Error("final control message must be an object");
  }

  assertExactKeys(value, [
    "agents",
    "approval",
    "blocker",
    "closureGatePassed",
    "evidence",
    "kind",
    "status",
    "summary",
  ]);
  assertOneOf(value.status, ["complete", "continue", "waiting_approval", "externally_blocked"]);
  assertString(value.summary, "summary");
  assertAgents(value.agents);
  assertBoolean(value.closureGatePassed, "closureGatePassed");
  assertEvidence(value.evidence);
  assertApproval(value.approval);
  assertBlocker(value.blocker);
}

function assertAgents(value: unknown): asserts value is ControlEnvelope["agents"] {
  if (!isRecord(value)) {
    throw new Error("agents must be an object");
  }

  assertExactKeys(value, ["coordinator", "subagents"]);
  if (!isRecord(value.coordinator)) {
    throw new Error("agents.coordinator must be an object");
  }
  assertExactKeys(value.coordinator, ["status", "task"]);
  assertOneOf(value.coordinator.status, ["working", "waiting", "blocked", "complete"]);
  assertString(value.coordinator.task, "agents.coordinator.task");

  if (!Array.isArray(value.subagents)) {
    throw new Error("agents.subagents must be an array");
  }
  for (const [index, subagent] of value.subagents.entries()) {
    if (!isRecord(subagent)) {
      throw new Error(`agents.subagents[${index}] must be an object`);
    }
    assertExactKeys(subagent, ["name", "role", "status", "task"]);
    assertString(subagent.name, `agents.subagents[${index}].name`);
    assertString(subagent.role, `agents.subagents[${index}].role`);
    assertOneOf(subagent.status, ["running", "waiting", "blocked"]);
    assertString(subagent.task, `agents.subagents[${index}].task`);
  }
}

function assertEvidence(value: unknown): asserts value is ControlEnvelope["evidence"] {
  if (!isRecord(value)) {
    throw new Error("evidence must be an object");
  }

  assertExactKeys(value, ["issueUrls", "prUrls", "reviewUrls", "statusPath"]);
  assertString(value.statusPath, "evidence.statusPath");
  assertStringArray(value.issueUrls, "evidence.issueUrls");
  assertStringArray(value.prUrls, "evidence.prUrls");
  assertStringArray(value.reviewUrls, "evidence.reviewUrls");
}

function assertApproval(value: unknown): asserts value is ControlEnvelope["approval"] {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error("approval must be null or an object");
  }

  assertExactKeys(value, ["kind", "operation", "question", "risk"]);
  assertString(value.kind, "approval.kind");
  assertString(value.question, "approval.question");
  assertString(value.risk, "approval.risk");
  assertOperation(value.operation);
}

function assertOperation(
  value: unknown,
): asserts value is NonNullable<ControlEnvelope["approval"]>["operation"] {
  if (!isRecord(value)) {
    throw new Error("approval.operation must be an object");
  }

  assertExactKeys(value, ["action", "details", "target"]);
  assertString(value.action, "approval.operation.action");
  assertString(value.target, "approval.operation.target");
  assertString(value.details, "approval.operation.details");
}

function assertBlocker(value: unknown): asserts value is ControlEnvelope["blocker"] {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error("blocker must be null or an object");
  }

  assertExactKeys(value, ["attemptedOperation", "evidence", "kind", "message"]);
  assertString(value.kind, "blocker.kind");
  assertString(value.message, "blocker.message");
  assertString(value.attemptedOperation, "blocker.attemptedOperation");
  assertStringArray(value.evidence, "blocker.evidence");
}

function assertReviewCycle(value: unknown): asserts value is ControlCheckpoint["reviewCycle"] {
  if (value === null) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error("reviewCycle must be null or an object");
  }

  assertExactKeys(value, ["currentCycle", "maxCycles", "prUrl"]);
  assertString(value.prUrl, "reviewCycle.prUrl");
  assertNumber(value.currentCycle, "reviewCycle.currentCycle");
  assertNumber(value.maxCycles, "reviewCycle.maxCycles");
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.join("\0") !== actual.join("\0")) {
    throw new Error(`Unexpected control envelope keys: ${actual.join(", ")}`);
  }
}

function assertOneOf(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Invalid status: ${String(value)}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
}

function assertNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
