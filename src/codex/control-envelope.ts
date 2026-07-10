export interface ControlEnvelope {
  status: "complete" | "continue" | "waiting_approval" | "externally_blocked";
  summary: string;
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

export const CONTROL_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "closureGatePassed", "evidence", "approval", "blocker"],
  properties: {
    status: {
      type: "string",
      enum: ["complete", "continue", "waiting_approval", "externally_blocked"],
    },
    summary: { type: "string" },
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
    approval: {
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
    },
    blocker: {
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
    },
  },
} as const;

export function parseControlEnvelope(text: string): ControlEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed control envelope JSON: ${errorMessage(error)}`);
  }

  assertEnvelope(value);

  if (value.status === "complete" && !value.closureGatePassed) {
    throw new Error("Complete envelope rejected because closureGatePassed is false");
  }

  if (value.status === "waiting_approval" && value.approval === null) {
    throw new Error("waiting_approval envelope requires approval details");
  }

  if (value.status === "externally_blocked" && value.blocker === null) {
    throw new Error("externally_blocked envelope requires blocker details");
  }

  return value;
}

function assertEnvelope(value: unknown): asserts value is ControlEnvelope {
  if (!isRecord(value)) {
    throw new Error("Control envelope must be an object");
  }

  assertExactKeys(value, [
    "approval",
    "blocker",
    "closureGatePassed",
    "evidence",
    "status",
    "summary",
  ]);
  assertOneOf(value.status, ["complete", "continue", "waiting_approval", "externally_blocked"]);
  assertString(value.summary, "summary");
  assertBoolean(value.closureGatePassed, "closureGatePassed");
  assertEvidence(value.evidence);
  assertApproval(value.approval);
  assertBlocker(value.blocker);
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
