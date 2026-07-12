#!/usr/bin/env node
/**
 * dead-context.js — Dead-context detection engine
 *
 * Detects "dead context" in a session — content that no longer has value but still
 * occupies the token budget.
 * Based on a taxonomy of 18 strategies plus researched best practices.
 * Currently implements 11 strategies (gentle 3 -> standard 8 -> aggressive 11, each a
 * superset of the previous).
 *
 * Detection strategies (three levels, cumulative):
 *   gentle (3):      compact-summary-collapse, metadata-dedup, progress-collapse
 *   standard (+5):   thinking-blocks, tool-output-trim, tool-result-age,
 *                    stale-reads, system-reminder-dedup
 *   aggressive (+3): orphaned-tool-results, large-base64, hook-noise
 *
 * Usage:
 *   recensa-session dead-context <session.jsonl>                         full detection report
 *   recensa-session dead-context <session.jsonl> --strategy aggressive   aggressive detection
 *   recensa-session dead-context <session.jsonl> --auto-fix              auto-mark (does not modify the original)
 *   recensa-session dead-context <session.jsonl> --json                   JSON output
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

// ── Detection rules ──────────────────────────────────────

const STRATEGIES = {
  gentle: [
    'compact-summary-collapse',
    'metadata-dedup',
    'progress-collapse',
  ],
  standard: [
    'compact-summary-collapse', 'metadata-dedup', 'progress-collapse',
    'thinking-blocks', 'tool-output-trim', 'tool-result-age',
    'stale-reads', 'system-reminder-dedup',
  ],
  aggressive: [
    'compact-summary-collapse', 'metadata-dedup', 'progress-collapse',
    'thinking-blocks', 'tool-output-trim', 'tool-result-age',
    'stale-reads', 'system-reminder-dedup',
    'orphaned-tool-results', 'large-base64', 'hook-noise',
  ],
};

// ── Individual detectors ─────────────────────────────────

function findLastCompactIdx(records) {
  let lastCompactIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'system' && /compact_boundary/.test(r.subtype || '')) {
      lastCompactIdx = i;
    }
  }
  return lastCompactIdx;
}

/** user/assistant with text content -> collapsible after a compact */
function isCollapsibleTextRecord(r) {
  if (r.type !== 'user' && r.type !== 'assistant') return false;
  const content = r.message?.content;
  return Array.isArray(content)
    ? content.some(b => b.type === 'text')
    : typeof content === 'string';
}

/** Old messages already covered by a compact summary */
function detectCompactSummaryCollapse(records) {
  const findings = [];
  const lastCompactIdx = findLastCompactIdx(records);

  if (lastCompactIdx > 0) {
    // user/assistant text messages before the compact boundary are already covered by the summary
    for (let i = 0; i < lastCompactIdx; i++) {
      const r = records[i];
      if (isCollapsibleTextRecord(r)) {
        findings.push({
          strategy: 'compact-summary-collapse',
          index: i,
          type: r.type,
          uuid: r.uuid,
          severity: 'optimizable',
          message: 'already covered by the compact summary, safe to remove (a normal Claude Code compact result)',
        });
      }
    }
  }

  return findings;
}

/** Duplicate metadata records (multiple custom-title, ai-title, etc.) */
function detectMetadataDedup(records) {
  const findings = [];
  const seen = {};

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (['custom-title', 'ai-title', 'last-prompt', 'tag', 'agent-name'].includes(r.type)) {
      const key = r.type;
      if (seen[key]) {
        findings.push({
          strategy: 'metadata-dedup',
          index: i,
          type: r.type,
          severity: 'optimizable',
          message: `duplicate ${r.type} (Claude Code reAppends on every compact/session exit; this is normal, keep only the last one)`,
        });
      }
      seen[key] = true;
    }
  }

  return findings;
}

/** progress events (usually 50%+ of the volume) */
function detectProgressCollapse(records) {
  const findings = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].type === 'progress') {
      findings.push({
        strategy: 'progress-collapse',
        index: i,
        type: 'progress',
        severity: 'optimizable',
        message: 'Progress event (~50% of the volume, ignored entirely by Claude Code resume, removing does not affect functionality)',
      });
    }
  }
  return findings;
}

/** thinking blocks */
function detectThinkingBlocks(records) {
  const findings = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const thinkingBlocks = r.message.content.filter(b => b.type === 'thinking');
      if (thinkingBlocks.length > 0) {
        findings.push({
          strategy: 'thinking-blocks',
          index: i,
          type: 'assistant',
          uuid: r.uuid,
          severity: 'optimizable',
          message: `a normal product of extended thinking, keeping it does not affect functionality`,
        });
      }
    }
  }
  return findings;
}

/** large tool output */
function detectToolOutputTrim(records) {
  const findings = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'user' && r.toolUseResult) {
      const output = r.toolUseResult.output;
      if (output) {
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        if (text.length > 2000) {
          findings.push({
            strategy: 'tool-output-trim',
            index: i,
            type: 'user',
            uuid: r.uuid,
            severity: 'warning',
            message: `tool output ${text.length.toLocaleString()} chars (> 2,000, can be truncated)`,
            size: text.length,
          });
        }
      }
    }
  }
  return findings;
}

/** stale tool results (> 30 turns) */
function detectToolResultAge(records) {
  const findings = [];
  let turnCount = 0;
  const turnMap = new Map(); // index -> turn number

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'assistant') turnCount++;
    turnMap.set(i, turnCount);
  }

  const lastTurn = turnCount;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'user' && r.toolUseResult) {
      const turn = turnMap.get(i) || 0;
      const age = lastTurn - turn;
      if (age > 30) {
        findings.push({
          strategy: 'tool-result-age',
          index: i,
          type: 'user',
          uuid: r.uuid,
          severity: 'optimizable',
          message: `tool result is ${age} turns old (> 30 turns, can be removed)`,
          age,
        });
      }
    }
  }

  return findings;
}

/** Classify a single tool_use block: Read goes into fileReads, Write/Edit into fileEdits */
function classifyFileToolBlock(block, index, uuid, fileEdits, fileReads) {
  if (block.type !== 'tool_use') return;
  const fp = block.input?.file_path || block.input?.filePath;
  if (!fp) return;
  if (block.name === 'Read') {
    fileReads.push({ filePath: fp, readIndex: index, uuid });
  } else if (['Write', 'Edit'].includes(block.name)) {
    fileEdits.set(fp, index);
  }
}

/** Collect all file Reads (with readIndex) and the last Write/Edit index per file */
function collectFileEditsAndReads(records) {
  const fileEdits = new Map(); // filePath -> index of its last edit
  const fileReads = [];        // each entry: filePath and readIndex
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        classifyFileToolBlock(block, i, r.uuid, fileEdits, fileReads);
      }
    }
  }
  return { fileEdits, fileReads };
}

/** file reads already superseded by a later edit */
function detectStaleReads(records) {
  const findings = [];
  const { fileEdits, fileReads } = collectFileEditsAndReads(records);

  for (const read of fileReads) {
    const lastEdit = fileEdits.get(read.filePath);
    if (lastEdit && lastEdit > read.readIndex) {
      findings.push({
        strategy: 'stale-reads',
        index: read.readIndex,
        type: 'assistant',
        uuid: read.uuid,
        severity: 'optimizable',
        message: `the Read of ${read.filePath} has been superseded by a later Edit`,
        filePath: read.filePath,
      });
    }
  }

  return findings;
}

/** duplicate system reminders (multiple identical system reminder contents) */
function detectSystemReminderDedup(records) {
  const findings = [];
  const seenReminders = new Set();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'user' && r.userType !== 'external') {
      const content = r.message?.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      if (seenReminders.has(text)) {
        findings.push({
          strategy: 'system-reminder-dedup',
          index: i,
          type: 'user',
          severity: 'optimizable',
          message: 'duplicate system reminder',
        });
      } else {
        seenReminders.add(text);
      }
    }
  }

  return findings;
}

/** Collect the ids of all assistant tool_use */
function collectToolUseIds(records) {
  const toolUseIds = new Set();
  for (const r of records) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block.type === 'tool_use' && block.id) {
          toolUseIds.add(block.id);
        }
      }
    }
  }
  return toolUseIds;
}

/** orphaned tool_result (missing its matching tool_use) */
function detectOrphanedToolResults(records) {
  const findings = [];
  const toolUseIds = collectToolUseIds(records);

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id && !toolUseIds.has(block.tool_use_id)) {
          findings.push({
            strategy: 'orphaned-tool-results',
            index: i,
            type: 'user',
            uuid: r.uuid,
            severity: 'warning',
            message: `orphaned tool_result: ${block.tool_use_id}`,
          });
        }
      }
    }
  }

  return findings;
}

/** Scan a record's content for large base64 images, return { totalSize, imageCount } */
function scanImageBlocks(content) {
  let totalSize = 0;
  let imageCount = 0;
  for (const block of content) {
    // Only check image block source.data, do not JSON.stringify the whole record
    if (block.type === 'image' && block.source?.data) {
      const data = typeof block.source.data === 'string' ? block.source.data : '';
      if (data.length > 1000) {
        imageCount++;
        totalSize += data.length;
      }
    }
  }
  return { totalSize, imageCount };
}

/** large base64 content (precisely targets image blocks and image content) */
function detectLargeBase64(records) {
  const findings = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;

    const { totalSize, imageCount } = scanImageBlocks(content);
    if (imageCount > 0) {
      findings.push({
        strategy: 'large-base64',
        index: i,
        type: r.type,
        severity: 'warning',
        message: `${imageCount} large base64 images (${(totalSize / 1024).toFixed(1)} KB)`,
        size: totalSize,
      });
    }
  }
  return findings;
}

/** hook noise (hook_progress, hook_success, etc. — many repeated hook messages) */
function detectHookNoise(records) {
  const findings = [];
  const hookCounts = {};

  for (const r of records) {
    if (r.type === 'progress') {
      const hookName = r.data?.hook_name || r.data?.hookName;
      if (hookName) {
        hookCounts[hookName] = (hookCounts[hookName] || 0) + 1;
      }
    }
  }

  for (const [hook, count] of Object.entries(hookCounts)) {
    if (count > 50) {
      findings.push({
        strategy: 'hook-noise',
        type: 'progress',
        severity: 'optimizable',
        message: `Hook "${hook}" appears ${count} times (> 50, heavy noise)`,
        count,
      });
    }
  }

  return findings;
}

// ── Main detection function ──────────────────────────────

const DETECTORS = {
  'compact-summary-collapse': detectCompactSummaryCollapse,
  'metadata-dedup': detectMetadataDedup,
  'progress-collapse': detectProgressCollapse,
  'thinking-blocks': detectThinkingBlocks,
  'tool-output-trim': detectToolOutputTrim,
  'tool-result-age': detectToolResultAge,
  'stale-reads': detectStaleReads,
  'system-reminder-dedup': detectSystemReminderDedup,
  'orphaned-tool-results': detectOrphanedToolResults,
  'large-base64': detectLargeBase64,
  'hook-noise': detectHookNoise,
};

async function detectDeadContext(sessionPath, strategy = 'standard') {
  // Stream line by line (a large 9MB+ session is not loaded at once, to avoid OOM — cleaning large files is exactly the main scenario)
  const records = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { records.push({ _raw: line }); }
  }
  rl.close();

  const strategies = STRATEGIES[strategy] || STRATEGIES.standard;
  const allFindings = [];

  for (const strat of strategies) {
    const detector = DETECTORS[strat];
    if (detector) {
      const findings = detector(records);
      allFindings.push(...findings);
    }
  }

  // Aggregate stats
  const byStrategy = {};
  for (const f of allFindings) {
    byStrategy[f.strategy] = (byStrategy[f.strategy] || 0) + 1;
  }

  return {
    sessionPath,
    strategy,
    totalRecords: records.length,
    optimizableCount: allFindings.length,
    byStrategy,
    findings: allFindings,
  };
}

// ── CLI ────────────────────────────────────────────────────

/** --chain (opt-in): scan along the fork chain segment by segment, merge findings (tag the segment source) */
async function runChainScan(args, strategy) {
  const { walkChain } = require('../lib/resolver');
  const input = args.find(a => !a.startsWith('--')) || '--latest';
  const chain = walkChain(input);
  const live = chain.filter(c => c.path);
  const broken = chain.filter(c => c.missing);
  if (broken.length) console.error(`⚠️  chain broken: ${broken.map(c => c.sessionId.slice(0, 8)).join(', ')}`);
  const segResults = [];
  let totalRecords = 0, totalOptimizable = 0;
  const byStrategyAll = {};
  for (const seg of live) {
    const r = await detectDeadContext(seg.path, strategy);
    totalRecords += r.totalRecords;
    totalOptimizable += r.optimizableCount;
    for (const [k, v] of Object.entries(r.byStrategy)) byStrategyAll[k] = (byStrategyAll[k] || 0) + v;
    segResults.push({ sessionId: seg.sessionId, totalRecords: r.totalRecords, optimizableCount: r.optimizableCount, byStrategy: r.byStrategy });
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ mode: 'chain', chainSegments: live.length, brokenSegments: broken.length, totalRecords, optimizableCount: totalOptimizable, byStrategy: byStrategyAll, perSegment: segResults }, null, 2));
    return;
  }
  console.log(`\n📊 fork chain dead-context scan (${live.length} segments)`);
  console.log(`strategy: ${strategy}  |  total records: ${totalRecords}  |  optimizable: ${totalOptimizable}`);
  console.log('─'.repeat(70));
  for (const [strat, count] of Object.entries(byStrategyAll)) console.log(`  ${strat}: ${count}`);
  console.log('\nper segment:');
  for (const s of segResults) console.log(`  ${s.sessionId.slice(0, 8)}: ${s.optimizableCount}/${s.totalRecords} optimizable`);
}

/** Text report for a single-session scan result */
function printResult(result, strategy) {
  console.log(`\n📊 context optimizable-point scan`);
  console.log(`strategy: ${strategy}  |  total records: ${result.totalRecords}  |  optimizable: ${result.optimizableCount}`);
  console.log('─'.repeat(70));

  for (const [strat, count] of Object.entries(result.byStrategy)) {
    const labels = {
      'compact-summary-collapse': 'old messages already covered by the compact summary (safe to remove)',
      'metadata-dedup': 'duplicate metadata (normal Claude Code behavior, keep only the last one)',
      'progress-collapse': 'Progress events (~50% of the volume, removing does not affect the conversation)',
      'thinking-blocks': 'Thinking blocks (a normal product of extended thinking, can be removed to save tokens)',
      'tool-output-trim': 'large tool output (can be truncated)',
      'tool-result-age': 'stale tool results (>30 turns, low value)',
      'stale-reads': 'file reads superseded by a later edit',
      'system-reminder-dedup': 'duplicate system reminders',
      'orphaned-tool-results': 'orphaned tool_result',
      'large-base64': 'large base64 content (likely images)',
      'hook-noise': 'many hook events',
    };
    console.log(`  ${labels[strat] || strat}: ${count}`);
  }

  if (result.optimizableCount > 0) {
    console.log('\nTop 20 (removable content):');
    const top = result.findings.slice(0, 20);
    for (const f of top) {
      console.log(`  ℹ️  [${f.strategy}] index=${f.index} ${f.type}: ${f.message}`);
    }
    if (result.findings.length > 20) {
      console.log(`  ... ${result.findings.length - 20} more`);
    }
    console.log(`\n💡 All of the above is normal native session content, not errors.`);
    console.log(`   Removing them saves tokens, but not removing them does not affect resume.`);
  } else {
    console.log(`\n✅ no optimizable points`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--strategy', '--chain'],
    valueFlags: ['--strategy'],
    scriptName: 'dead-context',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`dead-context.js — Dead-context detection engine

Strategies:
  gentle      basic detection (compact-summary, metadata dedup, progress)
  standard    standard detection (+ thinking, tool output, stale reads, reminders) [default]
  aggressive  aggressive detection (+ orphaned tools, base64, hook noise)

Usage:
  recensa-session dead-context <session>                  accepts a path / UUID prefix / --latest
  recensa-session dead-context <session> --strategy aggressive
  recensa-session dead-context <session> --chain          scan along the fork chain, findings tagged by segment
  recensa-session dead-context <session> --json`);
    process.exit(0);
  }

  const strategyIdx = args.indexOf('--strategy');
  const strategy = strategyIdx >= 0 ? args[strategyIdx + 1] : 'standard';

  // An invalid --strategy value does not fall back silently: report an error + list valid values + exit != 0
  if (!Object.hasOwn(STRATEGIES, strategy)) {
    console.error(`❌ unknown strategy: ${strategy}`);
    console.error(`   valid values: ${Object.keys(STRATEGIES).join(', ')}`);
    process.exit(2);
  }

  // Accept UUID prefix / --latest (aligned with siblings for UX consistency)
  const { resolveFromArgs } = require('../lib/resolver');
  let filePath;
  try { filePath = resolveFromArgs(args).path; }
  catch { filePath = args.find(a => !a.startsWith('--')); }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`❌ Not found: ${filePath}`);
    process.exit(1);
  }

  // --chain (opt-in): scan along the fork chain segment by segment, merge findings (tag the segment source)
  if (args.includes('--chain')) {
    await runChainScan(args, strategy);
    return;
  }

  const result = await detectDeadContext(filePath, strategy);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printResult(result, strategy);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { detectDeadContext, STRATEGIES, DETECTORS };
