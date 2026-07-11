import type { ThreadEvent, Usage } from "@openai/codex-sdk";

import type { CodexRunInput, CodexRunner } from "../codex/client.ts";
import { agentMessageText } from "../codex/event-mapper.ts";
import type { RunLimits, RunUsage } from "../domain/run.ts";
import type { Scheduler } from "./ports.ts";

export interface TranchePolicy {
  cooperativeTrancheMs: number;
  hardTurnDeadlineMs: number;
  eventStallMs: number;
}

export type TrancheAbortReason =
  | "operator_cancelled"
  | "tranche_elapsed"
  | "hard_deadline"
  | "event_stalled"
  | "sdk_failed";

export type TrancheOutcome =
  | {
      finalText: string | null;
      status: "completed";
      usage: RunUsage;
    }
  | {
      abortReason: TrancheAbortReason;
      errorMessage: string;
      finalText: string | null;
      status: "aborted";
      usage: RunUsage;
    };

export interface RunTrancheInput {
  onEvent: (event: ThreadEvent) => Promise<void> | void;
  request: CodexRunInput;
  runner: CodexRunner;
  signal: AbortSignal;
}

type RaceResult =
  | { reason: Exclude<TrancheAbortReason, "sdk_failed">; type: "abort" }
  | { error: unknown; type: "error" }
  | { result: IteratorResult<ThreadEvent>; type: "next" };
type AbortResult = Extract<RaceResult, { type: "abort" }>;
type StreamResult = { events: AsyncIterable<ThreadEvent>; type: "stream" };

export class BoundedTurnSupervisor {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly policy: TranchePolicy,
  ) {}

  static policyFromLimits(limits: RunLimits): TranchePolicy {
    return {
      cooperativeTrancheMs: limits.cooperativeTrancheMs,
      eventStallMs: limits.eventStallWarningMs,
      hardTurnDeadlineMs: limits.hardTurnDeadlineMs,
    };
  }

  async runTranche(input: RunTrancheInput): Promise<TrancheOutcome> {
    const abortController = new AbortController();
    const operatorAbort = this.operatorAbort(input.signal);
    let finalText: string | null = null;
    let usage = zeroUsage();

    const abort = (reason: Exclude<TrancheAbortReason, "sdk_failed">): TrancheOutcome => {
      abortController.abort(reason);
      return {
        abortReason: reason,
        errorMessage: abortReasonMessage(reason),
        finalText,
        status: "aborted",
        usage,
      };
    };

    try {
      const request = { ...input.request, signal: abortController.signal };
      const stream = await Promise.race<AbortResult | StreamResult>([
        input.runner
          .runStreamed(request)
          .then((events): StreamResult => ({ events, type: "stream" })),
        operatorAbort,
      ]);

      if (stream.type === "abort") {
        return abort(stream.reason);
      }

      const iterator = stream.events[Symbol.asyncIterator]();
      const cooperative = this.deadline(
        "tranche_elapsed",
        this.policy.cooperativeTrancheMs,
        abortController.signal,
      );
      const hard = this.deadline(
        "hard_deadline",
        this.policy.hardTurnDeadlineMs,
        abortController.signal,
      );

      while (true) {
        const next = iterator.next().then(
          (result: IteratorResult<ThreadEvent>): RaceResult => ({ result, type: "next" }),
          (error: unknown): RaceResult => ({ error, type: "error" }),
        );
        const stalled = this.deadline(
          "event_stalled",
          this.policy.eventStallMs,
          abortController.signal,
        );

        const raced = await Promise.race([next, cooperative, hard, stalled, operatorAbort]);
        if (raced.type === "abort") {
          return abort(raced.reason);
        }

        if (raced.type === "error") {
          return {
            abortReason: "sdk_failed",
            errorMessage: errorMessage(raced.error),
            finalText,
            status: "aborted",
            usage,
          };
        }

        if (raced.result.done === true) {
          return { finalText, status: "completed", usage };
        }

        const event = raced.result.value;
        await input.onEvent(event);
        finalText = agentMessageText(event) ?? finalText;

        if (event.type === "turn.completed") {
          usage = mapUsage(event.usage);
        }

        if (event.type === "turn.failed" || event.type === "error") {
          return {
            abortReason: "sdk_failed",
            errorMessage: event.type === "turn.failed" ? event.error.message : event.message,
            finalText,
            status: "aborted",
            usage,
          };
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        return abort("operator_cancelled");
      }

      return {
        abortReason: "sdk_failed",
        errorMessage: errorMessage(error),
        finalText,
        status: "aborted",
        usage,
      };
    } finally {
      abortController.abort("tranche complete");
    }
  }

  private async deadline(
    reason: Exclude<TrancheAbortReason, "sdk_failed">,
    ms: number,
    signal: AbortSignal,
  ): Promise<RaceResult> {
    try {
      await this.scheduler.sleep(ms, signal);
      return { reason, type: "abort" };
    } catch (error) {
      if (signal.aborted) {
        return new Promise<RaceResult>(() => {});
      }

      return { error, type: "error" };
    }
  }

  private operatorAbort(signal: AbortSignal): Promise<AbortResult> {
    if (signal.aborted) {
      return Promise.resolve({ reason: "operator_cancelled", type: "abort" });
    }

    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve({ reason: "operator_cancelled", type: "abort" }),
        { once: true },
      );
    });
  }
}

function abortReasonMessage(reason: Exclude<TrancheAbortReason, "sdk_failed">): string {
  switch (reason) {
    case "operator_cancelled":
      return "operator_cancelled: operator signal aborted the active turn";
    case "tranche_elapsed":
      return "tranche_elapsed: cooperative turn tranche elapsed";
    case "hard_deadline":
      return "hard_deadline: hard turn deadline elapsed";
    case "event_stalled":
      return "event_stalled: Codex stream produced no events before the stall deadline";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
