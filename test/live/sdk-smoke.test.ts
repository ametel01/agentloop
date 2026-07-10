import { test, expect } from "bun:test";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionCommandRunner } from "../../src/infrastructure/command-runner.ts";

const liveTest = process.env.AGENTLOOP_LIVE === "1" ? test : test.skip;

liveTest("starts and resumes a harmless Codex SDK thread", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "agentloop-live-sdk-"));
  const commandRunner = new ProductionCommandRunner();

  try {
    const init = await commandRunner.run("git", ["-C", repoPath, "init", "-q"]);
    expect(init.exitCode).toBe(0);

    const options = {
      approvalPolicy: "never",
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      webSearchMode: "disabled",
      workingDirectory: repoPath,
    } satisfies ThreadOptions;
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok"] },
      },
    } as const;

    const codex = new Codex();
    const firstThread = codex.startThread(options);
    const first = await firstThread.runStreamed('Return exactly {"status":"ok"}.', {
      outputSchema: schema,
    });
    const firstEvents = await collectEvents(first.events);
    const threadId = firstEvents.find((event) => event.type === "thread.started")?.thread_id;

    expect(threadId).toBeString();

    const resumedThread = codex.resumeThread(threadId ?? "", options);
    const resumed = await resumedThread.run('Return exactly {"status":"ok"}.', {
      outputSchema: schema,
    });

    expect(resumed.finalResponse).toContain("ok");
  } finally {
    await rm(repoPath, { force: true, recursive: true });
  }
});

async function collectEvents(events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
  const collected: ThreadEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}
