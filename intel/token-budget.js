#!/usr/bin/env node
/**
 * token-budget.js — Token budget tracking and analysis
 *
 * Does not depend on an external tokenizer (Claude 3+ has no official offline version).
 * Uses a character heuristic: English ~4 char/token, CJK ~1 char/token.
 * Also reads the exact API-reported token counts from the usage field of assistant messages.
 *
 * Usage:
 *   recensa-session token-budget <session.jsonl>                 full token report
 *   recensa-session token-budget <session.jsonl> --budget-view   budget view (simulates Claude Code /context)
 *   recensa-session token-budget <session.jsonl> --threshold 80  check whether it exceeds 80%
 *   recensa-session token-budget <session.jsonl> --per-turn      per-turn token breakdown
 *   recensa-session token-budget <session.jsonl> --waste         find token waste sources
 *
 * Programmatic use:
 *   const { analyzeBudget, estimateTokens } = require('./token-budget');
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { estimateTokens } = require('../lib/util');

function estimateMessageTokens(message) {
  // Estimate the token count of a fully formatted API message
  let tokens = 4; // role + structure overhead
  if (!message?.content) return tokens;

  const content = Array.isArray(message.content) ? message.content : [message.content];
  for (const block of content) {
    if (typeof block === 'string') {
      tokens += estimateTokens(block);
    } else if (block.type === 'text') {
      tokens += estimateTokens(block.text || '');
    } else if (block.type === 'tool_use') {
      tokens += 20 + estimateTokens(JSON.stringify(block.input || {}));
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
      tokens += estimateTokens(text);
    } else if (block.type === 'thinking') {
      tokens += estimateTokens(block.thinking || block.text || '');
    } else if (block.type === 'image') {
      tokens += 2000; // images ~2000 tokens fixed
    }
  }
  return tokens;
}

// ── Budget model (aligned with Claude Code's actual allocation) ──────────────────

// Fixed cost = the number of tokens the harness injects (system prompt / auto-memory / env / CLAUDE.md).
// Note: these are "content token counts", model-independent (the same CLAUDE.md is the same
// token count on any model), and do not scale with model "pricing" — pricing is handled by
// modelInputRate in cache-guard.
// The real drift axis is Anthropic changing harness prompt sizing (over time/versions), so an
// env override provides an escape hatch (calibrate after measuring).
// RECENSA_BUDGET_OVERRIDE='{"systemPrompt":5000,...}' can override any field.
const BUDGET_DEFAULTS = {
  contextWindow: 200000,
  systemPrompt: 4200,
  autoMemory: 680,
  environmentInfo: 280,
  mcpDeferred: 120,
  claudeMd: { min: 800, max: 2000, default: 1500 },
  maxOutputTokens: 20000, // buffer reserved for output
};

function loadBudgetModel() {
  const raw = process.env.RECENSA_BUDGET_OVERRIDE;
  if (!raw) return { ...BUDGET_DEFAULTS };
  try {
    const ov = JSON.parse(raw);
    return { ...BUDGET_DEFAULTS, ...ov, claudeMd: { ...BUDGET_DEFAULTS.claudeMd, ...ov.claudeMd } };
  } catch {
    process.stderr.write('⚠️  RECENSA_BUDGET_OVERRIDE is not valid JSON, ignored\n');
    return { ...BUDGET_DEFAULTS };
  }
}

const BUDGET_MODEL = loadBudgetModel();

// contextWindow can be overridden (for 1M context models); preferred value is detected from the model name
function resolveContextWindow(opts = {}) {
  if (opts.contextWindow) return opts.contextWindow;
  if (opts.detectedModels) {
    // 1M / 200K name-rule heuristic: contains "1m" / "-1m" / "long" -> 1M; otherwise -> 200K
    for (const m of opts.detectedModels) {
      if (!m) continue;
      const low = m.toLowerCase();
      if (low.includes('1m') || low.endsWith('-1m') || low.includes('long-context')) return 1_000_000;
    }
  }
  return BUDGET_MODEL.contextWindow;
}

function effectiveWindow(opts = {}) {
  const cw = resolveContextWindow(opts);
  return cw - Math.min(BUDGET_MODEL.maxOutputTokens, 20000);
}

function autoCompactThreshold(opts = {}) {
  return effectiveWindow(opts) - 13000;
}

function warningThreshold(opts = {}) {
  return effectiveWindow(opts) - 20000 - 13000;
}

function blockingLimit(opts = {}) {
  return effectiveWindow(opts) - 3000;
}

// ── Analysis engine ──────────────────────────────────────

// Extract plain text from user message content (for token estimation)
function userContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

// A user external prompt (not a tool_result) starts a new turn; covers external and legacy records without userType
function isTurnStart(record) {
  return record.type === 'user' &&
    !record.toolUseResult &&
    (record.userType === 'external' || record.userType === undefined);
}

function beginTurn(record, turnCount) {
  const currentTurn = {
    turn: turnCount,
    userTokens: 0,
    assistantTokens: 0,
    thinkingTokens: 0,
    toolOutputTokens: 0,
    apiInput: 0,
    apiOutput: 0,
    tools: [],
  };
  const content = record.message?.content;
  if (content) {
    currentTurn.userTokens = estimateTokens(userContentText(content));
  }
  return currentTurn;
}

// Dedup-detection key for a tool_use input
function toolCallKey(input) {
  if (input.file_path) return `file=${input.file_path}`;
  if (input.command) return `cmd=${String(input.command).slice(0, 80)}`;
  if (input.pattern) return `pat=${input.pattern}${input.path ? ' in ' + input.path : ''}`;
  if (input.query) return `q=${input.query.slice(0, 60)}`;
  return `(no-key)`;
}

// Accumulate a single assistant content block into currentTurn / result
function accumulateAssistantBlock(block, currentTurn, result) {
  if (block.type === 'text') {
    currentTurn.assistantTokens += estimateTokens(block.text || '');
  } else if (block.type === 'tool_use') {
    currentTurn.tools.push(block.name);
    currentTurn.assistantTokens += 20 + estimateTokens(JSON.stringify(block.input || {}));
    // Collect tool-call details for attribution (repeated-call detection)
    if (!result._toolCalls) result._toolCalls = [];
    result._toolCalls.push({ turn: currentTurn.turn, name: block.name, key: toolCallKey(block.input || {}) });
  } else if (block.type === 'thinking') {
    const t = estimateTokens(block.thinking || block.text || '');
    currentTurn.thinkingTokens += t;
    result.estimated.thinkingTokens += t;
  }
}

// Process an assistant record: usage stats + model collection + content blocks
function processAssistantBudget(record, currentTurn, result, detectedModels) {
  const msg = record.message;
  const usage = msg?.usage;
  if (msg?.model) detectedModels.add(msg.model);

  if (usage) {
    result.apiReported.input += usage.input_tokens || 0;
    result.apiReported.output += usage.output_tokens || 0;
    result.apiReported.cacheCreate += usage.cache_creation_input_tokens || 0;
    result.apiReported.cacheRead += usage.cache_read_input_tokens || 0;
    currentTurn.apiInput += usage.input_tokens || 0;
    currentTurn.apiOutput += usage.output_tokens || 0;
  }

  if (msg?.content && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      accumulateAssistantBlock(block, currentTurn, result);
    }
  }
}

// Tool output (user but userType is tool_result)
function accumulateToolResult(record, currentTurn, result) {
  const output = record.toolUseResult.output || '';
  const tokens = estimateTokens(typeof output === 'string' ? output : JSON.stringify(output));
  currentTurn.toolOutputTokens += tokens;
  result.estimated.toolOutputTokens += tokens;
}

function budgetStatus(effPct) {
  if (effPct >= 88.5) return 'critical';
  if (effPct >= 83.5) return 'autoCompact';
  if (effPct >= 73.5) return 'warning';
  if (effPct >= 50) return 'elevated';
  return 'normal';
}

// After the scan completes, compute total budget usage and status
function finalizeBudget(result, detectedModels, opts) {
  const historyTokens = result.turns.reduce((s, t) =>
    s + t.userTokens + t.assistantTokens + t.thinkingTokens, 0);
  const totalEstimated = result.fixedCosts.totalFixed +
    historyTokens + result.estimated.toolOutputTokens;
  result.estimated.totalInput = totalEstimated;
  // totalOutput used to always be 0. Aggregate assistant text + thinking + tool_use as the output estimate
  result.estimated.totalOutput = result.turns.reduce(
    (s, t) => s + t.assistantTokens + t.thinkingTokens, 0
  );
  // Compute using the detected model + the caller-overridden contextWindow
  const modelArr = [...detectedModels];
  result.detectedModels = modelArr;
  const ctxOpts = { detectedModels: modelArr, contextWindow: opts.contextWindow };
  const cw = resolveContextWindow(ctxOpts);
  const effWin = effectiveWindow(ctxOpts);
  result.budgetUsage.total = totalEstimated;
  result.budgetUsage.contextWindow = cw;
  result.budgetUsage.effectiveWindow = effWin;
  result.budgetUsage.percent = ((totalEstimated / cw) * 100);
  result.budgetUsage.effectivePercent = ((totalEstimated / effWin) * 100);
  // Keep ctxOpts for other functions
  result._ctxOpts = ctxOpts;
  // Budget status
  result.budgetUsage.status = budgetStatus(result.budgetUsage.effectivePercent);
}

// Digest one line: parse + split into turns + accumulate assistant/tool_result, advancing state (pure reorg, logic unchanged)
function ingestBudgetLine(line, state, result, detectedModels) {
  if (!line.trim()) return;
  try {
    const record = JSON.parse(line);

    // New turn boundary: a user message that is not a tool_result
    if (isTurnStart(record)) {
      if (state.currentTurn) result.turns.push(state.currentTurn);
      state.turnCount++;
      state.currentTurn = beginTurn(record, state.turnCount);
    }

    if (record.type === 'assistant' && state.currentTurn) {
      processAssistantBudget(record, state.currentTurn, result, detectedModels);
    }

    // Tool output (user but userType is tool_result)
    if (record.type === 'user' && record.toolUseResult && state.currentTurn) {
      accumulateToolResult(record, state.currentTurn, result);
    }

  } catch { /* skip non-JSON lines */ }
}

async function analyzeBudget(sessionPath, opts = {}) {
  // Collect all model names in the session for 1M context detection
  const detectedModels = new Set();
  const result = {
    sessionPath,
    detectedModels: detectedModels, // converted to array at the end
    // Fixed costs (estimated)
    fixedCosts: {
      systemPrompt: BUDGET_MODEL.systemPrompt,
      autoMemory: BUDGET_MODEL.autoMemory,
      environmentInfo: BUDGET_MODEL.environmentInfo,
      mcpDeferred: BUDGET_MODEL.mcpDeferred,
      claudeMd: BUDGET_MODEL.claudeMd.default,
      totalFixed: BUDGET_MODEL.systemPrompt + BUDGET_MODEL.autoMemory +
        BUDGET_MODEL.environmentInfo + BUDGET_MODEL.mcpDeferred + BUDGET_MODEL.claudeMd.default,
    },
    // Exact API-reported token stats
    apiReported: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    // Estimated stats
    estimated: { totalInput: 0, totalOutput: 0, thinkingTokens: 0, toolOutputTokens: 0 },
    // Per-turn
    turns: [],
    // Waste analysis
    waste: [],
    // Budget usage
    budgetUsage: { total: 0, percent: 0, status: 'normal' },
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const state = { currentTurn: null, turnCount: 0 };

  for await (const line of rl) {
    ingestBudgetLine(line, state, result, detectedModels);
  }
  rl.close();

  if (state.currentTurn) result.turns.push(state.currentTurn);

  finalizeBudget(result, detectedModels, opts);

  // Waste analysis
  if (opts.waste) {
    _analyzeWaste(result);
  }

  return result;
}

// Rough per-tool-call token estimate (conservative for Read/Edit/Bash)
function estPerCall(name) {
  if (name === 'Read') return 1500;
  if (name === 'Edit') return 1200;
  if (name === 'Bash') return 800;
  return 400;
}

// Repeated tool-call attribution (>= 3 calls with the same key counts as repeated)
function attributeRepeatedToolCalls(result) {
  if (!result._toolCalls || result._toolCalls.length === 0) return;
  const groups = new Map(); // key -> { name, count, turns, estTokens }
  for (const c of result._toolCalls) {
    const groupKey = `${c.name}|${c.key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { name: c.name, key: c.key, count: 0, turns: new Set() });
    const g = groups.get(groupKey);
    g.count++;
    g.turns.add(c.turn);
  }
  const repeats = [...groups.values()]
    .filter(g => g.count >= 3)
    .map(g => ({
      ...g,
      turns: [...g.turns].sort((a, b) => a - b),
      // Rough estimate: Read/Edit 1500 tokens each, Bash output 800, Grep 300 (conservative)
      estTokens: g.count * estPerCall(g.name),
    }))
    .sort((a, b) => b.estTokens - a.estTokens);
  for (const r of repeats.slice(0, 10)) {
    result.waste.push({
      type: 'repeated_tool_call',
      tool: r.name,
      key: r.key,
      count: r.count,
      turns: r.turns.slice(0, 5),
      tokens: r.estTokens,
      message: `${r.name} ×${r.count} ${r.key} @ turn ${r.turns.slice(0, 3).join(',')}${r.turns.length > 3 ? '...' : ''} ≈ ${r.estTokens.toLocaleString()} tokens`,
    });
  }
}

function _analyzeWaste(result) {
  const waste = result.waste;

  // Check 1: large tool output
  for (const turn of result.turns) {
    if (turn.toolOutputTokens > 5000) {
      waste.push({
        type: 'large_tool_output',
        turn: turn.turn,
        tokens: turn.toolOutputTokens,
        message: `turn ${turn.turn} tool output ${turn.toolOutputTokens} tokens (can be truncated)`,
      });
    }
  }

  // Check 2: thinking share too high
  if (result.estimated.thinkingTokens > result.estimated.totalInput * 0.2) {
    waste.push({
      type: 'excessive_thinking',
      tokens: result.estimated.thinkingTokens,
      message: `Thinking is ${((result.estimated.thinkingTokens / result.estimated.totalInput) * 100).toFixed(0)}% of input tokens`,
    });
  }

  // Check 3: cache efficiency
  if (result.apiReported.cacheCreate > 0 && result.apiReported.cacheRead === 0) {
    waste.push({
      type: 'cache_never_read',
      tokens: result.apiReported.cacheCreate,
      message: `wrote ${result.apiReported.cacheCreate} cache tokens but never read them`,
    });
  }

  // Check 4: output/input ratio
  const ratio = result.apiReported.output / Math.max(1, result.apiReported.input);
  if (ratio < 0.01 && result.apiReported.input > 100000) {
    waste.push({
      type: 'low_output_ratio',
      message: `Output/Input ratio is only ${(ratio * 100).toFixed(1)}% (possibly over-reading files)`,
    });
  }

  // Repeated tool-call attribution (>= 3 calls with the same key counts as repeated)
  attributeRepeatedToolCalls(result);
}

// ── CLI ────────────────────────────────────────────────────

const BUDGET_STATUS_ICONS = { critical: '🔴', autoCompact: '🟠', warning: '🟡' };
function budgetStatusIcon(status) {
  return BUDGET_STATUS_ICONS[status] || '🟢';
}

// --chain (opt-in): roll up each segment along the forkedFrom chain to reflect the true cost of the whole conversation
async function runChainRollup(args) {
  const { walkChain } = require('../lib/resolver');
  const input = args.find(a => !a.startsWith('--')) || '--latest';
  let chain;
  try { chain = walkChain(input); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  const live = chain.filter(c => c.path);
  const broken = chain.filter(c => c.missing);
  if (broken.length) console.error(`⚠️  chain broken: ${broken.map(c => c.sessionId.slice(0, 8)).join(', ')} (earlier segments missing, rollup excludes their cost)`);

  const cwIdx0 = args.indexOf('--context-window');
  const cwOverride = cwIdx0 >= 0 ? (Number.parseInt(args[cwIdx0 + 1]) || undefined) : undefined;
  const roll = {
    apiReported: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    estimated: { totalInput: 0, totalOutput: 0, thinkingTokens: 0, toolOutputTokens: 0 },
    turnCount: 0, segments: [], detectedModels: new Set(),
  };
  for (const seg of live) {
    const r = await analyzeBudget(seg.path, { contextWindow: cwOverride });
    for (const k of Object.keys(roll.apiReported)) roll.apiReported[k] += r.apiReported[k] || 0;
    for (const k of Object.keys(roll.estimated)) roll.estimated[k] += r.estimated[k] || 0;
    roll.turnCount += r.turns.length;
    (r.detectedModels || []).forEach(m => roll.detectedModels.add(m));
    roll.segments.push({ sessionId: seg.sessionId, turns: r.turns.length, apiInput: r.apiReported.input, apiOutput: r.apiReported.output });
  }
  console.log(JSON.stringify({
    mode: 'chain-rollup',
    chainSegments: live.length,
    brokenSegments: broken.length,
    detectedModels: [...roll.detectedModels],
    apiReportedRollup: roll.apiReported,
    estimatedRollup: roll.estimated,
    totalTurns: roll.turnCount,
    perSegment: roll.segments,
  }, null, 2));
}

// --context-window override (for 1M models or custom); reject NaN / 0 / negative
function parseContextWindowOverride(args) {
  const cwIdx = args.indexOf('--context-window');
  if (cwIdx < 0) return undefined;
  const raw = args[cwIdx + 1];
  const contextWindow = Number.parseInt(raw);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    console.error(`❌ token-budget: --context-window must be a positive integer (you gave "${raw}")`);
    process.exit(2);
  }
  return contextWindow;
}

function printBudgetView(result) {
  const bm = BUDGET_MODEL;
  const eff = effectiveWindow();
  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  Context Budget View                ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Context Window:  ${bm.contextWindow.toLocaleString()} tokens    ║`);
  console.log(`║  Effective:       ${eff.toLocaleString()} tokens    ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  [Fixed Costs]                      ║`);
  console.log(`║  System Prompt:    ${String(bm.systemPrompt).padStart(6)} tokens    ║`);
  console.log(`║  Auto Memory:      ${String(bm.autoMemory).padStart(6)} tokens    ║`);
  console.log(`║  Environment:      ${String(bm.environmentInfo).padStart(6)} tokens    ║`);
  console.log(`║  MCP (deferred):   ${String(bm.mcpDeferred).padStart(6)} tokens    ║`);
  console.log(`║  CLAUDE.md (est):  ${String(bm.claudeMd.default).padStart(6)} tokens    ║`);
  console.log(`║  Total Fixed:      ${String(result.fixedCosts.totalFixed).padStart(6)} tokens    ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  [Variable Costs]                   ║`);
  console.log(`║  History (est):   ${String(result.estimated.totalInput - result.fixedCosts.totalFixed).padStart(6)} tokens    ║`);
  console.log(`║  Total (est):     ${String(result.estimated.totalInput).padStart(6)} tokens    ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  [Thresholds]                       ║`);
  console.log(`║  Auto-Compact:   ${String(autoCompactThreshold()).padStart(6)} tokens    ║`);
  console.log(`║  Warning:        ${String(warningThreshold()).padStart(6)} tokens    ║`);
  console.log(`║  Blocking:       ${String(blockingLimit()).padStart(6)} tokens    ║`);
  console.log(`╠══════════════════════════════════════╣`);
  const statusIcon = budgetStatusIcon(result.budgetUsage.status);
  console.log(`║  Status: ${statusIcon} ${result.budgetUsage.status.padEnd(15)}          ║`);
  console.log(`║  Usage: ${result.budgetUsage.effectivePercent.toFixed(1)}% of effective window       ║`);
  console.log(`╚══════════════════════════════════════╝`);
}

// out-of-range warning
function warnPerTurnRange(fromTurn, toTurn, turnsLen, sessionTotalTurns) {
  if ((fromTurn !== null || toTurn !== null) && turnsLen === 0) {
    console.error(`⚠️  token-budget --per-turn: --from ${fromTurn} --to ${toTurn} matched 0 turns in range. This session has ${sessionTotalTurns} turns (user-prompt order). Run overview first to confirm totalTurns, then use a range.`);
  } else if (fromTurn !== null && fromTurn > sessionTotalTurns) {
    console.error(`⚠️  token-budget --per-turn: --from ${fromTurn} > totalTurns ${sessionTotalTurns} (user-prompt order)`);
  } else if (toTurn !== null && toTurn > sessionTotalTurns) {
    console.error(`⚠️  token-budget --per-turn: --to ${toTurn} > totalTurns ${sessionTotalTurns} (clamped to the last turn)`);
  }
}

function printPerTurnSum(turns) {
  const sum = turns.reduce((s, t) => ({
    userTokens: s.userTokens + t.userTokens,
    assistantTokens: s.assistantTokens + t.assistantTokens,
    thinkingTokens: s.thinkingTokens + t.thinkingTokens,
    toolOutputTokens: s.toolOutputTokens + t.toolOutputTokens,
    apiInput: s.apiInput + t.apiInput,
    apiOutput: s.apiOutput + t.apiOutput,
  }), { userTokens: 0, assistantTokens: 0, thinkingTokens: 0, toolOutputTokens: 0, apiInput: 0, apiOutput: 0 });
  console.log('-'.repeat(80));
  console.log(` SUM | ${String(sum.userTokens).padStart(8)} | ${String(sum.assistantTokens).padStart(8)} | ${String(sum.thinkingTokens).padStart(5)} | ${String(sum.toolOutputTokens).padStart(7)} | ${String(sum.apiInput).padStart(6)} | ${String(sum.apiOutput).padStart(7)} |`);
  console.log(`Replay estimate (API In + Out): ${(sum.apiInput + sum.apiOutput).toLocaleString()} tokens`);
}

function printPerTurn(args, result) {
  // range filter (aligned with archive --from-turn: user-prompt order)
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const fromTurn = fromIdx >= 0 ? Number.parseInt(args[fromIdx + 1]) || null : null;
  const toTurn = toIdx >= 0 ? Number.parseInt(args[toIdx + 1]) || null : null;
  const wantSum = args.includes('--sum');
  const sessionTotalTurns = result.turns.length;

  let turns = result.turns;
  if (fromTurn !== null) turns = turns.filter(t => t.turn >= fromTurn);
  if (toTurn !== null) turns = turns.filter(t => t.turn <= toTurn);
  // --heavy N filters the "highest token burn" turns (apiInput + apiOutput > N)
  const heavyIdx = args.indexOf('--heavy');
  const heavyThreshold = heavyIdx >= 0 ? Number.parseInt(args[heavyIdx + 1]) : null;
  if (heavyThreshold !== null && Number.isFinite(heavyThreshold) && heavyThreshold > 0) {
    turns = turns.filter(t => (t.apiInput + t.apiOutput) >= heavyThreshold);
  }

  warnPerTurnRange(fromTurn, toTurn, turns.length, sessionTotalTurns);

  const rangeLabel = (fromTurn !== null || toTurn !== null)
    ? `  (range: ${fromTurn ?? 'start'} → ${toTurn ?? 'end'}, ${turns.length} turns / total ${sessionTotalTurns})`
    : '';
  console.log(`Turn | User Est | Asst Est | Think | ToolOut | API In | API Out | Tools${rangeLabel}`);
  console.log('-'.repeat(80));
  for (const t of turns) {
    console.log(`${String(t.turn).padStart(4)} | ${String(t.userTokens).padStart(8)} | ${String(t.assistantTokens).padStart(8)} | ${String(t.thinkingTokens).padStart(5)} | ${String(t.toolOutputTokens).padStart(7)} | ${String(t.apiInput).padStart(6)} | ${String(t.apiOutput).padStart(7)} | ${t.tools.join(',')}`);
  }
  if (wantSum && turns.length > 0) {
    printPerTurnSum(turns);
  }
}

function printThreshold(args, result) {
  const thrIdx = args.indexOf('--threshold');
  const threshold = Number.parseInt(args[thrIdx + 1]) || 80;
  const usage = result.budgetUsage.effectivePercent;
  console.log(`${usage >= threshold ? '❌' : '✅'} Usage ${usage.toFixed(1)}% ${usage >= threshold ? 'over' : 'under'} the ${threshold}% threshold`);
  process.exit(usage >= threshold ? 1 : 0);
}

// --waste --attribute prints repeated tool-call details (root cause)
function printWasteAttribution(result) {
  console.log(`💸 Token Waste Attribution\n`);
  const repeats = result.waste.filter(w => w.type === 'repeated_tool_call');
  const others = result.waste.filter(w => w.type !== 'repeated_tool_call');
  if (repeats.length === 0) {
    console.log('✅ no repeated tool calls (>= 3 with the same key)');
  } else {
    console.log(`repeated tool calls top ${Math.min(repeats.length, 10)}:`);
    for (const r of repeats.slice(0, 10)) {
      console.log(`  - ${r.message}`);
    }
    const totalWaste = repeats.reduce((s, r) => s + r.tokens, 0);
    console.log(`  total: ~${totalWaste.toLocaleString()} tokens`);
  }
  if (others.length > 0) {
    console.log(`\nother waste types:`);
    for (const w of others) console.log(`  - [${w.type}] ${w.message}`);
  }
}

function printDefaultBudget(result) {
  console.log(JSON.stringify({
    sessionPath: result.sessionPath,
    fixedCosts: result.fixedCosts,
    apiReported: result.apiReported,
    estimated: result.estimated,
    budgetUsage: result.budgetUsage,
    thresholds: {
      effectiveWindow: effectiveWindow(),
      autoCompact: autoCompactThreshold(),
      warning: warningThreshold(),
      blocking: blockingLimit(),
    },
    turnCount: result.turns.length,
    waste: result.waste.length > 0 ? result.waste : undefined,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  // Added validator (missed by an earlier flag sweep)
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--budget-view', '--threshold', '--per-turn', '--waste', '--attribute', '--from', '--to', '--sum', '--context-window', '--heavy', '--chain'],
    valueFlags: ['--threshold', '--from', '--to', '--context-window'],
    scriptName: 'token-budget',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`token-budget.js — Token budget tracking and analysis

Usage:
  recensa-session token-budget <session.jsonl>                 full token report
  recensa-session token-budget <session.jsonl> --budget-view   budget view
  recensa-session token-budget <session.jsonl> --threshold 80  check whether it exceeds 80%
  recensa-session token-budget <session.jsonl> --per-turn      per-turn breakdown (add --from N / --to N to limit range, --sum to total, --heavy N to list only turns burning > N tokens)
  recensa-session token-budget <session.jsonl> --waste         waste analysis (add --attribute to print repeated tool-call details / root cause)
  recensa-session token-budget <session.jsonl> --context-window N  override the context window size (1M models or custom)
  recensa-session token-budget <session> --chain               aggregate tokens along the fork chain (rollup across compaction segments)`);
    process.exit(0);
  }

  // --chain (opt-in): roll up apiReported / estimated for each segment along the forkedFrom chain to reflect the true cost of the whole conversation
  if (args.includes('--chain')) {
    await runChainRollup(args);
    return;
  }

  const { resolveFromArgs } = require('../lib/resolver');
  let filePath;
  try {
    // Keep backward compatibility: originally accepted a bare path args[0]; now also supports UUID prefix / --latest (without breaking existing behavior)
    filePath = resolveFromArgs(args).path;
  } catch {
    filePath = args[0];
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`❌ file not found: ${filePath}`);
    process.exit(1);
  }

  require('../lib/resolver').hintChainIfForked(filePath, args);

  const contextWindow = parseContextWindowOverride(args);

  const result = await analyzeBudget(filePath, {
    waste: args.includes('--waste'),
    contextWindow,
  });
  // Report the detect result
  if (result.budgetUsage.contextWindow !== 200000) {
    const overrideNote = contextWindow ? ' / overridden by --context-window' : '';
    console.error(`ℹ️  context window: ${result.budgetUsage.contextWindow.toLocaleString()} tokens (detected from model: ${result.detectedModels.join(', ')}${overrideNote})`);
  }

  if (args.includes('--budget-view')) { printBudgetView(result); return; }
  if (args.includes('--per-turn')) { printPerTurn(args, result); return; }
  if (args.includes('--threshold')) { printThreshold(args, result); return; }
  if (args.includes('--waste') && args.includes('--attribute')) { printWasteAttribution(result); return; }

  // Default: full report
  printDefaultBudget(result);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyzeBudget, estimateTokens, estimateMessageTokens, BUDGET_MODEL, effectiveWindow, autoCompactThreshold, warningThreshold, blockingLimit };
