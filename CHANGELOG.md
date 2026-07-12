# Changelog

All notable changes to recensa-session are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.1.1] — 2026-07-12

### Changed
- Author metadata unified to the maintainer's public GitHub name.
- README: absolute link to the Recensa viewer repository (the relative link broke
  outside the original monorepo).

## [0.1.0] — 2026-07-12

First tagged release.

### Added
- `redact` command: mask secrets before exporting or sharing a transcript. Covers
  many provider formats — OpenAI/Anthropic keys, GitHub tokens and PATs, AWS access
  keys, Slack tokens and webhooks, Stripe/Google/SendGrid/npm/GitLab/DigitalOcean/GCP
  keys, Azure storage and SAS values, `Bearer` / `Basic` auth headers, JWTs, PEM
  private-key blocks, connection-string credentials, and `password=` / `token=` style
  assignments. Best-effort by design; review output before sharing. Flags:
  `--out` / `--stdout` / `--dry-run`.
- Crash-safe atomic writes for all surgery output: content goes to a same-directory
  temp file opened with `O_EXCL`, then renames over the target, so an interrupted run
  cannot leave a torn transcript.
- UUID-chain cycle detection in resume/fork validation, including rootless cycles
  (a loop with no entry point into the chain).
- The 8 automatic repairs in `repair`, each runnable on its own or all at once:
  orphan tool_use, orphan tool_result, out-of-order tool_use, duplicate messages,
  broken thinking blocks, and the rest of the resume-validity set.

### Changed
- Read path rebuilt around a byte cursor: paging and stream-parsing large transcripts
  no longer re-read the file from the start on each step.

### Fixed
- `redact` value classes tightened so an opaque base64 token masks whole (the earlier
  class stopped at the first `+` / `=` and leaked the tail) and a credential regex
  cannot run past a JSON string boundary and corrupt the surrounding line.
