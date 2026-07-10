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
- [ ] Step 6: Final acceptance and `/goal` closure evidence.

## Baseline

- `bun run verify` passed on 2026-07-10 with 55 tests passed, 1 opt-in live test skipped, and a successful build.

## Repository State

- Agentloop before Step 0: `PLAN.md` was untracked; no other Agentloop changes were present.
- Installed skills before Step 0: `agent-team-status-protocol/SKILL.md`, `codex-dev-team-goal/SKILL.md`, and `team-coordinator/SKILL.md` had pre-existing uncommitted edits and are treated as user-owned until Step 4 reconciliation.

## Current Status

- Status: Step 5 complete.
- Next step: begin Step 6 final acceptance and `/goal` closure evidence.

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
- 2026-07-10: Step 5 Agentloop commit subject: `docs: document label dispatch operations`.
