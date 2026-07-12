#!/usr/bin/env node
/**
 * session-archiver.js — Cross-session context exchange
 *
 * Capabilities:
 *   1. Extract the core context from session A (tasks, decisions, files)
 *   2. Inject it at the start of session B (as a context preamble)
 *   3. Merge the key information of multiple sessions
 *
 * Usage:
 *   recensa-session archive extract <session.jsonl>              extract core context
 *   recensa-session archive inject <context.json> <target.jsonl> inject context
 *   recensa-session archive merge <session1> <session2>          merge two session summaries
 *   recensa-session archive export <session.jsonl> --to dir/     export to a portable format
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SessionParser } = require('./session-parser');

// ── Core context extraction ──────────────────────────────

// turn range filter (turn = user external prompt order, aligned with token-budget --per-turn)
function collectMessagesInRange(parser, fromTurn, toTurn) {
  const hasTurnRange = fromTurn !== null || toTurn !== null;
  let userTurnCounter = 0;
  const messagesInRange = [];
  for (const msg of parser.messages) {
    // a user external prompt starts a new turn (aligned with token-budget)
    if (msg.role === 'user' && !msg.hasToolResult) userTurnCounter++;
    if (hasTurnRange) {
      if (fromTurn !== null && userTurnCounter < fromTurn) continue;
      if (toTurn !== null && userTurnCounter > toTurn) continue;
    }
    messagesInRange.push({ ...msg, turn: userTurnCounter });
  }
  return { messagesInRange, userTurnCounter, hasTurnRange };
}

// out-of-range warning
function warnTurnRange(hasTurnRange, fromTurn, toTurn, messagesInRange, userTurnCounter) {
  if (!hasTurnRange) return;
  if (messagesInRange.length === 0) {
    console.error(`⚠️  archive: --from-turn ${fromTurn} --to-turn ${toTurn} matched 0 messages in range. This session has ${userTurnCounter} turns (user-prompt order). Run overview first to confirm totalTurns, then use a range.`);
  } else if (fromTurn !== null && fromTurn > userTurnCounter) {
    console.error(`⚠️  archive: --from-turn ${fromTurn} > totalTurns ${userTurnCounter} (user-prompt order), no data`);
  } else if (toTurn !== null && toTurn > userTurnCounter) {
    console.error(`⚠️  archive: --to-turn ${toTurn} > totalTurns ${userTurnCounter} (clamped to the last turn)`);
  }
}

// Sum the token usage of a group of messages
function sumTokenUsage(messages) {
  return messages.reduce((acc, m) => {
    const u = m.tokenUsage;
    if (u) {
      acc.input += u.input_tokens || 0;
      acc.output += u.output_tokens || 0;
      acc.cacheCreate += u.cache_creation_input_tokens || 0;
      acc.cacheRead += u.cache_read_input_tokens || 0;
    }
    return acc;
  }, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
}

// Build the context skeleton (with segment vs whole-session field switching in turnRange mode)
function buildContextSkeleton(parser, sessionPath, r) {
  const { hasTurnRange, fromTurn, toTurn, messagesInRange, userTurnCounter } = r;
  return {
    source: sessionPath,
    sessionId: parser.stats.sessionId,
    turnRange: hasTurnRange ? { from: fromTurn, to: toTurn, messageCount: messagesInRange.length, totalTurns: userTurnCounter, turnUnit: 'user-prompt' } : null,
    extractedAt: new Date().toISOString(),
    // Compute duration from timestamps (parser.stats has no durationMs, previously undefined -> JSON null)
    duration: (parser.stats.firstTimestamp && parser.stats.lastTimestamp)
      ? new Date(parser.stats.lastTimestamp).getTime() - new Date(parser.stats.firstTimestamp).getTime()
      : 0,
    // Model and cost (in turnRange mode scoped to the segment; whole-session values stored separately in sessionTotal)
    model: hasTurnRange
      ? [...new Set(messagesInRange.filter(m => m.model && m.model !== '<synthetic>').map(m => m.model))]
      : [...parser.stats.models].filter(m => m !== '<synthetic>'),
    tokenUsage: hasTurnRange ? sumTokenUsage(messagesInRange) : parser.stats.tokenUsage,
    sessionTotal: hasTurnRange ? {
      model: [...parser.stats.models].filter(m => m !== '<synthetic>'),
      tokenUsage: parser.stats.tokenUsage,
      totalTurns: userTurnCounter,
    } : null,
    // Task summary (inferred from agent progress and user messages)
    tasks: [],
    // Explicit user requests
    userRequests: [],
    // Key decisions (segments extracted from assistant text containing decision markers)
    decisions: [],
    // Modified files
    filesModified: [],
    // Last few exchanges (used to restore context)
    lastExchanges: [],
    // Tool usage overview
    toolsUsed: parser.stats.toolUsage,
    // compact count (how many times the session was compacted)
    compactCount: parser.stats.compactCount,
  };
}

// Extract the snippet near the first decision keyword from assistant text
function extractDecisions(msg, context, decisions) {
  for (const marker of decisions) {
    if (msg.text.includes(marker)) {
      const idx = msg.text.indexOf(marker);
      const snippet = msg.text.slice(Math.max(0, idx - 20), idx + 100);
      context.decisions.push(snippet);
      break;
    }
  }
}

// Extract lines containing a task keyword from assistant text
function extractTasks(msg, context, taskMarkers) {
  for (const marker of taskMarkers) {
    if (msg.text.toLowerCase().includes(marker.toLowerCase())) {
      const lines = msg.text.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(marker.toLowerCase()) && line.length > 20) {
          context.tasks.push(line.trim().slice(0, 200));
        }
      }
      break;
    }
  }
}

// Extract structured info from messages (user requests / decisions / tasks / last exchanges)
function extractStructuredInfo(sourceMessages, context) {
  // Decision / task cues scanned from free-text assistant narration (no structural marker) → English only.
  const decisions = ['decided', 'chose', 'chosen', 'went with', 'switch to', 'switched to', 'replace', 'merge', 'split', 'refactor'];
  const taskMarkers = ['fix', 'add', 'implement', 'refactor', 'optimize', 'debug', 'investigate', 'remove', 'migrate'];
  for (const msg of sourceMessages) {
    // User requests
    if (msg.role === 'user' && msg.text && msg.text.length > 10) {
      const isReal = !msg.text.startsWith('tool_use_id') &&
                     !msg.text.includes('[Request interrupted') &&
                     !msg.text.includes('session is being continued');
      if (isReal) {
        context.userRequests.push(msg.text.slice(0, 300));
      }
    }

    // Assistant decisions
    if (msg.role === 'assistant' && msg.text) {
      extractDecisions(msg, context, decisions);
      extractTasks(msg, context, taskMarkers);
    }

    // Last 5 exchanges
    if (msg.role === 'user' || msg.role === 'assistant') {
      context.lastExchanges.push({
        role: msg.role,
        text: (msg.text || '').slice(0, 300),
        timestamp: msg.timestamp,
      });
    }
  }
}

/**
 * Extract a structured context summary from a session.
 * Includes: task goals, key decisions, modified files, last state
 */
async function extractContext(sessionPath, opts = {}) {
  const parser = new SessionParser(sessionPath, {
    progressFilter: 'summary',
    includeThinking: false,
  });

  await parser.stream();

  const fromTurn = opts.fromTurn || null;
  const toTurn = opts.toTurn || null;
  const range = collectMessagesInRange(parser, fromTurn, toTurn);
  warnTurnRange(range.hasTurnRange, fromTurn, toTurn, range.messagesInRange, range.userTurnCounter);

  const context = buildContextSkeleton(parser, sessionPath, { ...range, fromTurn, toTurn });

  // If a turn range is given -> use the filtered messagesInRange
  const sourceMessages = range.hasTurnRange ? range.messagesInRange : parser.messages;
  extractStructuredInfo(sourceMessages, context);

  // Keep only the last 10 exchanges
  context.lastExchanges = context.lastExchanges.slice(-10);
  // Dedupe
  context.tasks = [...new Set(context.tasks)].slice(0, 20);
  context.decisions = [...new Set(context.decisions)].slice(0, 10);

  return context;
}

// ── Context injection ────────────────────────────────────

/**
 * Produce a new JSONL session file, injecting context as a preamble.
 * Note: this does not modify the original session, it produces a new file.
 *
 * @param {object} context - the context obtained from extractContext
 * @param {string} outputPath - output path
 */
function injectContext(context, outputPath) {
  // Inject the context as a system message, followed by a boundary marker
  const lines = [];
  lines.push(JSON.stringify({
    type: 'system',
    subtype: 'injected_context',
    timestamp: new Date().toISOString(),
    sessionId: 'context-injection',
    contextSource: context.source,
    contextSessionId: context.sessionId,
    message: {
      role: 'system',
      content: [
        {
          type: 'text',
          text: `[Cross-session context injection — source: ${context.sessionId}]

## Task background
${context.tasks.slice(0, 10).map((t, i) => `${i + 1}. ${t}`).join('\n')}

## User requests
${context.userRequests.slice(0, 5).map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Key decisions
${context.decisions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

## Tool usage
${Object.entries(context.toolsUsed).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Last interactions
${context.lastExchanges.slice(-5).map(e =>
  `[${e.role === 'user' ? 'User' : 'Claude'}]: ${e.text?.slice(0, 200)}`).join('\n\n')}

## Technical info
- Model: ${context.model.join(', ')}
- Token: input ${context.tokenUsage.input} / output ${context.tokenUsage.output}
- Duration: ${(context.duration / 60000).toFixed(0)} min
- Compactions: ${context.compactCount}
`,
        },
      ],
    },
  }),
  // Boundary marker
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: new Date().toISOString(),
    sessionId: 'context-injection',
    compact_metadata: { trigger: 'manual_context_injection' },
  }));

  const output = lines.join('\n') + '\n';
  fs.writeFileSync(outputPath, output, 'utf8');
  return outputPath;
}

// ── Merge multi-session summaries ────────────────────────

async function mergeContexts(sessionPaths) {
  const contexts = [];
  for (const sp of sessionPaths) {
    contexts.push(await extractContext(sp));
  }

  const merged = {
    sources: contexts.map(c => c.sessionId),
    totalDuration: contexts.reduce((s, c) => s + c.duration, 0),
    allModels: [...new Set(contexts.flatMap(c => c.model))],
    totalTokens: contexts.reduce((s, c) => ({
      input: s.input + c.tokenUsage.input,
      output: s.output + c.tokenUsage.output,
      cacheCreate: s.cacheCreate + c.tokenUsage.cacheCreate,
      cacheRead: s.cacheRead + c.tokenUsage.cacheRead,
    }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }),
    commonTasks: _findCommon(contexts.map(c => c.tasks)),
    commonDecisions: _findCommon(contexts.map(c => c.decisions)),
    allUserRequests: contexts.flatMap(c => c.userRequests),
    perSession: contexts.map(c => ({
      sessionId: c.sessionId,
      duration: c.duration,
      taskCount: c.tasks.length,
      model: c.model,
      tokenUsage: c.tokenUsage,
    })),
  };

  return merged;
}

function _findCommon(arrays) {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return arrays[0];
  // Find tasks appearing in at least 2 sessions
  const freq = {};
  for (const arr of arrays) {
    for (const item of new Set(arr)) {
      freq[item] = (freq[item] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .map(([item]) => item);
}

// ── CLI ────────────────────────────────────────────────────

async function cmdExtract(args) {
  const sessionPath = args[1];
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.error('❌ please provide a valid session JSONL path');
    process.exit(1);
  }
  const fromTurnIdx = args.indexOf('--from-turn');
  const toTurnIdx = args.indexOf('--to-turn');
  const fromTurn = fromTurnIdx >= 0 ? Number.parseInt(args[fromTurnIdx + 1]) || null : null;
  const toTurn = toTurnIdx >= 0 ? Number.parseInt(args[toTurnIdx + 1]) || null : null;
  // Reject from > to / negative
  if (fromTurn !== null && fromTurn < 0) {
    console.error(`❌ archive: --from-turn must be non-negative (you gave ${fromTurn})`);
    process.exit(2);
  }
  if (toTurn !== null && toTurn < 0) {
    console.error(`❌ archive: --to-turn must be non-negative (you gave ${toTurn})`);
    process.exit(2);
  }
  if (fromTurn !== null && toTurn !== null && fromTurn > toTurn) {
    console.error(`❌ archive: --from-turn ${fromTurn} > --to-turn ${toTurn} (reversed)`);
    console.error(`   valid range: from <= to`);
    process.exit(2);
  }
  const context = await extractContext(sessionPath, { fromTurn, toTurn });

  const outputIdx = args.indexOf('--output');
  if (outputIdx >= 0) {
    fs.writeFileSync(args[outputIdx + 1], JSON.stringify(context, null, 2), 'utf8');
    console.error(`✅ context written to: ${args[outputIdx + 1]}`);
  } else {
    console.log(JSON.stringify(context, null, 2));
  }
}

function cmdInject(args) {
  const contextPath = args[1];
  const outputIdxInject = args.indexOf('--output');
  let outputPath;
  if (outputIdxInject >= 0) outputPath = args[outputIdxInject + 1];
  else if (args[2] && !args[2].startsWith('--')) outputPath = args[2];
  else outputPath = 'injected-context.jsonl';
  if (!contextPath || !fs.existsSync(contextPath)) {
    console.error('❌ please provide a valid context JSON path');
    process.exit(1);
  }
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const result = injectContext(context, outputPath);
  console.error(`✅ context injection complete: ${result}`);
}

async function cmdMerge(args) {
  // positional args must skip --output and its value, otherwise it is treated as a source jsonl and throws ENOENT
  const VALUE_FLAGS = new Set(['--output']);
  const sessionPaths = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    sessionPaths.push(a);
  }
  if (sessionPaths.length < 2) {
    console.error('❌ please provide at least 2 session paths');
    process.exit(1);
  }
  const merged = await mergeContexts(sessionPaths);
  const outputIdxMerge = args.indexOf('--output');
  if (outputIdxMerge >= 0) {
    const outPath = args[outputIdxMerge + 1];
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
    console.error(`✅ merged result written to: ${outPath}`);
  } else {
    console.log(JSON.stringify(merged, null, 2));
  }
}

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags (--output should be allowed in every subcommand + value-skip)
  const { validateArgs } = require('../lib/argv');
  validateArgs(args.slice(1), {
    known: ['--output', '--from-turn', '--to-turn'],
    valueFlags: ['--output', '--from-turn', '--to-turn'],
    scriptName: 'archive',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-archiver.js — Cross-session context exchange

Usage:
  recensa-session archive extract <session.jsonl>              extract core context
  recensa-session archive inject <context.json> <target.jsonl> inject context
  recensa-session archive merge <s1.jsonl> <s2.jsonl> [...]    merge multi-session summaries
  recensa-session archive extract <s.jsonl> --output ctx.json  write to a file
  recensa-session archive extract <s.jsonl> --from-turn 234 --to-turn 280
                                                                 extract only turns 234-280 (use token-budget --per-turn to see turn numbers)`);
    process.exit(0);
  }

  const cmd = args[0];
  if (cmd === 'extract') await cmdExtract(args);
  else if (cmd === 'inject') cmdInject(args);
  else if (cmd === 'merge') await cmdMerge(args);
  else {
    console.error(`❌ unknown command: ${cmd}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { extractContext, injectContext, mergeContexts };
