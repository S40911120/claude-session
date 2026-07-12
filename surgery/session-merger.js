#!/usr/bin/env node
/**
 * session-merger.js — session merge and split
 *
 * Merge multiple sessions into one continuous conversation (sorted by time, with UUID deconfliction).
 * Supports full chain rebuild after merging.
 *
 * Usage:
 *   recensa-session merge merge <s1.jsonl> <s2.jsonl> [s3...]  merge multiple sessions
 *   recensa-session merge merge --interleave <s1> <s2>          interleave merge (by timestamp)
 *   recensa-session merge extract-range <s.jsonl> 10-50         extract a given range
 *   recensa-session merge extract-type <s.jsonl> user assistant extract only the given types
 *
 * Programmatic use:
 *   const { merge, extractRange, extractType } = require('./session-merger');
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uuid4, remapAll, autoLinkChain, validateChain } = require('../lib/uuid-engine');
const { isConversationRecord, isSidechainRecord, parseJsonlSync, stringifyRecord } = require('../lib/util');
const { collectUserToolResultRefs: collectToolResultIds } = require('../lib/tool-blocks');

const { atomicWriteLines } = require('../lib/atomic-write');

// "chain-related": conversation or sidechain records (user/assistant/system/attachment)
function isChainRelated(r) {
  return isConversationRecord(r) || isSidechainRecord(r);
}

// ── Core operations ───────────────────────────────────────

/**
 * Merge multiple session JSONL files.
 * Order: all records of the first session → all records of the second → ...
 * Each source session's UUIDs are remapped independently first, then concatenated.
 *
 * @param {string[]} sourcePaths
 * @param {object} opts
 * @param {boolean} opts.interleave - interleave merge by timestamp
 * @param {boolean} opts.keepMetadata - keep metadata entries (default true)
 */
function merge(sourcePaths, opts = {}) {
  const sources = [];

  for (const sp of sourcePaths) {
    const records = parseJsonlSync(sp);

    const sessionId = records.find(r => r.sessionId)?.sessionId || path.basename(sp, '.jsonl');

    // first identify each source's metadata and conversation records
    const metaRecords = [];
    const convRecords = [];
    for (const r of records) {
      if (isChainRelated(r)) {
        convRecords.push(r);
      } else {
        metaRecords.push(r);
      }
    }

    sources.push({ path: sp, sessionId, records, metaRecords, convRecords, count: records.length });
  }

  if (sources.length < 2) {
    return { success: false, error: 'need at least 2 sessions to merge' };
  }

  // UUID deconfliction: remap each source's conversation records independently
  const newSessionId = uuid4();
  const merged = [];

  for (const source of sources) {
    const { records: remappedConv } = remapAll(source.convRecords);
    const { records: remappedMeta } = remapAll(source.metaRecords);

    // unify sessionId across all records
    for (const r of [...remappedConv, ...remappedMeta]) {
      r.sessionId = newSessionId;
    }

    if (opts.keepMetadata !== false) {
      merged.push(...remappedMeta);
    }
    merged.push(...remappedConv);
  }

  // rebuild the full parentUuid chain
  // concatenate all sources' conversation records in order
  if (opts.interleave) {
    // re-sort chain-related records by timestamp. Decorate-sort-undecorate: parse each timestamp to a number once
    // instead of twice per comparison (O(n log n) Date parses). The sort is stable and the comparator is unchanged
    // (a.t - b.t with the same "timestamp ? getTime() : 0" key), so equal-timestamp records keep their original order.
    const metaOnly = merged.filter(r => !isChainRelated(r));
    const decorated = merged
      .filter(r => isChainRelated(r))
      .map(r => ({ r, t: r.timestamp ? new Date(r.timestamp).getTime() : 0 }));
    decorated.sort((a, b) => a.t - b.t);
    // rebuild the parentUuid chain (autoLinkChain internally handles only user/assistant)
    const relinked = autoLinkChain(decorated.map(d => d.r));
    merged.length = 0;
    merged.push(...metaOnly, ...relinked);
  } else {
    // sequential merge: keep each source's internal order, chain the parentUuids
    const chainRelated = merged.filter(r => isChainRelated(r));
    const metaOnly = merged.filter(r => !isChainRelated(r));
    const relinked = autoLinkChain(chainRelated);
    merged.length = 0;
    merged.push(...metaOnly, ...relinked);
  }

  // add merge markers
  merged.push({
    type: 'custom-title',
    sessionId: newSessionId,
    timestamp: new Date().toISOString(),
    customTitle: `Merged from ${sources.length} sessions`,
  }, {
    type: 'last-prompt',
    sessionId: newSessionId,
    timestamp: new Date().toISOString(),
    lastPrompt: `Merged session: ${sources.map(s => s.sessionId?.slice(0, 8)).join(', ')}`,
  });

  // validate
  const validation = validateChain(merged);

  return {
    success: validation.valid,
    newSessionId,
    sources: sources.map(s => ({ sessionId: s.sessionId, path: s.path, count: s.count })),
    totalRecords: merged.length,
    validation,
    records: merged,
  };
}

// collectToolResultIds (tool_use_id from tool_result within the range, for orphan detection) is imported from lib/tool-blocks

// remove orphan tool_use from a single assistant record; returns { record, trimmed }, record=null means drop the whole record
function stripOrphanToolUses(r, toolResultIds) {
  const blocks = r.message.content;
  const isOrphan = (b) => b.type === 'tool_use' && b.id && !toolResultIds.has(b.id);
  const orphans = blocks.filter(isOrphan);
  if (orphans.length === 0) return { record: r, trimmed: 0 };
  const newBlocks = blocks.filter(b => !isOrphan(b));
  if (newBlocks.length === 0) return { record: null, trimmed: orphans.length };
  const newMsg = { ...r.message, content: newBlocks };
  if (!newBlocks.some(b => b.type === 'tool_use')) newMsg.stop_reason = 'end_turn';
  return { record: { ...r, message: newMsg }, trimmed: orphans.length };
}

// remove orphan tool_use (whose tool_result is out of range) so the output stays resumable
function trimOrphanToolUses(extracted) {
  const toolResultIds = collectToolResultIds(extracted);
  const filtered = [];
  let trimmedToolUses = 0;
  for (const r of extracted) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const { record, trimmed } = stripOrphanToolUses(r, toolResultIds);
      trimmedToolUses += trimmed;
      if (record) filtered.push(record);
    } else {
      filtered.push(r);
    }
  }
  return { filtered, trimmedToolUses };
}

/**
 * Extract records in a given range from a session (index range, inclusive of both ends).
 */
function extractRange(sourcePath, startIdx, endIdx, opts = {}) {
  const trim = opts.trim !== false; // trim by default
  // NOT parseJsonlSync here: extractRange keeps records by index, so a malformed {_raw} record can survive into the
  // output where it is JSON.stringify'd (see result.records.map in cmdExtractRange). parseJsonlSync's {_raw,_error}
  // sentinel would add an _error field to that serialized line, changing output — so this site keeps the {_raw}-only form.
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const records = raw.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return { _raw: l }; }
  });

  let extracted = records.slice(startIdx, endIdx + 1);

  // extracting a segment inevitably cuts some tool_use ↔ tool_result pairs; clear them by default to keep the output resumable
  let trimmedToolUses = 0;
  if (trim) {
    const trimRes = trimOrphanToolUses(extracted);
    extracted = trimRes.filtered;
    trimmedToolUses = trimRes.trimmedToolUses;
  }

  const { records: remapped } = remapAll(extracted);

  // rebuild the chain (pass only the conversation chain to autoLinkChain; keep system/attachment as-is)
  // isConversationRecord is already required at the top of the file
  const relinked = autoLinkChain(remapped.filter(r => isConversationRecord(r)));
  const meta = remapped.filter(r => !isConversationRecord(r));

  const newSessionId = uuid4();
  const result = [...meta, ...relinked].map(r => ({ ...r, sessionId: newSessionId }));

  return {
    success: true,
    newSessionId,
    extractedCount: extracted.length,
    trimmedToolUses,
    startIndex: startIdx,
    endIndex: endIdx,
    records: result,
  };
}

/**
 * Extract only records of the given types from a session.
 */
function extractType(sourcePath, types) {
  const typeSet = new Set(types);
  // malformed lines become {_raw} sentinels; they lack a .type so the filter below drops them (never reach output)
  const records = parseJsonlSync(sourcePath);

  const extracted = records.filter(r => typeSet.has(r.type));
  const { records: remapped } = remapAll(extracted);
  const relinked = autoLinkChain(
    remapped.filter(r => ['user', 'assistant'].includes(r.type))
  );
  const others = remapped.filter(r => !['user', 'assistant'].includes(r.type));

  const newSessionId = uuid4();
  const result = [...others, ...relinked].map(r => ({ ...r, sessionId: newSessionId }));

  return {
    success: true,
    newSessionId,
    extractedCount: extracted.length,
    originalCount: records.length,
    records: result,
  };
}

// Lazily serialize records to output lines — no intermediate array, so atomicWriteLines streams straight
// from records to disk without ever building a full-file string (a very large session's join would RangeError
// past V8's MAX_STRING_LENGTH). Each cmd passes its own serializer so the exact output bytes are unchanged.
function* serializedLines(records, serialize) {
  for (const r of records) yield serialize(r);
}

// ── CLI ────────────────────────────────────────────────────

// filter out the real positional args, skipping --flags and their values
// value-taking flags: --output (the following token is its value, not an input)
const VALUE_FLAGS = new Set(['--output']);
function positionalArgs(args, startFromIdx) {
  const out = [];
  for (let i = startFromIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++; // skip the value
      continue;
    }
    out.push(a);
  }
  return out;
}

function cmdMerge(args, outputIdx) {
  const interleave = args.includes('--interleave');
  const sources = positionalArgs(args, 1);
  const result = merge(sources, { interleave });

  if (!result.success) {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }

  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : `merged-${result.newSessionId.slice(0, 8)}.jsonl`;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  // stringifyRecord emits a malformed {_raw} sentinel VERBATIM (merge preserves unparseable lines as-is).
  // Stream record-by-record: atomicWriteLines' bytes == map(stringifyRecord).join('\n') + '\n', without the
  // single mega-string that RangeErrors when merging huge (~300MB) sessions.
  atomicWriteLines(outputPath, serializedLines(result.records, stringifyRecord));

  console.log(JSON.stringify({
    success: true,
    newSessionId: result.newSessionId,
    outputPath,
    sourceCount: result.sources.length,
    totalRecords: result.totalRecords,
  }, null, 2));
  console.error(`✅ merge complete: ${outputPath}`);
}

function cmdExtractRange(args, outputIdx) {
  const sourcePath = args[1];
  const range = args[2];
  if (!sourcePath || !range) {
    console.error('❌ need source and range (e.g. 10-50)');
    process.exit(1);
  }
  const [start, end] = range.split('-').map(Number);
  const noTrim = args.includes('--no-trim');
  const result = extractRange(sourcePath, start, end, { trim: !noTrim });

  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : `extracted-${result.newSessionId.slice(0, 8)}.jsonl`;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  // INTENTIONALLY plain JSON.stringify (NOT stringifyRecord): extractRange keeps its own {_raw}-only sentinel
  // so a malformed record surfaces as {"_raw":...} in ranged output — see extractRange's parse comment.
  // Streamed via atomicWriteLines with the SAME serializer → bytes == map(JSON.stringify).join('\n') + '\n'.
  atomicWriteLines(outputPath, serializedLines(result.records, (r) => JSON.stringify(r)));

  console.log(JSON.stringify({
    success: true,
    newSessionId: result.newSessionId,
    outputPath,
    extractedCount: result.extractedCount,
    trimmedToolUses: result.trimmedToolUses,
  }, null, 2));
  if (result.trimmedToolUses > 0) {
    console.error(`✂️  trim removed ${result.trimmedToolUses} cut-off tool_use (whose tool_result is out of range) — disable with --no-trim`);
  }
  console.error(`✅ extraction complete: ${outputPath}`);
}

function cmdExtractType(args, outputIdx) {
  const sourcePath = args[1];
  const types = positionalArgs(args, 2);
  if (!sourcePath || types.length === 0) {
    console.error('❌ need source and types');
    process.exit(1);
  }
  const result = extractType(sourcePath, types);

  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : `extracted-${result.newSessionId.slice(0, 8)}.jsonl`;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  // same verbatim-sentinel rule as merge (extractType filters by .type so a {_raw} sentinel is dropped
  // before it reaches here, but route through the shared serializer for a single agreed output contract).
  // Streamed via atomicWriteLines → bytes == map(stringifyRecord).join('\n') + '\n'.
  atomicWriteLines(outputPath, serializedLines(result.records, stringifyRecord));

  console.log(JSON.stringify({
    success: true,
    newSessionId: result.newSessionId,
    outputPath,
    extractedCount: result.extractedCount,
  }, null, 2));
  console.error(`✅ extraction complete: ${outputPath}`);
}

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--interleave', '--no-trim', '--output'],
    valueFlags: ['--output'],
    scriptName: 'merger',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-merger.js — session merge and split

Usage:
  recensa-session merge merge <s1.jsonl> <s2.jsonl> [s3...]
  recensa-session merge merge --interleave <s1.jsonl> <s2.jsonl>
  recensa-session merge extract-range <s.jsonl> 10-50
  recensa-session merge extract-type <s.jsonl> user assistant

Options:
  --output <path>  output path
  --interleave     interleave merge by timestamp (default: sequential concatenation)`);
    process.exit(0);
  }

  const cmd = args[0];
  const outputIdx = args.indexOf('--output');

  if (cmd === 'merge') cmdMerge(args, outputIdx);
  else if (cmd === 'extract-range') cmdExtractRange(args, outputIdx);
  else if (cmd === 'extract-type') cmdExtractType(args, outputIdx);
  else {
    console.error(`❌ unknown command: ${cmd}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { merge, extractRange, extractType };
