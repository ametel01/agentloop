# Security

Agentloop is a local orchestration harness for Codex. It makes autonomous work more durable, but it does not make an untrusted repository safe.

## Trust Boundary

- `--trust-repo` means the operator accepts that Codex may read repository files, follow repository-local instructions, and use the host's configured GitHub and OpenAI credentials through normal tools.
- Workspace sandboxing constrains filesystem access for Codex tool execution, not GitHub account permissions. If `gh` is authenticated with write access, model-directed GitHub operations may use that access.
- The harness verifies and warns about repository-local instruction/configuration surfaces such as `AGENTS.md`, Codex config, MCP config, Git hooks, scripts, binary directories, Makefiles, package manifests, and GitHub workflows.
- Agentloop does not store GitHub or OpenAI credentials. Operators should use least-privilege host credentials for repositories they run.

## Command Execution

- Harness subprocesses use structured command/argument arrays and explicit timeouts. User goal text, approval messages, and run IDs are not interpolated into shell command strings.
- The production command runner invokes `Bun.spawn([command, ...args])`; no `sh -c` path is used by the harness.
- Repository commands used for preflight and fingerprinting run with bounded timeouts and fail closed when required tools are missing.

## Persistence And Redaction

- SQLite state is created under the state directory with directory mode `0700` and database mode `0600`.
- WAL mode, foreign keys, busy timeout, and ordered migrations are enabled before execution state is used.
- SDK event payloads are redacted before persistence. Turn responses, approval responses, and failure messages are also redacted before durable storage and terminal output.
- Redaction is best-effort pattern matching for common token/private-key forms. It is not a substitute for avoiding secrets in prompts, repository files, or tool output.

## Recovery Risks

- The durable boundary is an outer Codex turn. If a process exits after side effects but before a final envelope is persisted, recovery is at least once.
- Stale worker leases are reclaimed only for `running` or `continuing` runs. Waiting, blocked, failed, exhausted, cancelled, and complete runs require explicit operator action where applicable.
- Recovery prompts require live-state reconciliation before new actions, but the harness cannot prove that arbitrary external side effects were exactly once.

## Failure Handling

- Corrupt or unwritable SQLite state stops execution rather than running without durable state.
- Missing GitHub CLI, Codex CLI, SDK import support, required skills, or writable state/worktree directories fail preflight before autonomous work starts.
- Operators should inspect `agentloop status` and `agentloop events` after interruption, failure, or stale-lease recovery before deciding whether to resume.
