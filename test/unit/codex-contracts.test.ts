import { describe, expect, test } from "bun:test";

import { parseControlEnvelope } from "../../src/codex/control-envelope.ts";
import { buildThreadOptions } from "../../src/codex/thread-options.ts";

describe("Codex contracts", () => {
  test("omits model overrides when not supplied", () => {
    expect(
      buildThreadOptions({
        model: null,
        reasoningEffort: null,
        repoPath: "/repo",
        worktreeRoot: "/worktrees/repo",
      }),
    ).toEqual({
      additionalDirectories: ["/worktrees/repo"],
      approvalPolicy: "never",
      networkAccessEnabled: true,
      sandboxMode: "workspace-write",
      webSearchMode: "disabled",
      workingDirectory: "/repo",
    });
  });

  test("rejects complete envelopes without closure evidence", () => {
    expect(() =>
      parseControlEnvelope(
        JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: false,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          status: "complete",
          summary: "not really done",
        }),
      ),
    ).toThrow("closureGatePassed is false");
  });

  test("rejects additional properties", () => {
    expect(() =>
      parseControlEnvelope(
        JSON.stringify({
          approval: null,
          blocker: null,
          closureGatePassed: false,
          evidence: {
            issueUrls: [],
            prUrls: [],
            reviewUrls: [],
            statusPath: "STATUS.md",
          },
          extra: true,
          status: "continue",
          summary: "continue",
        }),
      ),
    ).toThrow("Unexpected control envelope keys");
  });
});
