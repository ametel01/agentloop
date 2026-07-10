import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  FileStat,
  FileSystem,
} from "../../src/application/ports.ts";

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
