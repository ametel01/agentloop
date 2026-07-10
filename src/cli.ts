#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { runDoctor, type DoctorDependencies } from "./application/doctor.ts";
import { CliUsageError } from "./domain/errors.ts";
import { ProductionCommandRunner } from "./infrastructure/command-runner.ts";
import { NodeFileSystem } from "./infrastructure/filesystem.ts";
import { doctorExitCode, EXIT_CODES } from "./presentation/exit-codes.ts";
import { renderDoctorJson } from "./presentation/json-renderer.ts";
import { renderDoctorText } from "./presentation/text-renderer.ts";

const VERSION = "0.0.0";

const HELP_TEXT = `agentloop

Usage:
  agentloop --help
  agentloop --version
  agentloop doctor --repo PATH [--json]

Commands:
  doctor   Run read-only repository, toolchain, GitHub, SDK, and skill preflight checks.
`;

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface CliDependencies extends DoctorDependencies {}

export async function runCli(
  args: readonly string[],
  dependencies = createProductionDependencies(),
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    return await runCliUnsafe(args, dependencies, io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return EXIT_CODES.internal;
  }
}

function createProductionDependencies(): CliDependencies {
  return {
    commandRunner: new ProductionCommandRunner(),
    fileSystem: new NodeFileSystem(),
  };
}

async function runCliUnsafe(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const [command, ...commandArgs] = args;

  switch (command) {
    case "doctor":
      return await runDoctorCommand(commandArgs, dependencies, io);
    default:
      throw new CliUsageError("Unsupported command. Run `agentloop --help`.");
  }
}

async function runDoctorCommand(
  args: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      repo: { type: "string" },
    },
    strict: true,
  });

  const repo = parsed.values.repo;
  if (repo === undefined || repo.trim() === "") {
    throw new CliUsageError("Missing required option: --repo PATH");
  }

  const report = await runDoctor({ repo }, dependencies);
  io.stdout(parsed.values.json ? renderDoctorJson(report) : renderDoctorText(report));
  return doctorExitCode(report);
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
