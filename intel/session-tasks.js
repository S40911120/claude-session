#!/usr/bin/env node
/**
 * session-tasks.js — extract every Task operation in a session and assemble the final task list
 *
 * Motivated by real usage: "there was no dedicated tool to view someone's task list; I grepped regex by hand"
 *
 * Parsing logic (all keyed off structural tool_use markers, not prose — language-universal):
 *   - TaskCreate.input.subject / description / activeForm → create a task (id from sequence)
 *   - TaskUpdate.input.taskId / status → update status
 *   - TodoWrite.input.todos (a JSON-string snapshot of {content,status,activeForm}[]) → upsert each
 *     entry by its content; status is the latest snapshot value, updateCount counts status transitions
 *   - finally list each task's latest status
 *
 * Usage:
 *   recensa-session tasks <session.jsonl>             all tasks
 *   recensa-session tasks <session.jsonl> --current   only in_progress
 *   recensa-session tasks <session.jsonl> --pending   only pending
 *   recensa-session tasks <session.jsonl> --done      only completed
 *   recensa-session tasks <session.jsonl> --json      JSON output
 *   recensa-session tasks a.jsonl --diff b.jsonl      task diff between two sessions
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const STATUS_ICONS = {
  pending: '⏸️',
  in_progress: '⚙️',
  completed: '✅',
  blocked: '🚫',
  cancelled: '🚫',
};

// time-range filter: both bounds empty → pass everything; bounded but ts invalid/out-of-range → exclude
function passesTimeRange(ts, sinceMs, untilMs) {
  if (!sinceMs && !untilMs) return true;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  if (sinceMs && t < sinceMs) return false;
  if (untilMs && t > untilMs) return false;
  return true;
}

function applyTaskCreate(tasks, input, ts, id) {
  const existing = tasks.get(id);
  if (existing?.phantom) {
    // A TaskUpdate arrived before its TaskCreate (fork/merge/repair reordering left a phantom): keep the
    // accumulated status/updateCount, fill in the subject/description the create carries, clear the phantom.
    existing.subject = input.subject || '(no subject)';
    existing.description = input.description || existing.description;
    existing.activeForm = input.activeForm || existing.activeForm;
    existing.createdAt = ts;
    existing.phantom = false;
    return;
  }
  tasks.set(id, {
    id,
    subject: input.subject || '(no subject)',
    description: input.description || '',
    activeForm: input.activeForm || '',
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
    updateCount: 0,
  });
}

function applyTaskUpdate(tasks, input, ts) {
  const id = String(input.taskId);
  const task = tasks.get(id);
  if (task) {
    task.status = input.status || task.status;
    task.updatedAt = ts;
    task.updateCount++;
  } else {
    // taskId doesn't exist → create a phantom record
    tasks.set(id, {
      id,
      subject: '(no matching TaskCreate)',
      description: '',
      activeForm: '',
      status: input.status || 'pending',
      createdAt: null,
      updatedAt: ts,
      updateCount: 1,
      phantom: true,
    });
  }
}

// Key a snapshot entry. Present, first-seen content keys stably by content (so the same entry upserts across
// snapshots). Empty content, or content already seen in THIS snapshot, is disambiguated by its position so
// distinct-but-blank or duplicate entries never collapse into one and lose data.
function todoKey(entry, index, seenThisSnapshot) {
  const content = entry.content || entry.activeForm || '';
  if (!content) return `todo:#${index}`;
  const base = `todo:${content}`;
  if (seenThisSnapshot.has(base)) return `${base}#${index}`;
  seenThisSnapshot.add(base);
  return base;
}

// upsert one snapshot entry by its content (its stable identity across snapshots)
function upsertTodoEntry(tasks, entry, ts, counters, index, seenThisSnapshot) {
  const subject = entry.content || entry.activeForm || '(no content)';
  const key = todoKey(entry, index, seenThisSnapshot);
  const status = entry.status || 'pending';
  const existing = tasks.get(key);
  if (existing) {
    if (status !== existing.status) { existing.status = status; existing.updateCount++; }
    if (entry.activeForm && !existing.activeForm) existing.activeForm = entry.activeForm;
    existing.updatedAt = ts;
    return;
  }
  counters.todo++;
  tasks.set(key, {
    id: `todo-${counters.todo}`,
    subject,
    description: '',
    activeForm: entry.activeForm || '',
    status,
    createdAt: ts,
    updatedAt: ts,
    updateCount: 0,
  });
}

// TodoWrite writes a full snapshot of the task list on each call; upsert each entry by its content.
// input.todos is a JSON string (older builds: a plain array).
function applyTodoWrite(tasks, input, ts, counters) {
  let entries = input.todos;
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); } catch { return; } // malformed snapshot -> skip, never crash the scan
  }
  if (!Array.isArray(entries)) return;
  const seenThisSnapshot = new Set(); // disambiguate empty/duplicate content within this one snapshot
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry && typeof entry === 'object') upsertTodoEntry(tasks, entry, ts, counters, i, seenThisSnapshot);
  }
}

// process one assistant message's content blocks; mutates the shared counter object
function processTaskBlocks(tasks, content, ts, counters) {
  for (const block of content) {
    if (!block || typeof block !== 'object') continue; // skip a null/non-object block (adversarial jsonl), never crash the scan
    if (block.type !== 'tool_use') continue;

    if (block.name === 'TaskCreate') {
      counters.create++;
      const input = block.input || {};
      // no taskId → use the sequence number as the key (Claude Code behavior)
      const id = String(input.taskId || counters.create);
      applyTaskCreate(tasks, input, ts, id);
    } else if (block.name === 'TaskUpdate') {
      applyTaskUpdate(tasks, block.input || {}, ts);
    } else if (block.name === 'TodoWrite') {
      applyTodoWrite(tasks, block.input || {}, ts, counters);
    }
  }
}

async function extractTasks(sessionPath, opts = {}) {
  const tasks = new Map();
  const counters = { create: 0, todo: 0 };
  const sinceMs = opts.sinceMs || null;
  const untilMs = opts.untilMs || null;

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }

    if (r.type !== 'assistant') continue;
    if (!Array.isArray(r.message?.content)) continue;

    // Process every block on the full pass so TaskCreate sequence keys and TaskUpdate↔TaskCreate
    // correlation stay stable regardless of the time filter; the filter is applied to the assembled
    // task list below (a create dropped mid-pass would shift the sequence and mis-key later updates).
    processTaskBlocks(tasks, r.message.content, r.timestamp, counters);
  }
  rl.close();

  const all = mergeAcrossSources([...tasks.values()]);
  if (!sinceMs && !untilMs) return all;
  // list only tasks created or updated within the range (keying already done, independent of this filter)
  return all.filter(t => passesTimeRange(t.createdAt, sinceMs, untilMs) || passesTimeRange(t.updatedAt, sinceMs, untilMs));
}

// When one logical task is tracked by BOTH the Task tool (id key) and TodoWrite (content key), the two
// disjoint key spaces would list it twice with contradictory status. Merge entries that share a verbatim
// subject (exact match — a normalized match would falsely merge opposites like "add tests"/"remove tests"):
// keep the Task-sourced record as the canonical identity, adopt the status of whichever source was updated
// most recently, and take the larger updateCount. TodoWrite-only and Task-only subjects pass through untouched.
function mergeAcrossSources(list) {
  const bySubject = new Map();
  for (const t of list) {
    const group = bySubject.get(t.subject);
    if (group) group.push(t); else bySubject.set(t.subject, [t]);
  }
  const out = [];
  for (const group of bySubject.values()) {
    const taskSourced = group.find(t => !String(t.id).startsWith('todo-'));
    const todoSourced = group.find(t => String(t.id).startsWith('todo-'));
    if (group.length === 1 || !taskSourced || !todoSourced) { out.push(...group); continue; }
    const newest = group.reduce((a, b) => ((b.updatedAt || '') >= (a.updatedAt || '') ? b : a));
    out.push({ ...taskSourced, status: newest.status, updateCount: Math.max(...group.map(t => t.updateCount || 0)) });
  }
  return out;
}

/** merge tasks along the fork chain: extractTasks per segment, dedup by (subject|createdAt) (forks re-include parent content).
 *  take the "last seen" status (child segments are newer and override the parent's old status for the same task). */
async function extractTasksChain(input, opts = {}) {
  const { walkChain } = require('../lib/resolver');
  const chain = walkChain(input);
  const live = chain.filter(c => c.path);
  const broken = chain.filter(c => c.missing);
  if (broken.length) {
    console.error(`⚠️  broken chain: ${broken.map(c => c.sessionId.slice(0, 8)).join(', ')} (tasks from earlier segments are unavailable)`);
  }
  const merged = new Map(); // key=(subject|createdAt) → task
  for (const seg of live) {
    const segTasks = await extractTasks(seg.path, opts);
    for (const t of segTasks) {
      const key = `${t.subject}|${t.createdAt || ''}`;
      const prev = merged.get(key);
      // later (child) segments override; keep updateCount without double-counting (take the larger, since child segments re-include parent updates)
      if (prev) merged.set(key, { ...t, updateCount: Math.max(prev.updateCount || 0, t.updateCount || 0) });
      else merged.set(key, { ...t });
    }
  }
  return { tasks: [...merged.values()], chainSegments: live.length, brokenSegments: broken.length };
}

function filterTasks(tasks, opts) {
  if (opts.current) return tasks.filter(t => t.status === 'in_progress');
  if (opts.pending) return tasks.filter(t => t.status === 'pending');
  if (opts.done) return tasks.filter(t => t.status === 'completed');
  return tasks;
}

function printTasks(tasks, opts = {}) {
  if (tasks.length === 0) {
    console.log('(no tasks matched)');
    return;
  }
  // summary
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const summary = Object.entries(byStatus).map(([s, c]) => `${STATUS_ICONS[s] || '·'} ${s}: ${c}`).join(' | ');
  console.log(`📋 ${tasks.length} tasks  (${summary})\n`);

  // count the never-updated ratio and warn the user
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  const neverUpdated = pendingTasks.filter(t => (t.updateCount || 0) === 0);
  if (neverUpdated.length > 0) {
    console.log(`⚠️  ${neverUpdated.length}/${pendingTasks.length} pending tasks were never touched by TaskUpdate (status may be inaccurate)\n`);
  }

  for (const t of tasks) {
    const icon = STATUS_ICONS[t.status] || '·';
    const phantom = t.phantom ? ' [phantom]' : '';
    const neverMark = (t.status === 'pending' && (t.updateCount || 0) === 0) ? ' [never-updated]' : '';
    console.log(`${icon} #${t.id}${phantom}${neverMark}  ${t.subject}`);
    if (opts.verbose && t.description) {
      console.log(`     ${t.description.slice(0, 150)}`);
    }
  }
}

// ── Fuzzy match helpers ────────────────────────────────────
// Common task-verb stop words: appear across many task subjects but carry weak discriminating meaning, so
// removing them lets the fuzzy matcher focus on the distinctive nouns. English set (matches the English-only
// public tool). Removed as whole words (before whitespace is squished) so they never corrupt unrelated words
// the way a substring strip would (e.g. "the" inside "theme"). Antonym verbs (add/remove/create/delete) are
// deliberately excluded: stripping them would collapse opposite tasks ("add tests" vs "remove tests") to the
// same token and let the diff mislabel them as identical.
const FUZZY_STOP_WORDS = new Set([
  'fix', 'fixes', 'fixed',
  'update', 'updates', 'updated', 'change', 'changes', 'changed', 'refactor', 'refactored', 'rename',
  'implement', 'implements', 'implemented', 'verify', 'validate', 'check', 'checks', 'simplify',
  'optimize', 'optimise', 'align', 'apply', 'support', 'improve', 'migrate', 'cleanup', 'the', 'and', 'for',
]);

function normalizeSubject(s) {
  let t = (s || '').toLowerCase();
  t = t.replace(/^[a-z]\d+\s+/g, ''); // strip tag prefixes like "c4 / h1 / m2 "
  // drop common stop words as whole tokens (before squishing whitespace, so substrings stay intact)
  t = t.split(/\s+/).filter((w) => !FUZZY_STOP_WORDS.has(w.replace(/[^a-z0-9]/g, ''))).join(' ');
  // then strip remaining whitespace + punctuation for a stable bigram comparison
  return t.replace(/[\s\-_/.,:;()[\]]+/g, '');
}

function diceCoefficient(a, b) {
  // bigram overlap (CJK-friendly, more stable than Levenshtein for short strings)
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [k, v] of A) { total += v; if (B.has(k)) inter += Math.min(v, B.get(k)); }
  for (const [, v] of B) total += v;
  return (2 * inter) / total;
}

function findFuzzyMatch(target, candidates, threshold = 0.75) {
  const targetNorm = normalizeSubject(target);
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = diceCoefficient(targetNorm, normalizeSubject(c.subject));
    if (score > bestScore && score >= threshold) {
      best = c;
      bestScore = score;
    }
  }
  return best ? { match: best, score: bestScore } : null;
}

// pairing: match exact subjects first, then fill the rest with fuzzy matching
function pairTasks(a, b, fuzzyThreshold) {
  const mapA = new Map(a.map(t => [t.subject, t]));
  const matchedB = new Set();
  const matchedA = new Set();
  const pairs = []; // each item has tA, tB, score

  for (const tB of b) {
    const tA = mapA.get(tB.subject);
    if (tA) {
      pairs.push({ tA, tB, score: 1 });
      matchedA.add(tA.subject);
      matchedB.add(tB.subject);
    }
  }
  // fuzzy fill-in
  if (fuzzyThreshold <= 1) {
    const remainA = a.filter(t => !matchedA.has(t.subject));
    for (const tB of b) {
      if (matchedB.has(tB.subject)) continue;
      const r = findFuzzyMatch(tB.subject, remainA.filter(t => !matchedA.has(t.subject)), fuzzyThreshold);
      if (r) {
        pairs.push({ tA: r.match, tB, score: r.score });
        matchedA.add(r.match.subject);
        matchedB.add(tB.subject);
      }
    }
  }
  return { pairs, matchedA, matchedB };
}

function printStatusChanged(statusChanged) {
  if (statusChanged.length === 0) return;
  console.log(`\n🔄 In both but with different status (${statusChanged.length}):`);
  for (const p of statusChanged) {
    const fuzzyMark = p.score < 1 ? ` [fuzzy ${(p.score * 100).toFixed(0)}%]` : '';
    console.log(`   ${STATUS_ICONS[p.tA.status] || '·'} → ${STATUS_ICONS[p.tB.status] || '·'}  ${p.tB.subject}${fuzzyMark}`);
    if (p.score < 1) console.log(`      side A: ${p.tA.subject}`);
  }
}

function printFuzzySame(fuzzyMatched) {
  const sameStatusFuzzy = fuzzyMatched.filter(p => p.tA.status === p.tB.status);
  if (sameStatusFuzzy.length === 0) return;
  console.log(`\n🟰 Fuzzy-matched, same status (${sameStatusFuzzy.length}):`);
  for (const p of sameStatusFuzzy) {
    console.log(`   ${STATUS_ICONS[p.tB.status] || '·'} [${(p.score * 100).toFixed(0)}%]  ${p.tB.subject}`);
    console.log(`      side A: ${p.tA.subject}`);
  }
}

function printOnlyIn(tasks, label) {
  if (tasks.length === 0) return;
  console.log(`\n${label}(${tasks.length}):`);
  for (const t of tasks) console.log(`   ${STATUS_ICONS[t.status] || '·'} ${t.subject}`);
}

async function diffSessions(pathA, pathB, opts = {}) {
  const [a, b] = await Promise.all([extractTasks(pathA), extractTasks(pathB)]);
  const fuzzyThreshold = opts.fuzzy === false ? 1.01 : (opts.threshold || 0.7);

  const { pairs, matchedA, matchedB } = pairTasks(a, b, fuzzyThreshold);

  const added = b.filter(t => !matchedB.has(t.subject));
  const removed = a.filter(t => !matchedA.has(t.subject));
  // "identical" requires verbatim-equal subjects, not a stop-word-normalized score of 1: a normalization
  // collapse (different wording that reduces to the same tokens) is surfaced as a fuzzy match, never
  // silently reported as an exact/identical pair.
  const fuzzyMatched = pairs.filter(p => p.tA.subject !== p.tB.subject);
  const statusChanged = pairs.filter(p => p.tA.status !== p.tB.status);
  const identical = pairs.filter(p => p.tA.subject === p.tB.subject && p.tA.status === p.tB.status);

  console.log(`📊 Task Diff (A → B)`);
  console.log(`A: ${pathA}  (${a.length} tasks)`);
  console.log(`B: ${pathB}  (${b.length} tasks)`);
  console.log(`Pairing: exact ${identical.length} | status-changed ${statusChanged.length - fuzzyMatched.filter(p => p.tA.status !== p.tB.status).length} | fuzzy ${fuzzyMatched.length}`);
  // never-updated warning
  const aNever = a.filter(t => (t.updateCount || 0) === 0).length;
  const bNever = b.filter(t => (t.updateCount || 0) === 0).length;
  if (aNever > 0 || bNever > 0) {
    console.log(`⚠️  Never touched by TaskUpdate: A=${aNever}, B=${bNever} (status may be inaccurate — a task stays pending if TaskUpdate is never called after TaskCreate)`);
  }
  console.log(`─`.repeat(60));

  printStatusChanged(statusChanged);
  printFuzzySame(fuzzyMatched);
  printOnlyIn(added, '➕ Only in B (not in A)');
  printOnlyIn(removed, '➖ Only in A (not in B)');
  if (added.length === 0 && removed.length === 0 && statusChanged.length === 0 && fuzzyMatched.length === 0) {
    console.log(`\n✅ The two sessions' task lists are identical`);
  }
}

// ── CLI ────────────────────────────────────────────────────

async function runDiff(args, sessionPath, diffIdx) {
  // --diff is mutually exclusive with --by-keyword / --by-phase / --current / --pending / --done
  // they are semantically orthogonal: diff compares across sessions, the others filter/group a single session
  const conflicts = ['--by-keyword', '--by-phase', '--current', '--pending', '--done']
    .filter(f => args.includes(f));
  if (conflicts.length > 0) {
    console.error(`❌ --diff cannot be used together with ${conflicts.join(' / ')} (mutually exclusive)`);
    console.error(`   --diff = cross-session comparison; ${conflicts.join(' / ')} = single-session filter/group`);
    console.error(`   to compare filtered tasks: first extract both task lists with --json, then compare with another tool`);
    process.exit(2);
  }
  let pathB;
  try {
    const { resolve } = require('../lib/resolver');
    pathB = resolve(args[diffIdx + 1]).path;
  } catch (e) {
    console.error(`❌ --diff: ${e.message}`);
    process.exit(1);
  }
  const fuzzyOff = args.includes('--no-fuzzy');
  const thrIdx = args.indexOf('--fuzzy-threshold');
  const threshold = thrIdx >= 0 ? Number.parseFloat(args[thrIdx + 1]) : 0.7;
  return diffSessions(sessionPath, pathB, { fuzzy: !fuzzyOff, threshold });
}

// split into phases by createdAt gaps
function groupIntoPhases(sorted, gapMin) {
  const phases = [];
  let current = null;
  for (const t of sorted) {
    const ts = new Date(t.createdAt).getTime();
    if (!current) {
      current = { phase: 1, start: ts, end: ts, tasks: [t] };
    } else if (ts - current.end > gapMin * 60_000) {
      phases.push(current);
      current = { phase: phases.length + 1, start: ts, end: ts, tasks: [t] };
    } else {
      current.end = ts;
      current.tasks.push(t);
    }
  }
  if (current) phases.push(current);
  return phases;
}

function printPhases(phases, gapMin) {
  console.log(`📊 ${phases.length} phases (gap >= ${gapMin} minutes)\n`);
  // compute Day N labels (the first phase's date is Day 1)
  const firstDate = phases.length > 0 ? new Date(phases[0].start).toISOString().slice(0, 10) : null;
  const dayOf = (ms) => {
    if (!firstDate) return 1;
    const d = new Date(ms).toISOString().slice(0, 10);
    return Math.round((new Date(d) - new Date(firstDate)) / 86_400_000) + 1;
  };
  for (const ph of phases) {
    const sDate = new Date(ph.start).toISOString().slice(0, 10);
    const eDate = new Date(ph.end).toISOString().slice(0, 10);
    const s = new Date(ph.start).toISOString().slice(11, 19);
    const e = new Date(ph.end).toISOString().slice(11, 19);
    const dur = ((ph.end - ph.start) / 60_000).toFixed(0);
    const dayTag = `Day ${dayOf(ph.start)}`;
    const dateRange = sDate === eDate ? sDate : `${sDate} → ${eDate}`;
    console.log(`Phase ${ph.phase} [${dayTag}] ${dateRange} ${s} → ${e} (${dur}m, ${ph.tasks.length} tasks):`);
    for (const t of ph.tasks) {
      const neverMark = (t.status === 'pending' && (t.updateCount || 0) === 0) ? ' [never-updated]' : '';
      console.log(`   ${STATUS_ICONS[t.status] || '·'} ${t.subject}${neverMark}`);
    }
    console.log('');
  }
}

// tasks --by-phase (auto-split into phases by TaskCreate timestamp)
async function runByPhase(args, sessionPath) {
  const gapMinIdx = args.indexOf('--phase-gap');
  const gapMin = gapMinIdx >= 0 ? Number.parseInt(args[gapMinIdx + 1]) || 15 : 15;
  const all = await extractTasks(sessionPath);
  // sort by createdAt
  const sorted = all.filter(t => t.createdAt).sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
  const phases = groupIntoPhases(sorted, gapMin);
  if (args.includes('--json')) {
    console.log(JSON.stringify(phases, null, 2));
    return;
  }
  printPhases(phases, gapMin);
}

// tasks --by-keyword
async function runByKeyword(args, sessionPath, kwIdx) {
  const kw = (args[kwIdx + 1] || '').toLowerCase();
  if (!kw) { console.error('❌ --by-keyword requires a keyword'); process.exit(1); }
  const all = await extractTasks(sessionPath);
  const matched = all.filter(t =>
    (t.subject || '').toLowerCase().includes(kw) ||
    (t.description || '').toLowerCase().includes(kw)
  );
  printTasks(matched, { verbose: args.includes('--verbose') });
}

async function runDefault(args, sessionPath) {
  // time-range filter (for exited sessions, baseMs defaults to the file mtime)
  const { parseTimeRange } = require('../lib/resolver');
  const { sinceMs, untilMs, baseSource } = parseTimeRange(args, { sessionPath });
  if (args.includes('--since') || args.includes('--until')) {
    console.error(`ℹ️  time basis: ${baseSource === 'session-mtime' ? 'session last-modified time' : 'current time'}`);
  }

  let tasks;
  if (args.includes('--chain')) {
    const input = args.find(a => !a.startsWith('--')) || '--latest';
    const r = await extractTasksChain(input, { sinceMs, untilMs });
    tasks = r.tasks;
    const brokenNote = r.brokenSegments ? ` (⚠️broken chain ${r.brokenSegments})` : '';
    console.error(`ℹ️  chain rollup: merged ${r.chainSegments} segments${brokenNote}`);
  } else {
    require('../lib/resolver').hintChainIfForked(sessionPath, args);
    tasks = await extractTasks(sessionPath, { sinceMs, untilMs });
  }
  const filtered = filterTasks(tasks, {
    current: args.includes('--current'),
    pending: args.includes('--pending'),
    done: args.includes('--done'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  printTasks(filtered, { verbose: args.includes('--verbose') });
}

async function main() {
  const args = process.argv.slice(2);
  // unknown-flag detection
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--current', '--pending', '--done', '--verbose', '--diff', '--since', '--until',
            '--by-keyword', '--by-phase', '--phase-gap', '--no-fuzzy', '--fuzzy-threshold', '--chain'],
    valueFlags: ['--diff', '--since', '--until', '--by-keyword', '--phase-gap', '--fuzzy-threshold'],
    scriptName: 'tasks',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-tasks.js — extract a session's task list

Usage:
  recensa-session tasks <session.jsonl>             all tasks
  recensa-session tasks <session.jsonl> --current   list only in_progress
  recensa-session tasks <session.jsonl> --pending   list only pending
  recensa-session tasks <session.jsonl> --done      list only completed
  recensa-session tasks <session.jsonl> --verbose   include description
  recensa-session tasks <session.jsonl> --json      JSON output
  recensa-session tasks a.jsonl --diff b.jsonl      diff between two sessions
  recensa-session tasks <session> --chain           merge tasks along the fork chain (includes tasks before the compaction point)

Filter / group:
  --by-keyword <kw>     list only tasks whose subject/description contains the keyword
  --by-phase            auto-split into phases by TaskCreate time (split on gaps)
  --phase-gap <min>     phase-split interval for --by-phase (minutes, default 15)
  --since <spec>        list only tasks created/updated at or after spec
  --until <spec>        list only tasks created/updated at or before spec

--diff fuzzy-matching options:
  --fuzzy-threshold <n> fuzzy-match similarity threshold (0~1, default 0.7)
  --no-fuzzy            disable fuzzy matching, do exact subject comparison only`);
    process.exit(0);
  }

  // resolve the session path (supports --latest and short UUID prefixes)
  let sessionPath;
  try {
    const { resolveFromArgs } = require('../lib/resolver');
    sessionPath = resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const diffIdx = args.indexOf('--diff');
  if (diffIdx >= 0) return runDiff(args, sessionPath, diffIdx);

  if (args.includes('--by-phase')) return runByPhase(args, sessionPath);

  const kwIdx = args.indexOf('--by-keyword');
  if (kwIdx >= 0) return runByKeyword(args, sessionPath, kwIdx);

  return runDefault(args, sessionPath);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { extractTasks, filterTasks };
