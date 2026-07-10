import type { ModelReasoningEffort, ThreadOptions } from "@openai/codex-sdk";

export interface BuildThreadOptionsInput {
  repoPath: string;
  worktreeRoot: string;
  model: string | null;
  reasoningEffort: string | null;
}

export function buildThreadOptions(input: BuildThreadOptionsInput): ThreadOptions {
  return {
    workingDirectory: input.repoPath,
    sandboxMode: "workspace-write",
    additionalDirectories: [input.worktreeRoot],
    networkAccessEnabled: true,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    ...(input.model === null ? {} : { model: input.model }),
    ...(input.reasoningEffort === null
      ? {}
      : { modelReasoningEffort: input.reasoningEffort as ModelReasoningEffort }),
  };
}
