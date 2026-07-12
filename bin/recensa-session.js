#!/usr/bin/env node
/**
 * recensa-session.js — unified recensa-session CLI entry (dispatcher; package "bin")
 *
 * Usage: node bin/recensa-session.js <command> [args]
 *   node bin/recensa-session.js overview --latest                # view the latest session at a glance
 *   node bin/recensa-session.js tasks a1b2c3d4 --current         # use an 8-char prefix
 *   node bin/recensa-session.js verify <file>                    # surgery commands dispatched from the same entry
 *
 * Dispatches two command groups: intel/ (analysis) + surgery/ (surgery); for the library API see ../index.js (require('@recensa/claude-session')).
 * Every subcommand supports --latest and short-UUID-prefix auto resolution.
 * Note: there is no require.main guard — main() runs on require as well, so a thin CLI shim can pass argv straight through.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// intel scripts that live alongside this dispatcher (this dir)
const COMMANDS = {
  overview:    { script: 'session-overview.js',  desc: 'One-page combined report (goal + tasks + tools + files + tokens + cache warnings + chronicle + fork lineage)' },
  dashboard:   { script: 'session-overview.js',  desc: 'alias of overview (merged command — overview already covers every dashboard element)' },
  summary:     { script: 'session-summary.js',   desc: 'Cross-session aggregate (--since 7d, weekly report)', noResolve: true },
  tasks:       { script: 'session-tasks.js',     desc: 'Task list (--current / --pending / --done / --diff)' },
  goal:        { script: 'session-goal.js',      desc: 'Stop hook goal (--history)' },
  parser:      { script: 'session-parser.js',    desc: 'Parse (--messages / --tool-summary / --find)' },
  search:      { script: 'session-search.js',    desc: 'Full-text search across sessions' },
  clean:       { script: 'session-clean.js',     desc: 'Clean up / slim down (--strategy / --keep-tools)' },
  info:        { script: 'session-info.js',      desc: 'Metadata (--all / --brief)' },
  archive:     { script: 'session-archiver.js',  desc: 'Context extract / inject / merge' },
  'token-budget': { script: 'token-budget.js',   desc: 'Token-budget analysis (--budget-view)' },
  diff:        { script: 'context-diff.js',      desc: 'Content diff between two sessions (alias: context-diff)' },
  'context-diff': { script: 'context-diff.js',   desc: 'alias of diff' },
  'dead-context': { script: 'dead-context.js',   desc: 'Dead-context detection' },
  'cache-guard': { script: 'cache-guard.js',     desc: 'Prompt-cache killer detection' },
  handoff:     { script: 'session-handoff.js',   desc: 'Write a collaboration handoff file (.claude-output/session-coordination.md)' },
  watch:       { script: 'session-watch.js',     desc: 'Poll-mode watch for new session activity' },
  tree:        { script: 'session-tree.js',      desc: 'Fork-tree visualization (read-only, based on the jsonl forkedFrom field)', noResolve: true },
  reconstruct: { script: 'session-reconstruct.js', desc: 'Follow the fork chain to restore the full pre-compaction conversation → clean jsonl (offline archive, on-demand; --md/--stats)', noResolve: true },
  failures:    { script: 'session-failures.js',   desc: 'Full tool-failure survey + thrash detection (--summary/--retry/--log/--chain)', noResolve: true },
  guard:       { script: 'session-guard.js',      desc: 'Session degradation-signal scan (model purity / same-file churn / saturation; --self scans the current session; exit 0/1/2 = green/yellow/red)' },
  redact:      { script: 'session-redact.js',     desc: 'Mask keys/credentials before export/handoff (sk-/ghp_/Bearer/token=…; --out/--stdout/--dry-run)', noResolve: true },

  // surgery commands, dispatched across entry points (path: ../surgery/)
  verify:      { script: '../surgery/session-verify.js',  desc: '[surgery] 24 validity checks' },
  repair:      { script: '../surgery/session-repair.js',  desc: '[surgery] 8 automatic repairs' },
  surgeon:     { script: '../surgery/session-surgeon.js', desc: '[surgery] message-level insert/delete/find' },
  fork:        { script: '../surgery/session-forker.js',  desc: '[surgery] fork / split / trim' },
  merge:       { script: '../surgery/session-merger.js',  desc: '[surgery] merge multiple sessions' },
  construct:   { script: '../surgery/session-constructor.js', desc: '[surgery] build a session from scratch' },

  // utility commands
  ls:          { builtin: 'list', desc: 'List sessions (--match / --project / --since / --json / --cwd)' },
  cwd:         { builtin: 'cwd', desc: 'Show the human-readable working directory of a session (decodes the encoded path)' },
  where:       { builtin: 'cwd', desc: 'alias of cwd' },
  resolve:     { builtin: 'resolve', desc: 'Resolve input → full path (for debugging)' },
};

/** Extract the human-readable working directory (cwd field) from the head of the session JSONL.
 *  Scans in chunks so a huge first message (e.g. a base64 image) never exceeds a single window. */
function extractCwd(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const CHUNK = 256 * 1024; // 256KB per chunk
    const MAX_SCAN = 5 * 1024 * 1024; // scan at most 5MB
    let offset = 0;
    let leftover = '';
    while (offset < Math.min(stat.size, MAX_SCAN)) {
      const buf = Buffer.alloc(CHUNK);
      const bytes = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (bytes === 0) break;
      const text = leftover + buf.slice(0, bytes).toString('utf8');
      const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (match) {
        fs.closeSync(fd);
        return match[1].replaceAll(String.raw`\\`, '\\').replaceAll(String.raw`\"`, '"');
      }
      // keep the last 256 chars so a chunk boundary cannot split the "cwd" field
      leftover = text.slice(-256);
      offset += bytes;
    }
    fs.closeSync(fd);
    return null;
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`recensa-session — Claude Code session-JSONL toolkit

Usage:
  recensa-session <command> [session] [options]

Subcommands:`);
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(18)} ${c.desc}`);
  }
  console.log(`
Session identifiers (common to all subcommands):
  <absolute path>            point directly at a .jsonl path (most common)
  a1b2c3d4                   short UUID prefix (≥ 6 chars; multiple matches are listed)
  --latest                   the most recently modified session (**only for the "find latest" case**)
  --latest-in "path frag"    the latest within a project-directory keyword

ls subcommand options (find a session when you don't know its path):
  ls 10                      the 10 most recent
  ls --project "myproject"   only projects whose path contains myproject
  ls --match "LoginFlow"     sessions whose content contains "LoginFlow" (scans the first and last 32KB)
  ls --since 1h              within the last hour
  ls --cwd                   also show the human-readable working directory
  ls --json                  JSON output (to pipe into other tools)

cwd / where subcommand (session ID → working directory):
  recensa-session cwd a1b2c3d4                  # short UUID prefix
  recensa-session cwd --latest                  # latest session
  recensa-session cwd --latest-in "myproject"   # latest within a project
  recensa-session where <path-to-jsonl>         # alias of cwd

Examples:
  recensa-session ls 5                          # the 5 most recent
  recensa-session ls 5 --cwd                    # 5 most recent + working directory
  recensa-session ls --match "LoginFlow"        # find sessions that touched LoginFlow
  recensa-session overview <session-path>       # inspect a specific session
  recensa-session tasks a1b2c3d4 --current      # UUID prefix
  recensa-session goal --latest-in "myproject"  # latest within a project
  recensa-session cwd a1b2c3d4                  # look up a session's working directory`);
}

// ── list subcommand helpers (--project / --match / --since / --json / --cwd) ──────

/** Filter by content keyword (searches jsonl content, but only the first and last 32KB to stay fast on large files) */
function filterByContent(all, matchFilter, limit) {
  const lower = matchFilter.toLowerCase();
  const filtered = [];
  for (const s of all) {
    try {
      const fd = fs.openSync(s.path, 'r');
      const size = s.size;
      const buf = Buffer.alloc(Math.min(size, 32768));
      fs.readSync(fd, buf, 0, buf.length, 0);
      let text = buf.toString('utf8').toLowerCase();
      if (size > 32768) {
        const tailBuf = Buffer.alloc(32768);
        fs.readSync(fd, tailBuf, 0, 32768, size - 32768);
        text += tailBuf.toString('utf8').toLowerCase();
      }
      fs.closeSync(fd);
      if (text.includes(lower)) filtered.push(s);
    } catch {}
    if (filtered.length >= limit) break;
  }
  return filtered;
}

/** JSON output (to pipe into other tools) */
function printListJson(all, wantCwd) {
  const results = all.map(s => {
    const entry = {
      sessionId: s.sessionId,
      path: s.path,
      project: s.project,
      mtime: s.mtime.toISOString(),
      sizeBytes: s.size,
    };
    if (wantCwd) entry.cwd = extractCwd(s.path);
    return entry;
  });
  console.log(JSON.stringify(results, null, 2));
}

/** Human-readable list output */
function printListHuman(all, { projFilter, matchFilter, sinceSpec, wantCwd }) {
  const filterDesc = [];
  if (projFilter) filterDesc.push(`project~"${projFilter}"`);
  if (matchFilter) filterDesc.push(`content~"${matchFilter}"`);
  if (sinceSpec) filterDesc.push(`since=${sinceSpec}`);
  const desc = filterDesc.length > 0 ? ` (filter: ${filterDesc.join(', ')})` : '';

  console.log(`📁 ${all.length} session(s)${desc}:\n`);
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const date = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const sizeMB = (s.size / (1024 * 1024)).toFixed(1).padStart(6);
    console.log(`${(i + 1).toString().padStart(3)}. ${date}  ${sizeMB} MB  ${s.sessionId}`);
    console.log(`     Project: ${s.project}`);
    if (wantCwd) {
      const cwd = extractCwd(s.path);
      if (cwd) console.log(`     CWD:  ${cwd}`);
      else console.log(`     CWD:  (unresolved)`);
    }
  }
}

/** ls subcommand: list sessions */
function handleList(rest) {
  const { listAllSessions } = require('../lib/resolver');
  // parse --project / --match / --since / --json
  const projIdx = rest.indexOf('--project');
  const matchIdx = rest.indexOf('--match');
  const sinceIdx = rest.indexOf('--since');
  const wantJson = rest.includes('--json');
  const wantCwd = rest.includes('--cwd');
  const projFilter = projIdx >= 0 ? rest[projIdx + 1].toLowerCase() : null;
  const matchFilter = matchIdx >= 0 ? rest[matchIdx + 1] : null;
  const sinceSpec = sinceIdx >= 0 ? rest[sinceIdx + 1] : null;
  const limitArg = rest.find(a => /^\d+$/.test(a));
  const defaultLimit = matchFilter ? 100 : 10;
  const limit = limitArg ? Number.parseInt(limitArg) : defaultLimit;

  let all = listAllSessions();

  // project filter
  if (projFilter) {
    all = all.filter(s => s.project.toLowerCase().includes(projFilter));
  }
  // time filter
  if (sinceSpec) {
    const { parseTimeSpec } = require('../lib/resolver');
    const sinceMs = parseTimeSpec(sinceSpec);
    if (sinceMs) all = all.filter(s => s.mtime.getTime() >= sinceMs);
  }
  // content-keyword filter (searches jsonl content, but only the first and last 32KB to stay fast on large files)
  if (matchFilter) {
    all = filterByContent(all, matchFilter, limit);
  }

  all = all.slice(0, limit);

  if (wantJson) {
    printListJson(all, wantCwd);
    return;
  }

  printListHuman(all, { projFilter, matchFilter, sinceSpec, wantCwd });
}

/** resolve subcommand: resolve input → full path (for debugging) */
function handleResolve(rest) {
  const { resolveFromArgs, describe } = require('../lib/resolver');
  try {
    const r = resolveFromArgs(rest, { allowEmpty: true });
    console.log(describe(r));
    console.log('  path:', r.path);
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
}

/** cwd / where subcommand: session ID → working directory */
function handleCwd(rest) {
  const { resolveFromArgs } = require('../lib/resolver');
  try {
    const r = resolveFromArgs(rest);
    const cwd = extractCwd(r.path);
    if (cwd) {
      console.log(cwd);
    } else {
      console.error(`⚠️ no cwd field found in this session's JSONL`);
      console.error(`   encoded project name: ${r.project || '(unknown)'}`);
      console.error(`   file: ${r.path}`);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
}

// only treat firstArg as a session identifier when it looks like a UUID
// a pure number (e.g. 1000000) is not a UUID — avoids swallowing a --context-window value
function looksLikeUuid(firstArg) {
  return firstArg &&
    /^[a-f0-9]{6,}(?:-[a-f0-9]+)*$/i.test(firstArg) &&
    /[a-f]/i.test(firstArg) &&  // must contain a hex letter (excludes pure numbers)
    !firstArg.endsWith('.jsonl') &&
    !firstArg.includes('/') && !firstArg.includes('\\');
}

// resolve the session identifier → path, then safely remove the identifier itself (--latest or the short UUID prefix) while keeping the other args
function resolveFinalArgs(rest, firstArg, firstArgIsUuid) {
  const { resolveFromArgs } = require('../lib/resolver');
  try {
    const r = resolveFromArgs(rest);
    // safe removal: strip only the session identifier itself (--latest or the short UUID prefix), do not filter out other args
    const cleaned = [...rest];
    // remove --latest (standalone flag)
    const latestIdx = cleaned.indexOf('--latest');
    if (latestIdx >= 0) cleaned.splice(latestIdx, 1);
    // remove --latest-in <next>
    const latestInIdx = cleaned.indexOf('--latest-in');
    if (latestInIdx >= 0) cleaned.splice(latestInIdx, 2);
    // if firstArg is a UUID, remove it (use indexOf to find its exact position)
    if (firstArgIsUuid) {
      const uuidIdx = cleaned.indexOf(firstArg);
      if (uuidIdx >= 0) cleaned.splice(uuidIdx, 1);
    }
    return [r.path, ...cleaned];
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
}

// delegate to the matching script (bin/ sits at the package root: intel commands are bare names → prefix ../intel/; surgery commands already carry the ../surgery/ prefix, left as-is)
function handleScriptCommand(def, rest) {
  const rel = def.script.startsWith('../') ? def.script : path.join('..', 'intel', def.script);
  const scriptPath = path.resolve(__dirname, rel);
  if (!fs.existsSync(scriptPath)) {
    // targeted hint when a surgery command (now co-located under the package surgery/) is missing
    const isSurgery = def.script.startsWith('../surgery/');
    if (isSurgery) {
      console.error(`❌ surgery script not found: ${scriptPath}`);
      console.error(`   (this package's surgery/ directory should contain this file)`);
    } else {
      console.error(`❌ script not found: ${scriptPath}`);
    }
    process.exit(1);
  }

  // noResolve commands (e.g. tree) → pass args through directly, do not attempt session-path resolution
  if (def.noResolve) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('node', [scriptPath, ...rest], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  // try to turn the session identifier into a real path
  // condition: the first non-flag arg in rest is a UUID / --latest → resolve
  // otherwise pass straight through to the child script
  const firstArgIdx = rest.findIndex(a => !a.startsWith('--'));
  const firstArg = firstArgIdx >= 0 ? rest[firstArgIdx] : null;
  const hasLatest = rest.includes('--latest') || rest.includes('--latest-in');
  const firstArgIsUuid = looksLikeUuid(firstArg);
  const needsResolution = hasLatest || firstArgIsUuid;

  const finalArgs = needsResolution
    ? resolveFinalArgs(rest, firstArg, firstArgIsUuid)
    : rest;

  // spawn the child script
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('node', [scriptPath, ...finalArgs], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmd = args[0];
  const rest = args.slice(1);
  const def = COMMANDS[cmd];

  if (!def) {
    console.error(`❌ unknown subcommand: "${cmd}"`);
    console.error(`available subcommands: ${Object.keys(COMMANDS).join(', ')}`);
    console.error(`run recensa-session --help for full usage`);
    process.exit(1);
  }

  // built-in commands
  if (def.builtin === 'list') { handleList(rest); return; }
  if (def.builtin === 'resolve') { handleResolve(rest); return; }
  if (def.builtin === 'cwd') { handleCwd(rest); return; }

  handleScriptCommand(def, rest);
}

main();
