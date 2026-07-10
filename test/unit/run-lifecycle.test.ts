import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import { runCli } from "../../src/cli.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENTLOOP_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("detached run lifecycle", () => {
  test("creates, reads, and cancels a queued run across fresh CLI calls", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-run-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const homeDir = "/home/alex";
    const repoPath = "/work/agentloop";
    const dependencies = createDependencies(homeDir, repoPath);
    const firstStdout: string[] = [];

    const createExit = await runCli(
      ["run", "--repo", ".", "--goal", "ship it", "--trust-repo", "--detach"],
      dependencies,
      {
        stdout: (message) => firstStdout.push(message),
        stderr: () => {},
      },
    );

    expect(createExit).toBe(0);
    expect(firstStdout.join("").trim()).toBe("run-1");

    const secondDependencies = createDependencies(homeDir, repoPath);
    const statusJson: string[] = [];
    const statusExit = await runCli(["status", "run-1", "--json"], secondDependencies, {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });
    const run = JSON.parse(statusJson.join("")) as {
      id: string;
      status: string;
      objective: string;
    };

    expect(statusExit).toBe(0);
    expect(run).toMatchObject({ id: "run-1", objective: "ship it", status: "queued" });

    const cancelStdout: string[] = [];
    const cancelExit = await runCli(
      ["cancel", "run-1", "--reason", "test complete"],
      createDependencies(homeDir, repoPath),
      {
        stdout: (message) => cancelStdout.push(message),
        stderr: () => {},
      },
    );

    expect(cancelExit).toBe(0);
    expect(cancelStdout.join("")).toContain("status: cancelled");
  });
});

function createDependencies(homeDir: string, repoPath: string) {
  const fileSystem = new FakeFileSystem();
  fileSystem.addDirectory(repoPath);

  for (const skillName of REQUIRED_SKILLS) {
    fileSystem.addFile(
      resolve(homeDir, ".agents", "skills", skillName, "SKILL.md"),
      `---\nname: ${skillName}\n---\n`,
    );
  }

  fileSystem.addFile(
    resolve(
      homeDir,
      ".agents",
      "skills",
      "codex-dev-team-goal",
      "references",
      "sub-agent-prompts.md",
    ),
    "# prompts\n",
  );

  return {
    clock: new FixedClock(),
    commandRunner: new FakeCommandRunner((command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${repoPath}\n`, stderr: "" };
      }

      if (command === "codex") {
        return { exitCode: 0, stdout: "codex-cli 0.144.1\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "--version") {
        return { exitCode: 0, stdout: "gh version 2.96.0\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "auth") {
        return { exitCode: 0, stdout: "github.com\n", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    }),
    cwd: repoPath,
    fileSystem,
    homeDir,
    idGenerator: new FixedIdGenerator(),
  };
}

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-10T00:00:00.000Z");
  }
}

class FixedIdGenerator implements IdGenerator {
  randomId(): string {
    return "run-1";
  }
}
