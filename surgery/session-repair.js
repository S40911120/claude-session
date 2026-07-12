#!/usr/bin/env node
/**
 * session-repair.js — unified automatic repair engine
 *
 * 8 automatic repairs, each runnable on its own or all at once.
 * Every repair supports a --dry-run preview + automatic backup (.bak).
 *
 * Repairs (ordered by safety):
 *   [1] orphan-tool-results   remove orphaned tool_result (its matching tool_use no longer exists)
 *   [2] orphan-tool-uses      remove orphaned tool_use (no matching tool_result, API 400)
 *   [3] order-violations      remove out-of-order tool_use (its tool_result isn't in the next user message)
 *   [4] duplicate-uuids       fix duplicate UUIDs (assign new UUIDs + update parentUuid)
 *   [5] corrupted-tool-use    fix corrupted tool_use name (> 200 chars, params flattened in)
 *   [6] empty-thinking        remove empty thinking blocks (empty text but has a signature)
 *   [7] broken-parent-chain   rebuild broken parentUuid chains
 *   [8] missing-compact-bound rebuild a missing compact boundary
 *
 * Usage:
 *   recensa-session repair <session.jsonl>                    repair all
 *   recensa-session repair <session.jsonl> --fix orphan-tool  single repair
 *   recensa-session repair <session.jsonl> --dry-run          report only
 *   recensa-session repair <session.jsonl> --output fix.jsonl output to a new file
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uuid4, repairChainAfterDelete } = require('../lib/uuid-engine');
const {
  collectAssistantToolUseIds: collectToolUseIds,
  collectUserToolResultRefs: collectToolResultRefs,
  collectResultsBeforeNextTurn,
} = require('../lib/tool-blocks');

// ── Utilities ─────────────────────────────────────────────

function loadSession(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = [];
  const rawLines = raw.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      r.__idx = i + 1;
      records.push(r);
    } catch (e) {
      records.push({ _raw: line, _error: e.message, __idx: i + 1 });
    }
  }
  return { records, rawLines };
}

const { atomicWrite, backupFile } = require('../lib/atomic-write');

function saveSession(records, outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const content = records.map(r => {
    // Parse-fail sentinel is { _raw, _error, __idx } (see parseSession); require _error too so a legit
    // record that merely has a top-level _raw field is serialized normally instead of collapsed to its value.
    if (r._raw !== undefined && r._error !== undefined) return r._raw;
    const c = { ...r };
    delete c.__idx;
    return JSON.stringify(c);
  }).join('\n') + '\n';
  atomicWrite(outputPath, content);
}

// backupFile (auto-backup before an in-place overwrite) is imported from lib/atomic-write —
// shared with surgeon so the two never drift.

// ── Shared block helpers ──────────────────────────────────
// collectToolUseIds / collectToolResultRefs are imported from lib/tool-blocks (shared with verify + merger)

// remove tool_use blocks matching isTarget from a single assistant record; returns { record, removed }, record=null means drop the whole record
function stripToolUses(r, isTarget) {
  const blocks = r.message.content;
  if (!blocks.some(isTarget)) return { record: r, removed: 0 };
  let removed = 0;
  const newBlocks = blocks.filter(b => {
    if (isTarget(b)) { removed++; return false; }
    return true;
  });
  if (newBlocks.length === 0) return { record: null, removed };
  const newMsg = { ...r.message, content: newBlocks };
  if (!newBlocks.some(b => b.type === 'tool_use')) newMsg.stop_reason = 'end_turn';
  return { record: { ...r, message: newMsg }, removed };
}

// Chain repair for the delete+strip passes below: repairChainAfterDelete needs the ORIGINAL records
// (including the deleted ones) to rewire parentUuids past deleted ancestors, but it returns unstripped
// content — so take only its corrected parentUuid map and apply it onto the stripped survivors,
// otherwise the partial block-strips would be silently discarded (they must survive alongside the repair).
function reattachChain(strippedSurvivors, originalRecords, deletedUuids) {
  if (deletedUuids.length === 0) return strippedSurvivors;
  const rewired = repairChainAfterDelete([...originalRecords], deletedUuids);
  const newParent = new Map();
  for (const r of rewired) if (r.uuid) newParent.set(r.uuid, r.parentUuid);
  return strippedSurvivors.map(r =>
    (r.uuid && newParent.has(r.uuid) ? { ...r, parentUuid: newParent.get(r.uuid) } : r));
}

// remove tool_use matching isTarget across all assistants, and repair chains broken by fully deleted messages
function removeToolUses(records, isTarget) {
  let fixed = 0;
  const result = [];
  const deletedUuids = [];
  for (const r of records) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const { record, removed } = stripToolUses(r, isTarget);
      fixed += removed;
      if (record) result.push(record);
      else if (r.uuid) deletedUuids.push(r.uuid);
    } else {
      result.push(r);
    }
  }
  return { records: reattachChain(result, records, deletedUuids), fixed };
}

// ── [1] fix_orphaned_tool_results ─────────────────────────
// remove tool_result blocks whose matching tool_use doesn't exist
// based on a known fix for orphaned tool_results

// remove orphaned tool_result blocks from a single user record; returns { record, removed }, record=null means drop the whole record
function stripOrphanToolResults(r, toolUseIds) {
  const isOrphan = (b) => b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id);
  const blocks = r.message.content;
  if (!blocks.some(isOrphan)) return { record: r, removed: 0 };
  let removed = 0;
  const newBlocks = blocks.filter(b => {
    if (isOrphan(b)) { removed++; return false; }
    return true;
  });
  if (newBlocks.length > 0) {
    return { record: { ...r, message: { ...r.message, content: newBlocks } }, removed };
  }
  return { record: null, removed };
}

function fixOrphanedToolResults(records) {
  const toolUseIds = collectToolUseIds(records);

  let fixed = 0;
  const result = [];
  const deletedUuids = [];
  for (const r of records) {
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      const { record, removed } = stripOrphanToolResults(r, toolUseIds);
      fixed += removed;
      if (record) result.push(record);
      // the whole message will be deleted → record its UUID and repair the parentUuid chain later
      else if (r.uuid) deletedUuids.push(r.uuid);
    } else {
      result.push(r);
    }
  }

  // reattachChain rewires survivors' parentUuids past deleted ancestors while preserving the strips
  return { records: reattachChain(result, records, deletedUuids), fixed };
}

// ── [2] fix_orphaned_tool_uses ────────────────────────────
// remove tool_use blocks with no matching tool_result
// API 400: "tool_use ids were found without tool_result blocks immediately after"

function fixOrphanedToolUses(records) {
  const toolResultRefs = collectToolResultRefs(records);
  return removeToolUses(records, b => b.type === 'tool_use' && b.id && !toolResultRefs.has(b.id));
}

// ── [3] fix_duplicate_uuids ───────────────────────────────
// based on a published repair script (GitHub #22178)

function fixDuplicateUuids(records) {
  const seen = new Map(); // uuid → first index
  const duplicates = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r.uuid) continue;
    if (seen.has(r.uuid)) {
      duplicates.push({ index: i, uuid: r.uuid, firstIndex: seen.get(r.uuid) });
    } else {
      seen.set(r.uuid, i);
    }
  }

  if (duplicates.length === 0) return { records, fixed: 0 };

  const oldToNew = new Map();
  const result = [];
  let fixed = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (duplicates.some(d => d.index === i)) {
      const newUuid = uuid4();
      oldToNew.set(r.uuid, newUuid);
      result.push({ ...r, uuid: newUuid });
      fixed++;
    } else {
      result.push(r);
    }
  }

  // update parentUuid references (if any other record's parentUuid points at a replaced UUID)
  for (const r of result) {
    if (r.parentUuid && oldToNew.has(r.parentUuid)) {
      r.parentUuid = oldToNew.get(r.parentUuid);
    }
  }

  return { records: result, fixed };
}

// ── [4] fix_corrupted_tool_use ────────────────────────────
// fix tool calls with name > 200 chars (params serialized into the name field)
// based on a known fix for corrupted tool_use

// parse the key="value" params that were flattened into the name
function parseFlattenedParams(paramsStr) {
  const params = {};
  // bounded + linear ([^"]* is delimited by a closing "; no nested quantifiers) → no catastrophic-backtracking risk
  const paramRegex = /(\w+)="([^"]*)"/g; // NOSONAR
  let match;
  while ((match = paramRegex.exec(paramsStr)) !== null) {
    try {
      params[match[1]] = JSON.parse(`"${match[2]}"`);
    } catch {
      params[match[1]] = match[2];
    }
  }
  return params;
}

// repair a single block: corrupted tool_use name (>200 chars and contains quotes) → split into toolName + params, otherwise leave as-is
// returns { block, changed }
function repairCorruptedBlock(block) {
  if (block.type !== 'tool_use' || !block.name || block.name.length <= 200) {
    return { block, changed: false };
  }
  // format: 'ToolName" key1="val1" key2="val2"...'
  const name = block.name;
  const quoteIdx = name.indexOf('"');
  if (quoteIdx === -1) return { block, changed: false };

  const toolName = name.slice(0, quoteIdx).trim();
  const params = parseFlattenedParams(name.slice(quoteIdx));
  return {
    block: { ...block, name: toolName, input: { ...block.input, ...params } },
    changed: true,
  };
}

// repair all tool_use blocks in a single assistant record; returns { newBlocks, changed } (changed = number fixed)
function repairRecordToolUses(r) {
  const newBlocks = [];
  let changed = 0;
  for (const block of r.message.content) {
    const res = repairCorruptedBlock(block);
    newBlocks.push(res.block);
    if (res.changed) changed++;
  }
  return { newBlocks, changed };
}

function fixCorruptedToolUse(records) {
  let fixed = 0;
  const result = [];

  for (const r of records) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) {
      result.push(r);
      continue;
    }

    const { newBlocks, changed } = repairRecordToolUses(r);
    if (changed > 0) {
      result.push({ ...r, message: { ...r.message, content: newBlocks } });
      fixed += changed;
    } else {
      result.push(r);
    }
  }

  return { records: result, fixed };
}

// ── [5] fix_empty_thinking ────────────────────────────────
// remove blocks with empty thinking text + a valid signature
// based on a known fix for empty thinking blocks
// API 400: "thinking blocks cannot be modified"

// empty thinking text + a signature = corrupted (a known Claude Code bug; resume returns 400)
function isEmptyThinkingBlock(block) {
  if (block.type !== 'thinking') return false;
  const text = block.thinking || block.text || '';
  return !text.trim() && !!block.signature;
}

// filter empty thinking blocks from a single content array; returns { newBlocks, removed }
function filterEmptyThinking(content) {
  const newBlocks = [];
  let removed = 0;
  for (const block of content) {
    // redacted_thinking is a valid block (only signature + data, no text) → always keep
    if (block.type === 'redacted_thinking') { newBlocks.push(block); continue; }
    if (isEmptyThinkingBlock(block)) { removed++; continue; }
    newBlocks.push(block);
  }
  return { newBlocks, removed };
}

function fixEmptyThinking(records) {
  let fixed = 0;
  const result = [];

  for (const r of records) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) {
      result.push(r);
      continue;
    }

    const { newBlocks, removed } = filterEmptyThinking(r.message.content);
    if (removed > 0) {
      result.push({ ...r, message: { ...r.message, content: newBlocks } });
      fixed += removed;
    } else {
      result.push(r);
    }
  }

  return { records: result, fixed };
}

// ── [6] fix_broken_parent_chain ───────────────────────────
// uses uuid-engine's repairChainAfterDelete
// detect orphaned parentUuid and walk up to find a living ancestor

function collectUuidSet(records) {
  const set = new Set();
  for (const r of records) {
    if (r.uuid) set.add(r.uuid);
  }
  return set;
}

// build a parent map: uuid → parentUuid
function buildParentMap(records) {
  const parentMap = new Map();
  for (const r of records) {
    if (r.uuid && r.parentUuid !== undefined) {
      parentMap.set(r.uuid, r.parentUuid || null);
    }
  }
  return parentMap;
}

// walk up from a broken parentUuid to find the first living ancestor (null if none)
function findLivingAncestor(brokenParent, uuidSet, parentMap) {
  let ancestor = parentMap.get(brokenParent);
  const seen = new Set();
  while (ancestor && !uuidSet.has(ancestor) && !seen.has(ancestor)) {
    seen.add(ancestor);
    ancestor = parentMap.get(ancestor);
  }
  return ancestor && uuidSet.has(ancestor) ? ancestor : null;
}

function fixBrokenParentChain(records) {
  const uuidSet = collectUuidSet(records);
  const hasBroken = records.some(r => r.parentUuid && !uuidSet.has(r.parentUuid));
  if (!hasBroken) return { records, fixed: 0 };

  const parentMap = buildParentMap(records);

  // for each broken reference, walk up to find a living ancestor
  const result = [];
  let fixed = 0;

  for (const r of records) {
    if (r.parentUuid && !uuidSet.has(r.parentUuid)) {
      result.push({ ...r, parentUuid: findLivingAncestor(r.parentUuid, uuidSet, parentMap) });
      fixed++;
    } else {
      result.push(r);
    }
  }

  return { records: result, fixed };
}

// ── [7] fix_missing_compact_boundary ──────────────────────
// if there's a compact summary (isCompactSummary: true) but no compact_boundary,
// insert a synthetic boundary after the summary

function fixMissingCompactBoundary(records) {
  const hasBoundary = records.some(r =>
    r.type === 'system' && r.subtype === 'compact_boundary'
  );
  const hasSummary = records.some(r =>
    r.type === 'user' && r.isCompactSummary
  );

  if (hasBoundary || !hasSummary) return { records, fixed: 0 };

  // find the position of the isCompactSummary message
  let summaryIdx = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].type === 'user' && records[i].isCompactSummary) {
      summaryIdx = i;
      break;
    }
  }

  if (summaryIdx === -1) return { records, fixed: 0 };

  // insert a compact_boundary after the summary
  const sessionId = records.find(r => r.sessionId)?.sessionId;
  const summaryUuid = records[summaryIdx]?.uuid;

  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    sessionId: sessionId || '',
    timestamp: new Date().toISOString(),
    uuid: uuid4(),
    parentUuid: summaryUuid || null,
    isMeta: true,
    _repaired: true,
  };

  const result = [
    ...records.slice(0, summaryIdx + 1),
    boundary,
    ...records.slice(summaryIdx + 1),
  ];

  // set the first conversation record after the boundary to parentUuid = boundary.uuid (or null; either works)
  // actual Claude Code behavior: after a boundary, parentUuid = null (a new segment)

  return { records: result, fixed: 1 };
}

// ── [8] fix_order_violations ──────────────────────────────
// from verify [16] "order violation" — a tool_use's tool_result exists but appears
// after the next user external prompt (the API really does return 400)
// fix: remove the offending tool_use (keep the tool_result; it will be cleaned by fixOrphanedToolResults)
// collectResultsBeforeNextTurn is imported from lib/tool-blocks (shared with verify)

// a tool_use in this turn that didn't get a tool_result before the next turn → mark as a violation
function markViolations(toolUsesInTurn, resultsBeforeNextTurn, violatingIds) {
  for (const id of toolUsesInTurn) {
    if (!resultsBeforeNextTurn.has(id)) violatingIds.add(id);
  }
}

function detectOrderViolations(records) {
  const violatingIds = new Set();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const toolUsesInTurn = r.message.content
      .filter(b => b.type === 'tool_use' && b.id)
      .map(b => b.id);
    if (toolUsesInTurn.length === 0) continue;
    const { resultsBeforeNextTurn, reachedNextTurn } = collectResultsBeforeNextTurn(records, i);
    if (!reachedNextTurn && resultsBeforeNextTurn.size === 0) continue;
    markViolations(toolUsesInTurn, resultsBeforeNextTurn, violatingIds);
  }
  return violatingIds;
}

function fixOrderViolations(records) {
  const violatingIds = detectOrderViolations(records);
  if (violatingIds.size === 0) return { records, fixed: 0 };
  return removeToolUses(records, b => b.type === 'tool_use' && violatingIds.has(b.id));
}

// ── Main repair flow ──────────────────────────────────────

const REPAIRS = {
  'orphan-tool-results':  { fn: fixOrphanedToolResults,  desc: 'remove orphaned tool_result blocks' },
  'orphan-tool-uses':     { fn: fixOrphanedToolUses,     desc: 'remove orphaned tool_use blocks (hard API 400 error)' },
  'order-violations':     { fn: fixOrderViolations,      desc: 'remove out-of-order tool_use (tool_result not in the next user message)' },
  'duplicate-uuids':      { fn: fixDuplicateUuids,       desc: 'fix duplicate UUIDs' },
  'corrupted-tool-use':   { fn: fixCorruptedToolUse,     desc: 'fix corrupted tool_use name' },
  'empty-thinking':       { fn: fixEmptyThinking,        desc: 'remove empty thinking blocks' },
  'broken-parent-chain':  { fn: fixBrokenParentChain,    desc: 'rebuild broken parentUuid chains' },
  'missing-compact-bound':{ fn: fixMissingCompactBoundary, desc: 'rebuild a missing compact boundary' },
};

// Some repairs re-orphan each other: order-violations (3rd) strips a tool_use while intentionally leaving its
// tool_result for orphan-tool-results (1st) to clean — but that cleaner already ran this pass, so a single pass
// can still leave the file failing the resume API with a 400. Run the whole sequence to a fixpoint (repeat until a
// full pass changes nothing), bounded to avoid a pathological loop. Per-repair `fixed` counts are summed across
// passes, so the returned results shape (one entry per repair) is unchanged.
const MAX_REPAIR_PASSES = 5;

// Run every repair once in order, accumulating per-repair fixed counts into `totals`; returns the updated
// records + how many were fixed this pass (0 ⇒ fixpoint reached).
function runRepairPass(records, totals) {
  let current = records;
  let passFixed = 0;
  for (const [name, repair] of Object.entries(REPAIRS)) {
    const out = repair.fn(current);
    current = out.records;
    const count = out.fixed || 0;
    totals.set(name, totals.get(name) + count);
    passFixed += count;
  }
  return { records: current, passFixed };
}

function repairAll(records) {
  const totals = new Map(Object.keys(REPAIRS).map((name) => [name, 0]));
  let current = records;

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const { records: next, passFixed } = runRepairPass(current, totals);
    current = next;
    if (passFixed === 0) break; // fixpoint reached — nothing left to repair
  }

  const results = Object.entries(REPAIRS).map(([name, repair]) => ({
    repair: name,
    description: repair.desc,
    fixed: totals.get(name),
  }));

  return { records: current, results };
}

function repairOne(records, name) {
  const repair = REPAIRS[name];
  if (!repair) throw new Error(`unknown repair: ${name}`);
  const { records: fixed, ...stats } = repair.fn(records);
  return { records: fixed, repair: name, description: repair.desc, ...stats };
}

// ── CLI ────────────────────────────────────────────────────

function runList(records) {
  console.log('Scanning for repairable items:\n');
  let total = 0;
  for (const [name, repair] of Object.entries(REPAIRS)) {
    const { fixed } = repair.fn(records);
    const icon = fixed > 0 ? '🔧' : '✅';
    const status = fixed > 0 ? `${fixed} repairable` : 'no problems';
    console.log(`  ${icon} ${name}: ${status}`);
    if (fixed > 0) console.log(`      ${repair.desc}`);
    total += fixed;
  }
  const summary = total > 0 ? `🔧 ${total} items repairable in total` : '✅ nothing to repair';
  console.log(`\n${summary}`);
}

function printDryRunDetails(result) {
  if (Array.isArray(result.results)) {
    for (const r of result.results) {
      if (r.fixed > 0) console.log(`  🔧 ${r.repair}: ${r.fixed} (${r.description})`);
    }
  } else {
    console.log(`  🔧 ${result.repair}: ${result.fixed} (${result.description})`);
  }
}

function writeRepairResult(result, filePath, args, dryRun, outputIdx, totalFixed) {
  if (!dryRun && totalFixed > 0) {
    const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : filePath;
    if (outputPath === filePath) {
      const bak = backupFile(filePath);
      console.error(`📦 backed up the original: ${bak}`);
    }
    saveSession(result.records, outputPath);
    console.error(`✅ repaired ${totalFixed} items, written to: ${outputPath}`);
  } else if (dryRun) {
    console.log(`🔍 dry-run: ${totalFixed} repairable (file not modified)`);
    printDryRunDetails(result);
  } else if (outputIdx >= 0) {
    // even with totalFixed=0, still write the output (to avoid breaking the chain)
    const outputPath = args[outputIdx + 1];
    saveSession(result.records, outputPath);
    console.error(`✅ nothing to repair; copied the original to ${outputPath}`);
  } else {
    console.log('✅ nothing to repair');
  }
}

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--list', '--dry-run', '--fix', '--output'],
    valueFlags: ['--fix', '--output'],
    scriptName: 'repair',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-repair.js — unified automatic repair engine

8 repairs:
  orphan-tool-results    remove orphaned tool_result (tool_use no longer exists)
  orphan-tool-uses       remove orphaned tool_use (no tool_result, API 400)
  duplicate-uuids        fix duplicate UUIDs (assign new UUIDs)
  corrupted-tool-use     fix corrupted tool_use name (>200 chars)
  empty-thinking         remove empty thinking blocks (resume 400 error)
  broken-parent-chain    rebuild broken parentUuid chains
  missing-compact-bound  rebuild a missing compact boundary

Usage:
  recensa-session repair <session.jsonl>                    all 8 repairs
  recensa-session repair <session.jsonl> --fix orphan-tool  single repair
  recensa-session repair <session.jsonl> --dry-run          report only, no changes
  recensa-session repair <session.jsonl> --output fix.jsonl output to a new file
  recensa-session repair <session.jsonl> --list             list repairable items`);
    process.exit(0);
  }

  // resolve the session path (supports --latest and short UUID prefixes)
  let filePath;
  try {
    const { resolveFromArgs } = require('../lib/resolver');
    filePath = resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const { records } = loadSession(filePath);

  if (args.includes('--list')) return runList(records);

  const dryRun = args.includes('--dry-run');
  const fixIdx = args.indexOf('--fix');
  const outputIdx = args.indexOf('--output');

  let result;
  try {
    if (fixIdx >= 0) {
      const name = args[fixIdx + 1];
      result = repairOne(records, name);
    } else {
      result = repairAll(records);
    }
  } catch (e) {
    // repairOne throws on an unknown --fix <name>; surface a clean message + exit 1 like the file's
    // other error handling (loadSession above), not a raw uncaught stack trace.
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const totalFixed = Array.isArray(result.results)
    ? result.results.reduce((s, r) => s + (r.fixed || 0), 0)
    : result.fixed || 0;

  writeRepairResult(result, filePath, args, dryRun, outputIdx, totalFixed);

  console.log(JSON.stringify({
    totalFixed,
    details: Array.isArray(result.results) ? result.results : [result],
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { repairAll, repairOne, REPAIRS };
