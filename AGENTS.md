# Agentloop Repository Instructions

## Toolchain

- Use Bun only for package management, scripts, tests, and builds.
- Install dependencies with `bun install --frozen-lockfile` after `bun.lock` exists.
- Run `bun run verify` before reporting completed implementation work.
- Keep TypeScript strictness enabled; fix types directly instead of weakening `tsconfig.json`.

## Harness Boundary

- Keep this project a thin local harness around installed Codex skills.
- Do not copy installed skill bodies or role prompts into TypeScript.
- Do not add model, GitHub, or network calls to default tests.
- Use fake adapters for Codex, command execution, filesystem, clock, and ID behavior in tests.

## Credentials and State

- Never persist process environments, OpenAI credentials, GitHub tokens, or full auth command output.
- Keep local operational state out of Git, including SQLite databases, WAL/SHM files, logs, coverage, and generated worktrees.
- Require explicit trust before executing Codex against repository instructions or code.
