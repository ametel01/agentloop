import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli.ts";

const quietIo = {
  stdout: () => {},
  stderr: () => {},
};

describe("CLI scaffold", () => {
  test("accepts --help", () => {
    expect(runCli(["--help"], undefined, quietIo)).resolves.toBe(0);
  });

  test("accepts --version", () => {
    expect(runCli(["--version"], undefined, quietIo)).resolves.toBe(0);
  });

  test("rejects unsupported commands with usage failure", () => {
    expect(runCli(["unknown"], undefined, quietIo)).resolves.toBe(64);
  });
});
