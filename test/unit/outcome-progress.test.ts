import { describe, expect, test } from "bun:test";

import { collectOutcomeProgress } from "../../src/infrastructure/outcome-progress.ts";
import { FakeCommandRunner } from "../support/fakes.ts";

describe("outcome progress", () => {
  test("collects stable material outcomes without activity fingerprints", async () => {
    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "issue") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { closedAt: "2026-07-11T00:00:00Z", number: 42, state: "CLOSED", updatedAt: "x" },
            { number: 43, state: "OPEN", updatedAt: "y" },
          ]),
          stderr: "",
        };
      }

      if (command === "gh" && args[0] === "pr") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              headRefName: "feature",
              headRefOid: "def456",
              isDraft: false,
              mergeStateStatus: "CLEAN",
              number: 7,
              reviewDecision: "APPROVED",
              state: "OPEN",
              updatedAt: "ignored",
            },
          ]),
          stderr: "",
        };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    const observation = await collectOutcomeProgress(fakeRun(), { commandRunner });

    expect(observation.allSourcesAvailable).toBe(true);
    expect(observation.outcomes.map((outcome) => outcome.key).sort()).toEqual([
      "git-head:abc123",
      "issue:42:closed",
      "pr:7:OPEN:def456:APPROVED",
    ]);
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "git rev-parse HEAD",
      "gh issue list --state all --limit 100 --json number,state,closedAt",
      "gh pr list --state all --limit 100 --json number,state,headRefName,headRefOid,isDraft,reviewDecision,mergeStateStatus",
    ]);
  });

  test("fails closed when a required outcome source is unavailable", async () => {
    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "git" && args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }

      return { exitCode: 1, stdout: "", stderr: "source unavailable" };
    });

    const observation = await collectOutcomeProgress(fakeRun(), { commandRunner });

    expect(observation.allSourcesAvailable).toBe(false);
    expect(observation.sources.filter((source) => source.status === "failed")).toHaveLength(2);
  });
});

function fakeRun() {
  return {
    repoPath: "/work/repo",
  } as Parameters<typeof collectOutcomeProgress>[0];
}
