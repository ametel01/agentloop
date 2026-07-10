# Implementation Plan

## Source Documents

- Path: `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`
  - Role: Primary workflow specification.
  - Summary: Defines the coordinator loop, PR context and closure gates, worktree ownership, role separation, merge acceptance, reconciliation, shared `STATUS.md`, and terminal stop rules that the harness must invoke rather than duplicate.
- Path: `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/references/sub-agent-prompts.md`
  - Role: Role prompt contract.
  - Summary: Defines the required skill sets and behavioral boundaries for spec, builder, checker, reviewer, and retrospective agents. The harness must not copy these prompts into TypeScript.
- Path: `/Users/alexmetelli/.agents/skills/team-coordinator/SKILL.md`
  - Role: Coordinator behavior specification.
  - Summary: Defines dependency ordering, parallel saturation, resource isolation, worktree handling, PR packaging, post-merge reconciliation, and role routing.
- Path: `/Users/alexmetelli/.agents/skills/agent-team-status-protocol/SKILL.md`
  - Role: Repository-level durable state contract.
  - Summary: Defines `STATUS.md` and `STATUS.archive.md`, handoffs, ownership, gates, review state, loop brakes, and hot/cold state. These files remain the source of truth for dev-team semantics.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/djfarrelly-agent-loop-architecture-2026-06-19.md`
  - Role: Durable orchestration design input.
  - Summary: Establishes that restart recovery, checkpointing, retries, concurrency controls, child lifecycle, and post-hoc observability are infrastructure concerns rather than prompt concerns.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/mem0-loop-engineering-memory-2026-06-18.md`
  - Role: Long-running state and context design input.
  - Summary: Separates disposable model context from durable external state and recommends reading durable state before each pass and persisting independent checker verdicts.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/shmidt-loop-engineering-brakes-259-prs-2026-06-21.md`
  - Role: Safety and anti-spin design input.
  - Summary: Motivates hard budgets, circuit breakers, heartbeats, blast-radius restrictions, machine-verifiable completion, and explicit human boundaries.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/zodchiii-claude-code-agent-team-loops-2026-06-16.md`
  - Role: Builder/checker loop design input.
  - Summary: Reinforces maker/checker separation, exact failure evidence, five-cycle caps, repeated-failure stops, regression stops, and prohibition on weakening checks.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/vercel-eve-2026-06-18.md`
  - Role: Production harness design input.
  - Summary: Motivates durable sessions, isolated execution, resumable approvals, structured event traces, evals, versioned instructions, and adapter boundaries.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/atai-self-learning-agents-user-signal-2026-06-24.md`
  - Role: Harness improvement governance input.
  - Summary: Separates model, harness, and context learning and requires trace-driven harness changes to be proposed, evaluated, and human-approved rather than silently self-applied.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/hanako-self-updating-prompt-2026-06-19.md`
  - Role: Batched learning design input.
  - Summary: Treats individual decisions as noise and recommends accumulating repeated evidence before changing reusable instructions.
- Path: `/Users/alexmetelli/source/alex-okf/raw/articles/movez-kimi-self-improving-loop-2026-06-18.md`
  - Role: Specification and verification design input.
  - Summary: Requires a concrete spec, reviewable decomposition, bounded subtask contexts, artifact-oriented outputs, and independent verification before lessons become reusable skills.

## Goals

- Provide a local, durable CLI harness that runs the installed `$codex-dev-team-goal` workflow against an explicitly selected Git repository.
- Use `@openai/codex-sdk` as the only agent runtime and let Codex discover and invoke the currently installed skills.
- Keep the harness thin: it owns process durability, turn lifecycle, leases, budgets, approvals, event persistence, recovery, and operator commands, while skills own dev-team semantics.
- Persist enough operational state to recover after harness, Codex CLI, terminal, or machine-process interruption without blindly replaying side effects.
- Prevent concurrent external coordinators from operating on the same repository while allowing the coordinator skill to manage its own internal sub-agent concurrency.
- Make runs inspectable through structured status and event commands without requiring an external service or dashboard.
- Support foreground execution for development and a durable worker mode suitable for supervision by `launchd`, systemd, or another process manager.
- Preserve the selected coordinator model: an explicit CLI model overrides Codex configuration; otherwise the run inherits the local Codex default. Native sub-agents inherit that parent selection unless the Codex runtime loads a matching external custom-agent override.

## Non-Goals

- Do not reimplement issue discovery, dependency graphs, worktree creation, role prompts, checker loops, reviewer decisions, PR packaging, merge policy, retrospectives, or closure gates in TypeScript.
- Do not define Agents SDK agents, handoffs, or per-role model assignments.
- Do not copy installed `SKILL.md` bodies into the repository or database.
- Do not provide inner-step exactly-once execution for operations performed inside one Codex turn. The SDK exposes the turn as the durable boundary; recovery must reconcile live state.
- Do not add a web UI, HTTP API, hosted control plane, multi-host scheduler, distributed queue, or remote database in v1.
- Do not add semantic/vector memory. `STATUS.md`, `STATUS.archive.md`, Git/GitHub state, Codex thread history, and the operational ledger are sufficient for v1.
- Do not automatically edit skills, prompts, hooks, or harness code from a single run or retrospective.
- Do not deploy, release, publish an npm package, install a system service, or configure production credentials as part of this plan.
- Do not require a human merge by default because that would change `$codex-dev-team-goal`; provide an optional stricter merge policy only.
- Do not delete or modify the existing untracked `.DS_Store`; add it to `.gitignore` during toolchain setup.

## Definition of Done

- `agentloop doctor --repo <path>` verifies the repository, Git, Codex CLI/SDK compatibility, GitHub CLI authentication, writable worktree root, state directory, and required skill files, with human-readable and JSON output.
- `agentloop run --repo <path> --goal <text> --trust-repo` creates a durable run record before starting Codex, acquires a repository lease, launches a streamed Codex coordinator turn, invokes `$codex-dev-team-goal`, and persists the Codex thread ID as soon as `thread.started` arrives.
- `agentloop run --detach` queues a run without executing it; `agentloop worker` claims queued or recoverable runs and renews leases while work is active.
- `agentloop resume <run-id>` resumes the same Codex thread. Interrupted turns use a fixed recovery prompt that requires reconciliation of `STATUS.md`, GitHub issues/PRs, branches, and worktrees before new actions.
- `agentloop status`, `agentloop events`, and `agentloop cancel` expose durable state and work after process restarts.
- Runs support durable `waiting_approval` state plus `agentloop approve` and `agentloop reject`; no model process remains active while waiting.
- SQLite persists schema versions, runs, turns, events, approvals, and repository leases with WAL mode, foreign keys, busy timeout, atomic transitions, and restrictive filesystem permissions.
- The supervisor enforces maximum outer turns, maximum total tokens, maximum wall duration, repeated turn-failure limits, unchanged-state limits, cancellation, and repository singleton leases.
- The progress fingerprint records deterministic hashes of `STATUS.md` plus normalized Git, worktree, issue, and PR summaries. An unavailable fingerprint source is represented explicitly and cannot silently count as proof of no progress.
- SDK event payloads are assigned monotonic run-local sequence numbers, redacted before persistence, and rendered consistently in text and JSON modes.
- The initial, continuation, recovery, and approval prompts are fixed templates. User goal text is delimited as data, not interpolated into shell commands or instruction prose.
- The final Codex response conforms to a strict control-envelope schema with `complete`, `continue`, `waiting_approval`, or `externally_blocked` status and supporting evidence.
- The harness never reports `complete` unless the envelope says the skill closure gate passed and includes closure evidence references.
- Required skill names and their `SKILL.md` hashes are recorded when a run starts. A changed skill fingerprint on resume requires explicit operator acceptance before continuing.
- Unit and integration tests use fake Codex, clock, command, filesystem, and ID adapters. Default tests perform no model calls, GitHub writes, network access, or mutations outside temporary directories.
- An opt-in live smoke test proves that the pinned Codex SDK can start and resume a harmless read-only thread under Bun, but it is excluded from default CI.
- README and architecture, operations, and security documentation describe commands, state transitions, durability limits, sandboxing, credentials, recovery, approval handling, exit codes, and known at-least-once behavior.
- `PROGRESS.md` and `CHANGELOG.md` are current, every incremental step has a focused commit, and all quality gates pass.

## Assumptions and Open Questions

- Assumption: v1 is a single-host local harness. SQLite and expiring leases provide process-level durability and exclusion, not distributed consensus.
- Assumption: Bun is the runtime and package manager, Biome handles formatting/linting, TypeScript uses strict mode, and `bun:test` is the test runner, matching the surrounding TypeScript repositories.
- Assumption: `@openai/codex-sdk` version `0.144.1` is pinned initially because its inspected public API supplies `Codex`, `startThread`, `resumeThread`, `runStreamed`, structured events, output schemas, cancellation, working-directory controls, model controls, sandbox controls, and approval policy.
- Assumption: Bun compatibility with the pinned SDK must be proven by the opt-in smoke adapter before live coordinator execution is considered supported. If the SDK cannot start under Bun, stop implementation and record a blocker rather than adding a second runtime implicitly.
- Assumption: the target repository is already cloned, is a Git repository, and is accessible to the current OS user.
- Assumption: the host Codex installation discovers personal skills under `/Users/alexmetelli/.agents/skills`; the harness verifies skill availability but does not mount or copy skills.
- Assumption: `gh` uses existing host authentication. The harness never stores GitHub or OpenAI credentials.
- Assumption: the SDK/CLI inherits the process environment unless an explicit test adapter supplies a restricted environment.
- Assumption: `approvalPolicy: "never"` is required for unattended SDK operation because v1 does not implement Codex tool-call approval callbacks. Product-sensitive decisions are represented by the skill's final control envelope and durable approval state.
- Assumption: one external coordinator lease per canonical repository is intentionally conservative even when goals appear disjoint; the skill remains responsible for safe parallel work inside that coordinator.
- Assumption: the default worktree root is `<repo-parent>/.agentloop-worktrees/<repo-name>/<run-id>` and is passed as an additional writable directory and as an explicit coordinator instruction.
- Assumption: default limits are 25 outer turns, 5,000,000 total non-cached tokens, 8 hours wall duration, two consecutive failed outer turns, two unchanged `continue` turns, a 120-second lease TTL renewed every 30 seconds, and a 30-minute event-stall warning. All are configurable per run.
- Assumption: cost ceilings are not calculated in dollars in v1 because model pricing changes independently. Token and duration ceilings are deterministic.
- Assumption: an SDK turn may complete after side effects but before the final event is persisted. Recovery is therefore at-least-once at the turn boundary and must rely on the coordinator skill's live-state reconciliation and idempotent reuse of existing PRs, branches, and worktrees.
- Assumption: `STATUS.md` is semantic team state; SQLite is operational execution state. Neither replaces the other, and the harness does not parse `STATUS.md` into issue phases.
- Assumption: the optional `human-merge` policy is communicated to the coordinator prompt and causes a durable approval request before merge. The default remains `agent-approved` to preserve the existing skill contract.
- Open question: none blocks planning. Values above are conservative v1 decisions and can be changed later through reviewed configuration work.

## Implementation Approach

### Architectural Boundary

Use four layers with one-way ownership:

1. `CLI`: parses operator intent, validates arguments, invokes application services, maps terminal states to exit codes, and renders text or JSON.
2. `Durable supervisor`: owns SQLite, state transitions, leases, budgets, approvals, recovery selection, heartbeats, and event sequencing.
3. `Codex adapter`: translates a run into `@openai/codex-sdk` thread options and streams typed SDK events. It contains no dev-team workflow logic.
4. `Codex coordinator`: receives a prompt that names `$codex-dev-team-goal`; installed skills own all issue-to-merge behavior and repository semantic state.

Dependency direction must be `cli -> application -> ports`, with production adapters implementing ports. Avoid a generic dependency-injection container; construct dependencies explicitly in `src/bootstrap.ts`.

### Planned File Layout

```text
agentloop/
├── .github/workflows/ci.yml
├── .gitignore
├── AGENTS.md
├── CHANGELOG.md
├── PLAN.md
├── PROGRESS.md
├── README.md
├── biome.json
├── bun.lock
├── package.json
├── tsconfig.json
├── docs/
│   ├── architecture.md
│   ├── operations.md
│   └── security.md
├── src/
│   ├── cli.ts
│   ├── bootstrap.ts
│   ├── application/
│   │   ├── approvals.ts
│   │   ├── doctor.ts
│   │   ├── recovery.ts
│   │   ├── run-service.ts
│   │   ├── status-service.ts
│   │   ├── supervisor.ts
│   │   └── worker.ts
│   ├── codex/
│   │   ├── client.ts
│   │   ├── control-envelope.ts
│   │   ├── event-mapper.ts
│   │   ├── prompt-builder.ts
│   │   └── thread-options.ts
│   ├── domain/
│   │   ├── errors.ts
│   │   ├── events.ts
│   │   ├── policies.ts
│   │   ├── run.ts
│   │   ├── state-machine.ts
│   │   └── usage.ts
│   ├── infrastructure/
│   │   ├── clock.ts
│   │   ├── command-runner.ts
│   │   ├── filesystem.ts
│   │   ├── fingerprint.ts
│   │   ├── ids.ts
│   │   ├── redaction.ts
│   │   ├── skills.ts
│   │   └── sqlite/
│   │       ├── database.ts
│   │       ├── migrations.ts
│   │       └── run-store.ts
│   └── presentation/
│       ├── exit-codes.ts
│       ├── json-renderer.ts
│       └── text-renderer.ts
└── test/
    ├── fixtures/
    ├── integration/
    ├── live/
    ├── support/
    └── unit/
```

### Domain State Machine

Use these persisted run states:

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

Allowed transitions must be encoded as data and enforced with compare-and-swap updates:

- `queued -> running | cancelled`
- `running -> continuing | waiting_approval | externally_blocked | complete | stuck | budget_exhausted | failed | cancelled`
- `continuing -> running | cancelled`
- `waiting_approval -> continuing | cancelled`
- `externally_blocked -> continuing | cancelled` only through explicit `resume`
- `stuck -> continuing | cancelled` only through explicit `resume`
- `budget_exhausted -> continuing | cancelled` only through explicit `resume` with replacement limits that exceed recorded usage
- `failed -> continuing | cancelled` only through explicit `resume`
- `complete` and `cancelled` are terminal and cannot resume. No worker may implicitly resume any other stopped state; explicit operator action must record the reason for continuation.

Every transition must include expected current state, next state, reason code, timestamp, and optional turn ID in one SQLite transaction. A stale caller receives a typed `StateConflictError` and cannot overwrite newer state.

### SQLite Operational Ledger

Default database path:

```text
${AGENTLOOP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentloop}/agentloop.sqlite
```

Create the state directory with mode `0700` and database with mode `0600`. Enable:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

Implement ordered migrations in `src/infrastructure/sqlite/migrations.ts`. Migration 1 creates:

- `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
- `runs(id TEXT PRIMARY KEY, repo_path TEXT, repo_key TEXT, objective TEXT, objective_hash TEXT, thread_id TEXT NULL, status TEXT, model TEXT NULL, reasoning_effort TEXT NULL, approval_mode TEXT, worktree_root TEXT, skill_fingerprint TEXT, limits_json TEXT, turns_completed INTEGER, total_input_tokens INTEGER, total_cached_input_tokens INTEGER, total_output_tokens INTEGER, total_reasoning_tokens INTEGER, no_progress_count INTEGER, consecutive_failures INTEGER, state_fingerprint TEXT NULL, created_at TEXT, updated_at TEXT, started_at TEXT NULL, finished_at TEXT NULL, last_error TEXT NULL)`
- `turns(id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), turn_number INTEGER, kind TEXT, status TEXT, prompt_hash TEXT, started_at TEXT, finished_at TEXT NULL, fingerprint_before TEXT NULL, fingerprint_after TEXT NULL, response_json TEXT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, error_json TEXT NULL, UNIQUE(run_id, turn_number))`
- `events(run_id TEXT REFERENCES runs(id), sequence INTEGER, turn_id TEXT REFERENCES turns(id), event_type TEXT, item_id TEXT NULL, payload_json TEXT, created_at TEXT, PRIMARY KEY(run_id, sequence))`
- `approvals(id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), kind TEXT, question TEXT, risk TEXT, operation_json TEXT, evidence_json TEXT, status TEXT, requested_at TEXT, resolved_at TEXT NULL, response TEXT NULL)`
- `leases(repo_key TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), owner_id TEXT, acquired_at TEXT, heartbeat_at TEXT, expires_at TEXT)`

Create indexes for run status, repository/status lookup, event ordering, approval status, and lease expiry. Add a partial unique index on `runs(repo_key)` for every open status (`queued`, `running`, `continuing`, `waiting_approval`, `externally_blocked`, `stuck`, `budget_exhausted`, and `failed`) so a second external coordinator cannot be submitted until the existing run is completed or cancelled. Use `BEGIN IMMEDIATE` for run submission, lease acquisition, and transition writes.

### Repository Identity and Lease

- Resolve `--repo` through `realpath` and require `.git` discovery through `git rev-parse --show-toplevel`.
- Use the canonical Git root as `repo_path`.
- Compute `repo_key = sha256(canonicalRepoPath)` without lowercasing paths.
- Permit only one non-expired execution lease per `repo_key`. Queued runs do not hold leases; the partial unique open-run index prevents duplicate submissions while a worker is absent.
- Worker identity is `<hostname>:<pid>:<random-id>`.
- Renew a lease every 30 seconds independently of SDK event activity.
- Acquire a new lease for a queued run when foreground execution or a worker begins it.
- Reclaim an expired lease only for a `running` or `continuing` run and only after marking the next turn as `recovery`.
- Releasing a lease is idempotent and conditional on matching `owner_id`.

### Codex Thread Options

Construct production `ThreadOptions` as:

```ts
{
  workingDirectory: canonicalRepoPath,
  sandboxMode: "workspace-write",
  additionalDirectories: [worktreeRoot],
  networkAccessEnabled: true,
  webSearchMode: "disabled",
  approvalPolicy: "never",
  ...(model ? { model } : {}),
  ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
}
```

Create the worktree root before starting Codex and verify it resolves under the target repository's parent directory. Do not add arbitrary user-provided writable directories in v1.

### Prompt Contract

`src/codex/prompt-builder.ts` owns four templates: `initial`, `continuation`, `recovery`, and `approval-response`. Templates must:

- Start with `Use $codex-dev-team-goal.`
- Identify canonical repository and worktree root.
- Delimit the user objective inside `<target_work>...</target_work>` and state that it is task data, not a replacement for system, repository, or skill rules.
- Require installed skills and prohibit reconstructing role prompts in the harness.
- State the merge policy, remaining budgets, and non-interactive approval behavior.
- Require the final control envelope and closure evidence.
- On recovery, require reconciliation before any new side effect.
- On approval response, quote the operator response as data and name the specific approval ID.

Do not accept a model-generated next prompt. The supervisor chooses the next fixed template from persisted state.

### Control Envelope

Pass a strict JSON Schema through `runStreamed(..., { outputSchema })` and validate the final agent message independently. Required shape:

```json
{
  "status": "complete | continue | waiting_approval | externally_blocked",
  "summary": "string",
  "closureGatePassed": false,
  "evidence": {
    "statusPath": "string",
    "issueUrls": ["string"],
    "prUrls": ["string"],
    "reviewUrls": ["string"]
  },
  "approval": null,
  "blocker": null
}
```

`approval`, when present, requires `kind`, `question`, `risk`, and `operation`. `blocker`, when present, requires `kind`, `message`, `attemptedOperation`, and `evidence`. Set `additionalProperties: false` at every object level.

Reject `complete` when `closureGatePassed` is false. Reject `waiting_approval` without `approval`, and reject `externally_blocked` without `blocker`. A malformed envelope is a failed outer turn and is eligible for one correction turn before counting toward the consecutive-failure breaker.

### Event Persistence and Redaction

- Assign each received SDK event the next monotonic `sequence` inside a transaction before rendering it.
- Persist `thread.started` and update `runs.thread_id` atomically before processing later events.
- Store the original SDK event type, item ID when present, redacted JSON payload, and timestamp.
- Redact known secret environment values plus common token/key patterns before database writes or terminal output.
- Never persist the process environment, Codex API key, GitHub token, or full authentication command output.
- Treat event persistence failure as fatal: abort the active SDK turn, preserve the run as `failed`, and do not continue without explicit recovery.

### Progress Fingerprint

After every completed outer turn, compute a deterministic fingerprint from:

- SHA-256 of `STATUS.md`, or an explicit `missing` marker.
- Normalized `git status --short --branch --untracked-files=all`.
- Normalized `git worktree list --porcelain`.
- `gh issue list --state open --limit 100 --json number,updatedAt`.
- `gh pr list --state open --limit 100 --json number,headRefName,isDraft,updatedAt`.

Sort JSON collections and normalize line endings before hashing. Each source has a timeout and records `available`, `missing`, `timed_out`, or `failed`. If GitHub is unavailable, retain the explicit failure marker but do not increment `no_progress_count`; progress cannot be proven either way.

Increment `no_progress_count` only when the envelope says `continue`, all fingerprint sources needed for comparison are available, and the fingerprint is unchanged. Stop as `stuck` after two unchanged continuation turns.

### Budget and Circuit-Breaker Policy

Defaults:

- `maxOuterTurns = 25`
- `maxTotalTokens = 5_000_000`, calculated as input plus output plus reasoning tokens and excluding cached-input tokens from the hard total while reporting them separately
- `maxWallDuration = 8h`
- `maxConsecutiveTurnFailures = 2`
- `maxNoProgressTurns = 2`
- `leaseTtl = 120s`
- `leaseRenewInterval = 30s`
- `eventStallWarning = 30m`

Check budgets before starting each turn and after each `turn.completed`. Exceeding a hard budget transitions to `budget_exhausted`; it does not auto-resume. Event stall emits a warning but does not kill a potentially valid long-running command. Lease renewal and cancellation remain active during the stall.

### Approval Policy

- `agent-approved` preserves the skill's default merge behavior.
- `human-merge` tells the coordinator to return `waiting_approval` immediately before the first merge attempt.
- Production deploys, releases, secret changes, billing changes, and work outside target scope always require durable approval regardless of merge policy.
- `agentloop approve <run-id> --message <text>` resolves exactly one pending approval and transitions to `continuing`.
- `agentloop reject <run-id> --message <text>` records rejection and transitions to `cancelled` unless the approval operation explicitly allows a non-terminal alternative.
- Approval commands fail if there is zero or more than one pending approval; v1 requires an unambiguous single pending request.

### CLI Contract

Use `node:util.parseArgs` rather than adding a CLI framework. Commands:

```text
agentloop doctor --repo PATH [--json]
agentloop run --repo PATH --goal TEXT --trust-repo [--detach] [--model MODEL]
              [--reasoning minimal|low|medium|high|xhigh]
              [--approval-mode agent-approved|human-merge]
              [--max-turns N] [--max-tokens N] [--max-duration DURATION]
agentloop worker [--once] [--poll-interval DURATION]
agentloop resume RUN_ID [--message TEXT] [--accept-skill-change]
agentloop status [RUN_ID] [--json]
agentloop events RUN_ID [--follow] [--json]
agentloop approve RUN_ID --message TEXT
agentloop reject RUN_ID --message TEXT
agentloop cancel RUN_ID [--reason TEXT]
```

Exit codes:

- `0`: command succeeded or run completed
- `2`: waiting for approval
- `3`: externally blocked
- `4`: stuck or budget exhausted
- `64`: invalid CLI usage or failed preflight
- `70`: internal harness/SDK/persistence failure
- `75`: repository lease unavailable
- `130`: cancelled/interrupted

### Worker and Recovery

- Foreground `run` creates the durable row, acquires the lease, and executes the run in the same process.
- Detached `run` creates a `queued` row and exits after printing the run ID.
- `worker` polls for the oldest queued run, then expired recoverable leases, using an atomic claim transaction.
- A recovered run resumes `thread_id` and uses the recovery prompt. If no thread ID was ever persisted, start a new thread only when there are no persisted SDK events beyond run creation.
- SIGINT/SIGTERM abort the current turn through `AbortController`, persist cancellation intent, release the lease, and exit only after the database transition completes or a bounded shutdown timeout expires.
- A worker must never automatically resume `waiting_approval`, `externally_blocked`, `stuck`, `budget_exhausted`, `failed`, or `cancelled` states.

### Skill Discovery and Versioning

Resolve skills from the host's normal skill roots, prioritizing the paths reported by Codex configuration. At minimum verify these installed names before a run:

```text
codex-dev-team-goal
team-coordinator
agent-team-status-protocol
issue-spec-agent
builder-agent
checker-agent
maintainer-reviewer
process-retrospective-agent
```

Also verify the root skill's `references/sub-agent-prompts.md` exists. Record path, file size, modification time, and SHA-256 for each resolved `SKILL.md` plus the prompt reference, then hash the normalized manifest into `skill_fingerprint`.

Do not parse natural-language skill dependencies or load skill bodies into the prompt. If the fingerprint differs on resume, enter `waiting_approval` with kind `skill_change` unless `--accept-skill-change` was supplied.

### Security Boundary

- Require `--trust-repo` before any Codex execution because repository instructions and code are untrusted inputs with tool influence.
- `doctor` reports repository-local `AGENTS.md`, `.codex/config.toml`, MCP configuration, hooks, and executable scripts without treating their contents as trusted approval.
- Scope filesystem writes to the repository and generated worktree root.
- Keep web search disabled; enable network only for GitHub, Git remotes, package/test operations selected by the coordinator.
- Never shell-interpolate the objective, model, approval message, or run ID. Pass arguments as arrays through the command adapter.
- Keep event database and logs local with restrictive permissions and deterministic redaction.
- Document that workspace sandboxing limits filesystem blast radius but does not make repository instructions trustworthy and does not constrain authenticated GitHub side effects.

### Test Strategy

Define explicit ports for `CodexRunner`, `RunStore`, `CommandRunner`, `Clock`, `FileSystem`, and `IdGenerator`. Tests inject deterministic fakes directly; production wiring stays in `bootstrap.ts`.

Required unit coverage:

- CLI parsing, defaults, invalid combinations, durations, numeric limits, and exit-code mapping.
- Every allowed and forbidden state transition.
- Migration idempotence and schema version rejection.
- Atomic run creation and repository lease acquisition.
- Lease renewal, owner mismatch, expiry, reclaim, and release.
- Usage accumulation and every budget boundary.
- Control-envelope validation and correction-turn behavior.
- Prompt templates, delimiter preservation, and absence of shell interpolation.
- Event sequencing, thread-ID persistence, redaction, and persistence-failure abort.
- Skill resolution, missing skill errors, fingerprint stability, and changed-skill approval.
- Fingerprint normalization, unavailable-source handling, and no-progress counting.
- Approval creation, ambiguity rejection, approval, rejection, and resume.
- Cancellation and bounded shutdown behavior.

Required integration scenarios with fakes and temporary Git repositories:

- Initial run streams events and completes.
- Initial run returns `continue`, then completes on the same thread.
- Process interruption after `thread.started` resumes the recorded thread with a recovery prompt.
- Interruption before `thread.started` safely creates a new thread.
- Duplicate coordinator attempt fails on repository lease.
- Stale worker lease is reclaimed exactly once.
- Two unchanged continuation turns stop as `stuck`.
- Token, turn, and duration limits stop before another model turn.
- Approval survives process restart and resumes after operator response.
- Skill fingerprint change blocks resume until accepted.
- Malformed control envelope gets one correction turn, then fails.
- Database write failure aborts event processing and preserves recoverable evidence.
- SIGINT cancels the turn and leaves a consistent terminal state.

The opt-in live test under `test/live/` must require `AGENTLOOP_LIVE=1`, use a temporary read-only Git repository, issue a harmless prompt, assert `thread.started`, record the thread ID, resume it once, and make no GitHub writes.

## Quality Gates

- Setup status: No toolchain or quality gates exist. Step 1 must create them before implementation.
- Install command: `bun install --frozen-lockfile`
- Baseline command after Step 1: `bun run verify`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Typecheck command: `bun run typecheck`
- Test command: `bun run test`
- Build command: `bun run build`
- Aggregate command: `bun run verify`
- Dependency audit: `bun audit`
- Optional live SDK smoke test: `AGENTLOOP_LIVE=1 bun test test/live --timeout 120000`

`package.json` must define:

```json
{
  "type": "module",
  "scripts": {
    "format": "biome format --write .",
    "format:check": "biome format .",
    "lint": "biome lint .",
    "typecheck": "tsc --noEmit",
    "test": "bun test --timeout 10000",
    "build": "bun build ./src/cli.ts --target=bun --outdir=dist",
    "verify": "bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build"
  }
}
```

Pin `@openai/codex-sdk` to `0.144.1` for the initial implementation. Pin toolchain dependencies through `bun.lock`. Do not use range upgrades inside implementation steps.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before any quality-gate setup or implementation work begins.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.
- Required run notes: Record any baseline failure, SDK compatibility result, live-test skip reason, migration version, and known durability limitation.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Create `CHANGELOG.md` before any quality-gate setup or implementation work begins.
- Initial content: Include `# Changelog`, the standard preamble, and an `## [Unreleased]` section.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Omit entries for chores, progress tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs, framework migration housekeeping, and empty category headings.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described in this plan unless the user explicitly expands it.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required quality gates pass or documented pre-existing failures are handled, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for the user.
- Important boundary: The `/goal` must not start a live dev-team run against another repository as part of implementation verification. Only the explicitly opt-in harmless SDK smoke test may call a model.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Create durable progress and changelog files before any setup or implementation.

Depends on:

- Nothing.

Changes:

- Create `PROGRESS.md` with this plan's title, source list, all step checkboxes, current status, validation log, and next-step field.
- State that `PROGRESS.md` must be updated after every completed step.
- Create `CHANGELOG.md` with `# Changelog`, the Keep a Changelog preamble, and `## [Unreleased]`.
- Do not add empty change-category headings.

Acceptance criteria:

- Both files exist and are readable.
- `PROGRESS.md` lists Steps 0 through 11 and identifies Step 0 as current.
- `CHANGELOG.md` follows Keep a Changelog 1.0.0 structure.

Definition of Done contribution:

- Establishes the durable execution record required for autonomous plan implementation.

Validation:

- Inspect `PROGRESS.md` and confirm the complete checklist and update rules.
- Inspect `CHANGELOG.md` and confirm the preamble and `## [Unreleased]`.

Progress:

- Mark Step 0 complete, record validation, and set Step 1 as next.

Changelog:

- Do not add an entry; tracking setup is not a functional change.

Commit:

- `chore: initialize plan tracking`

### Step 1: Toolchain and Quality Gates Setup

Goal: Establish a strict, reproducible Bun/TypeScript/Biome project before product code.

Depends on:

- Step 0.

Changes:

- Create `package.json` with private package metadata, ESM mode, Bun engine declaration, `bin.agentloop`, exact scripts from `## Quality Gates`, pinned `@openai/codex-sdk@0.144.1`, and pinned development dependencies for TypeScript, Biome, and Bun types.
- Create `bun.lock` through Bun installation.
- Create strict `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and no emit for typechecking.
- Create `biome.json` covering source, tests, scripts, JSON, and Markdown while excluding `dist`, coverage, SQLite files, WAL/SHM files, and local state.
- Create `.gitignore` for `.DS_Store`, dependencies, build output, coverage, local databases, logs, temporary worktrees, and environment files.
- Create `AGENTS.md` documenting Bun-only commands, no-network default tests, fake-adapter requirements, no credential persistence, and the thin-harness boundary.
- Create a minimal `src/cli.ts` that supports only `--help` and `--version` so build and command smoke gates are real.
- Create `.github/workflows/ci.yml` using Bun, frozen install, and `bun run verify`.
- Add a minimal CLI smoke test under `test/unit/cli-smoke.test.ts`.

Acceptance criteria:

- Frozen installation succeeds from a clean dependency directory.
- Strict typecheck, format, lint, unit test, and build commands exist and pass.
- `dist/cli.js --help` exits zero.
- No implementation behavior beyond help/version exists.

Definition of Done contribution:

- Supplies all canonical gates and reproducible project conventions required by later steps.

Validation:

- Run `bun install --frozen-lockfile`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun run dist/cli.js --help`.

Progress:

- Record baseline results, commit reference if available, current status, and Step 2 as next.

Changelog:

- Do not add an entry; toolchain setup is not observable product behavior.

Commit:

- `chore: scaffold bun typescript cli`

### Step 2: Domain Contracts and Doctor Command

Goal: Deliver a read-only preflight command and stable internal contracts before Codex execution exists.

Depends on:

- Steps 0 and 1.

Changes:

- Add domain types for run IDs, statuses, limits, usage, approvals, skill manifests, doctor checks, and typed errors.
- Add `Clock`, `FileSystem`, `CommandRunner`, and `IdGenerator` ports plus production adapters.
- Implement canonical repository resolution through argument-array Git commands with timeouts.
- Implement state-directory resolution and permission checks without creating a database yet.
- Implement required-skill resolution and hashing without loading skill content into prompts.
- Implement `doctor --repo PATH [--json]` with checks for Git root, Codex executable/version, SDK import, `gh` executable/authentication, required skills, worktree-root writability, repository-local instruction/config surfaces, and trust flag guidance.
- Add text/JSON renderers and exit-code mapping for doctor results.
- Use fake command and filesystem adapters in unit tests; no test may call real `gh auth status`.

Acceptance criteria:

- Doctor reports each check as `pass`, `warning`, or `fail` with actionable evidence.
- JSON output has a stable schema and no ANSI sequences.
- Missing root skill, failed Git discovery, or failed authentication produces exit code 64.
- Repository instruction and MCP surfaces produce warnings, not silent trust.

Definition of Done contribution:

- Establishes the safety and compatibility gate required before any autonomous run.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun run dist/cli.js doctor --repo . --json` and record expected warnings/failures without starting Codex.

Progress:

- Record doctor behavior and validation, then set Step 3 as next.

Changelog:

- Add `Added` entry for the `doctor` command.

Commit:

- `feat: add repository and skill preflight`

### Step 3: Durable Ledger and Run Lifecycle Commands

Goal: Persist runs, state transitions, and repository leases before integrating Codex.

Depends on:

- Steps 0 through 2.

Changes:

- Implement SQLite database initialization, permissions, PRAGMAs, migration tracking, and Migration 1 schema exactly as specified.
- Implement transactional `RunStore` operations for create, get, list, compare-and-swap transition, usage update, turn creation/completion, event append, approval persistence, and lease lifecycle.
- Implement canonical repository keys and objective hashes.
- Add `run --detach` that performs doctor checks, requires `--trust-repo`, persists a `queued` run with limits and skill fingerprint, and prints its run ID without invoking Codex.
- Add `status [RUN_ID] [--json]` for one run or a concise recent-run list.
- Add `cancel RUN_ID [--reason]` for queued runs.
- Enforce state-directory and database permissions in tests using temporary directories.

Acceptance criteria:

- Concurrent submissions for the same repository cannot both create open runs; the loser receives a typed open-run conflict containing the existing run ID.
- Migration execution is idempotent and rejects unknown future schema versions.
- Invalid state transitions fail without modifying the row.
- Detached run creation and status survive a new CLI process.
- No Codex constructor or model call is used.

Definition of Done contribution:

- Creates the durable operational spine required for crash recovery and single-coordinator ownership.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- In a temporary Git repository and temporary state directory, run detached creation, status from a second process, cancellation, and status again.

Progress:

- Record migration version and lifecycle evidence, then set Step 4 as next.

Changelog:

- Add `Added` entry for durable queued runs, status, and cancellation.

Commit:

- `feat: persist run lifecycle in sqlite`

### Step 4: Codex SDK Adapter and Foreground Coordinator Run

Goal: Run one streamed `$codex-dev-team-goal` coordinator turn through the pinned Codex SDK.

Depends on:

- Steps 0 through 3.

Changes:

- Define `CodexRunner` port and production `@openai/codex-sdk` adapter.
- Implement thread-option construction, initial prompt template, control-envelope JSON Schema, envelope parser, SDK event mapper, redaction, monotonic event persistence, and text/JSON event rendering.
- Extend `run` without `--detach` to acquire the lease, create a turn, start a thread, persist `thread.started` atomically, stream events, parse the final envelope, update usage, fingerprint skills, transition state, and release the lease.
- Ensure omitted `--model` and `--reasoning` do not populate SDK overrides.
- Implement fake SDK scripts for complete, continue, blocked, malformed envelope, stream error, and persistence failure.
- Add the opt-in live SDK test proving start/resume compatibility under Bun without GitHub writes.

Acceptance criteria:

- The production adapter contains no role names other than the root skill mention in the prompt.
- Thread ID is durable before later events are handled.
- Event-persistence failure aborts the SDK stream and marks the run failed.
- `complete` is rejected without closure-gate evidence.
- Default tests make no model or network calls.

Definition of Done contribution:

- Delivers the minimal useful foreground harness while preserving all team semantics in installed skills.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- If explicitly authorized and credentials are available, run `AGENTLOOP_LIVE=1 bun test test/live --timeout 120000`; otherwise record the skip in `PROGRESS.md`.

Progress:

- Record adapter tests, live-test result or skip, and Step 5 as next.

Changelog:

- Add `Added` entry for foreground Codex dev-team execution and streamed progress.

Commit:

- `feat: run codex dev team in foreground`

### Step 5: Continuation, Resume, and Crash Recovery

Goal: Resume durable Codex threads safely after normal continuation or interruption.

Depends on:

- Steps 0 through 4.

Changes:

- Implement continuation and recovery prompt templates.
- Add supervisor logic that starts another outer turn on `continue` using the same in-memory thread.
- Implement `resume RUN_ID [--message] [--accept-skill-change]` using `resumeThread` and persisted state.
- Distinguish interrupted-before-thread-start from interrupted-after-thread-start.
- Require recovery turns to reconcile `STATUS.md`, GitHub, branches, and worktrees before side effects.
- Detect skill fingerprint changes and produce a durable `skill_change` approval request unless explicitly accepted.
- Add crash-boundary integration tests around thread-ID and event persistence.

Acceptance criteria:

- Normal continuation reuses the same thread ID.
- Recovery with a saved thread ID always uses `resumeThread` and the recovery prompt.
- Recovery without a thread ID starts fresh only when no SDK execution event was persisted.
- The original initial prompt is never replayed after an interrupted started thread.
- Skill changes cannot pass silently across resume.

Definition of Done contribution:

- Provides honest turn-level durability while documenting that inner Codex side effects remain at-least-once.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.

Progress:

- Record each recovery scenario result and set Step 6 as next.

Changelog:

- Add `Added` entry for durable thread continuation and recovery.

Commit:

- `feat: resume interrupted codex runs safely`

### Step 6: Budgets, Circuit Breakers, Heartbeats, and Progress Detection

Goal: Prevent runaway, stalled, duplicate, or non-progressing runs.

Depends on:

- Steps 0 through 5.

Changes:

- Implement policy parsing and defaults for turns, tokens, duration, failure count, no-progress count, lease timing, and event-stall warning.
- Accumulate SDK usage transactionally and check budgets before and after each turn.
- Add independent lease-renewal heartbeat and bounded shutdown behavior.
- Implement deterministic progress fingerprint collection with per-source timeouts and explicit availability markers.
- Implement no-progress and consecutive-failure circuit breakers.
- Add signal handling through `AbortController` and idempotent cancellation.
- Expose remaining budgets and breaker state in `status` output.

Acceptance criteria:

- No new turn begins after any hard budget is exhausted.
- Cached tokens are reported but excluded from the hard total exactly as documented.
- Two unchanged, fully available continuation fingerprints transition to `stuck`.
- Failed GitHub fingerprint collection does not falsely increment no-progress state.
- Lease renewal continues during an SDK event stall.
- SIGINT/SIGTERM leaves a consistent persisted state.

Definition of Done contribution:

- Adds the external brakes required for unattended operation.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.

Progress:

- Record boundary tests and set Step 7 as next.

Changelog:

- Add `Added` entry for budgets, circuit breakers, heartbeats, and progress detection.

Commit:

- `feat: enforce run safety limits`

### Step 7: Durable Human Approval Flow

Goal: Pause sensitive operations without keeping Codex or worker compute active.

Depends on:

- Steps 0 through 6.

Changes:

- Implement approval-envelope persistence and state transition to `waiting_approval`.
- Add `approve` and `reject` commands with exact-one-pending-approval validation.
- Implement approval-response prompt and resume path.
- Add `--approval-mode agent-approved|human-merge` and propagate it only as coordinator policy text.
- Require approvals for production deploy, release, secret, billing, out-of-scope work, and skill-fingerprint change.
- Render pending approval question, risk, operation, and evidence in text/JSON status.

Acceptance criteria:

- No active Codex process remains after `waiting_approval` is persisted.
- Approval and rejection survive process restarts.
- Approval response is associated with one approval ID and supplied as delimited task data.
- Ambiguous or stale approval commands fail without state mutation.
- Default merge policy remains compatible with the current skill.

Definition of Done contribution:

- Implements the durable human boundary required for high-impact operations.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.

Progress:

- Record approval lifecycle evidence and set Step 8 as next.

Changelog:

- Add `Added` entry for resumable human approvals and optional human merge gating.

Commit:

- `feat: add durable approval checkpoints`

### Step 8: Detached Worker and Lease Recovery

Goal: Execute queued runs and recover expired work under an external process supervisor.

Depends on:

- Steps 0 through 7.

Changes:

- Implement `worker [--once] [--poll-interval]` with atomic claim, oldest-queued ordering, expired-lease recovery, graceful idle polling, and shutdown.
- Reuse the same supervisor service as foreground mode; do not create a second execution path.
- Ensure one worker can process multiple repositories sequentially while repository leases prevent duplicates.
- Add recovery selection rules that exclude approval, external blocker, terminal, and explicit-failure states.
- Document example `launchd` and systemd supervision without installing either service.
- Add two-worker contention and stale-worker integration tests.

Acceptance criteria:

- Two worker processes cannot execute the same run concurrently.
- An expired active lease is reclaimed once and resumes through the recovery prompt.
- Waiting and terminal states are never auto-claimed.
- `worker --once` exits after one claimed run or immediately when no work exists.
- Worker shutdown releases only its own lease.

Definition of Done contribution:

- Enables unattended local execution with process-restart recovery while remaining single-host.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run a fake detached run through `worker --once` in a temporary state directory.

Progress:

- Record contention and recovery evidence and set Step 9 as next.

Changelog:

- Add `Added` entry for detached worker execution and stale-lease recovery.

Commit:

- `feat: process queued runs with durable worker`

### Step 9: Event Inspection and Operator Observability

Goal: Make every persisted run and turn auditable without a dashboard.

Depends on:

- Steps 0 through 8.

Changes:

- Implement `events RUN_ID [--follow] [--json]` with ordered replay and polling follow mode.
- Extend status output with turn summaries, usage totals, lease owner/expiry, heartbeat age, state fingerprint, no-progress count, pending approval, blocker, and last error.
- Add stable text rendering for command execution, file changes, MCP calls, agent messages, errors, and usage while keeping JSON output lossless after redaction.
- Ensure renderers never mutate persisted payloads.
- Add structured event export tests and follow-mode cancellation tests.

Acceptance criteria:

- A new process can replay all events in exact persisted order.
- JSON output is machine-readable JSONL for events and stable JSON for status.
- Text output clearly distinguishes harness state from model claims.
- Secret fixtures are redacted in database, text, and JSON output.

Definition of Done contribution:

- Supplies the post-hoc trust and debugging surface required for autonomous runs.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.

Progress:

- Record replay/redaction evidence and set Step 10 as next.

Changelog:

- Add `Added` entry for event replay, follow mode, and expanded run status.

Commit:

- `feat: expose durable run event history`

### Step 10: Security and Failure-Mode Hardening

Goal: Validate blast-radius, prompt-injection, credential, and corruption boundaries.

Depends on:

- Steps 0 through 9.

Changes:

- Add adversarial CLI tests for shell metacharacters, Unicode confusables, newlines, traversal, invalid run IDs, malicious approval messages, and malformed model envelopes.
- Verify all subprocess calls use argument arrays and explicit timeouts.
- Verify database/state permissions and redaction under failure paths.
- Add tests for corrupt SQLite files, migration mismatch, disk-full/write failure, unavailable `gh`, unavailable Codex, and unwritable worktree root.
- Add repository trust warnings for local instructions, hooks, MCP configuration, and executable scripts.
- Add `docs/security.md` documenting sandbox limits, authenticated network effects, trust requirements, credential handling, and recovery risks.
- Run dependency audit and classify findings without weakening versions or gates.

Acceptance criteria:

- No user-controlled value reaches a shell command string.
- Secret fixtures never persist or print.
- Corruption and disk-write failures stop execution rather than running without durable state.
- Missing GitHub/Codex dependencies fail before autonomous work.
- Security documentation states that workspace sandboxing does not constrain GitHub account permissions.

Definition of Done contribution:

- Hardens the harness at its highest-risk input and side-effect boundaries.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun audit` and record results.

Progress:

- Record security scenarios and audit disposition, then set Step 11 as next.

Changelog:

- Add `Security` entry for hardened input, persistence, credential, and trust boundaries if observable protections changed.

Commit:

- `security: harden harness execution boundaries`

### Step 11: Documentation, CI, and Final Acceptance

Goal: Make the harness operable, maintainable, and ready for controlled use.

Depends on:

- Steps 0 through 10.

Changes:

- Complete `README.md` with installation, doctor, foreground run, detached run, worker, status, events, resume, approvals, cancellation, model inheritance, and examples.
- Complete `docs/architecture.md` with ownership layers, state machine, SQLite schema, turn-level durability boundary, recovery sequence, and why role orchestration remains in skills.
- Complete `docs/operations.md` with state paths, backups, WAL files, worker supervision examples, stale leases, recovery, budget tuning, and incident procedures.
- Complete `docs/security.md` with the final reviewed threat boundary.
- Verify `.github/workflows/ci.yml` uses frozen installation and aggregate gates.
- Add final CLI black-box tests for help and every command's success and failure exit codes.
- Run the entire default test/gate suite from a clean install.
- Run the opt-in live smoke test only with explicit authorization and credentials; otherwise document it as an operator gate before first real run.
- Reconcile `PROGRESS.md` and `CHANGELOG.md` and record all known limitations.

Acceptance criteria:

- A new operator can understand durability guarantees, limitations, safety flags, and recovery without reading source code.
- Every CLI command and exit code is documented and tested.
- CI and local `verify` run the same canonical gates.
- No implementation requirement or test remains unaccounted for.
- The repository is clean except for intentionally uncommitted user files that predated implementation.

Definition of Done contribution:

- Completes all functional, operational, validation, and documentation requirements.

Validation:

- Remove dependencies and run `bun install --frozen-lockfile`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun audit`.
- Run built CLI help, doctor against this repository, fake detached lifecycle, fake worker lifecycle, status, events, approval, resume, and cancel smoke scenarios.
- If explicitly authorized, run `AGENTLOOP_LIVE=1 bun test test/live --timeout 120000`.

Progress:

- Mark Step 11 and the overall plan complete, record final validation and commit references, summarize known limitations, and set next step to none.

Changelog:

- Update existing `Unreleased` entries only for observable behavior finalized in this step. Do not add entries for docs, CI, tests, or validation alone.

Commit:

- `docs: finalize agentloop operations`

## Execution Rule for Every Implementation Step

After completing each implementation step:

1. Run all quality gates: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`.
2. Fix every new failure before proceeding; prove whether an unexpected failure is pre-existing before documenting it as baseline.
3. Update `PROGRESS.md` with the completed step, exact validation results, commit reference if available, current status, and next step.
4. Update `CHANGELOG.md` under `## [Unreleased]` only when the step shipped an observable functional or security change, using the appropriate Keep a Changelog heading and omitting empty headings.
5. Create the focused commit specified by the step before starting the next step.
