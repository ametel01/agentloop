import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";

export interface CodexRunInput {
  prompt: string;
  threadId: string | null;
  threadOptions: ThreadOptions;
  outputSchema: unknown;
  signal?: AbortSignal;
}

export interface CodexRunner {
  runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>>;
}

export class ProductionCodexRunner implements CodexRunner {
  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    const codex = new Codex();
    const thread =
      input.threadId === null
        ? codex.startThread(input.threadOptions)
        : codex.resumeThread(input.threadId, input.threadOptions);
    const { events } = await thread.runStreamed(input.prompt, {
      outputSchema: input.outputSchema,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return events;
  }
}
