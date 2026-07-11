# Implementation Plan

## Source Documents

- Path: `/private/tmp/agentloop-architecture-review-2026-07-10.html`
  - Role: Primary architecture review and implementation brief.
  - Summary: Diagnoses unbounded Codex turns, activity-based progress detection, verbose control envelopes, oversized hot ledgers, throughput-first scheduling, and repeated exact-head evidence collection. Recommends a bounded-turn supervisor first, followed by outcome progress, compact checkpoint/final messages, context limits, closure-first skill policy, and exact-head evidence reuse.
- Path: `/Users/alexmetelli/source/agentloop/AGENTS.md`
  - Role: Repository implementation constraints.
  - Summary: Requires Bun, strict TypeScript, `bun run verify`, offline fake-backed default tests, explicit repository trust, credential-safe persistence, and a thin harness around installed skills.
- Path: `/Users/alexmetelli/source/agentloop/docs/architecture.md`
  - Role: Existing harness ownership boundary.
  - Summary: Assigns durable runs, limits, events, leases, recovery, and state transitions to Agentloop while reserving issue/PR workflow semantics and role behavior for installed skills.
- Path: `/Users/alexmetelli/source/agentloop/docs/operations.md`
  - Role: Existing operator and recovery contract.
  - Summary: Defines state paths, foreground and worker behavior, current budgets, event output, stale-lease recovery, and incident handling that the bounded-turn design must preserve.
- Path: `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`
  - Role: Installed coordinator policy affected by the review.
  - Summary: Owns issue-to-merge scheduling, review cycles, closure gates, and hot `STATUS.md` discipline; it must carry closure-first and bounded-ledger policy instead of duplicating those semantics in TypeScript.
- Path: `/Users/alexmetelli/.agents/skills/team-coordinator/SKILL.md`
  - Role: Supporting scheduling policy.
  - Summary: Currently favors parallel saturation and tracks cycle counts; it needs a compatible nearest-to-merge reservation and speculative-stream limit.
- Path: `/Users/alexmetelli/.agents/skills/agent-team-status-protocol/SKILL.md`
  - Role: Supporting hot-state policy.
  - Summary: Defines `STATUS.md` as concise hot team memory and `STATUS.archive.md` as cold history; it is the semantic home for sharding and compaction rules.

## Goals

- Bound every Codex outer turn to a cooperative tranche of at most 10 minutes, with a separate hard deadline and event-stall deadline that are enforced while the stream is open.
- Convert tranche expiry, stream stall, operator cancellation, SDK failure, budget exhaustion, and review-cycle exhaustion into distinct typed outcomes with safe durable transitions.
- Persist a checkpoint after every tranche so official usage, usage completeness, active-agent deltas, material outcomes, blockers, and the next action are regularly visible.
- Replace activity fingerprints with durable outcome progress: pushed commits, PR creation/advancement/merge, issue closure, resolved review findings, and newly classified blockers.
- Ensure tracker edits, dirty files, repeated commands, broad GitHub timestamps, and unchanged agent snapshots do not reset no-progress detection.
- Split compact checkpoint messages from final closure envelopes, deduplicate unchanged roster snapshots, and require full closure evidence only for final completion.
- Keep hot coordination state bounded and local: detect an oversized `STATUS.md`, direct compaction/sharding before new assignment, and pass agents the owned shard rather than repeated broad ledger reads.
- Make closure-first scheduling explicit in installed skills and prevent a configured review-cycle cap from silently rolling into another cycle.
- Reuse exact-head evidence only under strict SHA or stable-patch, relevant-input, environment, and gate-version equivalence.
- Expose operator ratios for tokens, elapsed time, and review cycles per material outcome without adding telemetry services or new default network calls.

## Non-Goals

- Do not copy installed skill bodies, coordinator policy, role prompts, GitHub workflow logic, or issue semantics into Agentloop TypeScript.
- Do not replace the Codex SDK, build a hosted control plane, add a daemon beyond the existing worker, or add model/GitHub/network calls to default tests.
- Do not estimate missing official token usage from text size and present it as official usage. Aborted or incomplete usage must be marked incomplete.
- Do not treat command count, file dirtiness, `STATUS.md` edits, worktree creation, PR `updatedAt`, or issue `updatedAt` as material outcomes.
- Do not cache final merge acceptance, human approvals, secrets, process environments, full command output, full authentication output, or mutable hosted state without exact equivalence inputs.
- Do not make Agentloop parse or own the internal prose format of `STATUS.md`; the harness may measure size/line count and carry shard paths supplied through typed control messages.
- Do not automatically rewrite or delete a target repository's oversized ledger. Compaction and sharding remain coordinator actions under installed-skill policy.
- Do not publish packages, deploy services, run production goals, migrate target repositories, or modify unrelated user changes in the current dirty worktree.

## Definition of Done

- `executeSingleTurn` no longer owns timing, stream observation, abort classification, checkpoint persistence, and transition policy in one CLI function. A deep `BoundedTurnSupervisor` interface owns those responsibilities and returns a typed tranche outcome.
- Default policy uses a 10-minute cooperative tranche, a slightly longer hard turn deadline, and an event-stall deadline. Persisted policies are validated, old version-1 run rows receive safe defaults when read, and operators can inspect the effective limits.
- An endless fake stream ends as `continuing` at tranche expiry; an event-stalled fake stream ends with a distinct recoverable stall reason; Ctrl-C remains `cancelled`; true SDK failures remain failures.
- `maxConsecutiveTurnFailures` is enforced before another turn starts. A tranche timeout or controlled stall does not consume the operator-cancellation path or masquerade as an SDK failure.
- Each bounded completion persists a checkpoint and a usage-completeness marker. Official SDK usage is recorded when emitted; interrupted turns explicitly report incomplete/unavailable usage instead of durable zero usage.
- Progress observation produces typed `OutcomeDelta` records. One pushed SHA or one resolved review finding creates exactly one useful outcome; idempotent re-observation creates none.
- `STATUS.md`-only edits, dirty worktree changes, repeated commands/checks, worktree-list churn, and timestamp-only GitHub changes do not reset `noProgressCount`.
- No-progress uses time since the last useful outcome plus bounded-turn counts, and preserves fail-closed behavior when required outcome sources are unavailable.
- Control messages form a strict discriminated `checkpoint | final` union. Checkpoints carry only changed roster entries, material outcomes, blocker/approval changes, review-cycle state, next action, and optional owned status shard. Final messages alone carry complete closure evidence.
- Identical checkpoint snapshots are deduplicated. The last agent message is no longer blindly accepted as final; completion requires a valid `final` message, while valid checkpoints remain durable observations.
- An oversized hot ledger (more than 200 lines or 64 KiB by default) produces a clear compaction/sharding instruction before further assignment. `STATUS.md` remains a compact index and per-stream detail can live under `STATUS.d/<issue-or-pr>.md`.
- Installed coordinator/status skills reserve one agent slot for the nearest-to-merge PR, allow at most one speculative stream while a PR is blocked, open a draft PR after the first pushed focused-gate-green commit, batch a complete finding set per head, and stop at the configured review-cycle cap.
- The harness rejects or stops advancement when typed checkpoint state would enter review cycle `N+1` after the configured cap; it records the exact PR/cycle evidence and next required decision.
- Exact-head evidence is reused only when head SHA or stable patch ID, relevant-input digest, environment fingerprint, and gate version all match. Product-code changes invalidate affected evidence; docs/tracker-only changes may reuse unaffected evidence only when the declared input set proves that equivalence.
- Failure signatures for external/configuration blockers are reusable under the same strict keys, so the same known blocker is not rediscovered every tranche.
- `status` text/JSON exposes last useful outcome, checkpoint age, usage completeness, outcome counts, review-cycle counts, and tokens/time/cycles per outcome while redacting sensitive data.
- SQLite migration is transactional and backward compatible. Existing version-1 databases migrate without losing runs, turns, events, approvals, or leases; newer unknown schemas still fail closed.
- Default tests use fake Codex, commands, filesystem, clock/scheduler, IDs, and SQLite. They make no live GitHub, model, or network calls and cover deadlines, stalls, cancellation, failure caps, outcome idempotency, message parsing/deduplication, ledger limits, review caps, migration, cache invalidation, redaction, and existing run recovery.
- README, architecture, operations, and security documentation explain tranche semantics, typed aborts, incomplete usage, outcome progress, ledger limits/shards, closure-first scheduling, evidence reuse/invalidation, operator ratios, recovery, and rollback.
- `bun run verify` and `bun audit` pass from `/Users/alexmetelli/source/agentloop`; changed installed-skill JSON files pass `jq empty`; skill eval fixtures cover the new closure-first, ledger, and review-cap rules.
- `PROGRESS.md` and `CHANGELOG.md` are current. Each implementation step is committed independently without sweeping in the unrelated changes that predated this plan.

## Assumptions and Open Questions

- Assumption: The review's “8–10 minute tranche” is implemented as a 10-minute default cooperative deadline. The hard deadline should be longer than the cooperative deadline so a final checkpoint can flush, but still bounded; use 11 minutes unless SDK abort behavior requires a documented smaller grace period.
- Assumption: The existing `eventStallWarningMs` becomes an enforced stall policy rather than a warning-only declaration. Preserve compatibility with persisted JSON and document the semantic change.
- Assumption: A controlled tranche timeout transitions to `continuing` and starts a fresh SDK turn/thread continuation. It is not `cancelled`, `failed`, or a useful outcome by itself.
- Assumption: An event stall first aborts the open SDK stream and records a recoverable typed checkpoint. Repeated stalls are governed by the failure/stall cap and eventually stop instead of looping indefinitely.
- Assumption: Official usage is available only from SDK `turn.completed`. When the SDK cannot report usage after abort, persist `usageComplete: false` and the last official totals; never infer the missing delta.
- Assumption: Review-cycle counts and resolved-review identifiers arrive through typed checkpoint messages because their semantics belong to installed skills. The harness validates limits and durability but does not independently scrape GitHub review threads.
- Assumption: Material Git/GitHub outcomes may be observed through existing structured command adapters, but outcome collection must use stable identifiers/state transitions rather than broad timestamps. Tests remain fake-backed.
- Assumption: The existing SQLite schema requires a version-2 migration for typed outcomes, checkpoints, usage completeness, and evidence cache. Prefer additive tables/columns and keep legacy fingerprint fields readable until migration proves rollback-safe.
- Assumption: Evidence cache entries are local operational state in SQLite, not Git artifacts. Cache payloads contain compact redacted evidence summaries and identifiers, never credentials, process environments, or full command output.
- Assumption: The installed skills tree is a separate repository. Skill-policy changes require their own focused commit and must not be bundled into an Agentloop commit.
- Open question resolved conservatively: The review calls the evidence cache “worth exploring,” but also places it in recommended PR 4. This plan includes it only after outcome telemetry and strict invalidation primitives exist; if those prerequisites cannot prove equivalence, the step must ship a disabled/no-hit cache with documented follow-up rather than unsafe reuse.
- Open question: The current worktree contains pre-existing modifications to `CHANGELOG.md`, README/docs, install/CLI/control-envelope code, and tests. Plan execution must inventory and preserve them, then either build on them intentionally or use isolated commits/worktrees; it must not reset, overwrite, or accidentally include them.

## Implementation Approach

### Bounded Execution Boundary

- Add `src/application/bounded-turn-supervisor.ts` with a narrow interface shaped like `runTranche(run, policy, signal) -> TrancheOutcome`.
- Inject a scheduler/timer port alongside the existing clock so deadline and stall tests advance deterministically without sleeping.
- Combine operator signal, cooperative tranche timer, hard timer, and resettable event-stall timer through internal abort controllers. Classify the first cause as `operator_cancelled`, `tranche_elapsed`, `hard_deadline`, `event_stalled`, `sdk_failed`, `budget_exhausted`, or `review_cycle_exhausted`.
- Keep event redaction and persistence at the harness boundary. The supervisor emits/persists each redacted event, resets the stall deadline on meaningful SDK events, captures official usage when `turn.completed` arrives, and always finalizes the turn/checkpoint transactionally.
- A cooperative tranche outcome is `continuing`; hard deadline and repeated stalls/failures stop according to explicit policy. Operator SIGINT/SIGTERM remains cancellation.

### Durable Checkpoints and Schema Compatibility

- Add a transactional SQLite migration with additive checkpoint/outcome/cache storage plus turn usage-completeness and abort-reason fields.
- Normalize persisted `RunLimits` by merging validated stored values over current defaults so version-1 rows gain new policy fields safely.
- Persist compact checkpoint state separately from the full redacted SDK event stream. Store a snapshot digest for deduplication and append only changed typed state.
- Keep old `state_fingerprint` and turn fingerprint columns readable during migration, but stop using them for no-progress decisions after outcome tracking is active.

### Outcome Progress

- Replace `src/infrastructure/fingerprint.ts` with an outcome observer split into typed snapshot collection and pure `observe(before, after)` comparison.
- Stable outcome keys should include repository identity plus identifiers such as commit SHA, PR number/head/review state, issue number/closed state, review-thread identifier/resolved state, or blocker classification key.
- Persist unique outcome keys so retries and recovery remain idempotent. Track `lastUsefulOutcomeAt` and derive no-progress from bounded turns/time since that point.
- Source failures must not look like “no change.” Persist source availability and retain the previous trusted observation until the source recovers.

### Checkpoint and Final Protocol

- Replace `ControlEnvelope` with a strict discriminated union. A `checkpoint` is delta-oriented; a `final` contains closure, approval, or terminal-blocker evidence.
- Parse every agent message as a candidate control message. Persist valid checkpoints immediately, reject malformed typed messages safely, and require exactly one final message before a normal SDK completion can drive final transition logic.
- Build continuation prompts from the compact latest checkpoint, unresolved delta, owned shard paths, effective limits, and recent outcomes rather than reproducing full closure evidence/rosters.
- Deduplicate identical roster/checkpoint snapshots by canonical hash.

### Context and Scheduling Policy

- Add a lightweight hot-state inspector that measures `STATUS.md` bytes/lines through the filesystem port before each tranche. It never interprets or edits the file.
- When over 64 KiB or 200 lines, add a mandatory prompt instruction to compact the index and move per-stream details to `STATUS.d/<issue-or-pr>.md` before assignment. Checkpoint shard paths must remain within the trusted repository.
- Update `codex-dev-team-goal`, `team-coordinator`, and `agent-team-status-protocol` to own sharding, closure-first slot reservation, speculative-stream limits, draft-PR timing, per-head review batching, and cap behavior.
- Add eval fixtures for oversized ledgers, one-near-merge/one-speculative scheduling, and a PR at its final allowed review cycle.

### Evidence Reuse and Metrics

- Expose a deep `EvidenceCache` interface keyed by repository, head SHA or stable patch ID, gate name/version, relevant-input digest, and environment fingerprint.
- Cache only compact redacted results/failure signatures emitted through typed checkpoint evidence. A lookup is a miss if any key component is absent or differs.
- Invalidate by construction through keys; add explicit pruning by age/count only for storage hygiene, never to broaden reuse.
- Derive operator metrics from persisted official usage, elapsed run/checkpoint times, material outcome count, and typed review cycles. Mark ratios unavailable when usage or denominator data is incomplete.

### Rollout and Rollback

- Land in reviewable vertical slices with green gates after every commit. Keep new behavior default-on only after characterization, migration, and cancellation tests pass.
- Preserve a temporary read-only display of legacy fingerprint data for diagnostics, but do not let it affect new progress transitions.
- A rollback may stop using new tables while leaving additive schema intact. Do not downgrade or delete operator state automatically.
- Run against fake streams first. Any opt-in live SDK smoke remains explicitly authorized through `AGENTLOOP_LIVE=1` and is not required for default completion.

## Quality Gates

- Setup status: Existing Bun/Biome/TypeScript/test/build gates are complete; no quality-gate setup step is required.
- Baseline result: `bun run verify` passed on 2026-07-11 with 73 tests passed, one opt-in live SDK test skipped, zero failures, and a successful Bun build on the current dirty worktree.
- Install command: `bun install --frozen-lockfile`
- Baseline command: `bun run verify`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Typecheck command: `bun run typecheck`
- Test command: `bun run test`
- Build command: `bun run build`
- Aggregate gate: `bun run verify`
- Dependency security gate: `bun audit`
- Installed-skill JSON gate: `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json /Users/alexmetelli/.agents/skills/team-coordinator/evals/evals.json /Users/alexmetelli/.agents/skills/agent-team-status-protocol/evals/evals.json`
- Live SDK smoke: `AGENTLOOP_LIVE=1 bun test test/live --timeout 120000` only with explicit authorization; not part of default completion.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before any implementation work begins. If it already exists, preserve its prior history and reconcile it to this plan rather than overwriting unrelated progress.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Create `CHANGELOG.md` before implementation begins. If it already exists, preserve valid existing entries and normalize only what this plan requires.
- Initial content: Include `# Changelog`, the standard preamble, and one `## [Unreleased]` section at the top.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Omit entries for chores, progress tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs, framework migration housekeeping, and empty category headings.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described in this plan unless the user explicitly expands it.
- Dirty-worktree rule: Before editing, inventory the current diff and assign ownership of overlapping files. Preserve all pre-existing changes and use isolated worktrees or narrowly staged commits where necessary.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required quality gates pass or documented pre-existing failures are handled, `PROGRESS.md` and `CHANGELOG.md` are current, separate repository commits remain separate, and the final state is summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Establish durable execution tracking without losing the repository's existing plan history or current dirty changes.

Depends on:

- Nothing.

Changes:

- Inventory `git status --short`, the existing diff, current `PROGRESS.md`, and current `CHANGELOG.md`; record the pre-existing modified-file set in `PROGRESS.md` so later commits do not sweep it in accidentally.
- Create or reconcile `PROGRESS.md` with this plan's title/source, a checklist for Steps 0–8, current status, dirty-worktree preservation note, and short update log.
- Create or reconcile `CHANGELOG.md` with `# Changelog`, the Keep a Changelog preamble, and exactly one top-level `## [Unreleased]` section.
- Document that `PROGRESS.md` is updated after every completed step and `CHANGELOG.md` only for validated functional changes.

Acceptance criteria:

- Both tracking files exist, prior qualifying content is preserved, and the full step checklist is visible.
- Pre-existing dirty files are recorded and are not staged as part of this setup unless the user already intended them for the same change.

Definition-of-done advance:

- Establishes the audit trail and commit-scope guard required for autonomous execution.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix any new failures before proceeding.

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation results and commit reference if available, set current status, and identify Step 1 as next.

Changelog:

- Do not add a changelog entry because tracking setup is not a functional change.

Commit:

- `chore: initialize bounded-supervisor progress tracking`

### Step 1: Characterize Current Turn, Cancellation, and Persistence Semantics

Goal: Lock down current behavior and the desired bounded semantics before extracting the supervisor.

Depends on:

- Step 0.

Changes:

- Add focused fake-stream characterization tests in `test/unit/foreground-run.test.ts` for an endless stream, a stream that stops emitting events, operator abort, SDK failure before/after `thread.started`, current failure counting, and missing official usage.
- Extend `test/support/fakes.ts` with deterministic async stream controls and an injected fake scheduler/timer; avoid real sleeps and model/network calls.
- Add migration compatibility tests in `test/unit/sqlite-run-store.test.ts` that construct a version-1 database/run-limits payload and prove it remains readable after new defaults are introduced.
- Record the intended transition table for each abort cause in test names/fixtures so the next step cannot collapse timeout, stall, failure, and cancellation into one path.

Acceptance criteria:

- Characterization tests pass against the current implementation for behavior that must remain compatible, especially Ctrl-C cancellation and recovery after `thread.started`; deterministic endless/stall fixtures are ready for Step 2's new supervisor assertions without leaving the suite red.
- No production behavior is weakened and default tests remain offline.

Definition-of-done advance:

- Reduces risk around the highest-impact extraction and establishes regression proofs for typed abort behavior.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with the characterized cases, validation results, commit reference if available, current status, and Step 2 as next.

Changelog:

- Do not add a changelog entry because characterization tests do not ship functional behavior.

Commit:

- `test: characterize bounded turn termination semantics`

### Step 2: Introduce and Enforce the BoundedTurnSupervisor

Goal: End each outer turn within a bounded tranche and classify every termination cause correctly.

Depends on:

- Step 1.

Changes:

- Add `src/application/bounded-turn-supervisor.ts` with typed `TranchePolicy`, `TrancheAbortReason`, and `TrancheOutcome` interfaces.
- Add an injectable scheduler/timer port in `src/application/ports.ts` plus a production implementation; wire it through CLI dependencies and fake adapters.
- Extend `RunLimits` in `src/domain/run.ts` with cooperative tranche, hard deadline, stall, and repeated-stall/failure policy while retaining the 10-minute/11-minute defaults described above.
- Normalize stored run-limit JSON in `src/infrastructure/sqlite/run-store.ts` so existing rows inherit validated defaults rather than producing `undefined` limits.
- Refactor `src/cli.ts` so the supervisor owns stream iteration, timer reset, combined abort signals, event persistence, official usage capture, turn finalization, and transition selection.
- Enforce `maxConsecutiveTurnFailures`; treat cooperative tranche expiry as `continuing`, hard/repeated stall according to explicit stop policy, and operator signals as `cancelled`.
- Update status/event rendering to show the typed abort reason without exposing sensitive payloads.
- Make all Step 1 deadline, stall, failure-cap, recovery, and cancellation tests green.

Acceptance criteria:

- Endless and stalled fake streams terminate deterministically without wall-clock sleeps.
- Tranche timeout never becomes cancellation or SDK failure, Ctrl-C remains cancellation, and the failure limit prevents turn `N+1`.
- The CLI no longer contains the low-level timer/stream policy that belongs in the supervisor.

Definition-of-done advance:

- Delivers the primary deep module and gives the harness an enforceable steering seam.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with supervisor behavior, validation results, commit reference if available, current status, and Step 3 as next.

Changelog:

- Add an `Added` or `Changed` entry under `## [Unreleased]` describing bounded recoverable Codex tranches and enforced stall/failure limits.

Commit:

- `feat: bound Codex work into supervised tranches`

### Step 3: Persist Typed Checkpoints and Complete Usage State

Goal: Make every tranche boundary durably observable, including when official usage is unavailable.

Depends on:

- Step 2.

Changes:

- Add SQLite migration version 2 in `src/infrastructure/sqlite/migrations.ts` with additive checkpoint storage and turn fields for typed abort reason and usage completeness; retain all version-1 data.
- Add checkpoint/usage types in `src/domain/run.ts` and transactional create/list/latest methods in `src/infrastructure/sqlite/run-store.ts`.
- Have `BoundedTurnSupervisor` finalize every tranche with one compact checkpoint, even for controlled timeout/stall/failure paths.
- Store official token deltas only when the SDK emits them. Persist `usageComplete: false` when a stream abort prevents an official total; never turn absence into a trusted zero.
- Extend `status` and `events` JSON/text rendering with last checkpoint time, abort classification, and usage completeness.
- Add migration rollback/future-version, redaction, interrupted-usage, and atomic-finalization tests.

Acceptance criteria:

- Existing databases migrate transactionally and retain their records.
- Every bounded completion has one checkpoint, and operator output distinguishes complete official usage from unavailable usage.
- Checkpoint persistence never includes process environments, credentials, or unredacted error/output payloads.

Definition-of-done advance:

- Makes steering and usage visibility durable at each bounded seam.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with migration evidence, checkpoint/usage behavior, commit reference if available, current status, and Step 4 as next.

Changelog:

- Add an `Added` entry under `## [Unreleased]` for durable tranche checkpoints and explicit usage completeness.

Commit:

- `feat: persist supervised tranche checkpoints`

### Step 4: Replace Activity Fingerprints with OutcomeProgress

Goal: Reset no-progress only for durable delivery or decision outcomes.

Depends on:

- Step 3.

Changes:

- Replace `src/infrastructure/fingerprint.ts` with `src/infrastructure/outcome-progress.ts` or a small module family containing `OutcomeSnapshot`, `OutcomeDelta`, source availability, stable keys, and pure comparison logic.
- Collect stable Git/GitHub states through existing structured command adapters: pushed/local head relation, PR identity/head/state/review resolution, issue closed state, and typed blocker state. Do not use broad timestamps as progress.
- Add a unique outcomes table/methods through migration 2 and the run store, including `lastUsefulOutcomeAt` and source availability needed for fail-closed decisions.
- Update supervisor/CLI transitions so `noProgressCount` changes only after a trusted comparison and only a new unique outcome resets it.
- Remove `STATUS.md`, `git status`, worktree lists, and timestamp-only lists from progress decisions; retain separately useful diagnostics if needed.
- Add pure and integration tests for one pushed SHA, PR open/advance/merge, issue close, review resolution, new blocker classification, idempotent replay, tracker-only edits, dirty files, repeated commands, timestamp churn, and unavailable sources.

Acceptance criteria:

- Each durable outcome is recorded once and only once.
- Activity-only changes never reset no-progress.
- An unavailable required source neither invents progress nor increments a false no-progress count.

Definition-of-done advance:

- Aligns stop/continue decisions with shipped outcomes rather than work performed.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with outcome cases, idempotency evidence, validation results, commit reference if available, current status, and Step 5 as next.

Changelog:

- Add a `Changed` entry under `## [Unreleased]` describing outcome-based progress and more accurate stuck detection.

Commit:

- `feat: track material outcomes instead of activity`

### Step 5: Split Compact Checkpoints from Final Control Messages

Goal: Keep ongoing observability cheap while preserving strict final closure evidence.

Depends on:

- Step 4.

Changes:

- Refactor `src/codex/control-envelope.ts` into a strict discriminated `checkpoint | final` control-message schema and parser.
- Define checkpoint deltas for changed agents, outcomes, blocker/approval changes, review-cycle state, next action, and optional owned shard; keep full issue/PR/review closure evidence in final messages only.
- Update `src/codex/event-mapper.ts` and the supervisor to parse each agent message, persist valid checkpoints, canonicalize/deduplicate identical snapshots, and require a valid final message for final transition.
- Update `src/codex/prompt-builder.ts` to request short change-triggered checkpoints plus a 2–3 minute heartbeat, and to build continuation context from the latest checkpoint/outcomes instead of repeating the entire roster and closure evidence.
- Add contract tests for strict schemas, malformed checkpoints, duplicate snapshots, checkpoint-before-final streams, no-final completion, approval/blocker finals, and prompt token-shape regressions.

Acceptance criteria:

- Repeated identical agent rosters persist once.
- A checkpoint can update operator visibility without being mistaken for final completion.
- Final completion still requires complete closure evidence and existing approval/security gates.

Definition-of-done advance:

- Reduces control-message/context overhead while improving durable observability.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with protocol compatibility, deduplication evidence, validation results, commit reference if available, current status, and Step 6 as next.

Changelog:

- Add a `Changed` entry under `## [Unreleased]` for compact live checkpoints and strict final closure messages.

Commit:

- `feat: separate checkpoint and final control messages`

### Step 6: Bound Hot Context and Enforce Closure-First Review Policy

Goal: Prevent oversized ledgers and uncontrolled parallel/review churn from consuming bounded tranches.

Depends on:

- Step 5.

Changes:

- Add a filesystem-backed hot-state inspector in Agentloop that measures `STATUS.md` bytes/lines and validates checkpoint-owned shard paths without parsing semantic content.
- Add the default 64 KiB/200-line policy and inject a mandatory pre-assignment compaction/sharding instruction into prompts when exceeded.
- Extend checkpoint review-cycle fields and supervisor policy so the configured cap cannot advance to cycle `N+1`; persist the PR, cycle, finding summary, and next decision on stop.
- Update `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`, `/Users/alexmetelli/.agents/skills/team-coordinator/SKILL.md`, and `/Users/alexmetelli/.agents/skills/agent-team-status-protocol/SKILL.md` with closure-first slot reservation, at most one speculative stream while a PR is blocked, early draft PR creation, complete per-head finding batches, `STATUS.md` index/shard ownership, and hard review-cap behavior.
- Update the three skill eval JSON files with oversized-ledger, closure-first scheduling, owned-shard, and final-review-cycle cases.
- Add fake-filesystem and prompt tests proving a 140 KiB ledger triggers compaction before assignment and an in-cap ledger does not.
- Keep Agentloop and installed-skills changes in separate repository commits.

Acceptance criteria:

- Oversized hot state always produces clear, bounded instructions before new work assignment.
- Semantic scheduling/sharding rules live only in installed skills.
- Review cycle `N+1` is impossible after the configured cap without explicit operator resume/policy change.

Definition-of-done advance:

- Constrains the two largest context/churn multipliers while preserving the thin-harness boundary.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json /Users/alexmetelli/.agents/skills/team-coordinator/evals/evals.json /Users/alexmetelli/.agents/skills/agent-team-status-protocol/evals/evals.json`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with ledger threshold tests, review-cap evidence, both repository commit references if available, current status, and Step 7 as next.

Changelog:

- Add an `Added` or `Changed` entry under Agentloop's `## [Unreleased]` for hot-ledger warnings and enforced review-cycle limits. Do not add an Agentloop changelog entry solely for skill documentation/eval edits.

Commit:

- Agentloop: `feat: bound hot coordination context and review cycles`
- Installed skills: `feat: prioritize closure in bounded agent loops`

### Step 7: Add Strict Exact-Head Evidence Reuse

Goal: Avoid rerunning unchanged gates or rediscovering unchanged external blockers without accepting stale evidence.

Depends on:

- Step 6.

Changes:

- Add `src/application/evidence-cache.ts` with a deep lookup/store interface keyed by repository, head SHA or stable patch ID, gate/version, relevant-input digest, and environment fingerprint.
- Add compact redacted cache persistence and bounded pruning through migration 2/run-store methods.
- Extend checkpoint evidence records so installed skills can report gate identity, exact head/stable patch, declared relevant inputs, environment fingerprint, result, and reusable failure signature.
- Include valid cache hits in continuation prompts as evidence references; require the coordinator to rerun when any key is absent/different or when product inputs changed.
- Add tests for exact hits, each independent invalidation dimension, docs/tracker-only reuse with unaffected declared inputs, product-code invalidation, failure-signature reuse, redaction, and cache pruning.
- If stable equivalence cannot be proven for a gate, persist telemetry but return a cache miss; never weaken the acceptance gate to force reuse.

Acceptance criteria:

- Cache hits occur only under full key equivalence and are explainable in status/checkpoint output.
- Stale exact-head acceptance cannot survive a product-code or environment/gate-version change.
- No cached record contains secrets or full command/auth output.

Definition-of-done advance:

- Delivers safe evidence reuse after the outcome and checkpoint primitives needed to govern it exist.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with cache hit/miss/invalidation evidence, validation results, commit reference if available, current status, and Step 8 as next.

Changelog:

- Add an `Added` entry under `## [Unreleased]` describing safe exact-head gate and blocker evidence reuse.

Commit:

- `feat: reuse strictly equivalent execution evidence`

### Step 8: Expose Outcome Efficiency, Document Operations, and Run Final Gates

Goal: Make bounded execution operable and verify the complete architecture as one coherent system.

Depends on:

- Steps 0–7.

Changes:

- Extend status text/JSON in `src/cli.ts` and presentation helpers with last useful outcome, checkpoint age, usage completeness, outcomes by type, review cycles, and tokens/time/cycles per outcome. Render unavailable ratios honestly.
- Update `README.md`, `docs/architecture.md`, `docs/operations.md`, and `docs/security.md` with the supervisor boundary, default deadlines, transition table, checkpoint/final protocol, outcome semantics, ledger/shard policy, review caps, evidence cache keys/invalidation, recovery, redaction, and rollback.
- Add/extend CLI black-box and security tests for stable output, incomplete ratios, redaction, recovery from tranche/stall stops, and migration-visible fields.
- Run dependency audit and final repository/skills diffs; confirm no local SQLite/WAL/log/coverage/worktree artifacts are tracked.
- Reconcile `PROGRESS.md` and `CHANGELOG.md`, ensuring one `## [Unreleased]`, no empty headings, and only observable functional entries.

Acceptance criteria:

- Operators can explain why a run continued/stopped, when it last achieved an outcome, whether usage is complete, and whether evidence was reused.
- Documentation and output describe the same defaults and state transitions enforced by code.
- All default gates and dependency/security checks pass with unrelated pre-existing changes preserved and intentionally scoped.

Definition-of-done advance:

- Completes operator visibility, documentation, security validation, and the full plan definition of done.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun audit`.
- Run `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json /Users/alexmetelli/.agents/skills/team-coordinator/evals/evals.json /Users/alexmetelli/.agents/skills/agent-team-status-protocol/evals/evals.json`.
- Run `git status --short --branch --untracked-files=all` in both repositories and verify commit scope/artifact hygiene.
- Fix all failures before completion.

Progress:

- Mark Step 8 and the overall plan complete in `PROGRESS.md`; record all final gate results, Agentloop and installed-skills commit references, current status, and no next implementation step.

Changelog:

- Add or refine qualifying `Added`/`Changed`/`Fixed`/`Security` entries under `## [Unreleased]` for the observable bounded-supervision release. Do not add entries for docs, tests, audits, or plan completion alone.

Commit:

- `docs: finalize bounded supervisor operations`
