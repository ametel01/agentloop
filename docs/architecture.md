# Architecture

Agentloop is intentionally thin. It does not implement team roles, issue dependency graphs, worktree policy, PR review policy, merge decisions, or retrospectives. Those remain in the installed Codex skills invoked by `$codex-dev-team-goal`.

## Layers

1. CLI parses operator intent, validates arguments, renders text/JSON, and maps errors to exit codes.
2. Durable supervisor behavior in `src/cli.ts` and `SqliteRunStore` owns state transitions, turns, events, approvals, leases, budgets, heartbeats, cancellation, and recovery selection.
3. Codex adapter translates a run into `@openai/codex-sdk` thread options and streams SDK events.
4. Codex coordinator receives fixed prompts that invoke `$codex-dev-team-goal`; installed skills own repository semantic state.

## Label Dispatch Boundary

`agentloop dispatch` is a local repository-level dispatcher. It discovers open GitHub issues labeled `agentloop:ready`, validates the fixed protocol labels, and queues exactly one durable run for the current ready set. It does not start Codex, implement issue semantics, mutate claim labels, or run a scheduler.

Agentloop owns:

- doctor/trust preflight before dispatch
- deterministic ready-issue discovery through structured `gh` arguments
- stable text/JSON outcomes for `dry_run`, `queued`, `no_ready_issues`, and `already_active`
- repository singleton idempotency through the open-run constraint
- the scope-only queued objective containing the dispatch marker plus issue numbers and URLs
- the durable run ID in coordinator prompt headers

Installed skills own:

- GitHub claim comments and `agentloop:running`/`agentloop:blocked` mutation order
- same-run recovery and different-run refusal
- issue/PR reconciliation, existing-PR reuse, dependency routing, role assignment, merge closure, and transient-label cleanup

Discovery producers remain outside Agentloop. Health, UX, security, Hallmark, telemetry, and churn producers may create or enrich issues in future plans, but they do not apply `agentloop:ready` or launch implementation in this slice.

## State Machine

Persisted run states:

```text
queued
running
continuing
waiting_approval
externally_blocked
complete
stuck
budget_exhausted
failed
cancelled
```

`complete` and `cancelled` are terminal. Workers automatically claim only `queued` runs and expired active leases for `running` or `continuing` runs. All other stopped states require explicit operator action where supported.

## SQLite Ledger

Default database path:

```text
${AGENTLOOP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentloop}/agentloop.sqlite
```

Migration 1 creates:

- `runs`: durable run metadata, limits, usage, status, fingerprints, and thread ID.
- `turns`: outer Codex turns, prompt hashes, responses, usage, and errors.
- `events`: redacted SDK event payloads with run-local sequence numbers.
- `approvals`: durable human approval requests and resolution records.
- `leases`: one active repository execution lease per repository key.

SQLite is opened with WAL mode, foreign keys, busy timeout, synchronous normal, state directory mode `0700`, and database mode `0600`.

## Turn Boundary

The outer Codex turn is the durable execution boundary. Events are persisted as they stream, and the final control envelope decides the next run state. If a process exits after side effects but before the final envelope is persisted, recovery is at least once and must reconcile live state before taking new actions.

## Recovery

Explicit `resume` and stale worker recovery use a fixed recovery prompt. That prompt requires reconciliation of:

- `STATUS.md` and `STATUS.archive.md`
- Git branches and worktrees
- GitHub issues and PRs
- Existing Codex thread state when a durable thread ID exists

If SDK events exist but no durable thread ID was recorded, explicit resume is refused because the continuation target is ambiguous.

## Prompts And Skills

Prompt templates are fixed for initial, continuation, recovery, and approval-response turns. User objective and operator messages are delimited as data. Required skill fingerprints are recorded at run creation; resume blocks for approval if installed skill content changed.

Prompt headers include the durable Agentloop run ID so installed skills can publish `[agentloop run:<RUN_ID>]` claim evidence and recover same-run work without trusting issue body content.

## Leases And Budgets

Foreground runs acquire a repository lease before execution. Detached workers atomically claim queued runs or expired active leases. Active execution renews the lease on the configured heartbeat interval and releases only the caller's own lease.

The supervisor enforces maximum outer turns, non-cached token budget, wall duration, consecutive failures, unchanged progress count, and signal cancellation. Progress fingerprints hash `STATUS.md`, Git status, worktrees, GitHub issues, and GitHub PR summaries when available.
