# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Add the label-scoped `dispatch` command for idempotent scheduled polling, dry runs, no-ready-issue no-ops, and already-active run detection.
- Add `bun run install:global` for rebuilding and globally linking the local Agentloop checkout.
- Add event replay, follow mode, and expanded run status for durable run inspection.
- Add detached worker execution for queued runs and stale-lease recovery.
- Add durable human approval checkpoints with approve/reject commands and approval-response resume prompts.
- Add run safety limits for turn, token, duration, no-progress, heartbeat renewal, and signal cancellation handling.
- Add durable thread continuation, explicit resume, recovery prompts, and skill-change blocking for resumed runs.
- Add foreground Codex dev-team execution with streamed event persistence and strict control-envelope validation.
- Add durable queued runs, SQLite-backed status inspection, and queued-run cancellation.
- Add the `agentloop doctor` preflight command for repository, toolchain, GitHub, SDK, skill, state, and trust-boundary checks.

### Changed

- Keep interactive foreground sessions attached across paused open-run states and stream a compact structured roster with active/running/waiting/blocked counts, each agent's role and current task, coordinator decisions, and failures while hiding routine command/file/wait noise.
- Add GitHub-visible label claim guidance for dispatched issues, including same-run recovery, different-run refusal, existing-PR reuse, and terminal blocker evidence.
- Include the durable Agentloop run ID in coordinator prompt headers for GitHub claim and recovery correlation.

### Fixed

- Make `bun run install:global` replace broken Bun global links with a verified direct `agentloop` binary symlink.
- Make approval and blocker control-envelope fields valid strict Structured Outputs schemas.

### Security

- Harden CLI input, secret redaction, repository surface warnings, and fail-closed state handling.
