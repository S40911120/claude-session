/**
 * resolver.js — unified session path resolution
 *
 * Handles the several ways a user can identify a session:
 *   1. Full absolute path: C:/Users/.../xxx.jsonl
 *   2. Full session UUID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *   3. Short session UUID prefix: a1b2c3d4 (≥ 6 chars)
 *   4. --latest: the most recently modified session
 *   5. --latest-in <project>: the latest session within a given project
 *
 * So the user does not have to copy the full path every time, and can just run:
 *   node session-overview.js --latest
 *   node session-overview.js a1b2c3d4
 *   node session-overview.js --latest-in "D:/my-project"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Cross-platform location of the session JSONL root directory (single source of truth; shared by the recensa-session CLI and recensa config).
 * Order (most robust first):
 *   1. RECENSA_PROJECTS_DIR        explicit override for this tool (container bind-mount / relocation, highest priority)
 *   2. CLAUDE_CONFIG_DIR/projects     Claude Code's official config-relocation env (when set, both config and sessions live here)
 *   3. os.homedir()/.claude/projects  default (Windows=%USERPROFILE%, mac/Linux=$HOME; no XDG/%APPDATA% special case)
 * @param {{validate?:boolean}} [opts] validate=true → existsSync check, throw if missing (fail-fast at app startup rather than a silent empty scan)
 * @returns {string} absolute root directory
 */
function resolveProjectsDir({ validate = false } = {}) {
  const home = os.homedir();
  const dir = process.env.RECENSA_PROJECTS_DIR
    || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : null)
    || (home ? path.join(home, '.claude', 'projects') : null);
  if (!dir) {
    throw new Error('Cannot locate the session JSONL root directory: os.homedir() is empty and neither RECENSA_PROJECTS_DIR nor CLAUDE_CONFIG_DIR is set');
  }
  if (validate && !fs.existsSync(dir)) {
    throw new Error(`Session JSONL root directory does not exist: ${dir}\n  → initialize Claude Code first, or point RECENSA_PROJECTS_DIR / CLAUDE_CONFIG_DIR at the correct path (fail-fast rather than a silent empty scan)`);
  }
  return dir;
}

// Resolved once at module load (for the CLI; not validated — a missing directory is handled gracefully by listAllSessions' existsSync returning [])
const CLAUDE_PROJECTS = resolveProjectsDir();

/** Scan the session files under a single project directory (excluding subagent agent-*.jsonl), pushing results into sessions */
function scanProjectSessions(dir, project, sessions) {
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    if (file.startsWith('agent-')) continue;
    const fp = path.join(dir, file);
    try {
      const s = fs.statSync(fp);
      sessions.push({
        path: fp,
        project,
        sessionId: file.replace('.jsonl', ''),
        mtime: s.mtime,
        size: s.size,
      });
    } catch {}
  }
}

/** Scan every session file (excluding subagent agent-*.jsonl) */
function listAllSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const sessions = [];
  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, project);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    scanProjectSessions(dir, project, sessions);
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/** Find the latest session (with optional project filter) */
function findLatest(projectFilter = null) {
  const all = listAllSessions();
  if (!projectFilter) return all[0] || null;
  const lower = projectFilter.toLowerCase();
  // Decode the encoded project path, then match the ones containing the filter
  const decoded = (encoded) => {
    let r = '';
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '-' && encoded[i + 1] === '-') { r += '/.'; i++; }
      else if (encoded[i] === '-') { r += '/'; }
      else r += encoded[i];
    }
    return r;
  };
  return all.find(s => decoded(s.project).toLowerCase().includes(lower)) || null;
}

/** Resolve a user-provided session identifier → absolute path */
function resolve(input, opts = {}) {
  // null / empty → behaves like --latest
  if (!input || input === '--latest') {
    const latest = findLatest(opts.projectFilter);
    if (!latest) throw new Error('No sessions found');
    return { path: latest.path, source: 'latest', sessionId: latest.sessionId };
  }

  // Absolute path
  if (path.isAbsolute(input) || input.startsWith('/c/') || /^[a-zA-Z]:/.test(input)) {
    if (fs.existsSync(input)) {
      return { path: input, source: 'absolute', sessionId: path.basename(input, '.jsonl') };
    }
    throw new Error(`File not found: ${input}`);
  }

  // Session ID (full 36-char UUID)
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)) {
    const all = listAllSessions();
    const found = all.find(s => s.sessionId.toLowerCase() === input.toLowerCase());
    if (found) return { path: found.path, source: 'uuid', sessionId: found.sessionId };
    throw new Error(`Session ID not found: ${input}`);
  }

  // Session ID short prefix (6+ hex chars)
  if (/^[a-f0-9]{6,}$/i.test(input)) {
    const all = listAllSessions();
    const matches = all.filter(s => s.sessionId.toLowerCase().startsWith(input.toLowerCase()));
    if (matches.length === 0) throw new Error(`No session starting with "${input}"`);
    if (matches.length > 1) {
      const list = matches.slice(0, 5).map(s => `  ${s.sessionId}  ${s.mtime.toISOString().slice(0,16)}  ${s.project}`).join('\n');
      throw new Error(`"${input}" ambiguously matches ${matches.length} sessions:\n${list}\nplease provide a longer prefix`);
    }
    return { path: matches[0].path, source: 'prefix', sessionId: matches[0].sessionId };
  }

  // Neither an ID nor a path → try treating it as a path
  if (fs.existsSync(input)) {
    return { path: path.resolve(input), source: 'relative', sessionId: path.basename(input, '.jsonl') };
  }

  throw new Error(`Cannot resolve "${input}": not a file path and not a session ID (≥ 6 hex chars). Try --latest or an 8-char UUID prefix.`);
}

/** Pretty-print the resolution result (for debugging) */
function describe(resolved) {
  const sources = {
    latest: '🕐 latest session',
    uuid: '🎯 full UUID',
    prefix: '✨ auto-completed short UUID prefix',
    absolute: '📁 absolute path',
    relative: '📁 relative path',
  };
  return `${sources[resolved.source] || ''}: ${resolved.sessionId.slice(0, 16)}...`;
}

/** CLI helper: resolve a session from args — accepts args[0], --latest, or --session-id <id> */
function resolveFromArgs(args, opts = {}) {
  const latestIdx = args.indexOf('--latest');
  const latestInIdx = args.indexOf('--latest-in');
  const idIdx = args.indexOf('--session-id');

  if (latestInIdx >= 0) {
    return resolve(null, { projectFilter: args[latestInIdx + 1] });
  }
  if (latestIdx >= 0 || args.length === 0 && opts.allowEmpty) {
    return resolve('--latest');
  }
  if (idIdx >= 0) {
    return resolve(args[idIdx + 1]);
  }
  // Default: the first non-flag argument
  const first = args.find(a => !a.startsWith('--'));
  if (!first) throw new Error('A session argument is required (path, UUID, or --latest)');
  return resolve(first);
}

// ── Time-range parsing ──────────────────────────────────────────
// Accepts: "3m", "2h", "1d", "30s", "2026-06-11T10:00"
// Also accepts relative forms: "3m ago" (ago is the default anyway)

function parseTimeSpec(spec, baseMs = Date.now()) {
  if (!spec) return null;
  const m = spec.match(/^(\d+)\s*([smhd])(?:\s+ago)?$/i);
  if (m) {
    const n = Number.parseInt(m[1]);
    const unit = m[2].toLowerCase();
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const ms = n * unitMs[unit];
    return baseMs - ms;
  }
  // ISO 8601
  const t = new Date(spec).getTime();
  if (!Number.isNaN(t)) return t;
  return null;
}

/** Extract --since / --until from args → { sinceMs, untilMs, baseMs, baseSource }
 *
 *  baseMs default: if sessionPath is given and the file mtime is > 5 minutes old (treated as an
 *  already-exited session) → use mtime; otherwise use now (still active).
 *  Callers can force it via opts.forceBase to 'now' / 'session-mtime'.
 *  baseSource records which base was actually used (for display in output).
 */
function parseTimeRange(args, opts = {}) {
  const sinceIdx = args.indexOf('--since');
  const untilIdx = args.indexOf('--until');
  let baseMs = Date.now();
  let baseSource = 'now';
  if (opts.sessionPath) {
    try {
      const s = fs.statSync(opts.sessionPath);
      const mtimeMs = s.mtime.getTime();
      const ageMs = Date.now() - mtimeMs;
      const FIVE_MIN = 5 * 60_000;
      const useMtime = opts.forceBase === 'session-mtime' ||
        (opts.forceBase !== 'now' && ageMs > FIVE_MIN);
      if (useMtime) { baseMs = mtimeMs; baseSource = 'session-mtime'; }
    } catch {}
  }
  if (opts.baseMs) { baseMs = opts.baseMs; baseSource = 'caller-baseMs'; }
  return {
    sinceMs: sinceIdx >= 0 ? parseTimeSpec(args[sinceIdx + 1], baseMs) : null,
    untilMs: untilIdx >= 0 ? parseTimeSpec(args[untilIdx + 1], baseMs) : null,
    baseMs,
    baseSource,
  };
}

/** Given a record's timestamp string, decide whether it falls within range */
function isInRange(timestamp, { sinceMs, untilMs }) {
  if (!sinceMs && !untilMs) return true;
  if (!timestamp) return true; // metadata without a timestamp is not filtered out
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return true;
  if (sinceMs && t < sinceMs) return false;
  if (untilMs && t > untilMs) return false;
  return true;
}

// ── Fork-chain walk (follow forkedFrom back to the root) ──────────
// Mechanism:
// auto/manual compaction → stays in the same file (a mid-file compact_boundary, no forkedFrom, same sessionId);
// --resume/fork-session → creates a new file (the first-line replay block carries forkedFrom pointing at the parent).
// The full history across --resume files is spread along the forkedFrom chain (compaction itself never
// crosses files — the pre-compaction records stay in the same file, before the boundary).

/** Read the start of the jsonl to find the forkedFrom parent sessionId (scans the first 64KB, first match wins) */
function readForkParent(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.subarray(0, bytes).toString('utf8').match(/"forkedFrom":\{"sessionId":"([0-9a-f-]{36})"/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Walk the forkedFrom chain from input back to the root, returning ordered segments (root → ... → current).
 *  Cycle-guarded (seen). If the chain breaks (parent jsonl missing) → mark missing and stop. */
function walkChain(input, opts = {}) {
  const start = resolve(input, opts);
  const byId = new Map(listAllSessions().map((s) => [s.sessionId, s]));
  const chain = [];
  const seen = new Set();
  let curId = start.sessionId;
  while (curId && !seen.has(curId)) {
    seen.add(curId);
    const seg = byId.get(curId);
    if (!seg) { chain.push({ sessionId: curId, path: null, missing: true }); break; }
    const parent = readForkParent(seg.path);
    chain.push({ sessionId: curId, path: seg.path, forkedFrom: parent, size: seg.size, mtime: seg.mtime });
    curId = parent;
  }
  return chain.reverse();
}

/** On the non---chain path, detect whether the session was forked from another file; if so, print a
 *  stderr hint to add --chain (a fork-aware "under-counting" notice).
 *  Rationale: the conservative single-file default must surface a hint, otherwise the user silently
 *  hits the pitfall and misjudges the budget. */
function hintChainIfForked(sessionPath, args) {
  if (!args || args.includes('--chain')) return;
  try {
    const parent = readForkParent(sessionPath);
    if (parent) process.stderr.write(`ℹ️  this session was forked from ${parent.slice(0, 8)}; pre-compaction content is spread along the parent chain — only this segment is counted here, add --chain to see the full conversation\n`);
  } catch { /* a detection failure must not break the main flow */ }
}

module.exports = {
  listAllSessions,
  findLatest,
  resolve,
  resolveFromArgs,
  describe,
  parseTimeSpec,
  parseTimeRange,
  isInRange,
  readForkParent,
  walkChain,
  hintChainIfForked,
  resolveProjectsDir,
  CLAUDE_PROJECTS,
};
