#!/usr/bin/env node
/**
 * session-guard.js — Session degradation-signal pull-scanner (model purity / same-file patching / saturation)
 *
 * Three axes (rationale from quality-collapse forensics: a non-Anthropic model mixed in
 * produced false DONEs, same-file Edit runs of 50-95x never triggered de-patch, and
 * hallucinated edits appeared after 3-8 compactions):
 *   1. PURITY    — a non-claude-* model appears in an assistant message.model -> 🔴
 *                  (output from a non-Anthropic segment must be re-reviewed by Claude before it is committed or recorded into definitions)
 *   2. CHURN     — same-file Edit count >= 5 -> 🟡 (run de-patch check); >= 10 -> 🔴 (de-patch SEVERE review)
 *   3. SATURATION— compact >= 1 -> 🟡; >= 2 -> 🔴 (suggest /handoff to a fresh session);
 *                  user-prompt >= 80 -> 🟡
 *
 * exit code (only reliable in inline mode; read the text output otherwise):
 *   0 = all green   1 = has 🟡   2 = has 🔴
 *
 * Usage:
 *   recensa-session guard <session.jsonl>        scan the given session
 *   recensa-session guard --self                 scan the current session (reads CLAUDE_CODE_SESSION_ID)
 *   recensa-session guard <s> --json             JSON output
 *   --churn-warn <n>    same-file Edit warning threshold (default 5, aligned with de-patch)
 *   --churn-severe <n>  same-file Edit severe threshold (default 10, aligned with de-patch SEVERE)
 *   --top <n>           max files listed in the churn table (default 10)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { resolveProjectsDir } = require('../lib/resolver');

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

/** Update model stats; return the updated lastModel (pure reorg, decision logic unchanged) */
function recordAssistantModel(stats, m, lastModel) {
  if (m && m !== '<synthetic>') {
    stats.models[m] = (stats.models[m] || 0) + 1;
    if (!m.startsWith('claude-')) stats.nonClaudeTurns++;
    if (lastModel && m !== lastModel) stats.modelSwitches++;
    return m;
  }
  return lastModel;
}

/** Accumulate Edit/Write churn from assistant content (pure reorg, decision logic unchanged) */
function accumulateChurn(stats, content) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type !== 'tool_use') continue;
    const isEdit = EDIT_TOOLS.has(b.name);
    const isWrite = b.name === 'Write';
    if (!isEdit && !isWrite) continue;
    const fp = b.input?.file_path || b.input?.notebook_path;
    if (!fp || typeof fp !== 'string') continue;
    const key = fp.replaceAll('\\', '/').toLowerCase();
    if (!stats.churn[key]) stats.churn[key] = { display: fp.replaceAll('\\', '/'), edits: 0, writes: 0 };
    if (isEdit) stats.churn[key].edits++;
    else stats.churn[key].writes++;
  }
}

function resolveSelf() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    console.error('❌ --self requires the CLAUDE_CODE_SESSION_ID environment variable (only available inside a Claude Code session)');
    process.exit(2);
  }
  const projRoot = resolveProjectsDir();
  let dirs = [];
  try { dirs = fs.readdirSync(projRoot); } catch { /* fallthrough */ }
  for (const d of dirs) {
    const p = path.join(projRoot, d, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  console.error(`❌ not found under ${projRoot}: ${sid}.jsonl`);
  process.exit(2);
}

async function scan(sessionPath) {
  const stats = {
    sessionPath,
    turnCount: 0,
    userPromptCount: 0,
    compactCount: 0,
    models: {},            // model -> assistant turn count (excluding <synthetic>)
    modelSwitches: 0,
    nonClaudeTurns: 0,
    churn: {},             // normalized path -> { display, edits, writes }
  };
  let lastModel = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }

    if (r.type === 'system' && /compact_boundary/.test(r.subtype || '')) {
      stats.compactCount++;
      continue;
    }
    if (r.type === 'user' && r.userType === 'external' && !r.toolUseResult) {
      stats.userPromptCount++;
      continue;
    }
    if (r.type !== 'assistant') continue;

    stats.turnCount++;
    lastModel = recordAssistantModel(stats, r.message?.model, lastModel);
    accumulateChurn(stats, r.message?.content);
  }
  rl.close();
  return stats;
}

function judge(stats, opt) {
  const nonClaude = Object.entries(stats.models).filter(([m]) => !m.startsWith('claude-'));
  const purity = {
    level: nonClaude.length > 0 ? 'RED' : 'GREEN',
    nonClaudeModels: Object.fromEntries(nonClaude),
    nonClaudeTurns: stats.nonClaudeTurns,
    nonClaudePct: stats.turnCount ? Math.round((stats.nonClaudeTurns / stats.turnCount) * 100) : 0,
    modelSwitches: stats.modelSwitches,
    models: stats.models,
  };

  const rows = Object.values(stats.churn)
    .filter((c) => c.edits >= opt.churnWarn)
    .sort((a, b) => b.edits - a.edits);
  const severe = rows.filter((c) => c.edits >= opt.churnSevere);
  let churnLevel = 'GREEN';
  if (severe.length > 0) churnLevel = 'RED';
  else if (rows.length > 0) churnLevel = 'YELLOW';
  const churn = {
    level: churnLevel,
    warnThreshold: opt.churnWarn,
    severeThreshold: opt.churnSevere,
    files: rows,
    severeCount: severe.length,
  };

  // The RED threshold (compact >= 2) is also consumed by the post-compaction injection step
  // (same value, different owner: here it sets the guard report level, there it sets the
  // post-compaction SATURATION warning) — keep both `>= 2` in sync when changing this value.
  let saturationLevel = 'GREEN';
  if (stats.compactCount >= 2) saturationLevel = 'RED';
  else if (stats.compactCount === 1 || stats.userPromptCount >= 80) saturationLevel = 'YELLOW';
  const saturation = {
    level: saturationLevel,
    compactCount: stats.compactCount,
    userPromptCount: stats.userPromptCount,
    turnCount: stats.turnCount,
  };

  const levels = new Set([purity.level, churn.level, saturation.level]);
  let overall = 'GREEN';
  if (levels.has('RED')) overall = 'RED';
  else if (levels.has('YELLOW')) overall = 'YELLOW';
  return { purity, churn, saturation, overall };
}

const ICON = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' };

function printHuman(stats, v, opt) {
  console.log(`session-guard — ${path.basename(stats.sessionPath)}`);
  console.log(`  turns: ${stats.turnCount} assistant / ${stats.userPromptCount} user-prompts / compact ×${stats.compactCount}\n`);

  console.log(`${ICON[v.purity.level]} PURITY — model purity`);
  for (const [m, n] of Object.entries(v.purity.models)) {
    const mark = m.startsWith('claude-') ? '' : '  ⚠️ non-Anthropic';
    console.log(`   ${m}: ${n} turns${mark}`);
  }
  if (v.purity.level === 'RED') {
    console.log(`   → ${v.purity.nonClaudePct}% of turns are non-claude models (${v.purity.modelSwitches} switches). This segment must be re-reviewed by Claude; do not commit or record it into definitions directly.`);
  }

  console.log(`\n${ICON[v.churn.level]} CHURN — same-file patching (Edit >= ${opt.churnWarn} listed; >= ${opt.churnSevere} = de-patch SEVERE review)`);
  if (v.churn.files.length === 0) console.log('   (no files over threshold)');
  for (const c of v.churn.files.slice(0, opt.top)) {
    const flag = c.edits >= opt.churnSevere ? ' 🔴 run de-patch (full-file rewrite review)' : ' 🟡 run de-patch check';
    const writesPart = c.writes ? ` +${c.writes}W` : '';
    console.log(`   ${String(c.edits).padStart(3)}x Edit${writesPart}  ${c.display}${flag}`);
  }
  if (v.churn.files.length > opt.top) console.log(`   …${v.churn.files.length - opt.top} more files over threshold`);

  console.log(`\n${ICON[v.saturation.level]} SATURATION — saturation`);
  console.log(`   compact ×${v.saturation.compactCount} (>=2 = 🔴 suggest /handoff to a fresh session), user-prompts ${v.saturation.userPromptCount} (>=80 = 🟡)`);
  if (v.saturation.level !== 'GREEN') {
    console.log('   → after compaction, requirements tend to be dropped and tool hallucination increases. Do not force a large feature through; hand off and switch sessions.');
  }

  console.log(`\nVerdict: ${ICON[v.overall]} ${v.overall}`);
}

async function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--self', '--json', '--churn-warn', '--churn-severe', '--top'],
    valueFlags: ['--churn-warn', '--churn-severe', '--top'],
    scriptName: 'guard',
  });

  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-guard.js — Session degradation-signal pull-scanner

Usage:
  recensa-session guard <session.jsonl>        scan the given session
  recensa-session guard --self                 scan the current session (reads CLAUDE_CODE_SESSION_ID)
  --json               JSON output
  --churn-warn <n>     same-file Edit warning threshold (default 5)
  --churn-severe <n>   same-file Edit severe threshold (default 10)
  --top <n>            max files listed in the churn table (default 10)

Three axes: PURITY (non-claude-* model = 🔴 needs re-review by Claude) / CHURN (de-patch threshold operationalized) /
      SATURATION (compact >=2 = 🔴 suggest switching sessions)
exit: 0=all green 1=has 🟡 2=has 🔴 (exit code only reliable in inline mode)`);
    process.exit(0);
  }

  const getVal = (flag, dflt) => {
    const i = args.indexOf(flag);
    if (i < 0) return dflt;
    const n = Number.parseInt(args[i + 1], 10);
    if (Number.isNaN(n) || n < 1) { console.error(`❌ ${flag} requires a positive integer`); process.exit(2); }
    return n;
  };
  const opt = {
    churnWarn: getVal('--churn-warn', 5),
    churnSevere: getVal('--churn-severe', 10),
    top: getVal('--top', 10),
  };
  if (opt.churnSevere < opt.churnWarn) { console.error('❌ --churn-severe cannot be less than --churn-warn'); process.exit(2); }

  let sessionPath;
  if (args.includes('--self')) {
    sessionPath = resolveSelf();
  } else {
    sessionPath = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      console.error(`❌ session file not found: ${sessionPath || '(not specified)'}`);
      process.exit(2);
    }
  }

  const stats = await scan(sessionPath);
  const verdict = judge(stats, opt);

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      sessionPath: stats.sessionPath,
      overall: verdict.overall,
      purity: verdict.purity,
      churn: { ...verdict.churn, files: verdict.churn.files.slice(0, opt.top) },
      saturation: verdict.saturation,
    }, null, 2));
  } else {
    printHuman(stats, verdict, opt);
  }

  let exitCode = 0;
  if (verdict.overall === 'RED') exitCode = 2;
  else if (verdict.overall === 'YELLOW') exitCode = 1;
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(2); });
}

module.exports = { scan, judge };
