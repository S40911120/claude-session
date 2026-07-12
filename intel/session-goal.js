#!/usr/bin/env node
/**
 * session-goal.js — Extract the goal condition set by the Stop hook
 *
 * Parsing logic:
 *   1. /goal command — user message contains <command-name>/goal</command-name>
 *      + <command-args>{condition}</command-args>
 *   2. Stop hook confirmation message — user message contains
 *      "Stop hook is now active with condition: \"{condition}\""
 *   3. goal clear — no condition, or the args contain "clear"
 *
 * Usage:
 *   recensa-session goal <session.jsonl>             show the current goal
 *   recensa-session goal <session.jsonl> --history   list goal history
 *   recensa-session goal <session.jsonl> --json      JSON output
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

// Extract plain text from a user message content (content may be string / array)
function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

// Extract the /goal command args from text
function extractGoalCommand(text) {
  // <command-name>/goal</command-name> ... <command-args>condition</command-args>
  if (!text.includes('<command-name>/goal</command-name>') &&
      !text.includes('<command-name>goal</command-name>')) {
    return null;
  }
  const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (!m) return null;
  const args = m[1].trim();
  // /goal clear -> empty args
  if (!args || /^\s*clear\s*$/i.test(args)) return { type: 'clear' };
  return { type: 'set', condition: args };
}

// Extract the condition from a Stop hook message
function extractHookConfirmation(text) {
  // "A session-scoped Stop hook is now active with condition: \"...\""
  const m = text.match(/Stop hook is now active with condition:\s*["']([\s\S]+?)["']/);
  if (m) return { type: 'hook_active', condition: m[1] };
  // goal cleared
  if (/goal.*cleared|hook.*auto.?clear/i.test(text)) {
    return { type: 'hook_cleared' };
  }
  return null;
}

async function extractGoals(sessionPath) {
  const events = []; // { timestamp, type: 'set'|'clear'|'hook_active'|'hook_cleared', condition }

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }

    if (r.type !== 'user') continue;
    const text = userText(r.message?.content);
    if (!text) continue;

    const goalCmd = extractGoalCommand(text);
    if (goalCmd) {
      events.push({ timestamp: r.timestamp, source: 'command', ...goalCmd });
    }
    const hookConf = extractHookConfirmation(text);
    if (hookConf) {
      events.push({ timestamp: r.timestamp, source: 'hook', ...hookConf });
    }
  }
  rl.close();

  return dedupeGoalEvents(events);
}

/** Merge a /goal command with its matching hook confirmation for the same condition (delta <= 2s, identical condition) -> mark source=both */
function dedupeGoalEvents(events) {
  const equivAction = (t) => {
    if (t === 'set' || t === 'hook_active') return 'active';
    if (t === 'clear' || t === 'hook_cleared') return 'cleared';
    return t;
  };
  const out = [];
  for (const e of events) {
    const last = out.at(-1);
    if (!last) { out.push({ ...e }); continue; }
    const tDelta = Math.abs(new Date(e.timestamp || 0).getTime() - new Date(last.timestamp || 0).getTime());
    const sameCondition = (e.condition || null) === (last.condition || null);
    const sameAction = equivAction(e.type) === equivAction(last.type);
    const differentSource = e.source !== last.source;
    if (tDelta <= 2000 && sameCondition && sameAction && differentSource) {
      last.source = 'both';
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

function getCurrentGoal(events) {
  // Scan backwards: the first set/hook_active with no later clear/hook_cleared
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'clear' || e.type === 'hook_cleared') return null;
    if (e.type === 'set' || e.type === 'hook_active') return e;
  }
  return null;
}

// Event source label (/goal command / hook / both)
function sourceTag(source) {
  if (source === 'both') return '[/goal+hook]';
  if (source === 'command') return '[/goal]';
  return '[hook]';
}

function printGoalHistory(events) {
  if (events.length === 0) {
    console.log('(no goal events in this session)');
    return;
  }
  console.log(`📋 Goal history (${events.length} events)\n`);
  for (const e of events) {
    const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 19) : '?';
    const tag = sourceTag(e.source);
    if (e.type === 'set' || e.type === 'hook_active') {
      console.log(`${time}  ${tag} set:`);
      console.log(`   ${e.condition}\n`);
    } else if (e.type === 'clear' || e.type === 'hook_cleared') {
      console.log(`${time}  ${tag} cleared\n`);
    }
  }
}

function printCurrentGoal(events) {
  const current = getCurrentGoal(events);
  if (!current) {
    console.log('(no active goal)');
    return;
  }
  const time = current.timestamp ? new Date(current.timestamp).toISOString().slice(0, 19) : '?';
  console.log(`🎯 Active Goal (since ${time})\n`);
  console.log(`   ${current.condition}`);
}

// ── CLI ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--history', '--since', '--until'],
    valueFlags: ['--since', '--until'],
    scriptName: 'goal',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-goal.js — Extract the Stop hook goal within a session

Usage:
  recensa-session goal <session.jsonl>             show the current goal
  recensa-session goal <session.jsonl> --history   list all goal set/clear events
  recensa-session goal <session.jsonl> --json      JSON output
  --since <spec>   only events after this time (7d/1h/30s or ISO; exited sessions use file mtime as base)
  --until <spec>   only events before this time`);
    process.exit(0);
  }

  const path = args[0];
  if (!fs.existsSync(path)) {
    console.error(`❌ Not found: ${path}`);
    process.exit(1);
  }

  // --since / --until: filter by event timestamp (base = file mtime for exited sessions)
  const { parseTimeRange, isInRange } = require('../lib/resolver');
  const range = parseTimeRange(args, { sessionPath: path });
  if ((args.includes('--since') && range.sinceMs === null) ||
      (args.includes('--until') && range.untilMs === null)) {
    console.error(`❌ goal: cannot parse --since/--until (use 7d / 1h / 30s or ISO 8601, e.g. 2026-01-01T10:00)`);
    process.exit(2);
  }
  const hasRange = args.includes('--since') || args.includes('--until');
  if (hasRange) {
    console.error(`ℹ️  time base: ${range.baseSource === 'session-mtime' ? 'session last-modified time (exited session)' : 'current time (active session)'}`);
  }

  let events = await extractGoals(path);
  if (hasRange) {
    events = events.filter(e => isInRange(e.timestamp, range));
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      current: getCurrentGoal(events),
      events,
    }, null, 2));
    return;
  }

  if (args.includes('--history')) {
    printGoalHistory(events);
    return;
  }

  // Default: current goal
  printCurrentGoal(events);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { extractGoals, getCurrentGoal };
