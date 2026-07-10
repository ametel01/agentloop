# Operations

This document describes how to run Agentloop as a local operator-controlled harness.

## State Paths

By default, Agentloop stores operational state at:

```text
${AGENTLOOP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentloop}/agentloop.sqlite
```

The SQLite directory is created with mode `0700`; the database is created with mode `0600`. WAL sidecar files may exist next to the database while it is active.

Set a custom state location for testing or isolation:

```bash
AGENTLOOP_STATE_DIR=/tmp/agentloop-state bun src/cli.ts status
```

## Backups

For cold backup, stop foreground runs and workers, then copy:

```text
agentloop.sqlite
agentloop.sqlite-wal
agentloop.sqlite-shm
```

For hot backup, use SQLite-aware backup tooling. Do not copy only the main database file while WAL mode is active.

## Worker Supervision

Run one worker under a local supervisor:

```bash
bun dist/cli.js worker
```

For a one-shot job:

```bash
bun dist/cli.js worker --once
```

Example `launchd` shape:

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/bun</string>
  <string>/path/to/agentloop/dist/cli.js</string>
  <string>worker</string>
</array>
```

Keep the environment explicit in supervised runs, especially `PATH`, `HOME`, and any Codex/GitHub authentication setup expected by `codex` and `gh`.

## Stale Leases

Leases expire according to the run's persisted `leaseTtlMs`. A worker claims expired leases only for `running` or `continuing` runs and resumes through the recovery prompt. Waiting approval, externally blocked, stuck, exhausted, failed, cancelled, and complete runs are not automatically resumed by workers.

Inspect before resuming manually:

```bash
bun dist/cli.js status RUN_ID
bun dist/cli.js events RUN_ID
```

## Recovery Procedure

1. Run `status RUN_ID --json` and inspect the harness state, turn summaries, lease metadata, last error, latest blocker, and pending approvals.
2. Run `events RUN_ID` or `events RUN_ID --json` to inspect the streamed SDK history.
3. Inspect the target repository's `STATUS.md`, Git branches, worktrees, issues, and PRs.
4. Resume only when the current live state is understood:

```bash
bun dist/cli.js resume RUN_ID --message "Operator recovery context"
```

If a skill fingerprint changed, approve or reject the durable skill-change checkpoint instead of forcing silent continuation.

## Budget Tuning

Supported run limits:

- `--max-turns N`
- `--max-tokens N`
- `--max-duration 500ms|30s|10m|8h`

Defaults:

- 25 outer turns
- 5,000,000 non-cached tokens
- 8 hours wall duration
- 120 second lease TTL
- 30 second lease heartbeat
- 2 unchanged-progress continuation turns
- 2 consecutive failed outer turns

Token budgets count input, output, and reasoning tokens. Cached input tokens are tracked but excluded from the hard token ceiling.

## Approvals

Pending approvals stop active compute. Use:

```bash
bun dist/cli.js approve RUN_ID --message "Approved"
bun dist/cli.js reject RUN_ID --message "Rejected"
```

Approval resumes the run. Rejection cancels it. Approval responses are redacted before persistence.

## Incident Notes

- Corrupt or unwritable state fails closed with exit code `70`.
- Missing `codex`, missing `gh`, failed GitHub auth, missing skills, or unwritable worktree roots fail preflight with exit code `64`.
- SIGINT/SIGTERM during active execution aborts the active turn, persists cancellation, and releases only the current owner's lease.
- The opt-in live SDK smoke test requires explicit authorization:

```bash
AGENTLOOP_LIVE=1 bun test test/live --timeout 120000
```
