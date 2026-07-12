# Security Policy

## Supported Versions

@recensa/claude-session is pre-1.0 and ships fixes on the latest release only.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| < latest | :x: (please update)|

## Reporting a Vulnerability

Please report security issues **privately** via GitHub Security Advisories:

> `https://github.com/S40911120/claude-session/security/advisories/new`

Do **not** open a public issue or discuss the vulnerability in public until it has
been addressed. You can expect an initial response within a few days.

## Scope

recensa-session is a **local command-line tool and Node library**. It makes no external
network calls and collects no telemetry; it reads and writes files on the machine it
runs on. Please keep this threat model in mind when reporting — issues that require an
attacker to already have local shell access are generally out of scope.

Two behaviors are worth calling out because they are easy to over-trust.

### `redact` is best-effort, not a guarantee

`recensa-session redact` masks common credential formats — provider API keys and tokens,
`Authorization: Bearer` / `Basic` headers, `password=` / `token=`-style assignments,
private-key blocks, and more — by pattern matching each string in a transcript. Pattern
matching cannot catch every secret: a custom token format, a secret split across fields,
or an unusual encoding can slip through. Review the output yourself before sharing a
transcript. Do not treat a redacted file as safe to publish on the strength of the tool
alone. `redact` writes a new copy and leaves the original file unchanged.

### The surgery commands write to and delete from disk

The structural surgery commands change files on disk: `repair`, `fork`, `merge`, and
`construct` write new or modified transcripts, and `surgeon` can delete messages from a
transcript (`verify` is read-only). Writes go through a temp-file-plus-rename, so an
interrupted run cannot leave a half-written transcript, but the result still replaces
the target file. Point these commands at a copy if you want the original untouched, and
keep a backup of anything you cannot regenerate.
