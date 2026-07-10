import { randomUUID } from "node:crypto";

import type { IdGenerator } from "../application/ports.ts";

export class RandomIdGenerator implements IdGenerator {
  randomId(): string {
    return randomUUID();
  }
}
