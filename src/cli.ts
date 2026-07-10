#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import type { Usage } from "@openai/codex-sdk";

import { runDoctor, type DoctorDependencies } from "./application/doctor.ts";
import { resolveStateDir } from "./application/paths.ts";
import type { Clock, IdGenerator } from "./application/ports.ts";
import { CONTROL_ENVELOPE_SCHEMA, parseControlEnvelope } from "./codex/control-envelope.ts";
import { ProductionCodexRunner, type CodexRunner } from "./codex/client.ts";
import { agentMessageText, eventItemId, eventPayloadJson } from "./codex/event-mapper.ts";
import { buildInitialPrompt } from "./codex/prompt-builder.ts";
import { buildThreadOptions } from "./codex/thread-options.ts";
import { AgentloopError, CliUsageError } from "./domain/errors.ts";
import { DEFAULT_RUN_LIMITS, type RunLimits, type RunRecord, type RunUsage } from "./domain/run.ts";
import { ProductionCommandRunner } from "./infrastructure/command-runner.ts";
import { NodeFileSystem } from "./infrastructure/filesystem.ts";
import { SystemClock } from "./infrastructure/clock.ts";
import { RandomIdGenerator } from "./infrastructure/ids.ts";
import { sha256Hex } from "./infrastructure/hash.ts";
import { openDatabase } from "./infrastructure/sqlite/database.ts";
import { SqliteRunStore } from "./infrastructure/sqlite/run-store.ts";
import { doctorExitCode, EXIT_CODES } from "./presentation/exit-codes.ts";
import { renderDoctorJson } from "./presentation/json-renderer.ts";
import { renderDoctorText } from "./presentation/text-renderer.ts";

const VERSION = "0.0.0";

const HELP_TEXT = `agentloop

Usage:
  agentloop --help
  agentloop --version
  agentloop doctor --repo PATH [--json]
  agentloop run --repo PATH --goal TEXT --trust-repo --detach [--model MODEL]
  agentloop status [RUN_ID] [--json]
  agentloop cancel RUN_ID [--reason TEXT]

Commands:
  doctor   Run read-only repository, toolchain, GitHub, SDK, and skill preflight checks.
  run      Create a durable run. Step 3 supports --detach only.
  status   Show durable run status.
  cancel   Cancel a queued run.
`;

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface CliDependencies extends DoctorDependencies {
  clock?: Clock;
  codexRunner?: CodexRunner;
  idGenerator?: IdGenerator;
}

export async function runCli(
  args: readonly string[],
  dependencies = createProductionDependencies(),
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    return await runCliUnsafe(args, dependencies, io);
  } catch (error) {
    if (error instanceof AgentloopError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return EXIT_CODES.internal;
  }
}

function createProductionDependencies(): CliDependencies {
  return {
    commandRunner: new ProductionCommandRunner(),
    fileSystem: new NodeFileSystem(),
  };
}

async function runCliUnsafe(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const [command, ...commandArgs] = args;

  switch (command) {
    case "doctor":
      return await runDoctorCommand(commandArgs, dependencies, io);
    case "run":
      return await runCommand(commandArgs, dependencies, io);
    case "status":
      return await statusCommand(commandArgs, dependencies, io);
    case "cancel":
      return await cancelCommand(commandArgs, dependencies, io);
    default:
      throw new CliUsageError("Unsupported command. Run `agentloop --help`.");
  }
}

async function runDoctorCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      repo: { type: "string" },
    },
    strict: true,
  });

  const repo = parsed.values.repo;
  if (repo === undefined || repo.trim() === "") {
    throw new CliUsageError("Missing required option: --repo PATH");
  }

  const report = await runDoctor({ repo }, dependencies);
  io.stdout(parsed.values.json ? renderDoctorJson(report) : renderDoctorText(report));
  return doctorExitCode(report);
}

async function runCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      "approval-mode": { type: "string", default: "agent-approved" },
      detach: { type: "boolean", default: false },
      goal: { type: "string" },
      "max-duration": { type: "string" },
      "max-tokens": { type: "string" },
      "max-turns": { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      repo: { type: "string" },
      "trust-repo": { type: "boolean", default: false },
    },
    strict: true,
  });

  const repo = requireString(parsed.values.repo, "--repo PATH");
  const objective = requireString(parsed.values.goal, "--goal TEXT");

  if (!parsed.values["trust-repo"]) {
    throw new CliUsageError("Missing required option: --trust-repo");
  }

  if (!parsed.values.detach) {
    io.stdout("Starting foreground run. Codex events will stream below.\n");
  }

  const approvalMode = parsed.values["approval-mode"];
  if (approvalMode !== "agent-approved" && approvalMode !== "human-merge") {
    throw new CliUsageError("--approval-mode must be agent-approved or human-merge");
  }

  const report = await runDoctor({ repo }, dependencies);
  const exitCode = doctorExitCode(report);
  if (exitCode !== 0 || report.repoPath === null || report.worktreeRoot === null) {
    io.stdout(renderDoctorText(report));
    return exitCode;
  }

  const store = await openRunStore(dependencies);
  const now = (dependencies.clock ?? new SystemClock()).now().toISOString();
  const id = (dependencies.idGenerator ?? new RandomIdGenerator()).randomId();
  const limits = parseLimits(parsed.values);
  const run = store.createRun({
    id,
    repoPath: report.repoPath,
    repoKey: sha256Hex(report.repoPath),
    objective,
    objectiveHash: sha256Hex(objective),
    status: "queued",
    model: parsed.values.model ?? null,
    reasoningEffort: parsed.values.reasoning ?? null,
    approvalMode,
    worktreeRoot: report.worktreeRoot,
    skillFingerprint: requireString(report.skillManifestHash ?? undefined, "skill fingerprint"),
    limits,
    now,
  });

  if (parsed.values.detach) {
    io.stdout(`${run.id}\n`);
    return EXIT_CODES.ok;
  }

  const completed = await executeForegroundRun(run, store, dependencies, io);
  io.stdout(renderRun(completed));
  return EXIT_CODES.ok;
}

async function executeForegroundRun(
  queuedRun: RunRecord,
  store: SqliteRunStore,
  dependencies: CliDependencies,
  io: CliIo,
): Promise<RunRecord> {
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  const ownerId = `${hostname()}:${process.pid}:${idGenerator.randomId()}`;
  const acquiredAt = clock.now();
  const expiresAt = new Date(acquiredAt.getTime() + queuedRun.limits.leaseTtlMs);
  store.acquireLease({
    acquiredAt: acquiredAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ownerId,
    repoKey: queuedRun.repoKey,
    runId: queuedRun.id,
  });

  let runningRun = store.transitionRun({
    expectedStatus: "queued",
    id: queuedRun.id,
    nextStatus: "running",
    now: clock.now().toISOString(),
    reason: "foreground run started",
  });
  const turnId = idGenerator.randomId();
  const prompt = buildInitialPrompt(runningRun);
  store.createTurn({
    fingerprintBefore: null,
    id: turnId,
    kind: "initial",
    promptHash: sha256Hex(prompt),
    runId: runningRun.id,
    startedAt: clock.now().toISOString(),
    status: "running",
    turnNumber: runningRun.turnsCompleted + 1,
  });

  let finalText: string | null = null;
  let usage: RunUsage = zeroUsage();

  try {
    const runner = dependencies.codexRunner ?? new ProductionCodexRunner();
    const events = await runner.runStreamed({
      outputSchema: CONTROL_ENVELOPE_SCHEMA,
      prompt,
      threadOptions: buildThreadOptions({
        model: runningRun.model,
        reasoningEffort: runningRun.reasoningEffort,
        repoPath: runningRun.repoPath,
        worktreeRoot: runningRun.worktreeRoot,
      }),
    });

    for await (const event of events) {
      const createdAt = clock.now().toISOString();
      if (event.type === "thread.started") {
        store.recordThreadStarted({
          createdAt,
          eventType: event.type,
          itemId: null,
          payloadJson: eventPayloadJson(event),
          runId: runningRun.id,
          threadId: event.thread_id,
          turnId,
        });
      } else {
        store.appendEvent({
          createdAt,
          eventType: event.type,
          itemId: eventItemId(event),
          payloadJson: eventPayloadJson(event),
          runId: runningRun.id,
          turnId,
        });
      }

      io.stdout(`event: ${event.type}\n`);
      finalText = agentMessageText(event) ?? finalText;

      if (event.type === "turn.completed") {
        usage = mapUsage(event.usage);
      }

      if (event.type === "turn.failed" || event.type === "error") {
        throw new Error(event.type === "turn.failed" ? event.error.message : event.message);
      }
    }

    if (finalText === null) {
      throw new Error("Codex turn completed without an agent_message control envelope");
    }

    const envelope = parseControlEnvelope(finalText);
    store.completeTurn({
      errorJson: null,
      fingerprintAfter: null,
      finishedAt: clock.now().toISOString(),
      id: turnId,
      responseJson: finalText,
      status: "completed",
      usage,
    });
    runningRun = store.updateUsage({
      id: runningRun.id,
      now: clock.now().toISOString(),
      usageDelta: usage,
    });
    return store.transitionRun({
      expectedStatus: "running",
      id: runningRun.id,
      nextStatus: envelopeStatusToRunStatus(envelope.status),
      now: clock.now().toISOString(),
      reason: envelope.summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.completeTurn({
      errorJson: JSON.stringify({ message }),
      fingerprintAfter: null,
      finishedAt: clock.now().toISOString(),
      id: turnId,
      responseJson: finalText,
      status: "failed",
      usage,
    });
    store.transitionRun({
      expectedStatus: "running",
      id: runningRun.id,
      nextStatus: "failed",
      now: clock.now().toISOString(),
      reason: message,
    });
    throw error;
  } finally {
    store.releaseLease(queuedRun.repoKey, ownerId);
  }
}

function envelopeStatusToRunStatus(
  status: "complete" | "continue" | "waiting_approval" | "externally_blocked",
) {
  return status === "continue" ? "continuing" : status;
}

function mapUsage(usage: Usage): RunUsage {
  return {
    cachedInputTokens: usage.cached_input_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
}

function zeroUsage(): RunUsage {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

async function statusCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (parsed.positionals.length > 1) {
    throw new CliUsageError("Usage: agentloop status [RUN_ID] [--json]");
  }

  const store = await openRunStore(dependencies);
  const runId = parsed.positionals[0];

  if (runId === undefined) {
    const runs = store.listRuns(20);
    io.stdout(parsed.values.json ? `${JSON.stringify(runs, null, 2)}\n` : renderRunList(runs));
    return EXIT_CODES.ok;
  }

  const run = store.getRun(runId);
  if (run === null) {
    throw new CliUsageError(`Run not found: ${runId}`);
  }

  io.stdout(parsed.values.json ? `${JSON.stringify(run, null, 2)}\n` : renderRun(run));
  return EXIT_CODES.ok;
}

async function cancelCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reason: { type: "string", default: "cancelled by operator" },
    },
    strict: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: agentloop cancel RUN_ID [--reason TEXT]");
  }

  const store = await openRunStore(dependencies);
  const now = (dependencies.clock ?? new SystemClock()).now().toISOString();
  const run = store.transitionRun({
    id: parsed.positionals[0] ?? "",
    expectedStatus: "queued",
    nextStatus: "cancelled",
    reason: parsed.values.reason,
    now,
  });

  io.stdout(renderRun(run));
  return EXIT_CODES.ok;
}

async function openRunStore(dependencies: CliDependencies): Promise<SqliteRunStore> {
  const home = dependencies.homeDir ?? homedir();
  const stateDir = resolveStateDir(home, process.env);
  const database = await openDatabase({ path: join(stateDir, "agentloop.sqlite") });
  return new SqliteRunStore(database);
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`Missing required option: ${label}`);
  }

  return value;
}

function parseLimits(values: {
  "max-duration"?: string;
  "max-tokens"?: string;
  "max-turns"?: string;
}): RunLimits {
  return {
    ...DEFAULT_RUN_LIMITS,
    maxOuterTurns:
      parseOptionalPositiveInteger(values["max-turns"]) ?? DEFAULT_RUN_LIMITS.maxOuterTurns,
    maxTotalTokens:
      parseOptionalPositiveInteger(values["max-tokens"]) ?? DEFAULT_RUN_LIMITS.maxTotalTokens,
    maxWallDurationMs:
      parseOptionalDurationMs(values["max-duration"]) ?? DEFAULT_RUN_LIMITS.maxWallDurationMs,
  };
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`Expected positive integer, received: ${value}`);
  }

  return parsed;
}

function parseOptionalDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^(?<amount>\d+)(?<unit>ms|s|m|h)$/.exec(value);
  if (match?.groups === undefined) {
    throw new CliUsageError(`Expected duration like 500ms, 30s, 10m, or 8h, received: ${value}`);
  }

  const amount = Number(match.groups.amount);
  const unit = match.groups.unit;
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function renderRunList(runs: readonly RunRecord[]): string {
  if (runs.length === 0) {
    return "No runs found.\n";
  }

  return `${runs
    .map((run) => `${run.id}\t${run.status}\t${run.repoPath}\t${run.createdAt}`)
    .join("\n")}\n`;
}

function renderRun(run: RunRecord): string {
  return [
    `run: ${run.id}`,
    `status: ${run.status}`,
    `repo: ${run.repoPath}`,
    `objective: ${run.objective}`,
    `created: ${run.createdAt}`,
    `updated: ${run.updatedAt}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
