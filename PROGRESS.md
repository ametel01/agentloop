# Agentloop Implementation Progress

Source: `PLAN.md`

## Tracking Rules

- Update this file after every completed implementation step.
- Each completed step must record validation results, current status, next step, and the commit reference once available.
- Record baseline failures, SDK compatibility results, live-test skip reasons, migration version, and known durability limitations as they appear.
- Update `CHANGELOG.md` after each completed and validated step only when that step ships a functional change.

## Source Documents

- `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`
- `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/references/sub-agent-prompts.md`
- `/Users/alexmetelli/.agents/skills/team-coordinator/SKILL.md`
- `/Users/alexmetelli/.agents/skills/agent-team-status-protocol/SKILL.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/djfarrelly-agent-loop-architecture-2026-06-19.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/mem0-loop-engineering-memory-2026-06-18.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/shmidt-loop-engineering-brakes-259-prs-2026-06-21.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/zodchiii-claude-code-agent-team-loops-2026-06-16.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/vercel-eve-2026-06-18.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/atai-self-learning-agents-user-signal-2026-06-24.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/hanako-self-updating-prompt-2026-06-19.md`
- `/Users/alexmetelli/source/alex-okf/raw/articles/movez-kimi-self-improving-loop-2026-06-18.md`

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Toolchain and Quality Gates Setup
- [x] Step 2: Domain Contracts and Doctor Command
- [x] Step 3: Durable Ledger and Run Lifecycle Commands
- [x] Step 4: Codex SDK Adapter and Foreground Coordinator Run
- [x] Step 5: Continuation, Resume, and Crash Recovery
- [x] Step 6: Budgets, Circuit Breakers, Heartbeats, and Progress Detection
- [ ] Step 7: Durable Human Approval Flow
- [ ] Step 8: Detached Worker and Lease Recovery
- [ ] Step 9: Event Inspection and Operator Observability
- [ ] Step 10: Security and Failure-Mode Hardening
- [ ] Step 11: Documentation, CI, and Final Acceptance

## Current Status

- Completed step: Step 6
- Current implementation focus: Step 7
- Next step: Step 7: Durable Human Approval Flow
- Last completed commit: Step 6, `feat: enforce run safety limits`

## Validation Log

### Step 0: Progress and Changelog Tracking Setup

- Status: Complete
- Validation:
  - `PROGRESS.md` created with source list, update rules, and Steps 0 through 11.
  - `CHANGELOG.md` created with Keep a Changelog 1.0.0 preamble and `## [Unreleased]`.
- Changelog: No entry added because tracking setup is not a functional change.
- Commit: `0545985`

### Step 1: Toolchain and Quality Gates Setup

- Status: Complete
- Validation:
  - `bun install --frozen-lockfile` passed from a clean dependency directory.
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed.
  - `bun run build` passed.
  - `bun run verify` passed.
  - `bun run dist/cli.js --help` exited zero and printed scaffold usage.
- Baseline result: quality gates are established and passing.
- Changelog: No entry added because toolchain setup is not observable product behavior.
- Commit: `613af2a`

### Step 2: Domain Contracts and Doctor Command

- Status: Complete
- Validation:
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed with 5 tests.
  - `bun run build` passed.
  - `bun run verify` passed.
  - `bun run dist/cli.js doctor --repo . --json` exited zero and produced 21 checks, 0 failures, and 4 expected warnings for local repository surfaces plus the trust boundary.
- Doctor behavior:
  - Resolves the canonical Git root.
  - Checks Codex CLI availability, pinned SDK import, GitHub CLI availability, and GitHub CLI authentication.
  - Resolves the local state directory and generated worktree root.
  - Hashes required dev-team skill files and the `sub-agent-prompts.md` reference without loading skill bodies into prompts.
  - Emits stable text or JSON output with warnings for repository instruction/config surfaces.
- Changelog: Added entry for `agentloop doctor`.
- Commit: `feat: add repository and skill preflight`

### Step 3: Durable Ledger and Run Lifecycle Commands

- Status: Complete
- Validation:
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed with 12 tests.
  - `bun run build` passed.
  - `bun run verify` passed.
  - Temporary Git repository smoke passed with `run --detach`, `status --json` from a separate CLI process, `cancel --reason`, and `status --json` confirming `cancelled`.
- Ledger behavior:
  - SQLite Migration 1 creates `runs`, `turns`, `events`, `approvals`, `leases`, indexes, and the partial unique open-run index.
  - Database initialization applies WAL, foreign keys, busy timeout, synchronous normal, state directory mode `0700`, and database file mode `0600`.
  - `run --detach` requires `--trust-repo`, runs doctor preflight, records a queued run, persists the skill fingerprint, objective hash, repository key, limits, and worktree root, and does not instantiate Codex.
  - `status [RUN_ID] [--json]` reads durable state across CLI invocations.
  - `cancel RUN_ID [--reason]` transitions only queued runs to `cancelled`.
  - Store tests cover migration idempotence, future schema rejection, duplicate open-run conflict, invalid transition rejection, permission modes, and conditional lease release.
- Migration version: 1
- Changelog: Added entry for durable queued runs, status, and cancellation.
- Commit: `feat: persist run lifecycle in sqlite`

### Step 4: Codex SDK Adapter and Foreground Coordinator Run

- Status: Complete
- Validation:
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed with 17 tests and 1 skipped opt-in live test.
  - `bun run build` passed.
  - `bun run verify` passed.
  - Source check confirmed `src/codex` and `src/cli.ts` do not hardcode role-skill names such as builder/checker/reviewer agents; the fixed prompt only invokes `$codex-dev-team-goal`.
- Adapter behavior:
  - Added production `@openai/codex-sdk` streaming adapter and a `CodexRunner` port for fake-backed default tests.
  - Builds production thread options with workspace-write sandbox, generated worktree root, network enabled, web search disabled, approval policy never, and no model/reasoning override keys when omitted.
  - Adds the fixed initial prompt template with delimited target work and required final control envelope.
  - Adds strict control-envelope schema and independent parser validation.
  - Persists streamed SDK events with monotonic sequence numbers, redacted payload JSON, durable `thread_id` on `thread.started`, usage accounting, and terminal state transitions.
  - Marks malformed envelopes and stream failures as failed runs.
  - Adds `test/live/sdk-smoke.test.ts`, skipped unless `AGENTLOOP_LIVE=1`, for start/resume SDK compatibility without GitHub writes.
- Live SDK smoke test: skipped because Step 4 validation did not explicitly authorize model calls; run manually with `AGENTLOOP_LIVE=1 bun test test/live --timeout 120000`.
- Changelog: Added entry for foreground Codex dev-team execution and streamed progress.
- Commit: `feat: run codex dev team in foreground`

### Step 5: Continuation, Resume, and Crash Recovery

- Status: Complete
- Validation:
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed with 22 tests and 1 skipped opt-in live test.
  - `bun run build` passed.
  - `bun run verify` passed.
- Recovery scenarios:
  - Normal `continue` envelopes start another outer turn and reuse the persisted thread ID.
  - `resume RUN_ID` with a saved thread ID uses the recovery prompt and passes that thread ID to the Codex runner.
  - `resume RUN_ID` after interruption before `thread.started` starts a new recovery thread when no SDK events were persisted.
  - Resume is refused when SDK events exist but no durable thread ID was recorded.
  - Skill fingerprint changes create a durable `skill_change` approval request and transition to `waiting_approval` unless `--accept-skill-change` is supplied.
- Changelog: Added entry for durable continuation, resume, recovery prompts, and skill-change blocking.
- Commit: `feat: resume interrupted codex runs safely`

### Step 6: Budgets, Circuit Breakers, Heartbeats, and Progress Detection

- Status: Complete
- Validation:
  - `bun run format:check` passed.
  - `bun run lint` passed.
  - `bun run typecheck` passed.
  - `bun run test` passed with 27 tests and 1 skipped opt-in live test.
  - `bun run build` passed.
  - `bun run verify` passed.
- Boundary behavior:
  - Hard turn budgets stop before the next continuation turn.
  - Hard token budgets count input, output, and reasoning tokens while excluding cached input tokens.
  - Progress fingerprints include explicit source states for `STATUS.md`, Git status, worktrees, GitHub issues, and GitHub PRs.
  - Repeated unchanged fully available fingerprints transition the run to `stuck`.
  - Failed GitHub fingerprint collection does not increment no-progress state.
  - Active runs renew their repository lease on the configured heartbeat interval.
  - SIGINT/SIGTERM abort the active turn through `AbortController` and persist a consistent `cancelled` state.
- Changelog: Added entry for run safety limits, progress detection, heartbeat renewal, and signal cancellation handling.
- Commit: `feat: enforce run safety limits`

## Run Notes

- Baseline quality gates: established in Step 1 and passing.
- SDK compatibility: production SDK import and default fake-backed streaming adapter tests pass; opt-in live start/resume smoke exists but was skipped.
- SDK import compatibility: `@openai/codex-sdk@0.144.1` imports under Bun during `doctor`.
- Live SDK smoke test: skipped in Step 4 because model calls were not explicitly authorized.
- Migration version: 1.
- Known durability limitations: continuation, explicit resume/recovery, budgets, progress fingerprinting, heartbeat renewal, and signal cancellation exist; detached worker recovery and full approval command handling are not implemented yet.
