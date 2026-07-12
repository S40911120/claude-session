# recensa-session

**A dependency-free CLI and Node library for Claude Code session JSONL — parse, verify,
repair, fork, merge, and redact the `*.jsonl` transcripts under `~/.claude/projects/`.**

<p>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat" alt="Node >= 22">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat" alt="Zero runtime dependencies">
  <a href="https://www.npmjs.com/package/@recensa/claude-session"><img src="https://img.shields.io/npm/v/@recensa/claude-session?style=flat&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/S40911120/claude-session/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/S40911120/claude-session/ci.yml?style=flat&label=CI" alt="CI status"></a>
</p>

One bad structural edit bricks a transcript: drop a `tool_result`, orphan a `tool_use`,
and `claude --resume` fails with a permanent API 400. recensa-session reads, audits, and
repairs those transcripts from the command line or in-process — Node core only, no
runtime dependencies. It is the engine behind the
[Recensa](https://github.com/S40911120/recensa) session viewer.

> **Unofficial.** A community tool for working with Claude Code's on-disk session files.
> Not affiliated with, endorsed by, or supported by Anthropic.

- **Analyze.** `overview` folds a whole session into one page: goal, tasks, tool usage,
  changed files, token stats, cache warnings, and fork lineage.
- **Search.** Full-text search across every session, narrowed by time or project.
- **Verify.** Resume-validity checks that catch the exact defects that brick a
  `--resume` — orphaned `tool_use`, out-of-order blocks, duplicate UUIDs, broken
  thinking blocks.
- **Repair.** Fix those defects automatically, writing through a temp-file-plus-rename
  so an interrupted run never leaves a half-written transcript.
- **Fork / merge.** Split, trim, and recombine transcripts, or build one from scratch.
- **Redact.** Mask keys and credentials before you export or hand off a transcript.

## Install

```bash
npm install @recensa/claude-session        # library + the `recensa-session` CLI
```

## Example

`recensa-session overview <session>` folds an entire session into a one-page report — this is
its real output on a small session:

```
Session: 9e1db63e-e747-4a...  |  0.01 MB  |  3 user-prompts / 6 assistant-turns
Start: 2026-07-12 09:00:00  |  End: 2026-07-12 09:10:58  |  Models: claude-sonnet-4-6
Cwd: /home/dev/upload-service
Compact boundaries: 0

## 🎯 Current goal (since 2026-07-12 09:00:47)
   "upload retry lands and node --test stays green"

## 📋 Task summary (2 total)
   ✅ completed: 1  |  ⚙️ in_progress: 1
   In progress:
     ⚙️  Add retry regression test

## 🔧 Tool usage (top 12)
   TaskUpdate           3
   TaskCreate           2
   Edit                 2
   Read                 1
   Write                1
   Bash                 1

## 💬 Most recent 2 user prompts
   09:01:34  Add retry with exponential backoff to uploadFile(), then cover it with a test.
   09:10:11  Looks good. Bump the max attempts to 5 and keep the test green.

## 📁 Most frequently changed files (top 10)
   (2x) /home/dev/upload-service/src/client.js
   (1x) /home/dev/upload-service/test/client.test.js

## 📊 Token stats
   API input:        4,600
   API output:       997
   Cache read:       194,360
   Cache create:     0
   Cache hit rate:   97.7%
```

`recensa-session verify <session>` runs the same session through its resume-validity checks
and prints `Status: PASS` when `claude --resume` can safely load it — or names each
broken block (and the `repair` command that fixes it) when it cannot.

## CLI

```bash
recensa-session <command> [session] [options]
```

```bash
recensa-session ls 10                          # list the 10 most recent sessions
recensa-session overview --latest              # one-page report on the latest session
recensa-session parser <session> --messages    # stream-parse a transcript
recensa-session search "login flow" --since 1d # full-text search across sessions
recensa-session token-budget <session>         # token-budget breakdown
recensa-session guard --self                   # degradation signals for the current session
recensa-session redact <session> --out clean.jsonl  # mask secrets before export/handoff

# structural surgery (writes new/edited transcripts; always explicit)
recensa-session verify <session>               # 24 validity checks
recensa-session repair <session> --list        # auto-repair broken resume chains
recensa-session fork <session> ...             # fork / split / trim

recensa-session --help                         # full command list
```

Analysis commands read your transcripts without mutating them (`reconstruct` writes a new
archive file, never touching the source). Surgery commands (`verify`, `repair`, `surgeon`,
`fork`, `merge`, `construct`) write new or edited transcripts and are always invoked
explicitly.

`redact` masking is best-effort: it pattern-matches common credential formats, so review
the output before sharing a transcript. See [SECURITY.md](./SECURITY.md).

Every subcommand accepts the same session identifiers:

| Form | Example |
|------|---------|
| Absolute `.jsonl` path | `/path/to/session.jsonl` |
| Short UUID prefix (≥ 6 chars) | `a1b2c3d4` |
| Most recently modified | `--latest` |
| Latest within a path fragment | `--latest-in "myproject"` |

## Programmatic API

Call the same logic in-process, without spawning a subprocess:

```js
const recensa-session = require('@recensa/claude-session');

const report = await recensa-session.overview('/path/to/session.jsonl');
const budget = await recensa-session.tokenBudget('/path/to/session.jsonl');
```

Each function takes an absolute path to a session `.jsonl`. The analysis functions return
the same object shape as the CLI's `<command> --json` output (the equivalence is checked
by the package's parity tests).

**Analysis**

| Export | Returns |
|--------|---------|
| `overview(file, opts?)` | One-page report: goal, tasks, tools, files, tokens, cache warnings, fork lineage. |
| `tasks(file)` | Task list extracted from the session. |
| `goal(file)` | Current goal plus historical goal events. |
| `guard(file, opts?)` | Degradation signals (model purity, same-file churn, saturation). |
| `failures(file)` | Tool-failure survey plus thrash detection. |
| `tokenBudget(file, opts?)` | Token-budget report (fixed costs, API-reported, estimated, thresholds). |
| `deadContext(file, strategy?)` | Dead-context detection. |
| `cacheGuard(file)` | Prompt-cache-killer detection. |
| `reconstruct(file, outPath, opts?)` | Follow the fork chain and write the full pre-compaction conversation to `outPath` (writes a file). |

**Structural surgery**

| Export | Returns |
|--------|---------|
| `verify(file, opts?)` | 24 legality checks for resume validity. |
| `repair(file, opts?)` | Automatic repair (orphans, ordering, duplicates, broken thinking blocks). |

**Low-level**

| Export | Returns |
|--------|---------|
| `getSessionParser()` | The streaming `SessionParser` class, for custom in-process parsing. |
| `resolveProjectsDir(opts?)` | Absolute path to the session JSONL root (`RECENSA_PROJECTS_DIR` > `CLAUDE_CONFIG_DIR/projects` > `~/.claude/projects`); pass `{ validate: true }` to throw if it is missing. |

To spawn the CLI from another process instead, resolve its path:

```js
const bin = require.resolve('@recensa/claude-session/bin/recensa-session.js');
```

## Layout

- `intel/` — analysis commands (overview, tasks, goal, search, parser, guard,
  token-budget, and more).
- `surgery/` — structural surgery (verify, repair, surgeon, forker, merger, constructor).

## Configuration

- `RECENSA_PROJECTS_DIR` — override the sessions root. Resolution precedence:
  `RECENSA_PROJECTS_DIR` > `CLAUDE_CONFIG_DIR/projects` > `~/.claude/projects`. Set it
  for containerized or relocated setups.

## Troubleshooting

**`recensa-session: command not found` after `npm install @recensa/claude-session`.** A local install puts
the CLI in `node_modules/.bin`, not on your PATH. Run it with `npx @recensa/claude-session ...`, or
install globally with `npm install -g @recensa/claude-session`.

**"No sessions found", or it reads the wrong directory.** recensa-session looks in
`RECENSA_PROJECTS_DIR`, then `CLAUDE_CONFIG_DIR/projects`, then `~/.claude/projects`.
If your Claude config lives elsewhere — a relocated or containerized setup — point
`RECENSA_PROJECTS_DIR` at the directory that holds the `*.jsonl` files.

**Syntax or API errors on startup.** recensa-session targets Node 22 or newer. Check `node -v`
and upgrade if it is older.

## License

MIT. Author: Justin Chen.
