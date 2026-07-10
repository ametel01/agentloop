#!/usr/bin/env bun

const VERSION = "0.0.0";

const HELP_TEXT = `agentloop

Usage:
  agentloop --help
  agentloop --version

Commands are intentionally limited in this scaffold. Implementation steps add
doctor, run, worker, resume, status, events, approve, reject, and cancel.
`;

export function runCli(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return 0;
  }

  console.error("Unsupported command. Run `agentloop --help`.");
  return 64;
}

if (import.meta.main) {
  process.exitCode = runCli(Bun.argv.slice(2));
}
