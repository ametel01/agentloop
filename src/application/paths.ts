import { resolve } from "node:path";

export function resolveStateDir(home: string, env: NodeJS.ProcessEnv): string {
  if (env.AGENTLOOP_STATE_DIR !== undefined && env.AGENTLOOP_STATE_DIR !== "") {
    return resolve(env.AGENTLOOP_STATE_DIR);
  }

  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "") {
    return resolve(env.XDG_STATE_HOME, "agentloop");
  }

  return resolve(home, ".local", "state", "agentloop");
}
