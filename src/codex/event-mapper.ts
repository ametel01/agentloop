import type { ThreadEvent } from "@openai/codex-sdk";

import { redactJson } from "./redaction.ts";

export function eventItemId(event: ThreadEvent): string | null {
  if ("item" in event) {
    return event.item.id;
  }

  return null;
}

export function eventPayloadJson(event: ThreadEvent): string {
  return redactJson(event);
}

export function agentMessageText(event: ThreadEvent): string | null {
  if (!("item" in event)) {
    return null;
  }

  return event.item.type === "agent_message" ? event.item.text : null;
}
