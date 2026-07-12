#!/usr/bin/env node
/**
 * session-summary.js — cross-session aggregate report (weekly / monthly / custom period)
 *
 * Real use cases: "what did I do in the past 7 days", weekly reports, self-reflection
 *
 * Usage:
 *   recensa-session summary --since 7d
 *   recensa-session summary --since 7d --project myproj
 *   recensa-session summary --since 1d --json
 *   recensa-session summary --since 7d --by tools / tasks / tokens / prompts
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const { listAllSessions, parseTimeSpec } = require('../lib/resolver');

const BY_DIMS = ['tools', 'tasks', 'tokens', 'prompts'];

/** extract conversation text from user message content (pure reorg, replaces the nested ternary) */
function extractUserText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  return '';
}

/** accumulate an external user prompt (pure reorg, logic unchanged) */
function accumulatePrompt(r, agg, sessBreak, s) {
  const txt = extractUserText(r.message?.content);
  if (txt && !txt.startsWith('<')) {
    const clean = txt.replace(/\s+/g, ' ').slice(0, 120);
    agg.prompts.push({ sessionId: s.sessionId, text: clean });
    sessBreak.prompts++;
    if (sessBreak.promptTexts.length < 3) sessBreak.promptTexts.push(clean.slice(0, 60));
  }
}

/** accumulate assistant model / token / tool stats (pure reorg, logic unchanged) */
function accumulateAssistant(r, agg, sessBreak) {
  const m = r.message?.model;
  if (m && m !== '<synthetic>') agg.models.add(m);
  const u = r.message?.usage;
  if (u) {
    agg.tokens.input += u.input_tokens || 0;
    agg.tokens.output += u.output_tokens || 0;
    agg.tokens.cacheRead += u.cache_read_input_tokens || 0;
    agg.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
    sessBreak.tokens.input += u.input_tokens || 0;
    sessBreak.tokens.output += u.output_tokens || 0;
    sessBreak.tokens.cacheRead += u.cache_read_input_tokens || 0;
    sessBreak.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
  }
  if (Array.isArray(r.message?.content)) {
    for (const b of r.message.content) {
      if (b.type !== 'tool_use') continue;
      agg.tools[b.name] = (agg.tools[b.name] || 0) + 1;
      sessBreak.tools[b.name] = (sessBreak.tools[b.name] || 0) + 1;
      sessBreak.toolCount++;
      if (b.name === 'TaskCreate') { agg.tasks.created++; sessBreak.tasks++; sessBreak.tasksCreated++; }
      else if (b.name === 'TaskUpdate' && b.input?.status === 'completed') { agg.tasks.completed++; sessBreak.tasksCompleted++; }
    }
  }
}

/** ingest one record, updating agg + sessBreak (pure reorg, processing order unchanged) */
function ingestSummaryRecord(r, agg, sessBreak, s) {
  if (r.cwd) agg.cwds.add(r.cwd);
  // user external prompt
  if (r.type === 'user' && r.userType === 'external' && !r.toolUseResult) {
    accumulatePrompt(r, agg, sessBreak, s);
  }
  if (r.type === 'assistant') {
    accumulateAssistant(r, agg, sessBreak);
  }
}

/** finalize: Set→array, repeated-prompt detection, topTools (pure reorg, output fields unchanged) */
function finalizeAgg(agg) {
  agg.models = [...agg.models];
  agg.cwds = [...agg.cwds];
  // repeated-prompt detection (e.g. the same "keep digging" request run many times in a row)
  const promptCounts = new Map();
  for (const p of agg.prompts) {
    const key = p.text.slice(0, 30).toLowerCase();
    if (!promptCounts.has(key)) promptCounts.set(key, { sample: p.text, count: 0 });
    promptCounts.get(key).count++;
  }
  agg.repeatedPrompts = [...promptCounts.values()]
    .filter(p => p.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  agg.topTools = Object.entries(agg.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
}

async function aggregateSessions(sessions) {
  const agg = {
    sessionCount: sessions.length,
    activeSessionCount: 0, // mtime < 5 min
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    tools: {}, // name → count
    tasks: { created: 0, completed: 0 },
    prompts: [], // real external user prompts (used for frequency analysis)
    sessionsBreakdown: [], // a small summary per session
    models: new Set(),
    cwds: new Set(),
  };

  for (const s of sessions) {
    if ((Date.now() - s.mtime.getTime()) < 5 * 60_000) agg.activeSessionCount++;
    const sessBreak = {
      sessionId: s.sessionId, project: s.project, sizeBytes: s.size, mtime: s.mtime.toISOString(),
      prompts: 0, tasks: 0, tasksCreated: 0, tasksCompleted: 0,
      toolCount: 0, tools: {}, // per-session tool breakdown (used by --by tools)
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, // per-session tokens (used by --by tokens)
      promptTexts: [], // sample prompts for this session (used by --by prompts)
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(s.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      ingestSummaryRecord(r, agg, sessBreak, s);
    }
    rl.close();
    agg.sessionsBreakdown.push(sessBreak);
  }

  finalizeAgg(agg);
  return agg;
}

function format(agg, opts = {}) {
  const lines = [];
  const activePart = agg.activeSessionCount ? ` (${agg.activeSessionCount} active)` : '';
  const sincePart = opts.sinceLabel ? `  |  since ${opts.sinceLabel}` : '';
  lines.push(`📊 Summary report  |  ${agg.sessionCount} sessions${activePart}${sincePart}`);
  if (opts.project) lines.push(`Project filter: ${opts.project}`);
  lines.push(
    '',
    `## 📦 Sessions / Tasks / Tokens`,
    `   Sessions: ${agg.sessionCount}`,
    `   Tasks created: ${agg.tasks.created}, completed: ${agg.tasks.completed}`,
  );
  const cacheHitRate = agg.tokens.cacheRead > 0
    ? ((agg.tokens.cacheRead / (agg.tokens.input + agg.tokens.cacheRead)) * 100).toFixed(1) + '%'
    : '?';
  lines.push(
    `   Tokens: in ${agg.tokens.input.toLocaleString()} / out ${agg.tokens.output.toLocaleString()} / cache read ${agg.tokens.cacheRead.toLocaleString()} (hit rate ${cacheHitRate})`,
    `   Models: ${agg.models.join(', ')}`,
    '',
    `## 🔧 Top Tools (top 10)`,
  );
  for (const [name, count] of agg.topTools) {
    lines.push(`   ${name.padEnd(20)} ${count}`);
  }
  lines.push('');

  if (agg.repeatedPrompts.length > 0) {
    lines.push(`## ♻️ Repeated prompts (>= 3 times)`);
    for (const p of agg.repeatedPrompts) {
      lines.push(`   ×${p.count}  "${p.sample}"`);
    }
    lines.push('');
  }

  lines.push(`## 📁 ${agg.cwds.length} cwds involved`);
  for (const cwd of agg.cwds.slice(0, 5)) {
    lines.push(`   ${cwd}`);
  }
  if (agg.cwds.length > 5) lines.push(`   ... and ${agg.cwds.length - 5} more`);

  return lines.join('\n');
}

/** sort weight for a given dimension (pure reorg, replaces the nested ternary) */
function dimWeight(sb, dim) {
  if (dim === 'tools') return sb.toolCount;
  if (dim === 'tasks') return sb.tasksCreated + sb.tasksCompleted;
  if (dim === 'tokens') return sb.tokens.input + sb.tokens.output;
  return sb.prompts;
}

function renderByTools(lines, rows) {
  lines.push(`## 🔧 Tool usage per session`);
  for (const sb of rows) {
    const top = Object.entries(sb.tools).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, c]) => `${n}×${c}`).join(', ') || '(none)';
    lines.push(`   ${sb.sessionId.slice(0, 8)}  total ${sb.toolCount}  ${top}`);
  }
}

function renderByTasks(lines, rows) {
  lines.push(`## ✅ Tasks per session`);
  for (const sb of rows) {
    lines.push(`   ${sb.sessionId.slice(0, 8)}  created ${sb.tasksCreated} / completed ${sb.tasksCompleted}`);
  }
}

function renderByTokens(lines, rows) {
  lines.push(`## 🪙 Tokens per session (in / out / cache read)`);
  for (const sb of rows) {
    const t = sb.tokens;
    lines.push(`   ${sb.sessionId.slice(0, 8)}  in ${t.input.toLocaleString()} / out ${t.output.toLocaleString()} / cacheR ${t.cacheRead.toLocaleString()}`);
  }
}

function renderByPrompts(lines, rows) {
  lines.push(`## 💬 Prompts per session`);
  for (const sb of rows) {
    lines.push(`   ${sb.sessionId.slice(0, 8)}  ${sb.prompts} prompts total`);
    for (const t of sb.promptTexts) lines.push(`      · ${t}`);
  }
}

const BY_RENDERERS = { tools: renderByTools, tasks: renderByTasks, tokens: renderByTokens, prompts: renderByPrompts };

/** --by <dim>: present sessions grouped by that dimension (the "grouped stats" view of the aggregate report) */
function formatBy(agg, dim, opts = {}) {
  const lines = [];
  const sincePart = opts.sinceLabel ? `  |  since ${opts.sinceLabel}` : '';
  lines.push(`📊 Summary report — grouped by ${dim}  |  ${agg.sessionCount} sessions${sincePart}`);
  if (opts.project) lines.push(`Project filter: ${opts.project}`);
  lines.push('');

  // sort by that dimension's magnitude descending, so the session that uses it most is on top
  const rows = [...agg.sessionsBreakdown].sort((a, b) => dimWeight(b, dim) - dimWeight(a, dim));

  const render = BY_RENDERERS[dim];
  if (render) render(lines, rows);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--since', '--until', '--project', '--by'],
    valueFlags: ['--since', '--until', '--project', '--by'],
    scriptName: 'summary',
  });
  if (args.includes('--help')) {
    console.log(`session-summary.js — cross-session aggregate report

Usage:
  recensa-session summary --since 7d                cross-session report (past 7 days)
  recensa-session summary --since 7d --until 1d     upper time bound (filters mtime <= 1d ago)
  recensa-session summary --since 1d --project myproj  limit to a project
  recensa-session summary --since 7d --json         JSON output
  recensa-session summary --since 7d --by tools     group sessions by dimension (tools/tasks/tokens/prompts)

Aggregates:
  sessions / tasks / tokens / cache / tools / repeated prompts / cwds`);
    process.exit(0);
  }

  const byIdx = args.indexOf('--by');
  const byDim = byIdx >= 0 ? args[byIdx + 1] : null;
  if (byIdx >= 0 && !BY_DIMS.includes(byDim)) {
    console.error(`❌ summary: --by does not accept "${byDim ?? ''}" (valid values: ${BY_DIMS.join(' / ')})`);
    process.exit(2);
  }

  const sinceIdx = args.indexOf('--since');
  const untilIdx = args.indexOf('--until');
  const projectIdx = args.indexOf('--project');
  const sinceMs = sinceIdx >= 0 ? parseTimeSpec(args[sinceIdx + 1]) : null;
  const untilMs = untilIdx >= 0 ? parseTimeSpec(args[untilIdx + 1]) : null;
  const projectFilter = projectIdx >= 0 ? args[projectIdx + 1] : null;

  if (!sinceMs) {
    console.error(`❌ summary requires --since (e.g. 7d / 1d / 2h)`);
    process.exit(2);
  }

  let sessions = listAllSessions();
  if (projectFilter) {
    sessions = sessions.filter(s => s.project.toLowerCase().includes(projectFilter.toLowerCase()));
  }
  sessions = sessions.filter(s => s.mtime.getTime() >= sinceMs && (!untilMs || s.mtime.getTime() <= untilMs));

  if (sessions.length === 0) {
    console.error(`(no sessions matched)`);
    process.exit(0);
  }

  const agg = await aggregateSessions(sessions);

  if (args.includes('--json')) {
    console.log(JSON.stringify(agg, null, 2));
    return;
  }

  const fmtOpts = {
    sinceLabel: sinceIdx >= 0 ? args[sinceIdx + 1] : null,
    project: projectFilter,
  };
  console.log(byDim ? formatBy(agg, byDim, fmtOpts) : format(agg, fmtOpts));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { aggregateSessions, format, formatBy };
