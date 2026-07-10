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
import {
  buildContinuationPrompt,
  buildInitialPrompt,
  buildRecoveryPrompt,
} from "./codex/prompt-builder.ts";
import { buildThreadOptions } from "./codex/thread-options.ts";
import { AgentloopError, CliUsageError } from "./domain/errors.ts";
import { DEFAULT_RUN_LIMITS, type RunLimits, type RunRecord, type RunUsage } from "./domain/run.ts";
import { ProductionCommandRunner } from "./infrastructure/command-runner.ts";
import { NodeFileSystem } from "./infrastructure/filesystem.ts";
import { collectProgressFingerprint } from "./infrastructure/fingerprint.ts";
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
  agentloop run --repo PATH --goal TEXT --trust-repo [--detach] [--model MODEL]
  agentloop resume RUN_ID [--message TEXT] [--accept-skill-change]
  agentloop status [RUN_ID] [--json]
  agentloop cancel RUN_ID [--reason TEXT]

Commands:
  doctor   Run read-only repository, toolchain, GitHub, SDK, and skill preflight checks.
  run      Create a durable run, or execute it immediately without --detach.
  resume   Resume a continuing, interrupted, blocked, stuck, exhausted, or failed run.
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
    case "resume":
      return await resumeCommand(commandArgs, dependencies, io);
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

  const completed = await executeRun({
    dependencies,
    firstTurnKind: "initial",
    io,
    message: null,
    run,
    store,
  });
  io.stdout(renderRun(completed));
  return EXIT_CODES.ok;
}

interface ExecuteRunInput {
  run: RunRecord;
  store: SqliteRunStore;
  dependencies: CliDependencies;
  io: CliIo;
  firstTurnKind: TurnKind;
  message: string | null;
}

type TurnKind = "initial" | "continuation" | "recovery";

async function executeRun(input: ExecuteRunInput): Promise<RunRecord> {
  const { store, dependencies, io } = input;
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  const ownerId = `${hostname()}:${process.pid}:${idGenerator.randomId()}`;
  const acquiredAt = clock.now();
  const expiresAt = new Date(acquiredAt.getTime() + input.run.limits.leaseTtlMs);
  store.acquireLease({
    acquiredAt: acquiredAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ownerId,
    repoKey: input.run.repoKey,
    runId: input.run.id,
  });

  let currentRun = input.run;
  let currentTurnKind = input.firstTurnKind;
  const heartbeat = startLeaseHeartbeat(store, input.run, ownerId, clock);
  const abortController = new AbortController();
  const signalCleanup = installSignalHandlers(abortController);

  try {
    while (true) {
      currentRun = transitionToRunningForExecution(store, currentRun, clock.now().toISOString());
      const budgetReason = budgetExhaustionReason(currentRun, clock.now());
      if (budgetReason !== null) {
        return store.transitionRun({
          expectedStatus: "running",
          id: currentRun.id,
          nextStatus: "budget_exhausted",
          now: clock.now().toISOString(),
          reason: budgetReason,
        });
      }

      currentRun = await executeSingleTurn({
        dependencies,
        io,
        message: input.message,
        run: currentRun,
        signal: abortController.signal,
        store,
        turnKind: currentTurnKind,
      });

      if (currentRun.status !== "continuing") {
        return currentRun;
      }

      currentTurnKind = "continuation";
    }
  } finally {
    signalCleanup();
    heartbeat.stop();
    store.releaseLease(input.run.repoKey, ownerId);
  }
}

interface ExecuteSingleTurnInput {
  run: RunRecord;
  store: SqliteRunStore;
  dependencies: CliDependencies;
  io: CliIo;
  turnKind: TurnKind;
  message: string | null;
  signal: AbortSignal;
}

async function executeSingleTurn(input: ExecuteSingleTurnInput): Promise<RunRecord> {
  const { run, store, dependencies, io, turnKind, signal } = input;
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  const turnId = idGenerator.randomId();
  const prompt = buildPrompt(turnKind, run, input.message);
  store.createTurn({
    fingerprintBefore: null,
    id: turnId,
    kind: turnKind,
    promptHash: sha256Hex(prompt),
    runId: run.id,
    startedAt: clock.now().toISOString(),
    status: "running",
    turnNumber: store.countTurns(run.id) + 1,
  });

  let finalText: string | null = null;
  let usage: RunUsage = zeroUsage();

  try {
    const runner = dependencies.codexRunner ?? new ProductionCodexRunner();
    const events = await runner.runStreamed({
      outputSchema: CONTROL_ENVELOPE_SCHEMA,
      prompt,
      signal,
      threadId: turnKind === "initial" ? null : run.threadId,
      threadOptions: buildThreadOptions({
        model: run.model,
        reasoningEffort: run.reasoningEffort,
        repoPath: run.repoPath,
        worktreeRoot: run.worktreeRoot,
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
          runId: run.id,
          threadId: event.thread_id,
          turnId,
        });
      } else {
        store.appendEvent({
          createdAt,
          eventType: event.type,
          itemId: eventItemId(event),
          payloadJson: eventPayloadJson(event),
          runId: run.id,
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
    const updatedRun = store.updateUsage({
      id: run.id,
      now: clock.now().toISOString(),
      usageDelta: usage,
    });
    const budgetReason = budgetExhaustionReason(updatedRun, clock.now());
    if (budgetReason !== null) {
      return store.transitionRun({
        expectedStatus: "running",
        id: updatedRun.id,
        nextStatus: "budget_exhausted",
        now: clock.now().toISOString(),
        reason: budgetReason,
      });
    }

    const fingerprint = await collectProgressFingerprint(updatedRun, dependencies);
    const unchanged =
      envelope.status === "continue" &&
      fingerprint.allSourcesAvailable &&
      updatedRun.stateFingerprint === fingerprint.hash;
    const noProgressCount = unchanged ? updatedRun.noProgressCount + 1 : 0;
    const withProgress = store.updateProgress({
      consecutiveFailures: 0,
      id: updatedRun.id,
      noProgressCount,
      now: clock.now().toISOString(),
      stateFingerprint: fingerprint.hash,
    });

    if (
      envelope.status === "continue" &&
      noProgressCount >= withProgress.limits.maxNoProgressTurns
    ) {
      return store.transitionRun({
        expectedStatus: "running",
        id: withProgress.id,
        nextStatus: "stuck",
        now: clock.now().toISOString(),
        reason: "no progress detected across continuation turns",
      });
    }

    return store.transitionRun({
      expectedStatus: "running",
      id: withProgress.id,
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
      status: signal.aborted ? "cancelled" : "failed",
      usage,
    });
    const latestRun = requireRun(store, run.id);
    store.updateProgress({
      consecutiveFailures: latestRun.consecutiveFailures + 1,
      id: latestRun.id,
      noProgressCount: latestRun.noProgressCount,
      now: clock.now().toISOString(),
      stateFingerprint: latestRun.stateFingerprint ?? "",
    });
    const failedRun = store.transitionRun({
      expectedStatus: "running",
      id: run.id,
      nextStatus: signal.aborted ? "cancelled" : "failed",
      now: clock.now().toISOString(),
      reason: message,
    });
    if (signal.aborted) {
      return failedRun;
    }

    throw error;
  }
}

function budgetExhaustionReason(run: RunRecord, now: Date): string | null {
  if (run.turnsCompleted >= run.limits.maxOuterTurns) {
    return `maximum outer turns exhausted (${run.limits.maxOuterTurns})`;
  }

  const totalNonCachedTokens =
    run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens;
  if (totalNonCachedTokens >= run.limits.maxTotalTokens) {
    return `maximum non-cached tokens exhausted (${run.limits.maxTotalTokens})`;
  }

  const elapsedMs = now.getTime() - Date.parse(run.createdAt);
  if (elapsedMs >= run.limits.maxWallDurationMs) {
    return `maximum wall duration exhausted (${run.limits.maxWallDurationMs}ms)`;
  }

  return null;
}

function startLeaseHeartbeat(
  store: SqliteRunStore,
  run: RunRecord,
  ownerId: string,
  clock: Clock,
): { stop: () => void } {
  const interval = setInterval(() => {
    const heartbeatAt = clock.now();
    const expiresAt = new Date(heartbeatAt.getTime() + run.limits.leaseTtlMs);
    store.renewLease(run.repoKey, ownerId, heartbeatAt.toISOString(), expiresAt.toISOString());
  }, run.limits.leaseRenewIntervalMs);
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
  };
}

function installSignalHandlers(abortController: AbortController): () => void {
  const abort = () => abortController.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  return () => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  };
}

function buildPrompt(turnKind: TurnKind, run: RunRecord, message: string | null): string {
  switch (turnKind) {
    case "initial":
      return buildInitialPrompt(run);
    case "continuation":
      return buildContinuationPrompt(run);
    case "recovery":
      return buildRecoveryPrompt(run, message);
  }
}

function transitionToRunningForExecution(
  store: SqliteRunStore,
  run: RunRecord,
  now: string,
): RunRecord {
  switch (run.status) {
    case "queued":
      return store.transitionRun({
        expectedStatus: "queued",
        id: run.id,
        nextStatus: "running",
        now,
        reason: "foreground run started",
      });
    case "continuing":
      return store.transitionRun({
        expectedStatus: "continuing",
        id: run.id,
        nextStatus: "running",
        now,
        reason: "continuation started",
      });
    case "running":
      return run;
    default:
      throw new CliUsageError(`Run ${run.id} with status ${run.status} cannot start a turn`);
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

async function resumeCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "accept-skill-change": { type: "boolean", default: false },
      message: { type: "string" },
    },
    strict: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(
      "Usage: agentloop resume RUN_ID [--message TEXT] [--accept-skill-change]",
    );
  }

  const store = await openRunStore(dependencies);
  const runId = parsed.positionals[0] ?? "";
  let run = requireRun(store, runId);
  if (run.status === "complete" || run.status === "cancelled" || run.status === "queued") {
    throw new CliUsageError(`Run ${run.id} with status ${run.status} cannot be resumed`);
  }

  const report = await runDoctor({ repo: run.repoPath }, dependencies);
  const exitCode = doctorExitCode(report);
  if (exitCode !== 0 || report.skillManifestHash === null) {
    io.stdout(renderDoctorText(report));
    return exitCode;
  }

  const clock = dependencies.clock ?? new SystemClock();
  if (report.skillManifestHash !== run.skillFingerprint) {
    run = transitionToContinuingForResume(store, run, clock.now().toISOString());

    if (!parsed.values["accept-skill-change"]) {
      const approvalId = (dependencies.idGenerator ?? new RandomIdGenerator()).randomId();
      store.createApproval({
        evidenceJson: JSON.stringify({
          currentFingerprint: report.skillManifestHash,
          previousFingerprint: run.skillFingerprint,
        }),
        id: approvalId,
        kind: "skill_change",
        operationJson: JSON.stringify({ acceptSkillChange: true, runId: run.id }),
        question:
          "Required skill files changed since this run started. Resume with the new skill fingerprint?",
        requestedAt: clock.now().toISOString(),
        risk: "Continuation behavior may differ from the original run because installed skills changed.",
        runId: run.id,
      });
      const waiting = store.transitionRun({
        expectedStatus: "continuing",
        id: run.id,
        nextStatus: "waiting_approval",
        now: clock.now().toISOString(),
        reason: "skill fingerprint changed",
      });
      io.stdout(renderRun(waiting));
      return 2;
    }

    run = store.updateSkillFingerprint({
      id: run.id,
      now: clock.now().toISOString(),
      skillFingerprint: report.skillManifestHash,
    });
  }

  const turnKind = determineResumeTurnKind(store, run);
  run = transitionToContinuingForResume(store, run, clock.now().toISOString());
  const completed = await executeRun({
    dependencies,
    firstTurnKind: turnKind,
    io,
    message: parsed.values.message ?? null,
    run,
    store,
  });
  io.stdout(renderRun(completed));
  return EXIT_CODES.ok;
}

function transitionToContinuingForResume(
  store: SqliteRunStore,
  run: RunRecord,
  now: string,
): RunRecord {
  switch (run.status) {
    case "continuing":
      return run;
    case "running":
      return store.transitionRun({
        expectedStatus: "running",
        id: run.id,
        nextStatus: "continuing",
        now,
        reason: "resume requested",
      });
    case "externally_blocked":
    case "stuck":
    case "budget_exhausted":
    case "failed":
      return store.transitionRun({
        expectedStatus: run.status,
        id: run.id,
        nextStatus: "continuing",
        now,
        reason: "resume requested",
      });
    default:
      throw new CliUsageError(`Run ${run.id} with status ${run.status} cannot be resumed`);
  }
}

function determineResumeTurnKind(store: SqliteRunStore, run: RunRecord): TurnKind {
  if (run.status === "continuing") {
    return "continuation";
  }

  const eventCount = store.countEvents(run.id);
  if (run.threadId === null && eventCount > 0) {
    throw new CliUsageError(
      `Run ${run.id} has SDK events but no durable thread ID; refusing unsafe resume`,
    );
  }

  return "recovery";
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

function requireRun(store: SqliteRunStore, runId: string): RunRecord {
  const run = store.getRun(runId);
  if (run === null) {
    throw new CliUsageError(`Run not found: ${runId}`);
  }

  return run;
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
  const nonCachedTokens =
    run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens;
  const remainingTurns = Math.max(0, run.limits.maxOuterTurns - run.turnsCompleted);
  const remainingTokens = Math.max(0, run.limits.maxTotalTokens - nonCachedTokens);
  return [
    `run: ${run.id}`,
    `status: ${run.status}`,
    `repo: ${run.repoPath}`,
    `objective: ${run.objective}`,
    `remainingTurns: ${remainingTurns}`,
    `remainingNonCachedTokens: ${remainingTokens}`,
    `noProgressCount: ${run.noProgressCount}`,
    `consecutiveFailures: ${run.consecutiveFailures}`,
    `created: ${run.createdAt}`,
    `updated: ${run.updatedAt}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
