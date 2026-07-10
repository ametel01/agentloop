import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_SKILLS } from "../../src/application/doctor.ts";
import type { Clock, IdGenerator } from "../../src/application/ports.ts";
import { runCli } from "../../src/cli.ts";
import type { CodexRunInput, CodexRunner } from "../../src/codex/client.ts";
import { FakeCommandRunner, FakeFileSystem } from "../support/fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENTLOOP_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("foreground run", () => {
  test("streams a fake Codex turn and persists the thread ID before completion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const dependencies = createDependencies(new FakeCodexRunner(completeEvents()));
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "finish queue", "--trust-repo"],
      dependencies,
      quietIo(),
    );

    expect(exitCode).toBe(0);
    expect(dependencies.codexRunner.inputs).toHaveLength(1);
    expect(dependencies.codexRunner.inputs[0]?.prompt.startsWith("Use $codex-dev-team-goal.")).toBe(
      true,
    );

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });

    const run = JSON.parse(statusJson.join("")) as {
      status: string;
      threadId: string | null;
      turnsCompleted: number;
      usage: { inputTokens: number };
    };
    expect(run.status).toBe("complete");
    expect(run.threadId).toBe("thread-1");
    expect(run.turnsCompleted).toBe(1);
    expect(run.usage.inputTokens).toBe(10);
  });

  test("marks the run failed when the final envelope is malformed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentloop-foreground-test-"));
    tempDirs.push(stateDir);
    process.env.AGENTLOOP_STATE_DIR = stateDir;

    const stderr: string[] = [];
    const exitCode = await runCli(
      ["run", "--repo", ".", "--goal", "bad envelope", "--trust-repo"],
      createDependencies(new FakeCodexRunner(malformedEvents())),
      {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(70);
    expect(stderr.join("")).toContain("Malformed control envelope JSON");

    const statusJson: string[] = [];
    await runCli(["status", "id-1", "--json"], createDependencies(new FakeCodexRunner([])), {
      stdout: (message) => statusJson.push(message),
      stderr: () => {},
    });

    const run = JSON.parse(statusJson.join("")) as { status: string; lastError: string };
    expect(run.status).toBe("failed");
    expect(run.lastError).toContain("Malformed control envelope JSON");
  });
});

function createDependencies(codexRunner: FakeCodexRunner) {
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

  return {
    clock: new FixedClock(),
    codexRunner,
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
    idGenerator: new SequenceIdGenerator(),
  };
}

function quietIo() {
  return {
    stdout: () => {},
    stderr: () => {},
  };
}

function completeEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    { type: "turn.started" },
    {
      item: {
        id: "message-1",
        text: JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: true,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          status: "complete",
          summary: "done",
        }),
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    },
  ];
}

function malformedEvents(): ThreadEvent[] {
  return [
    { thread_id: "thread-1", type: "thread.started" },
    {
      item: {
        id: "message-1",
        text: "not json",
        type: "agent_message",
      },
      type: "item.completed",
    },
    {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 1,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ];
}

class FakeCodexRunner implements CodexRunner {
  readonly inputs: CodexRunInput[] = [];

  constructor(private readonly events: readonly ThreadEvent[]) {}

  async runStreamed(input: CodexRunInput): Promise<AsyncIterable<ThreadEvent>> {
    this.inputs.push(input);
    return this.eventStream();
  }

  private async *eventStream(): AsyncGenerator<ThreadEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-10T00:00:00.000Z");
  }
}

class SequenceIdGenerator implements IdGenerator {
  private nextId = 1;

  randomId(): string {
    const id = `id-${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}
