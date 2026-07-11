# Agentloop

Agentloop is a local durable CLI harness for running the installed `$codex-dev-team-goal` workflow against an explicit Git repository. It keeps process durability, SQLite state, leases, budgets, approvals, recovery, and operator commands in this repo while leaving dev-team semantics to the installed Codex skills.

## Install

```bash
bun install --frozen-lockfile
bun run build
```

During development, run commands through Bun:

```bash
bun src/cli.ts --help
```

After building, run:

```bash
bun dist/cli.js --help
```

To rebuild the current checkout, link `agentloop` globally, and add Bun's global binary directory to your shell profile when missing:

```bash
bun run install:global
```

The command is idempotent, so rerun it after local changes. If it updates your shell profile, open a new shell or source the profile before invoking `agentloop` from the current terminal.

## Commands

```text
agentloop doctor --repo PATH [--json]
agentloop dispatch --repo PATH --trust-repo [--dry-run] [--json]
agentloop run --repo PATH --goal TEXT --trust-repo [--detach] [--model MODEL]
agentloop resume RUN_ID [--message TEXT] [--accept-skill-change]
agentloop approve RUN_ID --message TEXT
agentloop reject RUN_ID --message TEXT
agentloop worker [--once] [--poll-interval DURATION]
agentloop events RUN_ID [--follow] [--json]
agentloop status [RUN_ID] [--json]
agentloop cancel RUN_ID [--reason TEXT]
```

Exit codes:

- `0`: command completed successfully.
- `64`: usage, preflight, invalid state, or operator-action error.
- `75`: a repository already has an open run and cannot accept another external coordinator.
- `70`: internal failure, including persistence or Codex execution failure.

## Preflight

Run doctor before autonomous work:

```bash
bun src/cli.ts doctor --repo /path/to/repo
bun src/cli.ts doctor --repo /path/to/repo --json
```

Doctor verifies Git root resolution, Codex CLI availability, SDK import compatibility, GitHub CLI availability/authentication, writable state/worktree roots, required skill files, and repository-local instruction/configuration surfaces. Warnings do not block execution, but they identify trust surfaces the operator accepts with `--trust-repo`.

## Label Dispatch

`dispatch` is the polling-safe entry point for issue-tracker-authorized implementation:

```bash
bun dist/cli.js dispatch --repo /path/to/repo --trust-repo
bun dist/cli.js dispatch --repo /path/to/repo --trust-repo --dry-run
bun dist/cli.js dispatch --repo /path/to/repo --trust-repo --json
```

Protocol labels are fixed:

- `agentloop:ready`: a human approved the issue for autonomous implementation.
- `agentloop:running`: a specific Agentloop run owns or reconciles the issue.
- `agentloop:blocked`: a run hit a terminal human or external blocker.

`dispatch` runs doctor, verifies all three labels exist, reads open `agentloop:ready` issues, and queues one repository-level run for the existing worker. It never invokes Codex directly. `no_ready_issues` and `already_active` are successful no-op outcomes for scheduled polling. `--dry-run` reports the exact issue numbers that would be queued without opening SQLite or mutating GitHub.

The queued objective stores only the immutable dispatch marker and sorted issue numbers/URLs. Issue titles, bodies, comments, and customer data are not persisted by dispatch.

## Foreground Runs

```bash
bun src/cli.ts run --repo /path/to/repo --goal "Close issues #10 through #12" --trust-repo
```

Foreground mode creates the durable run row, acquires the repository lease, starts a Codex coordinator turn, streams full redacted event details, and stores the Codex thread ID when available. In an interactive terminal, a run that pauses for approval, an external blocker, exhaustion, or no progress keeps the foreground monitor attached. The monitor shows events produced by another resume or approval process and stays open until the run completes, is cancelled, or the operator presses Ctrl-C to detach. Non-interactive callers return when execution pauses so scripts do not hang.

Each Codex turn is supervised as a bounded tranche. Defaults are a 10 minute cooperative tranche, an 11 minute hard deadline, and a 4 minute event-stall deadline. Cooperative tranche expiry continues the same run in a later turn; hard deadlines, repeated stalls, SDK failures, exhausted budgets, no progress, review-cycle caps, and operator cancellation are recorded as distinct durable outcomes.

When approval is required, the attached monitor prints the exact `approve` and `reject` commands to run from another terminal. A recoverable execution error is also persisted and keeps an interactive monitor attached with the exact `resume` command. Non-interactive callers, or an operator who detaches while the run is still failed, receive the nonzero execution result.

The default text event stream is a compact human view. Every coordinator update shows the number of active, running, waiting, and blocked subagents, followed by each active agent's canonical name, role, current task, and status. Routine successful commands, file-change events, and empty collaboration waits are hidden; decisions, command failures, approvals, blockers, and turn results remain visible. Raw command and SDK payload replay remains available with `events RUN_ID --json`.

Model selection:

- If `--model MODEL` is supplied, the coordinator thread uses it.
- If omitted, Codex inherits the local default.
- Native sub-agents inherit the parent Codex selection unless a matching custom agent file supplies a role-specific model override.

## Detached Runs And Worker

Queue without executing:

```bash
bun src/cli.ts run --repo /path/to/repo --goal "Run the team queue" --trust-repo --detach
bun dist/cli.js dispatch --repo /path/to/repo --trust-repo
```

Process queued or recoverable runs:

```bash
bun src/cli.ts worker
bun src/cli.ts worker --once
```

The worker atomically claims the oldest queued run first, then expired active leases for `running` or `continuing` runs. It never auto-claims waiting approval, externally blocked, stuck, exhausted, failed, cancelled, or complete runs.

Dispatched runs execute through the same worker path as `run --detach`; keep one worker supervised for the state directory used by dispatch.

## Status And Events

```bash
bun src/cli.ts status
bun src/cli.ts status RUN_ID
bun src/cli.ts status RUN_ID --json
bun src/cli.ts events RUN_ID
bun src/cli.ts events RUN_ID --json
bun src/cli.ts events RUN_ID --follow
```

Status reports harness state, usage totals, usage completeness, checkpoint age, outcome counts by type, recent exact evidence cache entries, token/time/review-cycle ratios per outcome, turn summaries, pending approvals, lease metadata, heartbeat age, no-progress count, latest blocker, and last error. Ratios render as `unavailable` when no outcome or complete usage denominator exists. JSON status is stable machine-readable output. Event JSON is newline-delimited JSON in persisted sequence order.

Control messages are split into compact `checkpoint` messages and terminal `final` messages. Checkpoints carry changed agents, material outcomes, blocker or approval changes, review-cycle state, optional owned `STATUS.d/...` shard paths, and reusable gate/blocker evidence. Final messages alone carry complete closure evidence.

## Resume And Recovery

```bash
bun src/cli.ts resume RUN_ID
bun src/cli.ts resume RUN_ID --message "Operator context"
```

Recovery is at least once at the outer Codex turn boundary. If a process dies after side effects but before the final envelope is persisted, resume uses a recovery prompt requiring live reconciliation of `STATUS.md`, GitHub issues/PRs, branches, and worktrees before new actions.

If required skill fingerprints changed, resume moves the run to `waiting_approval` unless `--accept-skill-change` is supplied.

Agentloop does not parse the prose inside `STATUS.md`. If `STATUS.md` exceeds 200 lines or 64 KiB, the next prompt instructs the coordinator to compact it into a short hot index and move per-stream detail under repository-relative `STATUS.d/<issue-or-pr>.md` shards. Absolute shard paths and `..` traversal are discarded from checkpoints.

Exact-head evidence reuse is local and conservative. A cache hit is available only when repository key, head SHA or stable patch ID, gate name/version, relevant-input digest, and environment fingerprint all match. Product-code, input, environment, or gate-version changes are misses; docs/tracker-only changes can reuse evidence only when the declared input digest proves they are unaffected.

## Approvals

Sensitive operations are represented as durable approval checkpoints:

```bash
bun src/cli.ts approve RUN_ID --message "Approved"
bun src/cli.ts reject RUN_ID --message "Rejected"
```

Approval resumes the same run with an approval-response prompt. Rejection cancels the run. The SDK approval policy remains `never`; these are product/operator approval checkpoints, not Codex tool-call approvals.

## Cancellation

```bash
bun src/cli.ts cancel RUN_ID --reason "No longer needed"
```

`cancel` applies only to queued runs. Active foreground or worker runs handle SIGINT/SIGTERM by aborting the active turn, persisting `cancelled`, and conditionally releasing the caller's own lease.

## Quality Gates

Local and CI use the same canonical gate:

```bash
bun run verify
```

For dependency security review:

```bash
bun audit
```

The opt-in live SDK smoke test is excluded from default CI. Run it only when model calls and credentials are explicitly authorized:

```bash
AGENTLOOP_LIVE=1 bun test test/live --timeout 120000
```

## Limitations

- v1 is single-host local orchestration with SQLite leases, not distributed consensus.
- Inner operations inside one Codex turn are not exactly once.
- Redaction is best-effort pattern matching, not a guarantee that arbitrary secrets cannot appear in prompts or tool output.
- The harness does not parse `STATUS.md` into semantic issue state; installed skills own dev-team workflow semantics.
- Agentloop does not install a system service or publish a package in v1.

See [Architecture](docs/architecture.md), [Operations](docs/operations.md), and [Security](docs/security.md) for more detail.
