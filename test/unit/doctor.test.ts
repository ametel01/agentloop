import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import { runCli } from "../../src/cli.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

describe("doctor command", () => {
  test("renders stable JSON from fake command and filesystem adapters", async () => {
    const homeDir = "/home/alex";
    const repoPath = "/work/agentloop";
    const fileSystem = new FakeFileSystem();
    fileSystem.addDirectory(repoPath);
    fileSystem.addFile(resolve(repoPath, "AGENTS.md"), "# Instructions\n");

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

    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${repoPath}\n`, stderr: "" };
      }

      if (command === "codex") {
        return { exitCode: 0, stdout: "codex 1.0.0\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "--version") {
        return { exitCode: 0, stdout: "gh version 2.0.0\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "auth") {
        return { exitCode: 0, stdout: "github.com\nToken: gho_secret\n", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["doctor", "--repo", ".", "--json"],
      { commandRunner, fileSystem, homeDir, cwd: repoPath },
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(
      commandRunner.calls.some((call) => call.command === "gh" && call.args[0] === "auth"),
    ).toBeTrue();

    const report = JSON.parse(stdout.join("")) as {
      repoPath: string;
      checks: Array<{ name: string; status: string; evidence: string[] }>;
    };
    expect(report.repoPath).toBe(repoPath);
    expect(report.checks.find((check) => check.name === "repo-surface:AGENTS.md")?.status).toBe(
      "warning",
    );
    expect(JSON.stringify(report)).not.toContain("gho_secret");
  });

  test("fails usage when GitHub auth fails", async () => {
    const homeDir = "/home/alex";
    const repoPath = "/work/agentloop";
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

    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${repoPath}\n`, stderr: "" };
      }

      if (command === "codex" || (command === "gh" && args[0] === "--version")) {
        return { exitCode: 0, stdout: `${command} version\n`, stderr: "" };
      }

      if (command === "gh" && args[0] === "auth") {
        return { exitCode: 1, stdout: "", stderr: "not logged in" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    const exitCode = await runCli(
      ["doctor", "--repo", ".", "--json"],
      { commandRunner, fileSystem, homeDir, cwd: repoPath },
      {
        stdout: () => {},
        stderr: () => {},
      },
    );

    expect(exitCode).toBe(64);
  });
});
