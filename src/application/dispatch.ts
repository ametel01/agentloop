import type { CommandRunner } from "./ports.ts";
import { AgentloopError } from "../domain/errors.ts";

export const DISPATCH_LABELS = {
  blocked: "agentloop:blocked",
  ready: "agentloop:ready",
  running: "agentloop:running",
} as const;

export const DISPATCH_PROTOCOL_LABELS = [
  DISPATCH_LABELS.ready,
  DISPATCH_LABELS.running,
  DISPATCH_LABELS.blocked,
] as const;

export const DEFAULT_READY_ISSUE_LIMIT = 100;
export const DISPATCH_SCOPE_MARKER = "agentloop-dispatch-v1";

const GITHUB_TIMEOUT_MS = 10_000;

export interface DispatchIssue {
  number: number;
  url: string;
}

export interface DispatchDiscovery {
  issueNumbers: number[];
  issues: DispatchIssue[];
}

export interface DiscoverReadyIssuesOptions {
  commandRunner: CommandRunner;
  repoPath: string;
  limit?: number;
}

export class DispatchDiscoveryError extends AgentloopError {
  constructor(message: string) {
    super(message, 64);
    this.name = "DispatchDiscoveryError";
  }
}

export async function discoverReadyIssues(
  options: DiscoverReadyIssuesOptions,
): Promise<DispatchDiscovery> {
  const limit = options.limit ?? DEFAULT_READY_ISSUE_LIMIT;
  validateLimit(limit);

  await assertProtocolLabelsExist(options.commandRunner, options.repoPath);

  const result = await options.commandRunner.run(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      DISPATCH_LABELS.ready,
      "--json",
      "number,url",
      "--limit",
      String(limit),
    ],
    { cwd: options.repoPath, timeoutMs: GITHUB_TIMEOUT_MS },
  );

  if (result.exitCode !== 0) {
    throw new DispatchDiscoveryError(
      `Failed to list open ${DISPATCH_LABELS.ready} issues: ${firstFailureLine(result)}`,
    );
  }

  const rawIssues = parseJsonArray(result.stdout, "ready issue list");
  if (rawIssues.length >= limit) {
    throw new DispatchDiscoveryError(
      `Ready issue discovery reached the configured cap (${limit}); raise the cap or reduce ${DISPATCH_LABELS.ready} issues before dispatching.`,
    );
  }

  const issues = normalizeIssues(rawIssues);

  return {
    issueNumbers: issues.map((issue) => issue.number),
    issues,
  };
}

export function buildDispatchObjective(issues: readonly DispatchIssue[]): string {
  const lines = [
    "Run the installed $codex-dev-team-goal workflow for the exact label-scoped issue set below.",
    `Scope marker: ${DISPATCH_SCOPE_MARKER}`,
    "",
    "Dispatched issues:",
    ...issues.map((issue) => `- #${issue.number} ${issue.url}`),
    "",
    "Do not implement or mutate issues outside this dispatched set except to inspect linked blockers or existing PR state for routing.",
  ];

  return lines.join("\n");
}

async function assertProtocolLabelsExist(commandRunner: CommandRunner, repoPath: string) {
  const result = await commandRunner.run(
    "gh",
    ["label", "list", "--json", "name", "--limit", "1000"],
    { cwd: repoPath, timeoutMs: GITHUB_TIMEOUT_MS },
  );

  if (result.exitCode !== 0) {
    throw new DispatchDiscoveryError(`Failed to list GitHub labels: ${firstFailureLine(result)}`);
  }

  const labels = parseJsonArray(result.stdout, "label list");
  const names = new Set(labels.map((label, index) => labelName(label, index)));
  const missing = DISPATCH_PROTOCOL_LABELS.filter((label) => !names.has(label));

  if (missing.length > 0) {
    throw new DispatchDiscoveryError(
      [
        `Missing required GitHub protocol labels: ${missing.join(", ")}.`,
        "Create them before dispatching:",
        ...missing.map((label) => `gh label create ${label}`),
      ].join("\n"),
    );
  }
}

function parseJsonArray(stdout: string, description: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new DispatchDiscoveryError(
      `Malformed GitHub ${description} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new DispatchDiscoveryError(`Malformed GitHub ${description} JSON: expected an array.`);
  }

  return parsed;
}

function labelName(value: unknown, index: number): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.trim() === ""
  ) {
    throw new DispatchDiscoveryError(`Malformed GitHub label record at index ${index}.`);
  }

  return value.name;
}

function normalizeIssues(values: readonly unknown[]): DispatchIssue[] {
  const byNumber = new Map<number, DispatchIssue>();

  for (const [index, value] of values.entries()) {
    const issue = normalizeIssue(value, index);
    byNumber.set(issue.number, issue);
  }

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

function normalizeIssue(value: unknown, index: number): DispatchIssue {
  if (typeof value !== "object" || value === null) {
    throw new DispatchDiscoveryError(`Malformed GitHub issue record at index ${index}.`);
  }

  const issueNumber = "number" in value ? value.number : undefined;
  const url = "url" in value ? value.url : undefined;

  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new DispatchDiscoveryError(
      `Malformed GitHub issue record at index ${index}: number must be a positive integer.`,
    );
  }

  if (typeof url !== "string" || url.trim() === "") {
    throw new DispatchDiscoveryError(
      `Malformed GitHub issue record at index ${index}: url must be a non-empty string.`,
    );
  }

  return {
    number: issueNumber,
    url: normalizeGithubUrl(url, issueNumber, index),
  };
}

function normalizeGithubUrl(url: string, issueNumber: number, index: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DispatchDiscoveryError(
      `Malformed GitHub issue record at index ${index}: url is not valid.`,
    );
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new DispatchDiscoveryError(
      `Malformed GitHub issue record at index ${index}: url must be a GitHub HTTPS URL.`,
    );
  }

  if (!parsed.pathname.endsWith(`/issues/${issueNumber}`)) {
    throw new DispatchDiscoveryError(
      `Malformed GitHub issue record at index ${index}: url does not match issue number ${issueNumber}.`,
    );
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DispatchDiscoveryError("Ready issue discovery limit must be a positive integer.");
  }
}

function firstFailureLine(result: { stdout: string; stderr: string }): string {
  const output = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

  return output ?? "unknown GitHub CLI failure";
}
