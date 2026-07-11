# Bounded Supervisor Implementation Progress

## Plan Sources

- `PLAN.md`: bounded-turn supervisor, checkpoint, outcome-progress, context, evidence, and operator-efficiency implementation plan.
- `AGENTS.md`: Bun-only toolchain, strict TypeScript, fake-backed default tests, and explicit repository trust rules.
- `docs/architecture.md`: Agentloop owns durable runs, limits, events, leases, recovery, and state transitions while installed skills own workflow semantics.
- `docs/operations.md`: local run state, foreground/worker behavior, event output, stale-lease recovery, and incident handling.
- `docs/security.md`: trust, credential, subprocess, persistence, and redaction constraints.
- `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`: coordinator policy affected by bounded ledgers, closure-first scheduling, and review caps.
- `/Users/alexmetelli/.agents/skills/team-coordinator/SKILL.md`: scheduling policy affected by nearest-to-merge reservation and speculative-stream limits.
- `/Users/alexmetelli/.agents/skills/agent-team-status-protocol/SKILL.md`: hot `STATUS.md` index and shard policy.

## Checklist

- [x] Step 0: Progress and changelog tracking setup.
- [x] Step 1: Characterize current turn, cancellation, and persistence semantics.
- [x] Step 2: Introduce and enforce the `BoundedTurnSupervisor`.
- [x] Step 3: Persist typed checkpoints and complete usage state.
- [x] Step 4: Replace activity fingerprints with `OutcomeProgress`.
- [x] Step 5: Split compact checkpoints from final control messages.
- [x] Step 6: Bound hot context and enforce closure-first review policy.
- [ ] Step 7: Add strict exact-head evidence reuse.
- [ ] Step 8: Expose outcome efficiency, document operations, and run final gates.

## Baseline

- Current branch: `main` tracking `origin/main`.
- Pre-existing dirty files before Step 0: none (`git status --short --branch` reported `## main...origin/main`).
- Prior progress history is preserved below under "Prior Label Dispatch Progress".
- `CHANGELOG.md` already has `# Changelog`, the Keep a Changelog preamble, and one `## [Unreleased]` section.

## Current Status

- Status: Step 6 complete and validated in both Agentloop and installed skills.
- Next step: Step 7 strict exact-head evidence reuse.

## Update Rules

- Update this file after each completed step with validation results, commit reference if available, current status, and the next step.
- Update `CHANGELOG.md` before each step commit only when the completed step ships a functional change.
- Keep Agentloop and installed-skills commits separate when a step touches both repositories.
- Preserve unrelated user-owned changes and stage only the completed step's intended files.

## Update Log

- 2026-07-11: Reconciled progress tracking for the bounded-supervisor plan, recorded the clean baseline, preserved prior label-dispatch progress history, and confirmed `CHANGELOG.md` already satisfies the plan's top-level structure.
- 2026-07-11: Step 0 validation passed: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`. Test summary: 73 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 0 Agentloop commit subject: `chore: initialize bounded-supervisor progress tracking`.
- 2026-07-11: Step 1 characterized current stream termination semantics: SDK failure after `thread.started` saves the thread ID, records a failed zero-usage turn, and increments consecutive failures; a stream ending without `turn.completed` currently completes with zero usage; signal abort remains `cancelled`.
- 2026-07-11: Step 1 added deterministic controlled stream and fake scheduler support for Step 2 deadline/stall tests, plus a SQLite v1 limits readability test.
- 2026-07-11: Step 1 validation passed: targeted `bun test test/unit/foreground-run.test.ts test/unit/sqlite-run-store.test.ts --timeout 10000`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`. Test summary: 76 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 1 Agentloop commit subject: `test: characterize bounded turn termination semantics`.
- 2026-07-11: Step 2 added `BoundedTurnSupervisor`, an injectable scheduler, production scheduler, cooperative tranche and hard-deadline run limits, legacy limit normalization, event-stall classification, and failure-cap enforcement before another SDK turn starts.
- 2026-07-11: Step 2 tests covered cooperative tranche continuation into a second turn, distinct event-stall and hard-deadline failures, current SDK failure/cancellation behavior, missing official usage characterization, and version-1 limits defaulting.
- 2026-07-11: Step 2 validation passed: targeted `bun test test/unit/foreground-run.test.ts test/unit/sqlite-run-store.test.ts --timeout 10000`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`. Test summary: 80 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 2 Agentloop commit subject: `feat: bound Codex work into supervised tranches`.
- 2026-07-11: Step 3 added SQLite schema version 2 with turn `abort_reason` and `usage_complete` fields plus durable checkpoints, store create/list/latest checkpoint APIs, supervisor usage-completeness propagation, and status text/JSON checkpoint visibility.
- 2026-07-11: Step 3 tests covered migration shape, checkpoint persistence, incomplete official usage, SDK-failure abort reasons, supervised abort checkpoints, and status rendering for latest checkpoint and turn usage completeness.
- 2026-07-11: Step 3 validation passed: targeted `bun run typecheck && bun test test/unit/foreground-run.test.ts test/unit/sqlite-run-store.test.ts --timeout 10000` and final `bun run verify`. Test summary: 82 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 3 Agentloop commit subject: `feat: persist supervised tranche checkpoints`.
- 2026-07-11: Step 4 replaced activity fingerprints with `collectOutcomeProgress`, persisted unique material outcome keys, added `last_useful_outcome_at`, removed `src/infrastructure/fingerprint.ts`, and exposed outcome counts in status output.
- 2026-07-11: Step 4 tests covered stable Git/GitHub outcome keys, ignored activity/timestamp fields, fail-closed unavailable sources, idempotent outcome storage, and unchanged-outcome no-progress behavior.
- 2026-07-11: Step 4 validation passed: targeted `bun run format && bun run typecheck && bun test test/unit/outcome-progress.test.ts test/unit/sqlite-run-store.test.ts test/unit/foreground-run.test.ts --timeout 10000`, then `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`. Test summary: 85 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 4 Agentloop commit subject: `feat: track material outcomes instead of activity`.
- 2026-07-11: Step 5 split control messages into `kind: "checkpoint"` and `kind: "final"`, required final messages for turn completion, persisted valid checkpoint messages during streams, and updated prompts to request compact checkpoint deltas plus final closure evidence only at the end.
- 2026-07-11: Step 5 tests covered strict union schemas, final discriminator parsing, compact checkpoint parsing, checkpoint-before-final persistence, final-only completion, approval/blocker finals, security fixtures, and CLI black-box flows.
- 2026-07-11: Step 5 validation passed: targeted `bun run typecheck && bun test test/unit/codex-contracts.test.ts test/unit/foreground-run.test.ts --timeout 10000`, then `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`. Test summary: 87 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 5 Agentloop commit subject: `feat: separate checkpoint and final control messages`.
- 2026-07-11: Step 6 Agentloop changes added hot `STATUS.md` size inspection before each tranche, compaction/sharding prompt instructions, checkpoint shard-path normalization, a recoverable `review_cycle_exhausted` run status, and checkpoint-driven review-cycle-cap stopping before another continuation.
- 2026-07-11: Step 6 installed-skill changes updated coordinator/status policy for bounded hot status shards, closure-first slot reservation, one speculative stream while PR work is blocked, early draft PRs, exact-head finding batches, and review-cycle-cap stopping.
- 2026-07-11: Step 6 validation passed: targeted `bun run typecheck` and `bun test test/unit/foreground-run.test.ts --timeout 10000`, full `bun run format && bun run verify`, `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json /Users/alexmetelli/.agents/skills/team-coordinator/evals/evals.json /Users/alexmetelli/.agents/skills/agent-team-status-protocol/evals/evals.json`, and `git -C /Users/alexmetelli/.agents/skills diff --check`. Test summary: 89 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded.
- 2026-07-11: Step 6 Agentloop commit subject: `feat: bound hot coordination context and review cycles`.
- 2026-07-11: Step 6 installed-skills commit: `ea2bc42` (`feat: prioritize closure in bounded agent loops`).

---

# Prior Label Dispatch Progress

# Label Dispatch Implementation Progress

## Plan Sources

- `PLAN.md`: label-scoped `agentloop dispatch` implementation plan.
- `AGENTS.md`: Bun-only toolchain, strict TypeScript, fake-backed tests, and explicit repository trust rules.
- `docs/architecture.md`: Agentloop owns durable execution while installed skills own workflow semantics.
- `docs/operations.md`: local worker supervision and recovery contract.
- `docs/security.md`: trust, credential, subprocess, and persistence constraints.
- `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`: coordinator workflow contract.
- `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/references/sub-agent-prompts.md`: role boundary reference.

## Checklist

- [x] Step 0: Progress and changelog tracking setup.
- [x] Step 1: Ready-issue discovery and scope contract.
- [x] Step 2: Idempotent dispatch CLI and durable queueing.
- [x] Step 3: Durable run identity in coordinator prompts.
- [x] Step 4: GitHub-visible claim protocol in installed skills.
- [x] Step 5: Operator polling, security, and recovery documentation.
- [x] Step 6: Final acceptance and `/goal` closure evidence.

## Baseline

- `bun run verify` passed on 2026-07-10 with 55 tests passed, 1 opt-in live test skipped, and a successful build.

## Repository State

- Agentloop before Step 0: `PLAN.md` was untracked; no other Agentloop changes were present.
- Installed skills before Step 0: `agent-team-status-protocol/SKILL.md`, `codex-dev-team-goal/SKILL.md`, and `team-coordinator/SKILL.md` had pre-existing uncommitted edits and are treated as user-owned until Step 4 reconciliation.

## Current Status

- Status: Complete.
- Next step: deferred follow-up work only; no discovery producer, webhook, scheduler installation, PII path, or distributed claim mechanism was implemented.

## Update Rules

- Update this file after each completed step with validation results, commit references, current status, and the next step.
- Record Agentloop and installed-skills commits separately.
- Do not imply installed-skill changes are committed when only Agentloop has a commit.

## Update Log

- 2026-07-10: Created progress tracking from `PLAN.md` and recorded initial repository state.
- 2026-07-10: Step 0 validation passed: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run verify`, `git diff --check`, and `git -C /Users/alexmetelli/.agents/skills diff --check`.
- 2026-07-10: Step 0 Agentloop commit: `5e4cb2d` (`docs: initialize label dispatch implementation tracking`).
- 2026-07-10: Step 1 added `src/application/dispatch.ts` and `test/unit/dispatch.test.ts` for label preflight, deterministic ready-issue discovery, fail-closed JSON parsing, cap handling, and scope-only objective construction.
- 2026-07-10: Step 1 validation passed: `bun test test/unit/dispatch.test.ts`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run verify`, and `git diff --check`.
- 2026-07-10: Step 1 Agentloop commit: `65fe7f1` (`feat: add ready issue discovery contract`).
- 2026-07-10: Step 2 added `agentloop dispatch`, stable text/JSON outcomes, shared queued-run creation, open-run idempotency lookup, and fake-backed CLI/store/security/lifecycle coverage.
- 2026-07-10: Step 2 validation passed: targeted dispatch CLI/store/security tests, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run verify`, and `git diff --check`.
- 2026-07-10: Step 2 Agentloop commit: `0e12b56` (`feat: queue label scoped agentloop runs`).
- 2026-07-10: Step 3 added durable run IDs to every coordinator prompt header and covered initial, continuation, recovery, and approval-response prompt construction.
- 2026-07-10: Step 3 validation passed: targeted prompt/foreground tests, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run verify`, and `git diff --check`.
- 2026-07-10: Step 3 Agentloop commit: `9ac78c7` (`feat: expose run identity to coordinator turns`).
- 2026-07-10: Step 4 added the installed `codex-dev-team-goal` label-scoped dispatch claim protocol and eval case. Skills-repo commit: `17021eb` (`feat: add agentloop issue claim protocol`).
- 2026-07-10: Step 4 validation passed: `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json`, `git -C /Users/alexmetelli/.agents/skills diff --check`, `git -C /Users/alexmetelli/.agents/skills diff --cached --check`, `bun dist/cli.js doctor --repo . --json`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`.
- 2026-07-10: Step 4 installed-skill fingerprint from doctor: `e83051cb25937423435cf96d6d8861ac05ff818cae553fd279e594ef0e1cb087`. Existing runs with prior fingerprints must use the existing skill-change approval or `--accept-skill-change` flow before resume.
- 2026-07-10: Step 4 skills-repo note: pre-existing unstaged edits remain in `agent-team-status-protocol/SKILL.md`, `codex-dev-team-goal/SKILL.md`, and `team-coordinator/SKILL.md`; only the dispatch protocol hunk and eval case were committed.
- 2026-07-10: Step 4 Agentloop commit: `b47e474` (`docs: record dispatch claim integration`).
- 2026-07-10: Step 5 documented dispatch syntax, fixed labels, dry-run/JSON output, worker handoff, polling no-op states, label setup, `launchd` shape, claim recovery, skill-fingerprint resume handling, and dispatch security boundaries.
- 2026-07-10: Step 5 validation passed: built CLI help/content checks, `rg` documentation checks, `git diff --check`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run verify`.
- 2026-07-10: Step 5 Agentloop commit: `8e6360a` (`docs: document label dispatch operations`).
- 2026-07-10: Step 6 final acceptance passed: built CLI help check, changelog category sanity check, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run verify`, `bun audit`, `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json`, Agentloop `git diff --check`, skills-repo `git diff --check`, and `bun dist/cli.js doctor --repo . --json`.
- 2026-07-10: Step 6 final test summary: 69 default tests passed, 1 opt-in live SDK smoke test skipped, build succeeded, and `bun audit` reported no vulnerabilities.
- 2026-07-10: Step 6 final doctor fingerprint: `e83051cb25937423435cf96d6d8861ac05ff818cae553fd279e594ef0e1cb087`; required skill checks passed with repository-surface warnings only.
- 2026-07-10: Step 6 install note: `bun install --frozen-lockfile` was not required because dependencies and `bun.lock` were unchanged.
- 2026-07-10: Step 6 repository state: Agentloop was clean before this final progress update and ahead of `origin/main` by six commits; skills repo was ahead by `17021eb` and retained pre-existing unstaged edits in `agent-team-status-protocol/SKILL.md`, `codex-dev-team-goal/SKILL.md`, and `team-coordinator/SKILL.md`.
- 2026-07-10: Step 6 deferred follow-ups: a read-only health producer and cross-host stale-claim reconciliation remain future plans and were not implemented.
- 2026-07-10: Step 6 Agentloop commit subject: `docs: record label dispatch acceptance`.
