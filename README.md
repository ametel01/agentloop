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

## Commands

```text
agentloop doctor --repo PATH [--json]
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

## Foreground Runs

```bash
bun src/cli.ts run --repo /path/to/repo --goal "Close issues #10 through #12" --trust-repo
```

Foreground mode creates the durable run row, acquires the repository lease, starts a Codex coordinator turn, streams events, stores the Codex thread ID when available, and stops only when the final control envelope says complete, waiting for approval, blocked, exhausted, stuck, failed, or cancelled.

Model selection:

- If `--model MODEL` is supplied, the coordinator thread uses it.
- If omitted, Codex inherits the local default.
- Native sub-agents inherit the parent Codex selection.

## Detached Runs And Worker

Queue without executing:

```bash
bun src/cli.ts run --repo /path/to/repo --goal "Run the team queue" --trust-repo --detach
```

Process queued or recoverable runs:

```bash
bun src/cli.ts worker
bun src/cli.ts worker --once
```

The worker atomically claims the oldest queued run first, then expired active leases for `running` or `continuing` runs. It never auto-claims waiting approval, externally blocked, stuck, exhausted, failed, cancelled, or complete runs.

## Status And Events

```bash
bun src/cli.ts status
bun src/cli.ts status RUN_ID
bun src/cli.ts status RUN_ID --json
bun src/cli.ts events RUN_ID
bun src/cli.ts events RUN_ID --json
bun src/cli.ts events RUN_ID --follow
```

Status reports harness state, usage totals, turn summaries, pending approvals, lease metadata, heartbeat age, no-progress count, latest blocker, and last error. JSON status is stable machine-readable output. Event JSON is newline-delimited JSON in persisted sequence order.

## Resume And Recovery

```bash
bun src/cli.ts resume RUN_ID
bun src/cli.ts resume RUN_ID --message "Operator context"
```

Recovery is at least once at the outer Codex turn boundary. If a process dies after side effects but before the final envelope is persisted, resume uses a recovery prompt requiring live reconciliation of `STATUS.md`, GitHub issues/PRs, branches, and worktrees before new actions.

If required skill fingerprints changed, resume moves the run to `waiting_approval` unless `--accept-skill-change` is supplied.

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
