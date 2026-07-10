import { sha256Hex } from "./hash.ts";
import type { CommandRunner, FileSystem } from "../application/ports.ts";
import type { RunRecord } from "../domain/run.ts";

export interface FingerprintSource {
  name: string;
  status: "available" | "missing" | "timed_out" | "failed";
  value: string;
}

export interface ProgressFingerprint {
  hash: string;
  allSourcesAvailable: boolean;
  sources: FingerprintSource[];
}

export async function collectProgressFingerprint(
  run: RunRecord,
  dependencies: { commandRunner: CommandRunner; fileSystem: FileSystem },
): Promise<ProgressFingerprint> {
  const sources = [
    await statusFileSource(run, dependencies.fileSystem),
    await commandSource(
      "git-status",
      "git",
      ["status", "--short", "--branch", "--untracked-files=all"],
      run,
      dependencies.commandRunner,
    ),
    await commandSource(
      "git-worktrees",
      "git",
      ["worktree", "list", "--porcelain"],
      run,
      dependencies.commandRunner,
    ),
    await ghJsonSource(
      "gh-issues",
      ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,updatedAt"],
      run,
      dependencies.commandRunner,
    ),
    await ghJsonSource(
      "gh-prs",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefName,isDraft,updatedAt",
      ],
      run,
      dependencies.commandRunner,
    ),
  ];
  const normalized = JSON.stringify(
    sources.map((source) => ({
      name: source.name,
      status: source.status,
      value: source.value.replace(/\r\n/g, "\n"),
    })),
  );

  return {
    allSourcesAvailable: sources.every((source) => source.status === "available"),
    hash: sha256Hex(normalized),
    sources,
  };
}

async function statusFileSource(
  run: RunRecord,
  fileSystem: FileSystem,
): Promise<FingerprintSource> {
  const path = `${run.repoPath}/STATUS.md`;
  if (!(await fileSystem.access(path))) {
    return { name: "status-file", status: "available", value: "missing" };
  }

  try {
    return {
      name: "status-file",
      status: "available",
      value: sha256Hex(await fileSystem.readFile(path)),
    };
  } catch (error) {
    return { name: "status-file", status: "failed", value: errorMessage(error) };
  }
}

async function commandSource(
  name: string,
  command: string,
  args: readonly string[],
  run: RunRecord,
  commandRunner: CommandRunner,
): Promise<FingerprintSource> {
  const result = await commandRunner.run(command, args, { cwd: run.repoPath, timeoutMs: 10_000 });
  if (result.exitCode === 124) {
    return { name, status: "timed_out", value: result.stderr };
  }

  if (result.exitCode !== 0) {
    return { name, status: "failed", value: result.stderr || result.stdout };
  }

  return { name, status: "available", value: result.stdout };
}

async function ghJsonSource(
  name: string,
  args: readonly string[],
  run: RunRecord,
  commandRunner: CommandRunner,
): Promise<FingerprintSource> {
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

function sortJsonArray(value: unknown[]): unknown[] {
  return [...value].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
