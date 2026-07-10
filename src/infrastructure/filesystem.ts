import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";

import type { FileStat, FileSystem } from "../application/ports.ts";

export class NodeFileSystem implements FileSystem {
  async access(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): Promise<void> {
    await mkdir(path, options);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await readFile(path);
  }

  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }

  async stat(path: string): Promise<FileStat> {
    const result = await stat(path);
    return {
      isDirectory: result.isDirectory(),
      isFile: result.isFile(),
      mode: result.mode,
      size: result.size,
      mtimeMs: result.mtimeMs,
    };
  }

  async writeFile(path: string, data: string): Promise<void> {
    await writeFile(path, data);
  }
}
