#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import type { Usage } from "@openai/codex-sdk";

import { runDoctor, type DoctorDependencies } from "./application/doctor.ts";
import { buildDispatchObjective, discoverReadyIssues } from "./application/dispatch.ts";
import { resolveStateDir } from "./application/paths.ts";
import type { Clock, IdGenerator } from "./application/ports.ts";
import { CONTROL_ENVELOPE_SCHEMA, parseControlEnvelope } from "./codex/control-envelope.ts";
import { ProductionCodexRunner, type CodexRunner } from "./codex/client.ts";
import { agentMessageText, eventItemId, eventPayloadJson } from "./codex/event-mapper.ts";
import {
  buildApprovalResponsePrompt,
  buildContinuationPrompt,
  buildInitialPrompt,
  buildRecoveryPrompt,
} from "./codex/prompt-builder.ts";
import { redactJson, redactText } from "./codex/redaction.ts";
import { buildThreadOptions } from "./codex/thread-options.ts";
import { AgentloopError, CliUsageError, OpenRunConflictError } from "./domain/errors.ts";
import {
  DEFAULT_RUN_LIMITS,
  type ApprovalRequest,
  type EventRecord,
  type LeaseRecord,
  type RunLimits,
  type RunRecord,
  type RunUsage,
  type TurnRecord,
} from "./domain/run.ts";
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
  agentloop dispatch --repo PATH --trust-repo [--dry-run] [--json]
  agentloop run --repo PATH --goal TEXT --trust-repo [--detach] [--model MODEL]
  agentloop resume RUN_ID [--message TEXT] [--accept-skill-change]
  agentloop approve RUN_ID --message TEXT
  agentloop reject RUN_ID --message TEXT
  agentloop worker [--once] [--poll-interval DURATION]
  agentloop events RUN_ID [--follow] [--json]
  agentloop status [RUN_ID] [--json]
  agentloop cancel RUN_ID [--reason TEXT]

Commands:
  doctor   Run read-only repository, toolchain, GitHub, SDK, and skill preflight checks.
  dispatch Queue one repository-level run for open issues labeled agentloop:ready.
  run      Create a durable run, or execute it immediately without --detach.
  resume   Resume a continuing, interrupted, blocked, stuck, exhausted, or failed run.
  approve  Approve one pending durable human approval and resume the run.
  reject   Reject one pending durable human approval and cancel the run.
  worker   Claim queued or expired recoverable runs and execute them.
  events   Replay persisted run events in order.
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
      io.stderr(`${redactText(error.message)}\n`);
      return error.exitCode;
    }

    const message = redactText(error instanceof Error ? error.message : String(error));
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
    case "dispatch":
      return await dispatchCommand(commandArgs, dependencies, io);
    case "run":
      return await runCommand(commandArgs, dependencies, io);
    case "resume":
      return await resumeCommand(commandArgs, dependencies, io);
    case "approve":
      return await approveCommand(commandArgs, dependencies, io);
    case "reject":
      return await rejectCommand(commandArgs, dependencies, io);
    case "worker":
      return await workerCommand(commandArgs, dependencies, io);
    case "events":
      return await eventsCommand(commandArgs, dependencies, io);
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
  const run = createQueuedRun({
    approvalMode,
    dependencies,
    model: parsed.values.model ?? null,
    objective,
    reasoningEffort: parsed.values.reasoning ?? null,
    report: {
      repoPath: report.repoPath,
      skillManifestHash: report.skillManifestHash,
      worktreeRoot: report.worktreeRoot,
    },
    store,
    limits: parseLimits(parsed.values),
  });

  if (parsed.values.detach) {
    io.stdout(`${run.id}\n`);
    return EXIT_CODES.ok;
  }

  const completed = await executeRun({
    approvalId: null,
    dependencies,
    firstTurnKind: "initial",
    io,
    leaseOwnerId: null,
    message: null,
    run,
    store,
  });
  io.stdout(renderRun(completed, store.listPendingApprovals(completed.id)));
  return EXIT_CODES.ok;
}

async function dispatchCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      "approval-mode": { type: "string", default: "agent-approved" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
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
  if (!parsed.values["trust-repo"]) {
    throw new CliUsageError("Missing required option: --trust-repo");
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

  const discovery = await discoverReadyIssues({
    commandRunner: dependencies.commandRunner,
    repoPath: report.repoPath,
  });

  if (discovery.issues.length === 0) {
    io.stdout(
      renderDispatchOutcome(
        {
          issueNumbers: [],
          repoPath: report.repoPath,
          runId: null,
          status: "no_ready_issues",
        },
        parsed.values.json,
      ),
    );
    return EXIT_CODES.ok;
  }

  if (parsed.values["dry-run"]) {
    io.stdout(
      renderDispatchOutcome(
        {
          issueNumbers: discovery.issueNumbers,
          repoPath: report.repoPath,
          runId: null,
          status: "dry_run",
        },
        parsed.values.json,
      ),
    );
    return EXIT_CODES.ok;
  }

  const repoKey = sha256Hex(report.repoPath);
  const store = await openRunStore(dependencies);
  const existing = store.getOpenRunByRepoKey(repoKey);
  if (existing !== null) {
    io.stdout(
      renderDispatchOutcome(
        {
          issueNumbers: discovery.issueNumbers,
          repoPath: report.repoPath,
          runId: existing.id,
          status: "already_active",
        },
        parsed.values.json,
      ),
    );
    return EXIT_CODES.ok;
  }

  try {
    const run = createQueuedRun({
      approvalMode,
      dependencies,
      model: parsed.values.model ?? null,
      objective: buildDispatchObjective(discovery.issues),
      reasoningEffort: parsed.values.reasoning ?? null,
      report: {
        repoPath: report.repoPath,
        skillManifestHash: report.skillManifestHash,
        worktreeRoot: report.worktreeRoot,
      },
      store,
      limits: parseLimits(parsed.values),
    });

    io.stdout(
      renderDispatchOutcome(
        {
          issueNumbers: discovery.issueNumbers,
          repoPath: report.repoPath,
          runId: run.id,
          status: "queued",
        },
        parsed.values.json,
      ),
    );
    return EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof OpenRunConflictError) {
      io.stdout(
        renderDispatchOutcome(
          {
            issueNumbers: discovery.issueNumbers,
            repoPath: report.repoPath,
            runId: error.existingRunId,
            status: "already_active",
          },
          parsed.values.json,
        ),
      );
      return EXIT_CODES.ok;
    }

    throw error;
  }
}

interface ExecuteRunInput {
  run: RunRecord;
  store: SqliteRunStore;
  dependencies: CliDependencies;
  io: CliIo;
  firstTurnKind: TurnKind;
  message: string | null;
  approvalId: string | null;
  leaseOwnerId: string | null;
}

type TurnKind = "initial" | "continuation" | "recovery" | "approval-response";

interface QueuedRunContext {
  repoPath: string | null;
  skillManifestHash: string | null;
  worktreeRoot: string | null;
}

interface CreateQueuedRunInput {
  approvalMode: "agent-approved" | "human-merge";
  dependencies: CliDependencies;
  limits: RunLimits;
  model: string | null;
  objective: string;
  reasoningEffort: string | null;
  report: QueuedRunContext;
  store: SqliteRunStore;
}

function createQueuedRun(input: CreateQueuedRunInput): RunRecord {
  const now = (input.dependencies.clock ?? new SystemClock()).now().toISOString();
  const id = (input.dependencies.idGenerator ?? new RandomIdGenerator()).randomId();
  const repoPath = requireString(input.report.repoPath ?? undefined, "repo path");
  const worktreeRoot = requireString(input.report.worktreeRoot ?? undefined, "worktree root");
  const skillFingerprint = requireString(
    input.report.skillManifestHash ?? undefined,
    "skill fingerprint",
  );

  return input.store.createRun({
    approvalMode: input.approvalMode,
    id,
    limits: input.limits,
    model: input.model,
    now,
    objective: input.objective,
    objectiveHash: sha256Hex(input.objective),
    reasoningEffort: input.reasoningEffort,
    repoKey: sha256Hex(repoPath),
    repoPath,
    skillFingerprint,
    status: "queued",
    worktreeRoot,
  });
}

async function executeRun(input: ExecuteRunInput): Promise<RunRecord> {
  const { store, dependencies, io } = input;
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  const ownerId = input.leaseOwnerId ?? `${hostname()}:${process.pid}:${idGenerator.randomId()}`;
  if (input.leaseOwnerId === null) {
    const acquiredAt = clock.now();
    const expiresAt = new Date(acquiredAt.getTime() + input.run.limits.leaseTtlMs);
    store.acquireLease({
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ownerId,
      repoKey: input.run.repoKey,
      runId: input.run.id,
    });
  }

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
        approvalId: input.approvalId,
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
  approvalId: string | null;
}

async function executeSingleTurn(input: ExecuteSingleTurnInput): Promise<RunRecord> {
  const { run, store, dependencies, io, turnKind, signal } = input;
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  const turnId = idGenerator.randomId();
  const prompt = buildPrompt(turnKind, run, input.message, input.approvalId);
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
      responseJson: redactText(finalText),
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

    if (envelope.status === "waiting_approval") {
      if (envelope.approval === null) {
        throw new Error("waiting_approval envelope missing approval details");
      }

      store.createApproval({
        evidenceJson: redactJson(envelope.evidence),
        id: idGenerator.randomId(),
        kind: envelope.approval.kind,
        operationJson: redactJson(envelope.approval.operation),
        question: redactText(envelope.approval.question),
        requestedAt: clock.now().toISOString(),
        risk: redactText(envelope.approval.risk),
        runId: updatedRun.id,
      });
      return store.transitionRun({
        expectedStatus: "running",
        id: updatedRun.id,
        nextStatus: "waiting_approval",
        now: clock.now().toISOString(),
        reason: redactText(envelope.summary),
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
      reason: redactText(envelope.summary),
    });
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
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

    throw new Error(message);
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

function buildPrompt(
  turnKind: TurnKind,
  run: RunRecord,
  message: string | null,
  approvalId: string | null,
): string {
  switch (turnKind) {
    case "initial":
      return buildInitialPrompt(run);
    case "continuation":
      return buildContinuationPrompt(run);
    case "recovery":
      return buildRecoveryPrompt(run, message);
    case "approval-response":
      return buildApprovalResponsePrompt(
        run,
        requireString(approvalId ?? undefined, "approval ID"),
        requireString(message ?? undefined, "approval response"),
      );
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
      io.stdout(renderRun(waiting, store.listPendingApprovals(waiting.id)));
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
    approvalId: null,
    dependencies,
    firstTurnKind: turnKind,
    io,
    leaseOwnerId: null,
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

async function approveCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      message: { type: "string" },
    },
    strict: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: agentloop approve RUN_ID --message TEXT");
  }

  const message = requireString(parsed.values.message, "--message TEXT");
  const store = await openRunStore(dependencies);
  let run = requireRun(store, parsed.positionals[0] ?? "");
  if (run.status !== "waiting_approval") {
    throw new CliUsageError(`Run ${run.id} is not waiting for approval`);
  }

  const approval = exactlyOnePendingApproval(store, run.id);
  const clock = dependencies.clock ?? new SystemClock();
  const resolved = store.resolveApproval({
    id: approval.id,
    resolvedAt: clock.now().toISOString(),
    response: redactText(message),
    status: "approved",
  });

  const currentFingerprint = currentFingerprintFromApproval(resolved);
  if (resolved.kind === "skill_change" && currentFingerprint !== null) {
    run = store.updateSkillFingerprint({
      id: run.id,
      now: clock.now().toISOString(),
      skillFingerprint: currentFingerprint,
    });
  }

  run = store.transitionRun({
    expectedStatus: "waiting_approval",
    id: run.id,
    nextStatus: "continuing",
    now: clock.now().toISOString(),
    reason: `approval ${approval.id} approved`,
  });
  const completed = await executeRun({
    approvalId: approval.id,
    dependencies,
    firstTurnKind: "approval-response",
    io,
    leaseOwnerId: null,
    message,
    run,
    store,
  });
  io.stdout(renderRun(completed, store.listPendingApprovals(completed.id)));
  return EXIT_CODES.ok;
}

async function rejectCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      message: { type: "string" },
    },
    strict: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: agentloop reject RUN_ID --message TEXT");
  }

  const message = requireString(parsed.values.message, "--message TEXT");
  const store = await openRunStore(dependencies);
  const run = requireRun(store, parsed.positionals[0] ?? "");
  if (run.status !== "waiting_approval") {
    throw new CliUsageError(`Run ${run.id} is not waiting for approval`);
  }

  const approval = exactlyOnePendingApproval(store, run.id);
  const clock = dependencies.clock ?? new SystemClock();
  store.resolveApproval({
    id: approval.id,
    resolvedAt: clock.now().toISOString(),
    response: redactText(message),
    status: "rejected",
  });
  const cancelled = store.transitionRun({
    expectedStatus: "waiting_approval",
    id: run.id,
    nextStatus: "cancelled",
    now: clock.now().toISOString(),
    reason: `approval ${approval.id} rejected`,
  });
  io.stdout(renderRun(cancelled, store.listPendingApprovals(cancelled.id)));
  return EXIT_CODES.ok;
}

async function workerCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      once: { type: "boolean", default: false },
      "poll-interval": { type: "string", default: "5s" },
    },
    strict: true,
  });

  const pollIntervalMs = parseOptionalDurationMs(parsed.values["poll-interval"]) ?? 5_000;
  const store = await openRunStore(dependencies);
  const clock = dependencies.clock ?? new SystemClock();
  const idGenerator = dependencies.idGenerator ?? new RandomIdGenerator();
  let shuttingDown = false;
  const stop = () => {
    shuttingDown = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!shuttingDown) {
      const ownerId = `${hostname()}:${process.pid}:${idGenerator.randomId()}`;
      const now = clock.now();
      const claim = claimWorkerRun(store, ownerId, now.toISOString());

      if (claim !== null) {
        io.stdout(`claimed: ${claim.run.id}\n`);
        await executeRun({
          approvalId: null,
          dependencies,
          firstTurnKind: claim.turnKind,
          io,
          leaseOwnerId: ownerId,
          message: null,
          run: claim.run,
          store,
        });

        if (parsed.values.once) {
          return EXIT_CODES.ok;
        }
      } else if (parsed.values.once) {
        return EXIT_CODES.ok;
      } else {
        await sleep(pollIntervalMs);
      }
    }

    return EXIT_CODES.ok;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function claimWorkerRun(
  store: SqliteRunStore,
  ownerId: string,
  now: string,
): { run: RunRecord; turnKind: TurnKind } | null {
  const queued = store.claimOldestQueued({ now, ownerId });
  if (queued !== null) {
    return { run: queued, turnKind: "initial" };
  }

  const expired = store.claimExpiredActive({ now, ownerId });
  if (expired !== null) {
    return { run: expired, turnKind: "recovery" };
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventsCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: agentloop events RUN_ID [--follow] [--json]");
  }

  const store = await openRunStore(dependencies);
  const runId = parsed.positionals[0] ?? "";
  requireRun(store, runId);

  let afterSequence = 0;
  let shuttingDown = false;
  let stopPolling = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopPolling = resolve;
  });
  const stop = () => {
    shuttingDown = true;
    stopPolling();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!shuttingDown) {
      const events = store.listEvents(runId, afterSequence, 100);
      for (const event of events) {
        io.stdout(parsed.values.json ? `${renderEventJson(event)}\n` : renderEventText(event));
        afterSequence = event.sequence;
      }

      if (!parsed.values.follow) {
        return EXIT_CODES.ok;
      }

      if (events.length === 0) {
        await Promise.race([sleep(250), stopped]);
      }
    }

    return EXIT_CODES.ok;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function exactlyOnePendingApproval(store: SqliteRunStore, runId: string): ApprovalRequest {
  const approvals = store.listPendingApprovals(runId);
  if (approvals.length !== 1) {
    throw new CliUsageError(
      `Expected exactly one pending approval for ${runId}, found ${approvals.length}`,
    );
  }

  return approvals[0] as ApprovalRequest;
}

function currentFingerprintFromApproval(approval: ApprovalRequest): string | null {
  if (
    typeof approval.evidence === "object" &&
    approval.evidence !== null &&
    "currentFingerprint" in approval.evidence &&
    typeof approval.evidence.currentFingerprint === "string"
  ) {
    return approval.evidence.currentFingerprint;
  }

  return null;
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

  const status = buildRunStatus(store, run, dependencies.clock ?? new SystemClock());
  io.stdout(parsed.values.json ? `${JSON.stringify(status, null, 2)}\n` : renderRunStatus(status));
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

  io.stdout(renderRun(run, store.listPendingApprovals(run.id)));
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

type DispatchStatus = "already_active" | "dry_run" | "no_ready_issues" | "queued";

interface DispatchOutcome {
  status: DispatchStatus;
  runId: string | null;
  repoPath: string;
  issueNumbers: number[];
}

function renderDispatchOutcome(outcome: DispatchOutcome, json: boolean): string {
  if (json) {
    return `${JSON.stringify(outcome, null, 2)}\n`;
  }

  const issueText =
    outcome.issueNumbers.length === 0
      ? "none"
      : outcome.issueNumbers.map((number) => `#${number}`).join(", ");

  return [
    `dispatch: ${outcome.status}`,
    `run: ${outcome.runId ?? "none"}`,
    `repo: ${outcome.repoPath}`,
    `issues: ${issueText}`,
    "",
  ].join("\n");
}

function renderRunList(runs: readonly RunRecord[]): string {
  if (runs.length === 0) {
    return "No runs found.\n";
  }

  return `${runs
    .map((run) => `${run.id}\t${run.status}\t${run.repoPath}\t${run.createdAt}`)
    .join("\n")}\n`;
}

interface RunStatusDocument extends RunRecord {
  pendingApprovals: ApprovalRequest[];
  turns: TurnRecord[];
  lease: LeaseRecord | null;
  heartbeatAgeMs: number | null;
  latestBlocker: unknown;
}

function buildRunStatus(store: SqliteRunStore, run: RunRecord, clock: Clock): RunStatusDocument {
  const lease = store.getLeaseForRun(run.id);
  return {
    ...run,
    heartbeatAgeMs:
      lease === null ? null : Math.max(0, clock.now().getTime() - Date.parse(lease.heartbeatAt)),
    latestBlocker: latestBlocker(store.listTurns(run.id)),
    lease,
    pendingApprovals: store.listPendingApprovals(run.id),
    turns: store.listTurns(run.id),
  };
}

function renderRunStatus(status: RunStatusDocument): string {
  const lines = [
    `run: ${status.id}`,
    `status: ${status.status}`,
    `harness.status: ${status.status}`,
    `repo: ${status.repoPath}`,
    `objective: ${status.objective}`,
    `thread: ${status.threadId ?? "none"}`,
    `usage.inputTokens: ${status.usage.inputTokens}`,
    `usage.cachedInputTokens: ${status.usage.cachedInputTokens}`,
    `usage.outputTokens: ${status.usage.outputTokens}`,
    `usage.reasoningTokens: ${status.usage.reasoningTokens}`,
    `stateFingerprint: ${status.stateFingerprint ?? "none"}`,
    `noProgressCount: ${status.noProgressCount}`,
    `consecutiveFailures: ${status.consecutiveFailures}`,
    `lastError: ${status.lastError ?? "none"}`,
    `latestBlocker: ${status.latestBlocker === null ? "none" : JSON.stringify(status.latestBlocker)}`,
    `lease.owner: ${status.lease?.ownerId ?? "none"}`,
    `lease.expiresAt: ${status.lease?.expiresAt ?? "none"}`,
    `lease.heartbeatAgeMs: ${status.heartbeatAgeMs ?? "none"}`,
    `created: ${status.createdAt}`,
    `updated: ${status.updatedAt}`,
  ];

  for (const turn of status.turns) {
    lines.push(
      `turn: ${turn.turnNumber}`,
      `turn.id: ${turn.id}`,
      `turn.kind: ${turn.kind}`,
      `turn.status: ${turn.status}`,
      `turn.usage: input=${turn.usage.inputTokens} cached=${turn.usage.cachedInputTokens} output=${turn.usage.outputTokens} reasoning=${turn.usage.reasoningTokens}`,
    );
  }

  for (const approval of status.pendingApprovals) {
    lines.push(
      `pendingApproval: ${approval.id}`,
      `approvalKind: ${approval.kind}`,
      `approvalQuestion: ${approval.question}`,
      `approvalRisk: ${approval.risk}`,
      `approvalOperation: ${JSON.stringify(approval.operation)}`,
      `approvalEvidence: ${JSON.stringify(approval.evidence)}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function renderRun(run: RunRecord, pendingApprovals: readonly ApprovalRequest[] = []): string {
  const nonCachedTokens =
    run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens;
  const remainingTurns = Math.max(0, run.limits.maxOuterTurns - run.turnsCompleted);
  const remainingTokens = Math.max(0, run.limits.maxTotalTokens - nonCachedTokens);
  const lines = [
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
  ];

  for (const approval of pendingApprovals) {
    lines.push(
      `pendingApproval: ${approval.id}`,
      `approvalKind: ${approval.kind}`,
      `approvalQuestion: ${approval.question}`,
      `approvalRisk: ${approval.risk}`,
      `approvalOperation: ${JSON.stringify(approval.operation)}`,
      `approvalEvidence: ${JSON.stringify(approval.evidence)}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function latestBlocker(turns: readonly TurnRecord[]): unknown {
  for (const turn of [...turns].reverse()) {
    if (turn.responseJson === null) {
      continue;
    }

    const parsed = parseJsonObject(turn.responseJson);
    if (parsed !== null && "blocker" in parsed) {
      return parsed.blocker;
    }
  }

  return null;
}

function renderEventJson(event: EventRecord): string {
  return JSON.stringify({
    ...event,
    payload: parseJsonObject(event.payloadJson) ?? event.payloadJson,
  });
}

function renderEventText(event: EventRecord): string {
  const payload = parseJsonObject(event.payloadJson);
  const prefix = `${event.sequence}\t${event.createdAt}`;
  if (event.eventType === "thread.started") {
    return `${prefix}\tharness: thread.started thread=${stringField(payload, "thread_id") ?? "unknown"}\n`;
  }

  if (event.eventType === "turn.completed") {
    const usage = objectField(payload, "usage");
    return `${prefix}\tharness: turn.completed usage=${formatUsagePayload(usage)}\n`;
  }

  if (event.eventType === "turn.failed" || event.eventType === "error") {
    return `${prefix}\tharness: ${event.eventType} error=${errorText(payload)}\n`;
  }

  if (event.eventType === "item.completed") {
    const item = objectField(payload, "item");
    const itemType = stringField(item, "type") ?? "unknown";
    const label = itemTypeLabel(itemType);
    return `${prefix}\tmodel: ${label} item=${event.itemId ?? "none"} ${itemText(item)}\n`;
  }

  return `${prefix}\tharness: ${event.eventType}\n`;
}

function itemTypeLabel(itemType: string): string {
  if (itemType === "agent_message") {
    return "agent_message";
  }

  if (itemType.includes("command")) {
    return "command_execution";
  }

  if (itemType.includes("mcp")) {
    return "mcp_call";
  }

  if (itemType.includes("file")) {
    return "file_change";
  }

  return itemType;
}

function itemText(item: Record<string, unknown> | null): string {
  if (item === null) {
    return "";
  }

  const text =
    stringField(item, "text") ?? stringField(item, "message") ?? stringField(item, "name");
  return text === null ? "" : `text=${text}`;
}

function errorText(payload: Record<string, unknown> | null): string {
  return (
    stringField(payload, "message") ?? stringField(objectField(payload, "error"), "message") ?? ""
  );
}

function formatUsagePayload(usage: Record<string, unknown> | null): string {
  if (usage === null) {
    return "none";
  }

  return `input=${numberField(usage, "input_tokens") ?? 0} cached=${numberField(usage, "cached_input_tokens") ?? 0} output=${numberField(usage, "output_tokens") ?? 0} reasoning=${numberField(usage, "reasoning_output_tokens") ?? 0}`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function objectField(
  value: Record<string, unknown> | null,
  field: string,
): Record<string, unknown> | null {
  const candidate = value?.[field];
  return typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown> | null, field: string): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" ? candidate : null;
}

function numberField(value: Record<string, unknown>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === "number" ? candidate : null;
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
