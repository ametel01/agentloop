import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { migrate } from "./migrations.ts";

export interface OpenDatabaseOptions {
  path: string;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  await chmod(dirname(options.path), 0o700);

  const database = new Database(options.path, { create: true, strict: true });
  migrate(database);
  await chmod(options.path, 0o600);
  return database;
}
