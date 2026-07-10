# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Add durable thread continuation, explicit resume, recovery prompts, and skill-change blocking for resumed runs.
- Add foreground Codex dev-team execution with streamed event persistence and strict control-envelope validation.
- Add durable queued runs, SQLite-backed status inspection, and queued-run cancellation.
- Add the `agentloop doctor` preflight command for repository, toolchain, GitHub, SDK, skill, state, and trust-boundary checks.
