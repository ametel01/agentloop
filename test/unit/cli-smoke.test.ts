import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli.ts";

describe("CLI scaffold", () => {
  test("accepts --help", () => {
    expect(runCli(["--help"])).toBe(0);
  });

  test("accepts --version", () => {
    expect(runCli(["--version"])).toBe(0);
  });

  test("rejects unsupported commands with usage failure", () => {
    expect(runCli(["doctor"])).toBe(64);
  });
});
