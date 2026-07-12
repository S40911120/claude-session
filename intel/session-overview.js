#!/usr/bin/env node
/**
 * session-overview.js — one-page combined session report
 *
 * Motivated by real usage: "reviewing someone's overview took 5 greps to piece together; I want one table that covers it all"
 *
 * Combines:
 *   - basic session info (id / size / start / end)
 *   - current goal (session-goal.js)
 *   - task summary (session-tasks.js)
 *   - tool usage stats
 *   - the most recent N user prompts
 *   - recently changed files (extracted from Edit/Write tool_use)
 *   - token estimate
 *
 * Usage:
 *   recensa-session overview <session.jsonl>
 *   recensa-session overview <session.jsonl> --recent 10    # the 10 most recent prompts
 *   recensa-session overview <session.jsonl> --json
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { extractTasks } = require('./session-tasks');
const { extractGoals, getCurrentGoal } = require('./session-goal');
const { parseTimeRange, isInRange } = require('../lib/resolver');

/** extract conversation text from user message content (pure reorg, replaces the nested ternary) */
function extractPromptText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  return '';
}

/** update first/last timestamp (pure reorg, logic unchanged) */
function updateTimestamps(overview, r) {
  if (!r.timestamp) return;
  const t = new Date(r.timestamp).getTime();
  if (!Number.isNaN(t)) {
    if (!overview.firstTimestamp || t < overview.firstTimestamp) overview.firstTimestamp = t;
    if (!overview.lastTimestamp || t > overview.lastTimestamp) overview.lastTimestamp = t;
  }
}

/** capture session-level scalar metadata (set on first sight) (pure reorg, logic unchanged) */
function captureScalars(overview, r) {
  if (!overview.sessionId && r.sessionId) overview.sessionId = r.sessionId;
  if (!overview.cwd && r.cwd) overview.cwd = r.cwd;
  if (!overview.forkedFrom && r.forkedFrom) overview.forkedFrom = r.forkedFrom;
  updateTimestamps(overview, r);
}

/** handle an external user prompt (noise filtering + collect recent) (pure reorg, logic unchanged) */
function processUserPrompt(r, overview) {
  overview.userPromptCount++;
  const c = r.message?.content;
  const txt = extractPromptText(c);
  // filter out noise (command-name, system-reminder, stop-hook feedback, etc.)
  const isNoise = !txt ||
    txt.startsWith('<command-name>') ||
    txt.startsWith('<system-reminder>') ||
    txt.startsWith('Stop hook feedback:') ||
    txt.includes('UserPromptSubmit hook success:') ||
    txt.startsWith('<task-notification>');
  if (!isNoise) {
    const clean = txt.replace(/\s+/g, ' ').trim();
    if (clean.length > 5) {
      overview.recentUserPrompts.push({
        timestamp: r.timestamp,
        text: clean.slice(0, 150),
      });
    }
  }
}

/** record the model and detect switches (which fully reset the cache) (pure reorg, logic unchanged) */
function trackModelSwitch(r, overview, ctx, m) {
  overview.model.add(m);
  // detect model switches (which fully reset the cache) — filter out <synthetic> to avoid false positives
  if (ctx.lastModel && ctx.lastModel !== m) {
    overview.modelSwitches.push({
      timestamp: r.timestamp,
      turn: overview.turnCount,
      line: ctx.lineNum,
      from: ctx.lastModel,
      to: m,
    });
  }
  ctx.lastModel = m;
}

/** accumulate tool_use usage and file edits for a single block (pure reorg, logic unchanged) */
function accumulateToolUsage(block, overview) {
  if (block.type !== 'tool_use') return;
  overview.toolUsage[block.name] = (overview.toolUsage[block.name] || 0) + 1;
  if (['Edit', 'Write'].includes(block.name)) {
    const fp = block.input?.file_path || block.input?.filePath;
    if (fp) {
      overview.fileEdits[fp] = (overview.fileEdits[fp] || 0) + 1;
    }
  }
}

/** handle an assistant record (model switch / token / tool_use) (pure reorg, logic unchanged) */
function processAssistantRecord(r, overview, ctx) {
  overview.turnCount++;
  const m = r.message?.model;
  const isSynthetic = m === '<synthetic>';
  if (m && !isSynthetic) {
    trackModelSwitch(r, overview, ctx, m);
  }
  const usage = r.message?.usage;
  if (usage) {
    overview.apiInputTokens += usage.input_tokens || 0;
    overview.apiOutputTokens += usage.output_tokens || 0;
    overview.apiCacheReadTokens += usage.cache_read_input_tokens || 0;
    overview.apiCacheCreateTokens += usage.cache_creation_input_tokens || 0;
  }
  if (Array.isArray(r.message?.content)) {
    for (const block of r.message.content) {
      accumulateToolUsage(block, overview);
    }
  }
}

/** ingest one record (time filter + scalar + compact + user + assistant) (pure reorg, processing order unchanged) */
function ingestOverviewRecord(r, overview, ctx, timeRange, hasTimeFilter) {
  // time-range filter (metadata is still kept)
  if (hasTimeFilter && r.timestamp && !isInRange(r.timestamp, timeRange)) return;

  captureScalars(overview, r);

  if (r.type === 'system' && /compact_boundary/.test(r.subtype || '')) {
    overview.compactBoundaryCount++;
    overview.compactBoundaries.push({
      line: ctx.lineNum,
      turn: overview.turnCount,
      timestamp: r.timestamp,
    });
  }

  if (r.type === 'user' && r.userType === 'external' && !r.toolUseResult) {
    processUserPrompt(r, overview);
  }

  if (r.type === 'assistant') {
    processAssistantRecord(r, overview, ctx);
  }
}

/** scan the same directory for children (forkedFrom.sessionId == this session's) (pure reorg, logic unchanged) */
function scanForkChildren(sessionPath, overview) {
  try {
    const sessionDir = path.dirname(sessionPath);
    const sibFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    for (const f of sibFiles) {
      const fp = path.join(sessionDir, f);
      if (fp === sessionPath) continue;
      try {
        const fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(2048);
        fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);
        const firstLine = buf.toString('utf8').split('\n')[0];
        if (!firstLine) continue;
        const r = JSON.parse(firstLine);
        if (r.forkedFrom?.sessionId === overview.sessionId) {
          overview.forks.push(f.replace('.jsonl', ''));
        }
      } catch {}
    }
  } catch {}
}

/** deep chronicle integration — use "events within this session's time range" rather than "the last 5" (pure reorg, logic unchanged) */
function integrateChronicle(overview) {
  if (!overview.cwd) return;
  const chroniclePath = path.join(overview.cwd, '.chronicle', 'events.jsonl');
  // Chronicle enrichment is optional: it reads a .chronicle/events.jsonl log from the working directory
  // when one is present. Record whether it was found; when absent the report skips the section entirely.
  if (!fs.existsSync(chroniclePath)) { overview.chronicleAvailable = false; return; }
  overview.chronicleAvailable = true;
  try {
    const raw = fs.readFileSync(chroniclePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const allEvents = [];
    for (const l of lines) {
      try { allEvents.push(JSON.parse(l)); } catch {}
    }
    // filter by the session's time range (first ~ last timestamp)
    const start = overview.firstTimestamp;
    const end = overview.lastTimestamp;
    let inWindow = [];
    if (start && end) {
      inWindow = allEvents.filter(e => {
        // an event may use time ('YYYY-MM-DD') or ts/timestamp
        const et = e.timestamp || e.ts || (e.time ? new Date(e.time).getTime() : null);
        if (!et) return false;
        const t = typeof et === 'number' ? et : new Date(et).getTime();
        if (Number.isNaN(t)) return false;
        return t >= start && t <= end + 24 * 3_600_000; // tolerate up to 1 day of lag
      });
    }
    overview.chronicleEventsInWindow = inWindow;
    overview.recentChronicleEvents = inWindow.length > 0 ? inWindow.slice(-10) : allEvents.slice(-5);
  } catch {}
}

async function buildOverview(sessionPath, opts = {}) {
  const recentPromptCount = opts.recentPromptCount || 5;
  const stat = fs.statSync(sessionPath);
  const timeRange = { sinceMs: opts.sinceMs || null, untilMs: opts.untilMs || null };
  const hasTimeFilter = timeRange.sinceMs || timeRange.untilMs;

  // extract tasks + goals in parallel
  const [tasks, goalEvents] = await Promise.all([
    extractTasks(sessionPath),
    extractGoals(sessionPath),
  ]);
  const currentGoal = getCurrentGoal(goalEvents);

  // scan the session once to collect the rest
  const overview = {
    sessionPath,
    fileSizeMB: (stat.size / (1024 * 1024)).toFixed(2),
    mtime: stat.mtime.toISOString(),
    sessionId: null,
    cwd: null,
    forkedFrom: null, // fork lineage parent { sessionId, messageUuid }
    forks: [],         // child sessions in the same dir whose forkedFrom == this session (list of short sessionId prefixes)
    firstTimestamp: null,
    lastTimestamp: null,
    model: new Set(),
    modelSwitches: [], // each entry: { timestamp, from, to }
    toolUsage: {}, // name → count
    fileEdits: {}, // path → count
    recentUserPrompts: [], // the most recent N external user prompts
    apiInputTokens: 0,
    apiOutputTokens: 0,
    apiCacheReadTokens: 0,
    apiCacheCreateTokens: 0,
    turnCount: 0,           // number of assistant messages
    userPromptCount: 0,     // number of external user prompts (the unit used by archive/token-budget --from-turn)
    compactBoundaryCount: 0,
    recentChronicleEvents: [],
  };

  const ctx = { lineNum: 0, lastModel: null };
  overview.compactBoundaries = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let recordCount = 0;
  let parseErrorCount = 0;
  for await (const line of rl) {
    ctx.lineNum++;
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); recordCount++; } catch { parseErrorCount++; continue; }
    ingestOverviewRecord(r, overview, ctx, timeRange, hasTimeFilter);
  }
  rl.close();
  overview.recordCount = recordCount;
  overview.parseErrorCount = parseErrorCount;
  if (parseErrorCount > 0) {
    console.error(`⚠️  ${parseErrorCount} lines with JSON parse errors, skipped (the file may be corrupt or non-standard jsonl)`);
  }

  // keep only the most recent N prompts
  overview.recentUserPrompts = overview.recentUserPrompts.slice(-recentPromptCount);
  overview.model = [...overview.model];

  // task stats
  const taskSummary = { total: tasks.length };
  for (const t of tasks) {
    taskSummary[t.status] = (taskSummary[t.status] || 0) + 1;
  }
  overview.tasks = {
    summary: taskSummary,
    inProgress: tasks.filter(t => t.status === 'in_progress'),
    pending: tasks.filter(t => t.status === 'pending'),
    completed: tasks.filter(t => t.status === 'completed').length,
    all: tasks,  // the full task list, for the caller to filter as needed
  };
  overview.currentGoal = currentGoal;
  overview.goalHistory = goalEvents;  // include goal history too

  // pre-sorted arrays of top files / tools (for the caller)
  overview.topToolsRanked = Object.entries(overview.toolUsage)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  overview.topFilesRanked = Object.entries(overview.fileEdits)
    .sort((a, b) => b[1] - a[1])
    .map(([path, editCount]) => ({ path, editCount }));

  // scan the same directory for children (forkedFrom.sessionId == this session's)
  scanForkChildren(sessionPath, overview);

  // deep chronicle integration — use "events within this session's time range" instead of "the last 5"
  // fall back to the last 5 when the session has no timestamps
  integrateChronicle(overview);

  return overview;
}

/** task status → icon (pure reorg, replaces the nested ternary) */
function statusIcon(k) {
  if (k === 'completed') return '✅';
  if (k === 'in_progress') return '⚙️';
  if (k === 'pending') return '⏸️';
  return '·';
}

/** fork lineage line (pure reorg, output unchanged) */
function formatForkLineage(lines, o) {
  if (!(o.forkedFrom || (o.forks && o.forks.length > 0))) return;
  const parts = [];
  if (o.forkedFrom) parts.push(`Parent: ${o.forkedFrom.sessionId.slice(0, 8)} @ msg ${o.forkedFrom.messageUuid.slice(0, 8)}`);
  if (o.forks && o.forks.length > 0) parts.push(`Forks: ${o.forks.length} children (${o.forks.slice(0, 3).map(s => s.slice(0, 8)).join(', ')}${o.forks.length > 3 ? ', ...' : ''})`);
  lines.push(`🔱 ${parts.join(' | ')}`);
}

/** pending-task section (pure reorg, output unchanged) */
function formatPendingSection(lines, pending) {
  if (pending.length === 0) return;
  const neverCount = pending.filter(x => (x.updateCount || 0) === 0).length;
  const neverHint = neverCount > 0 ? `  ⚠️ ${neverCount} never-updated` : '';
  lines.push(`   Pending (top 5):${neverHint}`);
  for (const task of pending.slice(0, 5)) {
    const mark = (task.updateCount || 0) === 0 ? ' [never-updated]' : '';
    lines.push(`     ⏸️  ${task.subject}${mark}`);
  }
  if (pending.length > 5) lines.push(`     ... and ${pending.length - 5} more`);
}

/** task summary section (pure reorg, output unchanged) */
function formatTaskSection(lines, t) {
  lines.push(`## 📋 Task summary (${t.summary.total} total)`);
  const statusParts = [];
  for (const [k, v] of Object.entries(t.summary)) {
    if (k === 'total') continue;
    const icon = statusIcon(k);
    statusParts.push(`${icon} ${k}: ${v}`);
  }
  lines.push(`   ${statusParts.join('  |  ')}`);
  if (t.inProgress.length > 0) {
    lines.push(`   In progress:`);
    for (const task of t.inProgress.slice(0, 5)) {
      lines.push(`     ⚙️  ${task.subject}`);
    }
  }
  formatPendingSection(lines, t.pending);
}

/** recent user prompts section (pure reorg, output unchanged) */
function formatRecentPrompts(lines, o) {
  if (o.recentUserPrompts.length === 0) return;
  lines.push(`## 💬 Most recent ${o.recentUserPrompts.length} user prompts`);
  for (const p of o.recentUserPrompts) {
    const time = p.timestamp ? new Date(p.timestamp).toISOString().slice(11, 19) : '?';
    lines.push(`   ${time}  ${p.text}`);
  }
  lines.push('');
}

/** recent chronicle events section (optional — rendered only when a chronicle log is present) */
function formatChronicleSection(lines, o) {
  // Chronicle enrichment is optional. When the session's working directory has no chronicle log
  // (the common case), skip the section entirely rather than printing an empty or confusing note.
  if (o.recentChronicleEvents.length === 0) return;
  // distinguish "during this session" vs "last N as a fallback"
  const inWin = o.chronicleEventsInWindow?.length || 0;
  const label = inWin > 0
    ? `.chronicle events during this session (${inWin})`
    : `recent .chronicle events (${o.recentChronicleEvents.length}) (outside the session's time range, falling back to recent)`;
  lines.push(`## 📜 ${label}`);
  for (const e of o.recentChronicleEvents) {
    const t = e.time || e.ts || e.timestamp || '?';
    const kind = e.kind || '?';
    const sum = (e.sum || e.summary || '').slice(0, 100);
    lines.push(`   ${t}  [${kind}] ${sum}`);
  }
  lines.push('');
}

/** cache-warning section (see it in one page without running cache-guard again) (pure reorg, output unchanged) */
function formatCacheWarning(lines, o) {
  if (!((o.modelSwitches?.length || 0) > 0 || (o.compactBoundaries?.length || 0) > 0)) return;
  lines.push('', `## ⚠️ Cache warnings`);
  for (const sw of (o.modelSwitches || [])) {
    lines.push(`   Model switch: ${sw.from} → ${sw.to} @ Turn ${sw.turn} (L${sw.line})`);
  }
  for (const cb of (o.compactBoundaries || [])) {
    lines.push(`   Compact boundary @ Turn ${cb.turn} (L${cb.line}) — conversation-layer cache reset (system/project layers preserved)`);
  }
  // rough waste estimate: each model switch forces a cache rebuild on the next turn; cache_creation cost ≈ cache_read * 1.25x
  // but overview doesn't track per-turn cache_creation against switch events, so it can't compute exactly → suggest running cache-guard
  if ((o.modelSwitches?.length || 0) > 0) {
    lines.push(`   for an exact waste figure → run cache-guard --cost-impact`);
  }
}

function formatOverview(o) {
  const lines = [];
  // early return for an empty session
  if ((o.recordCount || 0) === 0) {
    const parseErrPart = o.parseErrorCount ? `  |  parse error: ${o.parseErrorCount} lines` : '';
    lines.push(
      `⚠️ empty session (0 records) — file: ${o.sessionPath}`,
      `   size: ${o.fileSizeMB} MB${parseErrPart}`,
    );
    return lines.join('\n');
  }
  const firstStr = o.firstTimestamp ? new Date(o.firstTimestamp).toISOString().slice(0, 19).replace('T', ' ') : '?';
  const lastStr = o.lastTimestamp ? new Date(o.lastTimestamp).toISOString().slice(0, 19).replace('T', ' ') : '?';

  lines.push(
    `Session: ${o.sessionId?.slice(0, 16) || '?'}...  |  ${o.fileSizeMB} MB  |  ${o.userPromptCount} user-prompts / ${o.turnCount} assistant-turns`,
    `Start: ${firstStr}  |  End: ${lastStr}  |  Models: ${o.model.join(', ')}`,
  );
  if (o.cwd) lines.push(`Cwd: ${o.cwd}`);
  lines.push(`Compact boundaries: ${o.compactBoundaryCount}`);
  formatForkLineage(lines, o);
  lines.push('');

  // Goal
  if (o.currentGoal) {
    const goalTime = o.currentGoal.timestamp ? new Date(o.currentGoal.timestamp).toISOString().slice(0, 19).replace('T', ' ') : '?';
    lines.push(`## 🎯 Current goal (since ${goalTime})`, `   "${o.currentGoal.condition}"`, '');
  }

  // task summary
  formatTaskSection(lines, o.tasks);
  lines.push('');

  // tool usage stats
  const tools = Object.entries(o.toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 12);
  lines.push(`## 🔧 Tool usage (top 12)`);
  for (const [name, count] of tools) {
    lines.push(`   ${name.padEnd(20)} ${count}`);
  }
  lines.push('');

  // recent user prompts
  formatRecentPrompts(lines, o);

  // recently changed files
  const files = Object.entries(o.fileEdits).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (files.length > 0) {
    lines.push(`## 📁 Most frequently changed files (top 10)`);
    for (const [fp, count] of files) {
      lines.push(`   (${count}x) ${fp}`);
    }
    lines.push('');
  }

  // recent chronicle events
  formatChronicleSection(lines, o);

  // token stats
  lines.push(
    `## 📊 Token stats`,
    `   API input:        ${o.apiInputTokens.toLocaleString()}`,
    `   API output:       ${o.apiOutputTokens.toLocaleString()}`,
    `   Cache read:       ${o.apiCacheReadTokens.toLocaleString()}`,
    `   Cache create:     ${o.apiCacheCreateTokens.toLocaleString()}`,
  );
  const totalCacheRatio = o.apiCacheReadTokens > 0
    ? (o.apiCacheReadTokens / (o.apiInputTokens + o.apiCacheReadTokens) * 100).toFixed(1) + '%'
    : '?';
  lines.push(`   Cache hit rate:   ${totalCacheRatio}`);

  formatCacheWarning(lines, o);

  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  // unknown-flag detection
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--recent', '--since', '--until'],
    valueFlags: ['--recent', '--since', '--until'],
    scriptName: 'overview',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-overview.js — one-page combined session report

Usage:
  recensa-session overview <session.jsonl>
  recensa-session overview <session.jsonl> --recent 10
  recensa-session overview <session.jsonl> --since 30m              the last 30 minutes
  recensa-session overview <session.jsonl> --since 2h --until 1h    1-2 hours ago
  recensa-session overview <session.jsonl> --json

Tip: use the unified session.js entry point to omit the path:
  recensa-session overview --latest
  recensa-session overview a1b2c3d4 --since 1h`);
    process.exit(0);
  }

  // resolve the session path (supports --latest and short prefixes)
  const { resolveFromArgs } = require('../lib/resolver');
  let sessionPath;
  try {
    const resolved = resolveFromArgs(args);
    sessionPath = resolved.path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const recentIdx = args.indexOf('--recent');
  const timeRange = parseTimeRange(args, { sessionPath });
  if (args.includes('--since') || args.includes('--until')) {
    console.error(`ℹ️  time basis: ${timeRange.baseSource === 'session-mtime' ? 'session last-modified time' : 'current time'}`);
  }
  const overview = await buildOverview(sessionPath, {
    recentPromptCount: recentIdx >= 0 ? Number.parseInt(args[recentIdx + 1]) || 5 : 5,
    sinceMs: timeRange.sinceMs,
    untilMs: timeRange.untilMs,
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(overview, null, 2));
    return;
  }

  console.log(formatOverview(overview));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildOverview };
