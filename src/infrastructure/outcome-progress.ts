import type { CommandRunner } from "../application/ports.ts";
import type { RunRecord } from "../domain/run.ts";
import { sha256Hex } from "./hash.ts";

export type OutcomeSourceStatus = "available" | "failed" | "timed_out";

export interface OutcomeSourceState {
  name: string;
  status: OutcomeSourceStatus;
  value: string;
}

export interface OutcomeCandidate {
  key: string;
  type: string;
  payload: unknown;
}

export interface OutcomeObservation {
  allSourcesAvailable: boolean;
  diagnosticHash: string;
  outcomes: OutcomeCandidate[];
  sources: OutcomeSourceState[];
}

export async function collectOutcomeProgress(
  run: RunRecord,
  dependencies: { commandRunner: CommandRunner },
): Promise<OutcomeObservation> {
  const sources = [
    await gitHeadSource(run, dependencies.commandRunner),
    await ghJsonSource(
      "gh-issues",
      ["issue", "list", "--state", "all", "--limit", "100", "--json", "number,state,closedAt"],
      run,
      dependencies.commandRunner,
    ),
    await ghJsonSource(
      "gh-prs",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        "number,state,headRefName,headRefOid,isDraft,reviewDecision,mergeStateStatus",
      ],
      run,
      dependencies.commandRunner,
    ),
  ];
  const outcomes = sources.flatMap(outcomesFromSource);
  const normalized = JSON.stringify({
    outcomes: outcomes.map((outcome) => outcome.key).sort(),
    sources: sources.map((source) => ({
      name: source.name,
      status: source.status,
      value: source.value.replace(/\r\n/g, "\n"),
    })),
  });

  return {
    allSourcesAvailable: sources.every((source) => source.status === "available"),
    diagnosticHash: sha256Hex(normalized),
    outcomes,
    sources,
  };
}

async function gitHeadSource(
  run: RunRecord,
  commandRunner: CommandRunner,
): Promise<OutcomeSourceState> {
  const result = await commandRunner.run("git", ["rev-parse", "HEAD"], {
    cwd: run.repoPath,
    timeoutMs: 10_000,
  });
  if (result.exitCode === 124) {
    return { name: "git-head", status: "timed_out", value: result.stderr };
  }

  if (result.exitCode !== 0) {
    return { name: "git-head", status: "failed", value: result.stderr || result.stdout };
  }

  return { name: "git-head", status: "available", value: result.stdout.trim() };
}

async function ghJsonSource(
  name: string,
  args: readonly string[],
  run: RunRecord,
  commandRunner: CommandRunner,
): Promise<OutcomeSourceState> {
  const result = await commandRunner.run("gh", args, { cwd: run.repoPath, timeoutMs: 10_000 });
  if (result.exitCode === 124) {
    return { name, status: "timed_out", value: result.stderr };
  }

  if (result.exitCode !== 0) {
    return { name, status: "failed", value: result.stderr || result.stdout };
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown[];
    return { name, status: "available", value: JSON.stringify(sortJsonArray(parsed)) };
  } catch {
    return { name, status: "available", value: result.stdout };
  }
}

function outcomesFromSource(source: OutcomeSourceState): OutcomeCandidate[] {
  if (source.status !== "available") {
    return [];
  }

  switch (source.name) {
    case "git-head": {
      return source.value === ""
        ? []
        : [
            {
              key: `git-head:${source.value}`,
              payload: { sha: source.value },
              type: "git_head",
            },
          ];
    }
    case "gh-issues":
      return jsonArray(source.value).flatMap(issueOutcome);
    case "gh-prs":
      return jsonArray(source.value).flatMap(prOutcome);
    default:
      return [];
  }
}

function issueOutcome(value: unknown): OutcomeCandidate[] {
  if (!isRecord(value) || typeof value.number !== "number" || typeof value.state !== "string") {
    return [];
  }

  if (value.state.toUpperCase() !== "CLOSED") {
    return [];
  }

  return [
    {
      key: `issue:${value.number}:closed`,
      payload: { number: value.number, state: value.state },
      type: "issue_closed",
    },
  ];
}

function prOutcome(value: unknown): OutcomeCandidate[] {
  if (!isRecord(value) || typeof value.number !== "number") {
    return [];
  }

  const state = typeof value.state === "string" ? value.state : "unknown";
  const head =
    typeof value.headRefOid === "string" && value.headRefOid !== ""
      ? value.headRefOid
      : typeof value.headRefName === "string"
        ? value.headRefName
        : "unknown";
  const review = typeof value.reviewDecision === "string" ? value.reviewDecision : "none";
  return [
    {
      key: `pr:${value.number}:${state}:${head}:${review}`,
      payload: { head, number: value.number, reviewDecision: review, state },
      type: "pr_state",
    },
  ];
}

function jsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sortJsonArray(value: unknown[]): unknown[] {
  return [...value].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
