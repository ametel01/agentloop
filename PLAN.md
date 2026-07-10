# Implementation Plan

## Source Documents

- Path: Inline design brief supplied in the current planning task
  - Role: Primary product and workflow brief.
  - Summary: Defines a two-stage software factory boundary, with discovery producing GitHub issues and implementation beginning only after a human applies `agentloop:ready`. Requires one repository-level dispatcher, GitHub-visible claims, exact issue scoping, idempotent checks, and deferred discovery producers.
- Path: <https://x.com/piersonmarks/status/2075361336381555096>
  - Role: External design inspiration.
  - Summary: Separates pre-triage from implementation, uses the issue tracker as the interface, and uses a label as an explicit automation trigger.
- Path: `/Users/alexmetelli/source/agentloop/AGENTS.md`
  - Role: Repository implementation constraints.
  - Summary: Requires Bun, strict TypeScript, fake-backed default tests, explicit repository trust, no credential persistence, and a thin harness around installed Codex skills.
- Path: `/Users/alexmetelli/source/agentloop/docs/architecture.md`
  - Role: Harness ownership boundary.
  - Summary: Assigns durable execution, leases, budgets, events, and recovery to Agentloop while leaving issue and role semantics to installed skills.
- Path: `/Users/alexmetelli/source/agentloop/README.md`
  - Role: Current CLI and operator contract.
  - Summary: Documents run creation, detached queueing, worker execution, model selection, recovery, approvals, and existing operator commands.
- Path: `/Users/alexmetelli/source/agentloop/docs/operations.md`
  - Role: Local supervision and recovery contract.
  - Summary: Defines worker supervision, `launchd` integration, state paths, stale-lease behavior, and incident recovery.
- Path: `/Users/alexmetelli/source/agentloop/docs/security.md`
  - Role: Trust, credential, persistence, and subprocess constraints.
  - Summary: Requires structured command arguments, least-privilege host credentials, explicit trust, best-effort redaction, and no secret persistence.
- Path: `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`
  - Role: Coordinator and issue-to-merge workflow contract.
  - Summary: Owns live GitHub intake, dependency routing, worktree isolation, builder/checker/reviewer loops, merge acceptance, reconciliation, and closure evidence.
- Path: `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/references/sub-agent-prompts.md`
  - Role: Role boundary reference.
  - Summary: Keeps spec, builder, checker, reviewer, and retrospective behavior in installed skills rather than Agentloop TypeScript.

## Goals

- Add an operator-controlled `agentloop dispatch` command that discovers open GitHub issues labeled `agentloop:ready` and queues one exact, repository-level Agentloop run for that issue set.
- Make repeated scheduled dispatch attempts idempotent: no ready issues and an already-open repository run are successful no-op outcomes, not duplicate work or alert-worthy failures.
- Keep the durable objective narrow and safe by persisting only the repository identity and sorted issue numbers/URLs, never issue titles, bodies, comments, telemetry, or customer data.
- Expose the Agentloop run ID to the coordinator so GitHub claim comments and labels can be tied to a durable run.
- Add an installed-skill claim protocol that publishes `agentloop:running` and `agentloop:blocked` state, reuses existing PRs and same-run claims, and refuses to take work claimed by another run.
- Preserve one coordinator per repository; the coordinator continues to own dependency analysis and safe parallel builders within separate worktrees.
- Document a simple polling deployment using the existing worker and `launchd`, without adding an HTTP service or scheduler to Agentloop.

## Non-Goals

- Do not implement system-health, UX-feedback, churn-analysis, `improve`, Hallmark, security, or other discovery producers in this plan.
- Do not let discovery agents apply `agentloop:ready` or otherwise authorize implementation.
- Do not add a public webhook receiver, Hono service, hosted control plane, cloud routine integration, or network daemon.
- Do not start one Agentloop run per issue; one repository-level run must drain the exact ready set and coordinate internal parallelism.
- Do not make label names configurable in the first slice. Use `agentloop:ready`, `agentloop:running`, and `agentloop:blocked` as the fixed protocol.
- Do not automatically create repository labels. Missing protocol labels must fail dispatch preflight with exact setup guidance.
- Do not add a completion label. Successful PR closing references and closed GitHub issues remain the completion signal.
- Do not persist issue titles, bodies, comments, customer PII, session replay contents, payment data, provider credentials, full authentication output, or process environments.
- Do not provide distributed or cross-host claim consensus. The first slice remains single-host and relies on the existing repository singleton plus GitHub-visible advisory claims.
- Do not install a `launchd` service, publish a package, deploy infrastructure, release a version, or run production discovery automatically.

## Definition of Done

- The built CLI documents and accepts:

  ```text
  agentloop dispatch --repo PATH --trust-repo [--dry-run] [--json]
    [--model MODEL] [--reasoning EFFORT]
    [--approval-mode agent-approved|human-merge]
    [--max-turns N] [--max-tokens N] [--max-duration DURATION]
  ```

- `dispatch` runs the existing doctor/trust preflight, confirms all three protocol labels exist, and reads open `agentloop:ready` issues through structured `gh` arguments with a bounded timeout.
- Issue discovery returns a deterministic, deduplicated, ascending issue-number set. A configured collection cap cannot silently truncate work; reaching it fails with an actionable message.
- `--dry-run` performs no SQLite or GitHub mutation and reports the exact issue numbers that would be queued.
- Normal dispatch never invokes Codex directly. It creates one `queued` run for the existing worker, using the same model, reasoning, approval, limit, skill-fingerprint, worktree-root, and repository-key contracts as `run --detach`.
- With no ready issues, dispatch exits successfully, creates no run, and reports `no_ready_issues`.
- With an existing open repository run, dispatch exits successfully, creates no second run, and reports `already_active` with the existing run ID. A concurrent create race resolves to this same no-op result through the existing unique-open-run constraint.
- Text and JSON output are stable. JSON includes `status`, `runId`, `repoPath`, and `issueNumbers`, where status is one of `dry_run`, `queued`, `no_ready_issues`, or `already_active`.
- The queued objective contains only the exact sorted issue references and an immutable scope marker; issue titles/bodies are fetched later by the coordinator and are not persisted in the run objective.
- Every coordinator prompt includes the durable Agentloop run ID.
- The installed `codex-dev-team-goal` skill contains a label-scoped dispatch protocol that:
  - Re-fetches each dispatched issue and linked/open PR state before assignment.
  - Skips closed issues without creating work.
  - Reuses an existing PR rather than spawning a duplicate builder.
  - Treats a same-run claim marker as recovery state and continues idempotently.
  - Refuses to mutate or implement an issue claimed by a different run.
  - Writes a stable `[agentloop run:<RUN_ID>]` claim comment, adds `agentloop:running`, and removes `agentloop:ready` in a recoverable order.
  - Allows inspection of linked blockers and PRs only to determine routing, but does not modify or implement issues outside the dispatched set.
  - Uses `agentloop:blocked` only for terminal human/external blockers, removes `agentloop:running`, and records exact evidence and the next decision.
  - Removes transient dispatch labels when the issue closes through the intended merged PR.
- Agentloop TypeScript contains no copied role prompt or GitHub label mutation policy; semantic claim behavior remains in the installed skill.
- Default tests use fake command, filesystem, clock, ID, Codex, and SQLite adapters. They perform no live GitHub writes, model calls, network calls, label changes, or process-environment persistence.
- Tests cover trust failure, missing labels, no work, deterministic discovery, malformed/truncated GitHub output, dry run, queue creation, stable JSON/text output, an already-open run, a concurrent create race, exact objective scoping, and prompt run-ID propagation.
- README, architecture, operations, and security docs explain the label protocol, queue/worker split, polling setup, no-op states, claim recovery, skill-fingerprint impact, and deferred producer boundary.
- Existing runs remain compatible. No database migration is introduced unless implementation proves that existing run fields cannot safely represent dispatch; any such need must stop the goal for plan revision rather than silently expanding scope.
- `bun run verify` passes from `/Users/alexmetelli/source/agentloop`; `bun audit` reports no unresolved dependency vulnerabilities; the installed skill JSON/eval files validate; and both repositories have clean, intentional diffs with unrelated changes preserved.
- `PROGRESS.md` and `CHANGELOG.md` are current. The Agentloop changelog has one `## [Unreleased]` section with each change category appearing at most once.

## Assumptions and Open Questions

- Assumption: GitHub issues are the authorization and scope interface, `STATUS.md` is hot semantic coordination state, and SQLite is durable operational state. None replaces the others.
- Assumption: `dispatch` always queues work; the existing `worker` or `worker --once` starts execution. Foreground dispatch is intentionally deferred.
- Assumption: Protocol labels are fixed and operator-created. Their intended meanings are:
  - `agentloop:ready`: a human has approved the issue for autonomous implementation.
  - `agentloop:running`: a specific Agentloop run currently owns or reconciles the issue.
  - `agentloop:blocked`: the run reached a terminal external/human blocker and left exact evidence.
- Assumption: Repeated polling should be quiet. `no_ready_issues` and `already_active` therefore use exit code `0`; authentication, malformed responses, missing labels, or other broken preconditions remain failures.
- Assumption: A dispatch query uses a documented finite cap large enough for normal repositories and fails when the cap is reached, preventing silent partial queues.
- Assumption: The durable objective stores issue numbers and canonical URLs only. GitHub-provided titles and bodies are untrusted inputs and are unnecessary for dispatch.
- Assumption: A claim comment is written before removing `agentloop:ready`, so an interrupted claim leaves a durable ownership marker that recovery can inspect. The existing repository singleton prevents a second local run during the partial state.
- Assumption: A repo-local dependency outside the dispatched set may be inspected but not modified. If it must change before a target can complete, the target becomes blocked with the exact dependency rather than broadening scope.
- Assumption: The installed skills repository at `/Users/alexmetelli/.agents/skills` is a separate Git repository. Its changes require a separate commit and must not be bundled into an Agentloop commit.
- Open question: A `/goal` executing this plan needs write access to both `/Users/alexmetelli/source/agentloop` and `/Users/alexmetelli/.agents/skills`. If its runtime sandbox cannot write the skills repository, Step 4 must be performed in a separate authorized skills-repo task and treated as an external blocker for final acceptance.
- Open question: Cross-host stale-claim reconciliation is intentionally unresolved in this first slice. GitHub claims are advisory until a future distributed-ownership design is approved.
- Open question: A live GitHub dry-run may be useful after implementation, but it is not required for completion because protocol labels and eligible issues may not exist in a safe test repository. No live write smoke is authorized by this plan.

## Implementation Approach

### Ownership Boundary

- Agentloop owns ready-issue discovery, deterministic scope serialization, durable run creation, queue idempotency, run-ID prompt context, operator output, and local supervision docs.
- `codex-dev-team-goal` owns GitHub claim mutations, issue/PR reconciliation, dependency routing, role assignment, blocking semantics, merge completion, and cleanup of transient labels.
- Intake producers remain separate skills or automations. They may create or enrich issues later, but they do not appear in Agentloop TypeScript and cannot apply `agentloop:ready` by default.

### Dispatch Data Flow

1. Parse `dispatch` arguments and require `--repo` plus `--trust-repo`.
2. Run the existing doctor and resolve canonical repository/worktree paths plus the skill fingerprint.
3. Use the command runner with explicit `cwd` and timeouts to confirm the three labels exist and list open issues carrying `agentloop:ready`.
4. Parse and validate the GitHub JSON into a minimal `DispatchIssue` containing only `number` and canonical `url`; sort and deduplicate by number.
5. Return `no_ready_issues` without opening SQLite when the set is empty.
6. For `--dry-run`, return the exact set without creating a run or invoking Codex.
7. Open the run store, query for an existing open run by repository key, and return `already_active` when one exists.
8. Build a deterministic scope-only objective and create one queued run through a shared run-creation helper reused by `run --detach`.
9. If another process wins the unique-open-run race, translate `OpenRunConflictError` into `already_active` rather than an error.
10. The existing worker claims and executes the queued run. The prompt supplies `Run ID`, repository, worktree root, budgets, and the exact issue scope as delimited task data.
11. The coordinator applies the installed-skill claim protocol before assigning builders and reconciles claim/PR state on recovery.

### Application And CLI Shape

- Add `src/application/dispatch.ts` with:
  - Label constants and minimal `DispatchIssue`/`DispatchDiscovery` types.
  - Strict JSON parsing and response validation.
  - `discoverReadyIssues()` using the existing `CommandRunner` port.
  - `buildDispatchObjective()` producing deterministic scope data without titles or bodies.
- Refactor the duplicated durable-run construction in `src/cli.ts` into a small internal helper that accepts already-validated repo context, objective, run options, clock, ID generator, and store. Do not add a generic dependency-injection framework.
- Add a store lookup for an open run by repository key if the existing query is not already exposed. Preserve the unique partial index as the final race guard.
- Keep `dispatch` always detached. It must not instantiate `ProductionCodexRunner`.
- Add stable text and JSON renderers for dispatch outcomes; do not encode scheduling logic into the renderer.

### Claim Protocol

- Add a concise `Label-Scoped Dispatch` section to `codex-dev-team-goal/SKILL.md`; do not copy it into Agentloop source.
- Add an eval case to `codex-dev-team-goal/evals/evals.json` covering same-run recovery, different-run refusal, existing-PR reuse, and out-of-scope dependency behavior.
- The coordinator writes claim state in recoverable order: stable run marker comment, add `agentloop:running`, then remove `agentloop:ready`. Every operation must be preceded by a live-state recheck.
- `agentloop:blocked` is terminal, not a synonym for repo-local dependency blocking. A target waiting on an actionable in-scope dependency remains active in `STATUS.md`.
- Existing/open PRs are active work and must enter checker/reviewer routing; they must not cause a duplicate builder branch.

### Compatibility And Security

- Avoid a database migration by representing dispatch as an ordinary queued run with a deterministic objective. Stop and revise the plan if implementation requires new persisted columns.
- Do not interpolate issue content into shell commands. All `gh` calls use command/argument arrays and explicit timeouts.
- Do not persist full `gh auth` output, environment variables, credentials, telemetry payloads, or customer data.
- Treat issue content as untrusted repository-adjacent input. Discovery stores only numbers/URLs; the coordinator retrieves content under the existing trust boundary.
- A changed installed-skill fingerprint intentionally triggers the existing resume approval path for pre-existing runs. Document this operational consequence.

### Deferred Intake Extension

- After this plan is proven, a separate plan may add one read-only health producer that deduplicates and creates evidence-backed issues without applying `agentloop:ready` or launching implementation.
- UX feedback, security, `improve`, Hallmark, churn, and telemetry producers remain later independent slices with their own privacy and source-governance review.

## Quality Gates

- Setup status: Existing gates are complete; no quality-gate setup step is required.
- Baseline result: `bun run verify` passed on 2026-07-10 with 55 tests passed, 1 opt-in live test skipped, and a successful build.
- Install command: `bun install --frozen-lockfile`
- Baseline command: `bun run verify`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Typecheck command: `bun run typecheck`
- Test command: `bun run test`
- Build command: `bun run build`
- Aggregate gate: `bun run verify`
- Dependency security gate: `bun audit`
- Skills-repo syntax gate: `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json`
- Skills-repo diff gate: `git -C /Users/alexmetelli/.agents/skills diff --check`
- Skill fingerprint integration gate: `bun dist/cli.js doctor --repo . --json`
- Live GitHub/model calls: Not part of default or required validation. Any live smoke requires separate explicit authorization and must remain read-only unless the user expands scope.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before implementation begins. The file is currently absent and must be created in Step 0.
- Initial content: Include this plan title and sources, a checklist for Steps 0 through 6, the passing baseline result, current status, next step, and a concise update log.
- Update rule: After each completed step, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.
- Cross-repo rule: Record Agentloop and installed-skills commit references separately. Never imply an external skill change is committed when only the Agentloop repository changed.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: `CHANGELOG.md` already exists. Step 0 must preserve its entries and consolidate its duplicate `### Added` headings under the single `## [Unreleased]` section before implementation begins.
- Initial structure: Keep `# Changelog`, the standard preamble, and `## [Unreleased]`; each applicable category appears at most once and empty categories are omitted.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's Agentloop commit only when the step shipped a functional change.
- Qualifying entries: The dispatch command, stable dispatch output, run-ID prompt propagation, and label-claim integration are functional changes.
- Exclusions: Do not add entries for planning, progress tracking, docs-only work, tests/coverage, CI/validation runs, formatting, or skills-repo-only bookkeeping.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload after `PLAN.md` is reviewed.
- Scope: The `/goal` should execute only this label-dispatch and claim-protocol slice across `/Users/alexmetelli/source/agentloop` and `/Users/alexmetelli/.agents/skills/codex-dev-team-goal` unless the user explicitly expands it.
- Repository ownership: Keep the Agentloop root checkout coordinator-only, preserve unrelated changes, use focused worktrees/branches for implementation streams, and commit skills-repo changes separately.
- Review: Every implementation PR must pass the `codex-dev-team-goal` PR Context Gate, checker evidence, required CI, and `maintainer-reviewer` acceptance before merge.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required gates pass or documented pre-existing failures are handled, both repository states are reconciled, `PROGRESS.md` and `CHANGELOG.md` are current, and final issue/PR/commit/review evidence is recorded.
- Stop boundary: Do not start scheduled discovery producers after completing this plan. Record them as deferred follow-up work only.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Establish durable tracking for the label-dispatch implementation while preserving the repository's existing changelog history.

Depends on:

- Nothing.

Changes:

- Create `PROGRESS.md` at the Agentloop repository root with the plan sources, Step 0-6 checklist, passing baseline, current status, next step, and update rules.
- Preserve prior shipped entries in `CHANGELOG.md` and consolidate the duplicate `### Added` headings under `## [Unreleased]`.
- Record the current clean/dirty state of both `/Users/alexmetelli/source/agentloop` and `/Users/alexmetelli/.agents/skills`, treating pre-existing skill-tree changes as user-owned.
- Stage and commit only `PLAN.md`, `PROGRESS.md`, and the changelog normalization in Agentloop. Do not include unrelated working-tree changes.

Acceptance criteria:

- `PROGRESS.md` exists and contains every planned step plus the baseline result.
- `CHANGELOG.md` has one `## [Unreleased]` section and no duplicate change-category headings.
- Both repositories' pre-existing changes and ownership are recorded without being reverted or accidentally staged.

Definition-of-done advancement:

- Makes execution inspectable and establishes the required changelog contract before functional work.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `git diff --check` in Agentloop.
- Run `git -C /Users/alexmetelli/.agents/skills diff --check`.
- Fix all failures before proceeding.

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation results and the Agentloop commit reference, set Step 1 as next.

Changelog:

- Do not add an entry for planning/tracking setup or category normalization because these are non-functional changes.

Commit:

- `docs: initialize label dispatch implementation tracking`

### Step 1: Ready-Issue Discovery And Scope Contract

Goal: Produce a deterministic, minimal, read-only dispatch scope from GitHub without creating a run or mutating issues.

Depends on:

- Step 0.

Changes:

- Add `src/application/dispatch.ts` with fixed protocol-label constants, minimal dispatch DTOs, strict GitHub JSON parsing, label preflight, bounded ready-issue discovery, deterministic sorting/deduplication, cap detection, and scope-only objective construction.
- Use `CommandRunner.run()` with structured arguments, canonical repository `cwd`, and explicit timeouts.
- Persist no issue title/body/comment fields in application DTOs or objective text.
- Add `test/unit/dispatch.test.ts` using fake command responses for success, missing labels, no issues, duplicate/out-of-order results, malformed JSON, invalid issue records, command failure, and cap handling.
- Add security assertions that adversarial titles/bodies returned by fixtures never enter the objective or durable DTO.

Acceptance criteria:

- Discovery returns only validated issue numbers and canonical URLs in ascending order.
- Missing any protocol label fails with exact setup guidance.
- Empty discovery is a typed no-work result.
- GitHub failures, malformed responses, and cap exhaustion fail closed.
- The module performs no SQLite writes, Codex calls, label mutations, or network activity in default tests.

Definition-of-done advancement:

- Establishes the safe intake boundary and deterministic issue-set representation required by dispatch.

Validation:

- Run `bun test test/unit/dispatch.test.ts`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `git diff --check`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with Step 1 completion, validation results, commit reference, current status, and Step 2 as next.

Changelog:

- Do not add an entry because the discovery module is not yet operator-visible.

Commit:

- `feat: add ready issue discovery contract`

### Step 2: Idempotent Dispatch CLI And Durable Queueing

Goal: Let operators and polling jobs safely queue one exact label-scoped repository run.

Depends on:

- Step 1.

Changes:

- Add `dispatch` to CLI help and command routing in `src/cli.ts` with `--repo`, `--trust-repo`, `--dry-run`, `--json`, model/reasoning, approval-mode, and existing limit options.
- Reuse doctor output and extract a small shared queued-run creation helper from the existing `run --detach` path instead of duplicating run construction.
- Expose an open-run lookup by repository key in `SqliteRunStore` when needed for idempotent polling.
- Return stable `dry_run`, `queued`, `no_ready_issues`, and `already_active` outcomes in text and JSON.
- Translate a concurrent unique-open-run race into `already_active` with the winning run ID.
- Ensure normal dispatch always creates `status: queued` and never constructs a Codex runner; the worker remains the only execution path for dispatched work.
- Add black-box, lifecycle, store, and security tests in `test/unit/cli-blackbox.test.ts`, `test/unit/run-lifecycle.test.ts`, `test/unit/sqlite-run-store.test.ts`, and `test/unit/security-hardening.test.ts` as appropriate.

Acceptance criteria:

- Dry-run and no-work paths do not open or mutate SQLite.
- A ready set creates exactly one queued run with the exact deterministic objective and selected run options.
- Repeated and concurrent dispatches cannot create duplicate open runs.
- Trust/auth/preflight failures happen before durable mutation.
- Stable JSON contains only the documented fields and no issue content beyond numbers/URLs.

Definition-of-done advancement:

- Delivers the operator-visible dispatcher and reuses the existing durable worker rather than adding another execution system.

Validation:

- Run targeted dispatch CLI/store/security tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `git diff --check`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with Step 2 completion, validation results, commit reference, current status, and Step 3 as next.

Changelog:

- Add an `Added` entry under `## [Unreleased]` for the label-scoped `dispatch` command and its idempotent scheduled-polling outcomes.

Commit:

- `feat: queue label scoped agentloop runs`

### Step 3: Durable Run Identity In Coordinator Prompts

Goal: Give the coordinator a stable run identity it can publish in GitHub claim evidence.

Depends on:

- Step 2.

Changes:

- Add `Run ID: ${run.id}` to the fixed prompt header in `src/codex/prompt-builder.ts`.
- Keep the run ID outside `<target_work>` so it is trusted harness context, while the dispatch issue set remains delimited task data.
- Extend `test/unit/codex-contracts.test.ts` or focused prompt tests to verify initial, continuation, recovery, and approval-response prompts carry the same run ID without leaking unrelated persisted state.
- Confirm redaction and prompt hashing behavior remain unchanged apart from the intentional run-ID input.

Acceptance criteria:

- Every outer-turn prompt contains the exact durable run ID once in trusted harness context.
- Resumed and recovered turns preserve the same ID.
- No process environment, credential, or approval response is added to the header.

Definition-of-done advancement:

- Creates the stable correlation key required for same-run recovery and different-run refusal in GitHub.

Validation:

- Run targeted prompt/contract tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `git diff --check`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with Step 3 completion, validation results, commit reference, current status, and Step 4 as next.

Changelog:

- Add a `Changed` entry under `## [Unreleased]` noting that coordinator turns receive the durable run identifier for claim/recovery correlation.

Commit:

- `feat: expose run identity to coordinator turns`

### Step 4: GitHub-Visible Claim Protocol In Installed Skills

Goal: Make dispatched issue ownership and terminal blocking visible and recoverable in GitHub without moving workflow policy into Agentloop TypeScript.

Depends on:

- Step 3.

Changes:

- In `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/SKILL.md`, add a concise `Label-Scoped Dispatch` workflow covering live recheck, stable run marker comments, label transition order, same-run recovery, different-run refusal, existing-PR reuse, out-of-scope blocker inspection, terminal blocking, and completion cleanup.
- Update `/Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json` with scenarios that distinguish same-run recovery from a different active claim and prevent out-of-scope implementation.
- Update `references/sub-agent-prompts.md` only if a role prompt needs dispatch-scope awareness; keep claim mutation coordinator-owned and avoid duplicating the main protocol.
- Run Agentloop doctor after the skill change and record the new fingerprint. Document that pre-existing runs require the existing `--accept-skill-change` or approval flow before resume.
- Commit skills-repo changes separately from Agentloop tracking/changelog updates.

Acceptance criteria:

- The coordinator claims only the exact dispatched set and does not broaden implementation to outside issues.
- Closed issues and existing PRs are reconciled rather than duplicated.
- A same-run marker is recoverable; a different-run marker prevents mutation/assignment.
- Terminal blockers receive `agentloop:blocked`, exact evidence, and no false completion.
- No role prompt body is copied into Agentloop TypeScript.

Definition-of-done advancement:

- Completes the issue-tracker-visible half of the dispatch boundary while preserving the harness/skill architecture.

Validation:

- Run `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json`.
- Run `git -C /Users/alexmetelli/.agents/skills diff --check`.
- Run any existing focused skill eval/validator available in the skills repository without widening repairs to unrelated findings.
- Run `bun dist/cli.js doctor --repo . --json` from Agentloop and verify the required skill plus fingerprint checks pass.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with the separate Agentloop and skills-repo commit references, validation results, fingerprint change, current status, and Step 5 as next.

Changelog:

- Add a `Changed` entry in Agentloop for GitHub-visible label claims and terminal-blocker evidence only after the skill integration is validated. Do not add a second entry for evals or skill-file maintenance.

Commits:

- Skills repository: `feat: add agentloop issue claim protocol`
- Agentloop tracking/changelog: `docs: record dispatch claim integration`

### Step 5: Operator Polling, Security, And Recovery Documentation

Goal: Make the new boundary operable without adding a scheduler or public service.

Depends on:

- Step 4.

Changes:

- Update `README.md` with dispatch syntax, fixed labels, human authorization semantics, no-work/already-active behavior, dry-run/JSON output, and the worker handoff.
- Update `docs/architecture.md` with the discovery/dispatch/worker/coordinator boundary and ownership of GitHub claim semantics.
- Update `docs/operations.md` with label setup commands, a simple `launchd` polling shape for `dispatch`, the existing worker supervision, expected exit behavior, claim recovery, and skill-fingerprint resume handling.
- Update `docs/security.md` with issue-content trust, minimal durable scope, no title/body/PII persistence, label permissions, and the explicit deferral of webhook/telemetry ingestion.
- Document but do not run `bun run install:global`; service installation and profile changes remain operator actions outside this implementation goal.

Acceptance criteria:

- An operator can create labels, dry-run dispatch, queue work, supervise the worker, inspect the run, and recover a claim using documented commands.
- Documentation clearly separates successful polling no-ops from broken preconditions.
- No documentation implies that discovery producers, webhooks, distributed claims, or production telemetry ingestion are implemented.

Definition-of-done advancement:

- Makes the feature usable and sets safe expectations for scheduling, credentials, recovery, and deferred work.

Validation:

- Run command/help content checks for every documented option.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `git diff --check`.
- Fix all failures before proceeding.

Progress:

- Update `PROGRESS.md` with Step 5 completion, validation results, commit reference, current status, and Step 6 as next.

Changelog:

- Do not add a changelog entry for documentation-only work; functional dispatch/claim entries must already exist from Steps 2-4.

Commit:

- `docs: document label dispatch operations`

### Step 6: Final Acceptance And `/goal` Closure Evidence

Goal: Prove the complete bounded slice and leave both repositories in a reconciled, reviewable state.

Depends on:

- Steps 0 through 5.

Changes:

- Review the complete Agentloop and skills-repo diffs against this plan and remove any accidental scope expansion.
- Confirm all dispatch states and races are covered by fake-backed tests and that default tests make no model, GitHub, or network calls.
- Run the built CLI help, doctor, and fake-backed black-box acceptance paths; do not perform a live GitHub write smoke.
- Verify `PROGRESS.md`, `CHANGELOG.md`, README, architecture, operations, and security docs match the final behavior.
- Record deferred follow-up candidates for a read-only health producer and cross-host stale-claim reconciliation without implementing or publishing them unless separately requested.
- Reconcile branches, worktrees, PRs, reviews, skills-repo changes, and final commit references according to the `codex-dev-team-goal` closure gate.

Acceptance criteria:

- Every item in `## Definition of Done` is satisfied or an exact external blocker is recorded.
- Agentloop and skills-repo changes are independently reviewable and committed in their correct repositories.
- No target issue/PR/review thread or required gate remains unresolved.
- No discovery producer, webhook, scheduler installation, PII path, or distributed claim mechanism has entered the diff.

Definition-of-done advancement:

- Completes the plan and produces the evidence required for `/goal` closure.

Validation:

- Run `bun install --frozen-lockfile` if dependencies or the lockfile changed; otherwise record that it was not required.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run verify`.
- Run `bun audit`.
- Run `jq empty /Users/alexmetelli/.agents/skills/codex-dev-team-goal/evals/evals.json`.
- Run `git diff --check` in Agentloop.
- Run `git -C /Users/alexmetelli/.agents/skills diff --check`.
- Run `bun dist/cli.js doctor --repo . --json` and confirm required checks pass.
- Fix all failures before declaring completion.

Progress:

- Mark Step 6 and the overall plan complete in `PROGRESS.md`; record all gate results, final Agentloop and skills-repo commit/PR/review references, residual risks, deferred work, and final status.

Changelog:

- Do not add an entry for final validation or progress closure. Confirm existing `Added` and `Changed` entries accurately describe only shipped behavior.

Commit:

- `docs: record label dispatch acceptance`
