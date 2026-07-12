#!/usr/bin/env node
/**
 * cache-guard.js — Prompt cache killer detection
 *
 * Scan a session JSONL and mark every cache invalidation event.
 * Based on the five common prompt-cache killers:
 *
 *   1. Editing CLAUDE.md — a Write/Edit to CLAUDE.md invalidates all subsequent cache
 *   2. Dynamic timestamp/UUID in the prefix — a different ID per request -> cache = 0
 *   3. Model switch — each model has its own cache
 *   4. /compact with a different system prompt — post-compaction requests miss cache
 *   5. /resume minor structural differences — serialization introduces invisible diffs
 *
 * Usage:
 *   recensa-session cache-guard <session.jsonl>                  full cache event timeline
 *   recensa-session cache-guard <session.jsonl> --timeline        timeline view
 *   recensa-session cache-guard <session.jsonl> --cost-impact     estimate the extra cost of cache misses
 *   recensa-session cache-guard <session.jsonl> --json            JSON output
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { estimateTokens } = require('../lib/util');

// ── Detection rules ──────────────────────────────────────

const CLAUDE_MD_PATTERNS = [
  /CLAUDE\.md$/i,
  /\.claude\/CLAUDE\.md$/i,
  /CLAUDE\.local\.md$/i,
  /\.claude\/rules\//i,
  /memory\/MEMORY\.md$/i,
];

function isClaudeMdFile(filePath) {
  return CLAUDE_MD_PATTERNS.some(p => p.test(filePath));
}

// ── Individual detectors (called per record during the scan; call order is side-effect order) ──

function detectModelSwitch(record, state, events, turnIdx, lineNum) {
  // Track the model (filter out <synthetic> — a harness-synthesized message that hits no API and does not affect cache)
  const model = record.message?.model;
  const isSynthetic = model === '<synthetic>';
  if (!isSynthetic && model && state.currentModel && model !== state.currentModel) {
    state.modelSwitchCount++;
    events.push({
      turn: turnIdx,
      type: 'model_switch',
      from: state.currentModel,
      to: model,
      impact: 'full_cache_reset',
      message: `model switched from ${state.currentModel} to ${model} — all cache invalidated`,
      line: lineNum,
    });
    state.status = 'cold';
  }
  // <synthetic> does not update currentModel (otherwise the next real model would be misread as "switching back from synthetic")
  if (!isSynthetic && model) state.currentModel = model;
}

function trackUsage(usage, state, events, turnIdx, lineNum) {
  if (!usage) return;
  state.totalApiInputTokens += usage.input_tokens || 0;
  state.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
  state.totalCacheCreateTokens += usage.cache_creation_input_tokens || 0;

  // Was there a cache hit this turn?
  if (turnIdx > 1) {
    const hadCacheRead = (usage.cache_read_input_tokens || 0) > 0;
    if (!hadCacheRead && state.status === 'warm' && (usage.input_tokens || 0) > 5000) {
      events.push({
        turn: turnIdx,
        type: 'cache_miss',
        inputTokens: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens || 0,
        message: `turn ${turnIdx} cache miss — ${usage.input_tokens.toLocaleString()} input tokens billed in full`,
        line: lineNum,
      });
      state.status = 'degraded';
    } else if (hadCacheRead) {
      state.status = 'warm'; // cache recovered
    }
  }
}

function detectClaudeMdMods(record, state, events, turnIdx, lineNum) {
  // Detect CLAUDE.md edits in tool_use
  if (!Array.isArray(record.message?.content)) return;
  for (const block of record.message.content) {
    if (block.type === 'tool_use' && ['Write', 'Edit'].includes(block.name)) {
      const fp = block.input?.file_path || block.input?.filePath;
      if (fp && isClaudeMdFile(fp)) {
        state.claudeMdModifiedAt = turnIdx;
        events.push({
          turn: turnIdx,
          type: 'claude_md_modified',
          tool: block.name,
          filePath: fp,
          impact: 'all_subsequent_cache_invalidated',
          message: `${block.name} edited ${fp} — all cache invalidated from the next turn onward`,
          line: lineNum,
        });
        state.status = 'cold';
      }
    }
  }
}

function handleAssistantRecord(record, state, events, lineNum) {
  state.turnCount++;
  const turnIdx = state.turnCount;
  detectModelSwitch(record, state, events, turnIdx, lineNum);
  trackUsage(record.message?.usage, state, events, turnIdx, lineNum);
  detectClaudeMdMods(record, state, events, turnIdx, lineNum);
}

// ── Detect /compact (including microcompact_boundary) ──
function handleCompactRecord(record, state, events, lineNum) {
  if (record.type !== 'system' || !/compact_boundary/.test(record.subtype || '')) return;
  state.compactCount++;
  events.push({
    turn: state.turnCount,
    type: 'compact_boundary',
    count: state.compactCount,
    impact: 'conversation_cache_reset',
    message: `compact #${state.compactCount} — conversation-layer cache reset (system prompt + project layer still retained)`,
    line: lineNum,
  });
  // After a compact the cache partially recovers: system + project layers are retained
  if (state.status === 'cold') {
    state.status = 'degraded';
  }
}

// ── Main scan ────────────────────────────────────────────

async function scanSession(sessionPath) {
  const events = [];
  const cacheState = {
    status: 'warm', // warm | degraded | cold
    invalidations: [],
    currentModel: null,
    claudeMdModifiedAt: null,
    compactCount: 0,
    modelSwitchCount: 0,
    turnCount: 0,
    totalApiInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    estimatedWastedTokens: 0,
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    try {
      const record = JSON.parse(line);
      // ── Track turns ──
      if (record.type === 'assistant') handleAssistantRecord(record, cacheState, events, lineNum);
      // ── Detect /compact ──
      handleCompactRecord(record, cacheState, events, lineNum);
    } catch { /* skip non-JSON lines */ }
  }
  rl.close();

  // ── Cost estimation ──
  const cacheHitRate = cacheState.totalApiInputTokens > 0
    ? cacheState.totalCacheReadTokens / (cacheState.totalApiInputTokens + cacheState.totalCacheReadTokens)
    : 0;

  // Estimate waste: on a cache miss, the input tokens would only cost 10% if they had hit cache
  // Price by the detected model (not hardcoded Sonnet) — Opus ~= 5x Sonnet, Haiku ~= 1/3
  const estimatedWasted = _estimateWastedCost(events, cacheState, modelInputRate(cacheState.currentModel));

  return {
    sessionPath,
    turns: cacheState.turnCount,
    cacheState: {
      modelSwitches: cacheState.modelSwitchCount,
      claudeMdModified: cacheState.claudeMdModifiedAt !== null,
      claudeMdModifiedAtTurn: cacheState.claudeMdModifiedAt,
      compactCount: cacheState.compactCount,
      // 0 turns should show empty rather than the default warm (cache was never established)
      finalStatus: cacheState.turnCount === 0 ? 'empty' : cacheState.status,
    },
    metrics: {
      cacheHitRate: (cacheHitRate * 100).toFixed(1) + '%',
      totalInputTokens: cacheState.totalApiInputTokens,
      totalCacheReadTokens: cacheState.totalCacheReadTokens,
      totalCacheCreateTokens: cacheState.totalCacheCreateTokens,
      estimatedWastedCost: estimatedWasted,
    },
    events,
  };
}

// Return the input price per token (USD) for the detected model name. Unknown -> fall back to the Sonnet baseline.
// Order-of-magnitude alignment (not live pricing): Opus ~5x, Haiku ~1/4 of Sonnet $3/M.
function modelInputRate(model) {
  const SONNET = 3 / 1_000_000;
  if (!model) return SONNET;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 15 / 1_000_000;
  if (m.includes('haiku')) return 0.8 / 1_000_000;
  return SONNET; // sonnet / unknown
}

// Extra waste estimate for turns after a CLAUDE.md edit that were not accounted for per-turn
function _claudeMdExtraWaste(state, accountedTurns, cacheDiscount, rate) {
  if (!state.claudeMdModifiedAt) return 0;
  const turnsAfter = state.turnCount - state.claudeMdModifiedAt;
  if (turnsAfter <= 0 || state.totalApiInputTokens <= 0) return 0;
  const avgInput = state.totalApiInputTokens / Math.max(1, state.turnCount);
  // Subtract the turns already counted in the per-turn loop
  let uncountedTurnsAfter = 0;
  for (let t = state.claudeMdModifiedAt + 1; t <= state.turnCount; t++) {
    if (!accountedTurns.has(t)) uncountedTurnsAfter++;
  }
  const extraWaste = uncountedTurnsAfter * avgInput * (1 - cacheDiscount);
  return extraWaste * rate;
}

function _estimateWastedCost(events, state, inputRate) {
  let wasted = 0;
  const CACHE_DISCOUNT = 0.1; // a cache read is 10% of input
  const SONNET_INPUT_RATE = inputRate || (3 / 1_000_000);

  // Record the turns already accounted per-turn to avoid double-counting in the total estimate
  const accountedTurns = new Set();

  for (const event of events) {
    if (event.type === 'cache_miss' && event.inputTokens) {
      const wastedTokens = event.inputTokens * (1 - CACHE_DISCOUNT);
      wasted += wastedTokens * SONNET_INPUT_RATE;
      if (event.turn) accountedTurns.add(event.turn);
    }
  }

  // If CLAUDE.md was edited, only the subsequent turns not accounted per-turn need extra counting
  wasted += _claudeMdExtraWaste(state, accountedTurns, CACHE_DISCOUNT, SONNET_INPUT_RATE);

  return Math.round(wasted * 10000) / 10000; // 4 decimal places
}

// ── CLI ────────────────────────────────────────────────────

const CACHE_EVENT_ICONS = {
  model_switch: '🔄',
  claude_md_modified: '📝',
  compact_boundary: '🗜️',
  cache_miss: '❄️',
};

function printTimeline(result) {
  console.log(`🗺️  Cache timeline (${result.turns} turns)\n`);
  if (result.events.length === 0) {
    console.log('  ✅  no cache invalidation events detected');
    return;
  }
  const iconFor = (t) => CACHE_EVENT_ICONS[t] || '·';
  for (const e of result.events) {
    const turn = String(e.turn || '?').padStart(4);
    const line = e.line ? `L${String(e.line).padStart(5)}` : '     ';
    console.log(`${iconFor(e.type)} Turn ${turn}  ${line}  [${e.type}]`);
    console.log(`     ${e.message}`);
    if (e.from && e.to) console.log(`     ${e.from} → ${e.to}`);
    if (e.filePath) console.log(`     File: ${e.filePath}`);
    console.log('');
  }
  // Summary
  const byType = {};
  for (const e of result.events) byType[e.type] = (byType[e.type] || 0) + 1;
  const summary = Object.entries(byType).map(([t, c]) => `${t}×${c}`).join(' | ');
  console.log(`📊 Summary: ${summary}`);
}

function printCostImpact(result) {
  console.log(`💰 Estimated cache miss cost\n`);
  console.log(`Cache Hit Rate:     ${result.metrics.cacheHitRate}`);
  console.log(`Cache Read Tokens:  ${result.metrics.totalCacheReadTokens.toLocaleString()}`);
  console.log(`Total Input Tokens: ${result.metrics.totalInputTokens.toLocaleString()}`);
  console.log(`Estimated waste:    $${result.metrics.estimatedWastedCost.toFixed(4)} (at Sonnet $3/MTok)`);

  if (result.cacheState.claudeMdModified) {
    console.log(`\n⚠️  CLAUDE.md was edited at turn ${result.cacheState.claudeMdModifiedAtTurn} — cache fully invalidated for the following ${result.turns - result.cacheState.claudeMdModifiedAtTurn} turns`);
  }
  if (result.cacheState.modelSwitches > 0) {
    console.log(`⚠️  ${result.cacheState.modelSwitches} model switches — each switch fully resets the cache`);
  }
  if (result.cacheState.compactCount > 0) {
    console.log(`ℹ️  ${result.cacheState.compactCount} compacts — conversation-layer cache reset (system/project layers retained)`);
  }
}

function printDefaultReport(result, filePath) {
  const cs = result.cacheState;
  const path = require('node:path');
  console.log(`\n🔍 Cache Guard report\n`);
  console.log(`Session: ${path.basename(filePath, '.jsonl').slice(0, 16)}...`);
  console.log(`Total turns: ${result.turns}  |  Cache status: ${cs.finalStatus}`);
  console.log(`Cache Hit Rate: ${result.metrics.cacheHitRate}`);
  console.log('─'.repeat(50));

  const icon = (count) => count > 0 ? '⚠️' : '✅';
  const claudeMdInfo = cs.claudeMdModified ? `turn ${cs.claudeMdModifiedAtTurn}` : 'none';
  console.log(`${icon(cs.modelSwitches)}  Model switches: ${cs.modelSwitches}`);
  console.log(`${icon(cs.claudeMdModified ? 1 : 0)}  CLAUDE.md edited: ${claudeMdInfo}`);
  console.log(`${cs.compactCount > 2 ? '⚠️' : '✅'}  Compact: ${cs.compactCount}`);
  console.log(`💰  Estimated cache miss cost: $${result.metrics.estimatedWastedCost.toFixed(4)}`);

  if (result.events.length > 0) {
    console.log(`\n📋 Event list (${result.events.length}):`);
    for (const e of result.events) {
      console.log(`  [turn ${e.turn}] ${e.type}: ${e.message}`);
    }
  } else {
    console.log(`\n✅ no cache invalidation detected`);
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags (cache-guard does not support --since/--until — whole-session cache health analysis is what makes sense)
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--timeline', '--cost-impact'],
    valueFlags: [],
    scriptName: 'cache-guard',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`cache-guard.js — Prompt cache killer detection

Usage:
  recensa-session cache-guard <session.jsonl|--latest|UUID>   full report (supports --latest / --session-id / UUID prefix)
  recensa-session cache-guard <session.jsonl> --timeline        timeline view
  recensa-session cache-guard <session.jsonl> --cost-impact     cost impact
  recensa-session cache-guard <session.jsonl> --json            JSON output`);
    process.exit(0);
  }

  let filePath;
  try {
    filePath = require('../lib/resolver').resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const result = await scanSession(filePath);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.includes('--timeline')) { printTimeline(result); return; }
  if (args.includes('--cost-impact')) { printCostImpact(result); return; }

  // Default: full report
  printDefaultReport(result, filePath);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { scanSession };
