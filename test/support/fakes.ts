import type { ThreadEvent } from "@openai/codex-sdk";

import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  FileStat,
  FileSystem,
} from "../../src/application/ports.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";

export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: CommandOptions }> =
    [];

  constructor(
    private readonly handler: (
      command: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => CommandResult,
  ) {}

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push(options === undefined ? { command, args } : { command, args, options });
    return this.handler(command, args, options);
  }
}

interface FakeEntry {
  content: Uint8Array;
  mode: number;
  mtimeMs: number;
  type: "file" | "directory";
}

export class FakeFileSystem implements FileSystem {
  private readonly entries = new Map<string, FakeEntry>();

  addFile(path: string, content: string): void {
    this.entries.set(path, {
      content: new TextEncoder().encode(content),
      mode: 0o100644,
      mtimeMs: 1,
      type: "file",
    });
  }

  addDirectory(path: string): void {
    this.entries.set(path, {
      content: new Uint8Array(),
      mode: 0o40755,
      mtimeMs: 1,
      type: "directory",
    });
  }

  async access(path: string): Promise<boolean> {
    return this.entries.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.addDirectory(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(path);
    if (entry === undefined || entry.type !== "file") {
      throw new Error(`No file: ${path}`);
    }

    return entry.content;
  }

  async realpath(path: string): Promise<string> {
    return path;
  }

  async stat(path: string): Promise<FileStat> {
    const entry = this.entries.get(path);
    if (entry === undefined) {
      throw new Error(`No entry: ${path}`);
    }

    return {
      isDirectory: entry.type === "directory",
      isFile: entry.type === "file",
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      size: entry.content.byteLength,
    };
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.addFile(path, data);
  }
}

export class ControlledAsyncStream<T> implements AsyncIterable<T> {
  private readonly queue: Array<IteratorResult<T>> = [];
  private readonly waiters: Array<{
    reject: (error: unknown) => void;
    resolve: (result: IteratorResult<T>) => void;
  }> = [];
  private failure: unknown = null;

  push(value: T): void {
    this.deliver({ done: false, value });
  }

  close(): void {
    this.deliver({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
      return;
    }

    this.failure = error;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }

    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ reject, resolve });
    });
  }

  private deliver(result: IteratorResult<T>): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(result);
      return;
    }

    this.queue.push(result);
  }
}

export class ControlledCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];
  readonly stream = new ControlledAsyncStream<ThreadEvent>();

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    return this.stream;
  }
}

export class FakeScheduler {
  readonly sleeps: Array<{ ms: number; signal?: AbortSignal }> = [];
  private readonly pending: Array<{
    reject: (error: Error) => void;
    resolve: () => void;
    signal?: AbortSignal;
  }> = [];

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(signal === undefined ? { ms } : { ms, signal });

    if (signal?.aborted) {
      return Promise.reject(new Error("sleep aborted"));
    }

    return new Promise((resolve, reject) => {
      const pending = signal === undefined ? { reject, resolve } : { reject, resolve, signal };
      this.pending.push(pending);
      signal?.addEventListener(
        "abort",
        () => {
          this.removePending(pending);
          reject(new Error("sleep aborted"));
        },
        { once: true },
      );
    });
  }

  advanceNext(): void {
    const pending = this.pending.shift();
    pending?.resolve();
  }

  advanceAll(): void {
    while (this.pending.length > 0) {
      this.advanceNext();
    }
  }

  private removePending(entry: (typeof this.pending)[number]): void {
    const index = this.pending.indexOf(entry);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  }
}
