import { test, expect } from "bun:test";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_ENVELOPE_SCHEMA, parseControlEnvelope } from "../../src/codex/control-envelope.ts";
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
    const prompt = `Return this control envelope with no other text:
{"agents":{"coordinator":{"status":"complete","task":"Finish the harmless SDK smoke test."},"subagents":[]},"approval":null,"blocker":null,"closureGatePassed":true,"evidence":{"issueUrls":[],"prUrls":[],"reviewUrls":[],"statusPath":"STATUS.md"},"status":"complete","summary":"Live schema accepted."}`;

    const codex = new Codex();
    const firstThread = codex.startThread(options);
    const first = await firstThread.runStreamed(prompt, {
      outputSchema: CONTROL_ENVELOPE_SCHEMA,
    });
    const firstEvents = await collectEvents(first.events);
    const threadId = firstEvents.find((event) => event.type === "thread.started")?.thread_id;
    const firstResponse = firstEvents.find(
      (event) => event.type === "item.completed" && event.item.type === "agent_message",
    );

    expect(threadId).toBeString();
    expect(firstResponse?.type).toBe("item.completed");
    if (firstResponse?.type !== "item.completed" || firstResponse.item.type !== "agent_message") {
      throw new Error("Live Codex turn did not return an agent message");
    }
    expect(parseControlEnvelope(firstResponse.item.text).status).toBe("complete");

    const resumedThread = codex.resumeThread(threadId ?? "", options);
    const resumed = await resumedThread.run(prompt, {
      outputSchema: CONTROL_ENVELOPE_SCHEMA,
    });

    expect(parseControlEnvelope(resumed.finalResponse).status).toBe("complete");
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
