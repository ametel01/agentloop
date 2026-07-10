# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Add event replay, follow mode, and expanded run status for durable run inspection.
- Add detached worker execution for queued runs and stale-lease recovery.
- Add durable human approval checkpoints with approve/reject commands and approval-response resume prompts.
- Add run safety limits for turn, token, duration, no-progress, heartbeat renewal, and signal cancellation handling.
- Add durable thread continuation, explicit resume, recovery prompts, and skill-change blocking for resumed runs.
- Add foreground Codex dev-team execution with streamed event persistence and strict control-envelope validation.
- Add durable queued runs, SQLite-backed status inspection, and queued-run cancellation.
- Add the `agentloop doctor` preflight command for repository, toolchain, GitHub, SDK, skill, state, and trust-boundary checks.
