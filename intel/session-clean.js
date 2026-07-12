#!/usr/bin/env node
/**
 * session-clean.js — Session JSONL cleanup / filter / slimming
 *
 * Removes unnecessary content from a huge session JSONL, keeping the conversation core:
 *   - remove progress events (usually 50%+ of the volume)
 *   - truncate / remove large tool outputs (bash/read/write results)
 *   - remove thinking blocks
 *   - remove system reminder / hook messages
 *   - preserve UUID chain integrity (so --resume still works)
 *
 * Usage:
 *   recensa-session clean <input.jsonl>                         output the slimmed version to stdout
 *   recensa-session clean <input.jsonl> --output clean.jsonl    write to a file
 *   recensa-session clean <input.jsonl> --aggressive            most aggressive cleanup
 *   recensa-session clean <input.jsonl> --keep-tools            keep tool names but truncate output
 *   recensa-session clean <input.jsonl> --max-output 500        max tool-output char count
 *   recensa-session clean <input.jsonl> --dry-run               report only, no output
 *
 * Cleanup strategies:
 *   safe:      keep all conversation + tool names, truncate tool output > 2000 chars
 *   moderate:  remove progress + system, truncate tool output > 500 chars
 *   aggressive: keep only user/assistant text conversation, remove all tool interactions
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

// ── Filter rules ─────────────────────────────────────────

const STRATEGIES = {
  safe: {
    removeTypes: new Set([
      'progress',           // legacy <=v2.1.16x (~51% of volume then); no longer written in v2.1.17x+, kept for cleaning old files
      'queue-operation',
    ]),
    removeSubtypes: new Set([]),
    maxToolOutput: 2000,
    truncateToolOutput: true,
    removeThinking: false,
    removeSystemReminders: false,
    removeHookMessages: false,
  },
  moderate: {
    removeTypes: new Set([
      'progress',
      'queue-operation',
      'hook_progress',
    ]),
    removeSubtypes: new Set([
      'hook_progress',
      'todo_reminder',
    ]),
    maxToolOutput: 500,
    truncateToolOutput: true,
    removeThinking: true,
    removeSystemReminders: true,
    removeHookMessages: true,
  },
  aggressive: {
    removeTypes: new Set([
      'progress',
      'queue-operation',
      'system',
      'file-history-snapshot',
      'attribution-snapshot',
      'marble-origami-commit',
      'marble-origami-snapshot',
      'content-replacement',
    ]),
    removeSubtypes: new Set([
      'hook_progress',
      'todo_reminder',
      'critical_system_reminder',
    ]),
    maxToolOutput: 200,
    truncateToolOutput: true,
    removeThinking: true,
    removeSystemReminders: true,
    removeHookMessages: true,
    textOnly: true, // remove all tool_use blocks, keep plain text only
  },
};

// ── Decide whether a tool output is worth keeping ────────

const IMPORTANT_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'Task',       // task tracking
  'Write', 'Edit',                          // code edits
  'EnterPlanMode', 'ExitPlanMode',          // planning mode
]);

function isToolOutputImportant(toolName) {
  return IMPORTANT_TOOLS.has(toolName);
}

// ── Core cleanup functions ───────────────────────────────

// Decide whether to remove the whole record (type / subtype / system reminder / hook message)
function shouldRemoveRecord(record, type, rules, stats) {
  // ── Type filter ──
  if (rules.removeTypes.has(type)) {
    stats.removedByType[type] = (stats.removedByType[type] || 0) + 1;
    return true;
  }

  // ── subtype filter ──
  if (type === 'system') {
    const subtype = record.subtype;
    if (rules.removeSubtypes.has(subtype)) {
      stats.removedByType[`system:${subtype}`] = (stats.removedByType[`system:${subtype}`] || 0) + 1;
      return true;
    }
  }

  // ── Remove system reminders ──
  if (rules.removeSystemReminders && type === 'system' &&
      record.subtype === 'critical_system_reminder') {
    stats.removedSystemReminders++;
    return true;
  }

  // ── Remove hook messages ──
  if (rules.removeHookMessages && type === 'user') {
    const content = record.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    if (text.includes('hook_progress') || text.startsWith('<hook')) {
      stats.removedHookMessages++;
      return true;
    }
  }

  return false;
}

// ── Truncate tool output ──
function truncateToolOutput(record, type, rules, maxOutput, stats) {
  if (!(rules.truncateToolOutput && type === 'user' && record.toolUseResult)) return;
  const content = record.message?.content;
  if (!Array.isArray(content)) return;
  let modified = false;
  for (const block of content) {
    if (block.type === 'tool_result' && block.content) {
      const text = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      if (text.length > maxOutput) {
        block.content = text.slice(0, maxOutput) +
          `\n\n[... truncated ${text.length - maxOutput} chars of tool output]`;
        modified = true;
      }
    }
  }
  if (modified) {
    record.message.content = content;
    stats.truncatedOutputs++;
    stats.truncatedToolOutputs++;
  }
}

// ── Remove thinking blocks ──
function removeThinkingBlocks(record, type, rules, stats) {
  if (!(rules.removeThinking && type === 'assistant' && record.message?.content)) return;
  const filtered = record.message.content.filter(b => b.type !== 'thinking');
  if (filtered.length < record.message.content.length) {
    stats.removedThinking += record.message.content.length - filtered.length;
    record.message.content = filtered;
  }
}

// Keep a tool_use block (may truncate input by maxToolInput)
function keepToolUseBlock(block, maxToolInput, stats, newContent) {
  stats.keptToolsByName[block.name] = (stats.keptToolsByName[block.name] || 0) + 1;
  // Keep this tool_use, may truncate input
  if (maxToolInput > 0 && block.input) {
    const inputStr = JSON.stringify(block.input);
    if (inputStr.length > maxToolInput) {
      const truncated = { _truncated: true, _preview: inputStr.slice(0, maxToolInput) + '...' };
      newContent.push({ ...block, input: truncated });
      stats.truncatedOutputs++;
      stats.truncatedToolInputs++;
      return;
    }
  }
  newContent.push(block);
}

// Handle a single block in text-only mode (text kept / tool_use kept or marked for removal by name)
function applyTextOnlyBlock(block, keepTools, maxToolInput, stats, newContent, removedToolUseIds) {
  if (block.type === 'text') {
    newContent.push(block);
    return;
  }
  if (block.type === 'tool_use') {
    if (keepTools.has(block.name)) {
      keepToolUseBlock(block, maxToolInput, stats, newContent);
    } else if (block.id) {
      // Remove this tool_use -> record the ID so the second phase can remove the matching tool_result
      removedToolUseIds.add(block.id);
    }
  }
  // thinking and other blocks were already handled in the earlier removeThinking phase
}

// ── aggressive: text-only (identify tool_use ids to remove, keep the keepTools list) ──
function applyTextOnly(record, type, rules, opts, stats, removedToolUseIds) {
  if (!(rules.textOnly && type === 'assistant' && Array.isArray(record.message?.content))) return;
  const keepTools = opts.keepTools || new Set();
  const maxToolInput = opts.maxToolInput || 0;
  const newContent = [];
  for (const block of record.message.content) {
    applyTextOnlyBlock(block, keepTools, maxToolInput, stats, newContent, removedToolUseIds);
  }
  record.message.content = newContent;
  // No tool_use left -> change stop_reason to end_turn
  if (!newContent.some(b => b.type === 'tool_use')) {
    record.message.stop_reason = 'end_turn';
  }
}

// Second phase: in textOnly mode, remove orphaned tool_result, return the final outputLines
function removeOrphanToolResults(processed, rules, stats, removedToolUseIds) {
  const outputLines = [];
  for (const item of processed) {
    if (item.kind === 'raw') {
      outputLines.push(item.value);
      continue;
    }
    const record = item.value;

    if (rules.textOnly && record.type === 'user' && Array.isArray(record.message?.content)) {
      const filtered = record.message.content.filter(b => {
        if (b.type === 'tool_result' && removedToolUseIds.has(b.tool_use_id)) {
          stats.removedByType['tool_result:orphaned'] =
            (stats.removedByType['tool_result:orphaned'] || 0) + 1;
          return false;
        }
        return true;
      });
      // If every block is an orphaned tool_result -> remove the whole message
      if (filtered.length === 0 && record.message.content.length > 0) {
        continue;
      }
      record.message.content = filtered;
    }

    outputLines.push(JSON.stringify(record));
  }
  return outputLines;
}

// ── Output ──
function writeCleanOutput(outputLines, opts, outputPath) {
  if (opts.dryRun) return;
  const output = outputLines.join('\n') + '\n';
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

async function cleanSession(inputPath, opts = {}) {
  const strategy = opts.strategy || 'safe';
  const rules = typeof strategy === 'string' ? STRATEGIES[strategy] : strategy;
  const maxOutput = opts.maxOutput || rules.maxToolOutput;
  const outputPath = opts.output;

  const stats = {
    inputLines: 0,
    outputLines: 0,
    inputSize: fs.statSync(inputPath).size,
    removedByType: {},
    truncatedOutputs: 0,
    removedThinking: 0,
    removedSystemReminders: 0,
    removedHookMessages: 0,
    keptLines: 0,
    keptToolsByName: {}, // hit count per keep-tool
    truncatedToolInputs: 0, // count of truncated tool_use inputs
    truncatedToolOutputs: 0, // count of truncated tool_result contents
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  // First phase: collect all processed records
  // textOnly mode needs two phases: first identify tool_use ids to remove, then remove the matching tool_result
  const processed = []; // each entry: kind is record or raw, value is the content
  const removedToolUseIds = new Set();

  for await (const line of rl) {
    stats.inputLines++;
    if (!line.trim()) {
      processed.push({ kind: 'raw', value: line });
      continue;
    }

    try {
      const record = JSON.parse(line);
      const type = record.type || 'unknown';

      if (shouldRemoveRecord(record, type, rules, stats)) continue;
      truncateToolOutput(record, type, rules, maxOutput, stats);
      removeThinkingBlocks(record, type, rules, stats);
      applyTextOnly(record, type, rules, opts, stats, removedToolUseIds);

      processed.push({ kind: 'record', value: record });

    } catch {
      processed.push({ kind: 'raw', value: line });
    }
  }
  rl.close();

  // Second phase: in textOnly mode, remove orphaned tool_result
  const outputLines = removeOrphanToolResults(processed, rules, stats, removedToolUseIds);
  stats.outputLines = outputLines.length;

  writeCleanOutput(outputLines, opts, outputPath);

  return stats;
}

// ── Reverse read (tail): read the tail essence of a session ───────────────

async function readTail(inputPath, lineCount = 1000) {
  return new Promise((resolve, reject) => {
    // Windows has no native tail; implement it in Node.js
    const fd = fs.openSync(inputPath, 'r');
    const stat = fs.fstatSync(fd);
    const bufSize = Math.min(stat.size, 1024 * 1024); // read at most 1MB
    const buf = Buffer.alloc(bufSize);
    const start = Math.max(0, stat.size - bufSize);
    fs.readSync(fd, buf, 0, bufSize, start);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    // Skip the first line (if it is incomplete JSON cut off mid-file)
    // But if start === 0 (whole file read), keep the first line
    let lines = text.split('\n').filter(l => l.trim());
    if (start > 0 && lines.length > 0) {
      lines = lines.slice(1); // the first line may be a cut-off incomplete line
    }
    const tailLines = lines.slice(-lineCount);

    const records = [];
    for (const line of tailLines) {
      try { records.push(JSON.parse(line)); } catch { /* skip non-JSON tail lines */ }
    }
    resolve(records);
  });
}

// ── Quick summary (read only the tail 64KB) ──────────────

function summarizeUserRecord(r, summary) {
  const content = r.message?.content;
  if (typeof content === 'string') {
    summary.lastUserMessage = content.slice(0, 200);
  } else if (Array.isArray(content)) {
    const text = content.filter(b => b.type === 'text').map(b => b.text).join(' ');
    if (text && !text.startsWith('tool_use_id') && !text.includes('[Request interrupted')) {
      summary.lastUserMessage = text.slice(0, 200);
    }
  }
}

function summarizeAssistantRecord(r, summary) {
  if (!summary.modelName && r.message?.model) summary.modelName = r.message.model;
  const content = r.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type === 'text' && !summary.lastAssistantText) {
      summary.lastAssistantText = b.text?.slice(0, 200);
    }
    if (b.type === 'tool_use' && b.name) {
      summary.toolNames.add(b.name);
    }
  }
}

async function quickSummary(inputPath) {
  const records = await readTail(inputPath, 2000);
  const summary = {
    sessionId: null,
    messageTypes: {},
    lastUserMessage: null,
    lastAssistantText: null,
    toolNames: new Set(),
    modelName: null,
  };

  for (const r of records) {
    if (!summary.sessionId && r.sessionId) summary.sessionId = r.sessionId;
    summary.messageTypes[r.type] = (summary.messageTypes[r.type] || 0) + 1;
    if (r.type === 'user') summarizeUserRecord(r, summary);
    if (r.type === 'assistant') summarizeAssistantRecord(r, summary);
  }

  return {
    ...summary,
    toolNames: [...summary.toolNames],
  };
}

// ── CLI ────────────────────────────────────────────────────

function printCleanReport(stats, reduction) {
  console.error(`\n📊 Cleanup report:`);
  console.error(`   Input:  ${stats.inputLines} lines (${(stats.inputSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.error(`   Output: ${stats.outputLines} lines`);
  console.error(`   Reduced: ${reduction}%`);

  // Categorized display
  if (Object.keys(stats.keptToolsByName).length > 0) {
    console.error(`   Kept tool_use (--keep-tools):`);
    for (const [name, count] of Object.entries(stats.keptToolsByName)) {
      console.error(`     ${name}: ${count}`);
    }
  }
  if (stats.truncatedToolOutputs > 0 || stats.truncatedToolInputs > 0) {
    console.error(`   Truncated:`);
    if (stats.truncatedToolOutputs > 0) console.error(`     tool_result content: ${stats.truncatedToolOutputs}`);
    if (stats.truncatedToolInputs > 0) console.error(`     tool_use input: ${stats.truncatedToolInputs}`);
  }
  if (stats.removedThinking > 0) console.error(`   Removed thinking blocks: ${stats.removedThinking}`);
  if (stats.removedSystemReminders > 0) console.error(`   Removed system reminders: ${stats.removedSystemReminders}`);
  if (stats.removedHookMessages > 0) console.error(`   Removed hook messages: ${stats.removedHookMessages}`);
  if (Object.keys(stats.removedByType).length > 0) {
    console.error(`   Removed types:`);
    for (const [type, count] of Object.entries(stats.removedByType)) {
      console.error(`     ${type}: ${count}`);
    }
  }
}

// --json: machine-readable stats (to pipe into an AI)
function printCleanJson(stats, reduction) {
  console.log(JSON.stringify({
    inputLines: stats.inputLines,
    outputLines: stats.outputLines,
    inputSizeMB: (stats.inputSize / (1024 * 1024)).toFixed(2),
    reductionPercent: Number.parseFloat(reduction),
    truncatedOutputs: stats.truncatedOutputs,
    truncatedToolInputs: stats.truncatedToolInputs,
    truncatedToolOutputs: stats.truncatedToolOutputs,
    keptToolsByName: stats.keptToolsByName,
    removedThinking: stats.removedThinking,
    removedByType: stats.removedByType,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--strategy', '--output', '--max-output', '--dry-run', '--keep-tools', '--max-tool-input',
            '--quick-summary', '--tail'],
    valueFlags: ['--strategy', '--output', '--max-output', '--keep-tools', '--max-tool-input', '--tail'],
    scriptName: 'clean',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-clean.js — Session JSONL cleanup / slimming

Usage:
  recensa-session clean <input.jsonl>                          slim to stdout
  recensa-session clean <input.jsonl> --output clean.jsonl     write to a file
  recensa-session clean <input.jsonl> --strategy aggressive    most aggressive cleanup
  recensa-session clean <input.jsonl> --strategy moderate      moderate cleanup
  recensa-session clean <input.jsonl> --max-output 500         tool-output truncation limit
  recensa-session clean <input.jsonl> --dry-run                report only
  recensa-session clean <input.jsonl> --quick-summary          quick summary (read the tail only)
  recensa-session clean <input.jsonl> --tail 200               read the last N lines

Strategies:
  safe       keep conversation + tool names, truncate output > 2000 chars (default)
  moderate   remove progress/system, truncate output > 500 chars
  aggressive keep only user/assistant plain-text conversation, remove all tool interactions

aggressive mode advanced options:
  --keep-tools T1,T2,...    keep the tool_use of the given tool names (with input)
                            common: --keep-tools TaskCreate,TaskUpdate,Edit,Write
  --max-tool-input N        truncate kept tool_use input longer than N chars (default 500)`);
    process.exit(0);
  }

  // Resolve the session path (supports --latest, UUID short prefix)
  let inputPath;
  try {
    const { resolveFromArgs } = require('../lib/resolver');
    inputPath = resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  if (args.includes('--quick-summary')) {
    const summary = await quickSummary(inputPath);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const tailIdx = args.indexOf('--tail');
  if (tailIdx >= 0) {
    const n = Number.parseInt(args[tailIdx + 1]) || 1000;
    const records = await readTail(inputPath, n);
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  const strategyIdx = args.indexOf('--strategy');
  const outputIdx = args.indexOf('--output');
  const maxOutputIdx = args.indexOf('--max-output');
  const keepToolsIdx = args.indexOf('--keep-tools');
  const maxToolInputIdx = args.indexOf('--max-tool-input');

  const keepTools = keepToolsIdx >= 0
    ? new Set(args[keepToolsIdx + 1].split(',').map(s => s.trim()))
    : new Set();
  const maxToolInput = maxToolInputIdx >= 0
    ? Number.parseInt(args[maxToolInputIdx + 1]) || 500
    : 500;

  const stats = await cleanSession(inputPath, {
    strategy: strategyIdx >= 0 ? args[strategyIdx + 1] : 'safe',
    output: outputIdx >= 0 ? args[outputIdx + 1] : null,
    maxOutput: maxOutputIdx >= 0 ? Number.parseInt(args[maxOutputIdx + 1]) : undefined,
    dryRun: args.includes('--dry-run'),
    keepTools,
    maxToolInput,
  });

  const reduction = stats.inputLines > 0
    ? ((1 - stats.outputLines / stats.inputLines) * 100).toFixed(1)
    : 0;

  printCleanReport(stats, reduction);

  // --json: also print machine-readable stats (to pipe into an AI)
  if (args.includes('--json')) {
    printCleanJson(stats, reduction);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { cleanSession, readTail, quickSummary, STRATEGIES };
