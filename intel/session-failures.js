#!/usr/bin/env node
'use strict';

/*
 * session-failures.js — Scan all tool failures in a session, classify + detect thrash
 *
 * Turns the prose signals of the anti-fragility rules (Three-Strike / de-patch /
 * Edit-failure) into measurable signals. The source is a structured boolean
 * (content[].tool_result.is_error) plus the literal Bash "Exit code N", not NLP, so the
 * signal/noise ratio is highest. Every debrief should ask "what did this session keep
 * getting stuck on".
 *
 * Categories (by error-content prefix / tool kind):
 *   read-before-edit   Edit/Write without a prior Read ("has not been read" / "must read")
 *   stale-file         file changed, needs re-read ("has been modified" / "file has changed")
 *   string-not-found   Edit old_string mismatch ("String to replace not found" / "no match")
 *   bash-exit          Bash "Exit code N != 0"
 *   agent-validation   subagent / validation / verifier failure ("validation" / "verifier" / exit 2)
 *   other              uncategorized
 *
 * Usage: recensa-session failures <session> [--summary] [--retry] [--log] [--chain] [--json]
 */

const fs = require('node:fs');
const readline = require('node:readline');
const { resolveFromArgs, walkChain } = require('../lib/resolver');
const { validateArgs } = require('../lib/argv');

// Single source of truth for flag definitions (--help + validateArgs known/valueFlags all derive from this)
const FLAGS = [
  { name: '--summary', group: 'Mode', desc: 'Per-tool / per-category failure count census (default)' },
  { name: '--retry', group: 'Mode', desc: 'Thrash detection: consecutive failures on the same tool::target (operationalized 3-strike)' },
  { name: '--log', group: 'Mode', desc: 'List every error in order (turn + tool + category + summary)' },
  { name: '--chain', group: 'Scope', desc: 'Scan and merge along the fork chain segment by segment (includes failures before compaction points)' },
];

// Tools that launch a subagent/verifier: "exit code 2" from one is a validation-failure convention, but the
// same text from Bash is a real shell error → must stay bash-exit. Only these gate the exit-2 branch below.
const AGENT_TOOLS = new Set(['Task']);

// Classification rules: { id, test(errText, toolName) }, order is priority order
// The is_error flag (structural) is what detects a failure; these patterns only sub-classify the
// English error text Claude Code emits, so they are English-only (no need to match localized prose).
const CATEGORIES = [
  { id: 'read-before-edit', test: (t) => /has not been read|must read|read .* before/i.test(t) },
  { id: 'stale-file', test: (t) => /has been modified|file has changed|has been edited|modified since/i.test(t) },
  { id: 'string-not-found', test: (t) => /string to replace not found|no match|old_string|not unique/i.test(t) },
  { id: 'agent-validation', test: (t, tool) => /validation|verifier|validate|schema/i.test(t) || (AGENT_TOOLS.has(tool) && /exit code 2\b/i.test(t)) },
  { id: 'bash-exit', test: (t) => /exit code [1-9]/i.test(t) },
];

function classify(errText, toolName) {
  const t = errText || '';
  for (const { id, test } of CATEGORIES) {
    if (test(t, toolName)) return id;
  }
  return 'other';
}

// Representative target of a tool_use input (shown when looking up the tool_result)
function targetOf(input) {
  if (!input) return '';
  return input.file_path || input.command || input.pattern || input.query || input.subagent_type || '';
}

/** Extract plain text from tool_result content (content may be string / array / char-indexed object) */
function errTextOf(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  // a null/non-object array element (adversarial jsonl) contributes empty text instead of crashing
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
  if (c && typeof c === 'object') return Object.values(c).join('');
  return '';
}

// Record the assistant's tool_use (for tool_result lookup of name + target)
function indexToolUses(r, toolUseById) {
  if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) return;
  for (const b of r.message.content) {
    if (!b || typeof b !== 'object') continue; // skip a null/non-object block (adversarial jsonl)
    if (b.type === 'tool_use') toolUseById.set(b.id, { name: b.name, target: String(targetOf(b.input)).slice(0, 120) });
  }
}

// Scan the user tool_result is_error entries, pair with tool_use, then push into failures
function collectResultFailures(r, toolUseById, failures, turn) {
  if (r.type !== 'user' || !Array.isArray(r.message?.content)) return;
  for (const b of r.message.content) {
    if (!b || typeof b !== 'object') continue; // skip a null/non-object block (adversarial jsonl), never crash the scan
    if (b.type !== 'tool_result' || !b.is_error) continue;
    const errText = errTextOf(b);
    const tu = toolUseById.get(b.tool_use_id) || { name: '?', target: '' };
    failures.push({
      turn,
      tool: tu.name,
      target: tu.target,
      category: classify(errText, tu.name),
      preview: errText.replace(/\s+/g, ' ').slice(0, 160),
      toolUseId: b.tool_use_id,
      timestamp: r.timestamp,
    });
  }
}

/** Scan one jsonl, return failures[] (with tool_use-paired name + target) */
async function scanFailures(sessionPath) {
  const toolUseById = new Map(); // tool_use_id -> { name, target }
  const failures = [];
  let turn = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(sessionPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }

    if (r.type === 'user' && r.userType === 'external' && !r.toolUseResult) turn++;
    indexToolUses(r, toolUseById);
    collectResultFailures(r, toolUseById, failures, turn);
  }
  rl.close();
  return failures;
}

/** thrash: a run of consecutive (adjacent in time) failures on the same tool::target; length >= 2 counts as spinning */
function detectThrash(failures) {
  const runs = [];
  let cur = null;
  for (const f of failures) {
    const key = `${f.tool}::${f.target}`;
    if (cur?.key === key) {
      cur.count++; cur.turns.push(f.turn); cur.last = f;
    } else {
      if (cur && cur.count >= 2) runs.push(cur);
      cur = { key, tool: f.tool, target: f.target, count: 1, turns: [f.turn], first: f, last: f };
    }
  }
  if (cur && cur.count >= 2) runs.push(cur);
  return runs.sort((a, b) => b.count - a.count);
}

function printSummary(failures) {
  if (failures.length === 0) { console.log('✅ 0 tool failures'); return; }
  const byCat = {}, byTool = {};
  for (const f of failures) {
    byCat[f.category] = (byCat[f.category] || 0) + 1;
    byTool[f.tool] = (byTool[f.tool] || 0) + 1;
  }
  console.log(`🔴 ${failures.length} tool failures\n`);
  console.log('By category:');
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log('\nBy tool:');
  for (const [k, v] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
}

function printRetry(failures) {
  const runs = detectThrash(failures);
  if (runs.length === 0) { console.log('✅ no thrash (consecutive failures on the same tool::target >= 2)'); return; }
  console.log(`🌀 ${runs.length} thrash runs (consecutive failures on the same target)\n`);
  for (const r of runs) {
    const flag = r.count >= 3 ? '🚨 3-strike+' : '⚠️';
    console.log(`${flag} ${r.tool} × ${r.count}  → ${r.target || '(no target)'}`);
    console.log(`   turns ${r.turns.join(',')}  | last: ${r.last.preview.slice(0, 100)}`);
  }
}

function printLog(failures) {
  if (failures.length === 0) { console.log('✅ 0 tool failures'); return; }
  console.log(`🔴 ${failures.length} failures (chronological)\n`);
  for (const f of failures) {
    console.log(`turn ${String(f.turn).padStart(3)}  ${f.tool.padEnd(8)}  [${f.category}]  ${f.target}`);
    console.log(`         ${f.preview}`);
  }
}

function printHelp() {
  const fmt = (f) => {
    const valuePart = f.value ? ` <${f.value}>` : '';
    return `  ${(f.name + valuePart).padEnd(14)}${f.desc}`;
  };
  const byGroup = (g) => FLAGS.filter((f) => f.group === g).map(fmt).join('\n');
  console.log(`session-failures.js — Tool failure census + thrash detection

Usage: recensa-session failures <session> [flags]
  session = absolute path / UUID prefix (>=6) / --latest

Mode (choose one, default --summary):
${byGroup('Mode')}

Scope:
${byGroup('Scope')}`);
}

// Scan along the fork chain segment by segment, dedupe (toolUseId unique), and merge failures
async function collectChainFailures(args) {
  const input = args.find((a) => !a.startsWith('--')) || '--latest';
  const chain = walkChain(input);
  const broken = chain.filter((c) => c.missing);
  if (broken.length) console.error(`⚠️  chain broken: ${broken.map((c) => c.sessionId.slice(0, 8)).join(', ')}`);
  const seen = new Set();
  const failures = [];
  for (const seg of chain.filter((c) => c.path)) {
    const segF = await scanFailures(seg.path);
    // Dedupe (a fork re-includes its parent): toolUseId is unique
    for (const f of segF) {
      if (f.toolUseId && seen.has(f.toolUseId)) continue;
      if (f.toolUseId) seen.add(f.toolUseId);
      failures.push(f);
    }
  }
  console.error(`ℹ️  chain: ${chain.filter((c) => c.path).length} segments`);
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  validateArgs(args, {
    known: FLAGS.map((f) => f.name),
    valueFlags: FLAGS.filter((f) => f.value).map((f) => f.name),
    scriptName: 'failures',
  });

  // Collect failures (single file or along the chain)
  let failures;
  if (args.includes('--chain')) {
    failures = await collectChainFailures(args);
  } else {
    let filePath;
    try { filePath = resolveFromArgs(args).path; } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    failures = await scanFailures(filePath);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ total: failures.length, thrashRuns: detectThrash(failures), failures }, null, 2));
    return;
  }
  if (args.includes('--retry')) return printRetry(failures);
  if (args.includes('--log')) return printLog(failures);
  printSummary(failures); // default
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { scanFailures, classify, detectThrash };
