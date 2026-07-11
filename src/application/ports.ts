export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  mode: number;
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  access(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Scheduler {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IdGenerator {
  randomId(): string;
}
