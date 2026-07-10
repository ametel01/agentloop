import { describe, expect, test } from "bun:test";

import {
  buildDispatchObjective,
  discoverReadyIssues,
  DISPATCH_LABELS,
} from "../../src/application/dispatch.ts";
import { FakeCommandRunner } from "../support/fakes.ts";

const REPO_PATH = "/work/repo";

describe("dispatch discovery", () => {
  test("discovers a deterministic deduplicated ready issue set", async () => {
    const commandRunner = dispatchRunner([
      { number: 3, url: "https://github.com/acme/repo/issues/3" },
      { number: 1, url: "https://github.com/acme/repo/issues/1" },
      { number: 3, url: "https://github.com/acme/repo/issues/3?ignored=1#fragment" },
    ]);

    const discovery = await discoverReadyIssues({ commandRunner, repoPath: REPO_PATH });

    expect(discovery.issueNumbers).toEqual([1, 3]);
    expect(discovery.issues).toEqual([
      { number: 1, url: "https://github.com/acme/repo/issues/1" },
      { number: 3, url: "https://github.com/acme/repo/issues/3" },
    ]);
    expect(commandRunner.calls).toEqual([
      {
        args: ["label", "list", "--json", "name", "--limit", "1000"],
        command: "gh",
        options: { cwd: REPO_PATH, timeoutMs: 10_000 },
      },
      {
        args: [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          DISPATCH_LABELS.ready,
          "--json",
          "number,url",
          "--limit",
          "100",
        ],
        command: "gh",
        options: { cwd: REPO_PATH, timeoutMs: 10_000 },
      },
    ]);
  });

  test("fails when protocol labels are missing", async () => {
    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "gh" && args[0] === "label") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: DISPATCH_LABELS.ready }]),
          stderr: "",
        };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    await expect(discoverReadyIssues({ commandRunner, repoPath: REPO_PATH })).rejects.toThrow(
      /Missing required GitHub protocol labels: agentloop:running, agentloop:blocked/,
    );
    expect(commandRunner.calls).toHaveLength(1);
  });

  test("returns typed no-work discovery when no ready issues exist", async () => {
    const discovery = await discoverReadyIssues({
      commandRunner: dispatchRunner([]),
      repoPath: REPO_PATH,
    });

    expect(discovery).toEqual({ issueNumbers: [], issues: [] });
  });

  test("fails closed on malformed GitHub JSON", async () => {
    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "gh" && args[0] === "label") {
        return { exitCode: 0, stdout: JSON.stringify(protocolLabels()), stderr: "" };
      }

      if (command === "gh" && args[0] === "issue") {
        return { exitCode: 0, stdout: "{not-json", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    await expect(discoverReadyIssues({ commandRunner, repoPath: REPO_PATH })).rejects.toThrow(
      /Malformed GitHub ready issue list JSON/,
    );
  });

  test("fails closed on invalid issue records", async () => {
    await expect(
      discoverReadyIssues({
        commandRunner: dispatchRunner([
          { number: 0, url: "https://github.com/acme/repo/issues/0" },
        ]),
        repoPath: REPO_PATH,
      }),
    ).rejects.toThrow(/number must be a positive integer/);

    await expect(
      discoverReadyIssues({
        commandRunner: dispatchRunner([
          { number: 9, url: "https://example.com/acme/repo/issues/9" },
        ]),
        repoPath: REPO_PATH,
      }),
    ).rejects.toThrow(/GitHub HTTPS URL/);
  });

  test("fails closed on GitHub command failures", async () => {
    const commandRunner = new FakeCommandRunner((command, args) => {
      if (command === "gh" && args[0] === "label") {
        return { exitCode: 0, stdout: JSON.stringify(protocolLabels()), stderr: "" };
      }

      if (command === "gh" && args[0] === "issue") {
        return { exitCode: 1, stdout: "", stderr: "gh failed" };
      }

      return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    });

    await expect(discoverReadyIssues({ commandRunner, repoPath: REPO_PATH })).rejects.toThrow(
      /Failed to list open agentloop:ready issues: gh failed/,
    );
  });

  test("fails when discovery reaches the configured cap", async () => {
    await expect(
      discoverReadyIssues({
        commandRunner: dispatchRunner([
          { number: 1, url: "https://github.com/acme/repo/issues/1" },
          { number: 2, url: "https://github.com/acme/repo/issues/2" },
        ]),
        limit: 2,
        repoPath: REPO_PATH,
      }),
    ).rejects.toThrow(/reached the configured cap \(2\)/);
  });

  test("keeps adversarial issue content out of DTOs and objectives", async () => {
    const commandRunner = dispatchRunner([
      {
        body: "persist-me sk-secret123",
        number: 4,
        title: "do not persist this title",
        url: "https://github.com/acme/repo/issues/4",
      },
    ]);

    const discovery = await discoverReadyIssues({ commandRunner, repoPath: REPO_PATH });
    const objective = buildDispatchObjective(discovery.issues);
    const serialized = JSON.stringify(discovery);

    expect(serialized).not.toContain("persist-me");
    expect(serialized).not.toContain("title");
    expect(objective).toContain("#4 https://github.com/acme/repo/issues/4");
    expect(objective).not.toContain("persist-me");
    expect(objective).not.toContain("do not persist this title");
    expect(objective).not.toContain("sk-secret123");
  });

  test("builds deterministic scope-only objective text", () => {
    const objective = buildDispatchObjective([
      { number: 2, url: "https://github.com/acme/repo/issues/2" },
      { number: 5, url: "https://github.com/acme/repo/issues/5" },
    ]);

    expect(
      objective,
    ).toBe(`Run the installed $codex-dev-team-goal workflow for the exact label-scoped issue set below.
Scope marker: agentloop-dispatch-v1

Dispatched issues:
- #2 https://github.com/acme/repo/issues/2
- #5 https://github.com/acme/repo/issues/5

Do not implement or mutate issues outside this dispatched set except to inspect linked blockers or existing PR state for routing.`);
  });
});

function dispatchRunner(issues: readonly unknown[]): FakeCommandRunner {
  return new FakeCommandRunner((command, args) => {
    if (command === "gh" && args[0] === "label") {
      return { exitCode: 0, stdout: JSON.stringify(protocolLabels()), stderr: "" };
    }

    if (command === "gh" && args[0] === "issue") {
      return { exitCode: 0, stdout: JSON.stringify(issues), stderr: "" };
    }

    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  });
}

function protocolLabels(): Array<{ name: string }> {
  return [
    { name: DISPATCH_LABELS.ready },
    { name: DISPATCH_LABELS.running },
    { name: DISPATCH_LABELS.blocked },
  ];
}
