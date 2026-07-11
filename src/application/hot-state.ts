import type { FileSystem } from "./ports.ts";

export interface HotStatePolicy {
  maxBytes: number;
  maxLines: number;
}

export interface HotStateInspection {
  bytes: number;
  instruction: string | null;
  lines: number;
  path: string;
}

export const DEFAULT_HOT_STATE_POLICY: HotStatePolicy = {
  maxBytes: 64 * 1024,
  maxLines: 200,
};

export async function inspectHotState(input: {
  fileSystem: FileSystem;
  policy?: HotStatePolicy;
  repoPath: string;
}): Promise<HotStateInspection> {
  const policy = input.policy ?? DEFAULT_HOT_STATE_POLICY;
  const path = `${input.repoPath}/STATUS.md`;
  if (!(await input.fileSystem.access(path))) {
    return { bytes: 0, instruction: null, lines: 0, path };
  }

  const content = await input.fileSystem.readFile(path);
  const text = new TextDecoder().decode(content);
  const lines = text === "" ? 0 : text.split(/\r?\n/).length;
  const bytes = content.byteLength;
  const tooLarge = lines > policy.maxLines || bytes > policy.maxBytes;

  return {
    bytes,
    instruction: tooLarge
      ? [
          `STATUS.md is oversized (${lines} lines, ${bytes} bytes).`,
          "Before assigning new work, compact STATUS.md into a short index and move per-stream details to STATUS.d/<issue-or-pr>.md.",
          "Checkpoint messages must reference only owned shard paths inside this repository.",
        ].join(" ")
      : null,
    lines,
    path,
  };
}

export function normalizeOwnedStatusShard(path: string | null): string | null {
  if (path === null || path.trim() === "") {
    return null;
  }

  if (path.startsWith("/") || path.split("/").includes("..")) {
    return null;
  }

  return path;
}
