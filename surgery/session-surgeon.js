#!/usr/bin/env node
/**
 * session-surgeon.js — message-level structural operations on a session
 *
 * Relies on uuid-engine.js for chain repair.
 *
 * Features:
 *   - insert a message (at a given position / after a UUID)
 *   - delete messages (single / range / filter)
 *   - reorder messages
 *   - replace message content
 *   - find messages (by UUID / text / type)
 *   - dry-run mode
 *
 * Usage:
 *   recensa-session surgeon <session.jsonl> --delete <uuid>          delete a single message
 *   recensa-session surgeon <session.jsonl> --delete-range 5-10      delete a range
 *   recensa-session surgeon <session.jsonl> --delete-type progress   delete by type
 *   recensa-session surgeon <session.jsonl> --insert-after <uuid>    insert a message
 *   recensa-session surgeon <session.jsonl> --replace <uuid>         replace content
 *   recensa-session surgeon <session.jsonl> --find "keyword"         find messages
 *   recensa-session surgeon <session.jsonl> --dry-run                preview mode
 */

'use strict';

const path = require('node:path');
const { uuid4, validateChain, repairChainAfterDelete, quickValidate, findLeaves } = require('../lib/uuid-engine');
const { parseJsonlSync, stringifyRecord, PROTECTED_METADATA_TYPES } = require('../lib/util');

const { atomicWrite, backupFile } = require('../lib/atomic-write');

// ── Core operations ───────────────────────────────────────

/** delete by index */
function deleteByIndex(records, indices, opts = {}) {
  const indexSet = new Set(indices);
  const deleted = records.filter((_, i) => indexSet.has(i));
  const deletedUuids = deleted.map(r => r.uuid).filter(Boolean);

  let result = records.filter((_, i) => !indexSet.has(i));

  if (opts.repairChain !== false) {
    result = repairChainAfterDelete(result, deletedUuids);
  }

  return { records: result, deleted, deletedCount: deleted.length };
}

/** delete by UUID */
function deleteByUuid(records, uuids, opts = {}) {
  const uuidSet = new Set(uuids);
  const deleted = records.filter(r => uuidSet.has(r.uuid));
  const deletedUuids = deleted.map(r => r.uuid).filter(Boolean);

  let result = records.filter(r => !uuidSet.has(r.uuid));

  if (opts.repairChain !== false) {
    result = repairChainAfterDelete(result, deletedUuids);
  }

  return { records: result, deleted, deletedCount: deleted.length };
}

/** delete by type */
function deleteByType(records, types, opts = {}) {
  const typeSet = new Set(types);
  const deleted = records.filter(r => typeSet.has(r.type));
  const deletedUuids = deleted.map(r => r.uuid).filter(Boolean);

  let result = records.filter(r => !typeSet.has(r.type));

  if (opts.repairChain !== false) {
    result = repairChainAfterDelete(result, deletedUuids);
  }

  return { records: result, deleted, deletedCount: deleted.length };
}

/** delete by predicate function */
function deleteByFilter(records, filterFn, opts = {}) {
  const deleted = [];
  const keep = [];

  for (const r of records) {
    if (filterFn(r)) deleted.push(r);
    else keep.push(r);
  }

  const deletedUuids = deleted.map(r => r.uuid).filter(Boolean);
  let result = keep;

  if (opts.repairChain !== false) {
    result = repairChainAfterDelete(result, deletedUuids);
  }

  return { records: result, deleted, deletedCount: deleted.length };
}

/** insert a new message after the given UUID */
function insertAfter(records, afterUuid, newRecord) {
  const idx = records.findIndex(r => r.uuid === afterUuid);
  if (idx === -1) return { records, inserted: false, error: `UUID not found: ${afterUuid}` };

  const insert = { ...newRecord };
  if (!insert.uuid) insert.uuid = uuid4();
  insert.parentUuid = afterUuid;

  // insert the new record
  const result = [...records];
  result.splice(idx + 1, 0, insert);

  // linking strategy:
  // repoint every record that had parentUuid === afterUuid (fork siblings) to the inserted record
  // this makes insert part of the linear chain: ... → afterUuid → insert → (all former children)
  // if you want fork (sibling) behavior, use the fork tool rather than insertAfter
  for (let i = idx + 2; i < result.length; i++) {
    if (result[i].parentUuid === afterUuid) {
      result[i] = { ...result[i], parentUuid: insert.uuid };
    }
  }

  return { records: result, inserted: true, newUuid: insert.uuid };
}

/** replace the message content of the given UUID */
function replaceMessage(records, targetUuid, newContent) {
  const idx = records.findIndex(r => r.uuid === targetUuid);
  if (idx === -1) return { records, replaced: false, error: `UUID not found: ${targetUuid}` };

  const result = [...records];
  result[idx] = { ...result[idx], ...newContent, uuid: targetUuid }; // keep the UUID
  return { records: result, replaced: true };
}

/** find messages
 *  supported query forms:
 *   "plain text"      substring search (over the stringified JSON)
 *   "type=user"       exact single-field match (record top-level field)
 *   "type:user"       same as above (: is equivalent to =)
 *   "key=val,key2=val2" AND of multiple conditions
 */
function findMessages(records, query) {
  // detect key=val / key:val structured queries
  const isStructured = /^\s*\w+\s*[=:]/.test(query);
  let predicate;
  if (isStructured) {
    const conds = query.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      // bounded input (a single CLI condition string) + no nested quantifiers (\w+ / \s* / .+ are mutually exclusive, non-overlapping), no catastrophic-backtracking risk
      const m = s.match(/^(\w+)\s*[=:]\s*(.+)$/); // NOSONAR
      return m ? { key: m[1], val: m[2].trim() } : null;
    }).filter(Boolean);
    predicate = (r) => conds.every(c => String(r[c.key] ?? '') === c.val);
  } else {
    const q = query.toLowerCase();
    predicate = (r) => JSON.stringify(r).toLowerCase().includes(q);
  }

  const results = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (predicate(r)) {
      results.push({
        index: i,
        type: r.type,
        uuid: r.uuid,
        timestamp: r.timestamp,
        preview: _preview(r),
        record: r,
      });
    }
  }
  return results;
}

function _preview(record) {
  if (record.type === 'user') {
    const c = record.message?.content;
    if (typeof c === 'string') return c.slice(0, 120);
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 120);
  }
  if (record.type === 'assistant') {
    const c = record.message?.content;
    if (Array.isArray(c)) {
      const text = c.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
      if (text) return text.slice(0, 120);
      const tools = c.filter(b => b.type === 'tool_use').map(b => b.name);
      if (tools.length > 0) return `[tools: ${tools.join(', ')}]`;
    }
  }
  return JSON.stringify(record).slice(0, 120);
}

// ── CLI ────────────────────────────────────────────────────

// explicit string comparator (equivalent to the default sort's UTF-16 code-unit ordering; provides the compare fn required by S2871)
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function loadRecords(filePath) {
  return parseJsonlSync(filePath);
}

function runValidate(records) {
  const report = validateChain(records);
  console.log(JSON.stringify(report, null, 2));
}

function runStats(records) {
  const report = validateChain(records);
  console.log(`Total records: ${report.stats.total}`);
  console.log(`Conversation records: ${report.stats.conversations}`);
  console.log(`Chains: ${report.stats.chains}`);
  console.log(`Orphan references: ${report.stats.orphans}`);
  console.log(`Duplicate UUIDs: ${report.stats.duplicates}`);
  console.log(`Cycles: ${report.stats.cycles}`);
  console.log(`Valid: ${report.valid ? '✅' : '❌'}`);
  if (report.issues.length > 0) {
    console.log(`\nIssues:`);
    for (const issue of report.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
  }
}

function runFind(args, records, findIdx) {
  const query = args[findIdx + 1];
  const results = findMessages(records, query);
  // print full UUIDs by default (so users can copy them into --split-at / --up-to / --delete); --brief truncates
  const brief = args.includes('--brief');
  console.log(`🔍 Found ${results.length} matches:\n`);
  for (const r of results) {
    const uuidStr = brief ? `${r.uuid?.slice(0, 12)}...` : (r.uuid || '');
    console.log(`[${r.index}] ${r.type} ${uuidStr} ${r.timestamp || ''}`);
    console.log(`    ${r.preview}\n`);
  }
}

function deleteByRangeArg(args, records, delRangeIdx) {
  const range = args[delRangeIdx + 1];
  // strictly validate the range format (prevents Number('') === 0 from parsing -5--1 as 0-5 and actually deleting 6 records)
  const m = range && /^(\d+)-(\d+)$/.exec(range);
  if (!m) {
    console.error(`❌ surgeon: --delete-range malformed "${range}"`);
    console.error(`   valid format: <start>-<end>, two non-negative integers, e.g. 5-10`);
    console.error(`   negative / reversed / empty ranges are all rejected (to prevent accidental data loss)`);
    process.exit(2);
  }
  const start = Number.parseInt(m[1]);
  const end = Number.parseInt(m[2]);
  if (start > end) {
    console.error(`❌ surgeon: --delete-range reversed ${start}-${end} (start > end)`);
    console.error(`   valid range: start <= end`);
    process.exit(2);
  }
  if (end >= records.length) {
    console.error(`⚠️  surgeon: --delete-range end=${end} exceeds records.length=${records.length}, capping automatically`);
  }
  const cappedEnd = Math.min(end, records.length - 1);
  const indices = Array.from({ length: cappedEnd - start + 1 }, (_, i) => start + i);
  return deleteByIndex(records, indices);
}

function deleteByTypeArg(args, records, delTypeIdx) {
  const types = args.slice(delTypeIdx + 1).filter(a => !a.startsWith('--'));
  // protected critical types (never deleted) — single source of truth is PROTECTED_METADATA_TYPES in lib/util
  // detect the types actually present in the session; if the user gives one that doesn't exist → ⚠️ show known types
  const actualTypes = new Set();
  for (const r of records) if (r.type) actualTypes.add(r.type);
  const unknown = types.filter(t => !actualTypes.has(t));
  if (unknown.length > 0) {
    console.error(`⚠️  the given type is not present in the session: ${unknown.join(', ')}`);
    console.error(`   known types (${actualTypes.size}): ${[...actualTypes].sort(compareStrings).join(', ')}`);
  }
  const safeTypes = types.filter(t => !PROTECTED_METADATA_TYPES.has(t));
  if (safeTypes.length < types.length) {
    console.error(`⚠️  skipping protected types: ${types.filter(t => PROTECTED_METADATA_TYPES.has(t)).join(', ')}`);
  }
  return deleteByType(records, safeTypes);
}

function reportAndWrite(result, records, dryRun, outputPath, sourcePath) {
  console.error(`\n📊 Operation report:`);
  console.error(`   deleted: ${result.deletedCount}`);
  console.error(`   kept: ${result.records.length}`);
  console.error(`   original: ${records.length}`);

  if (dryRun) {
    console.error('🔍 dry-run: file not modified');
    return;
  }

  const output = result.records.map(stringifyRecord).join('\n') + '\n';

  if (outputPath) {
    // in-place overwrite of the source (--output <source>) → back up first, matching repair's auto-backup,
    // so a destructive message-level edit is always recoverable
    if (sourcePath && path.resolve(outputPath) === path.resolve(sourcePath)) {
      const bak = backupFile(sourcePath);
      console.error(`📦 backed up the original: ${bak}`);
    }
    atomicWrite(outputPath, output);
    console.error(`✅ written: ${outputPath}`);
  } else {
    process.stdout.write(output);
  }
}

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--find', '--delete', '--delete-range', '--delete-type', '--validate', '--stats', '--output', '--dry-run', '--brief'],
    valueFlags: ['--find', '--delete', '--delete-range', '--delete-type', '--output'],
    scriptName: 'surgeon',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-surgeon.js — message-level structural operations on a session

Usage:
  recensa-session surgeon <session.jsonl> --find "keyword"
  recensa-session surgeon <session.jsonl> --delete <uuid>
  recensa-session surgeon <session.jsonl> --delete-range 5-10
  recensa-session surgeon <session.jsonl> --delete-type progress
  recensa-session surgeon <session.jsonl> --validate          validate chain integrity
  recensa-session surgeon <session.jsonl> --stats             chain stats
  recensa-session surgeon <session.jsonl> --output out.jsonl  output file

All operations support --dry-run (report only, no rewrite)`);
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

  const records = loadRecords(filePath);

  // ── validate ──
  if (args.includes('--validate')) return runValidate(records);

  // ── stats ──
  if (args.includes('--stats')) return runStats(records);

  // ── find ──
  const findIdx = args.indexOf('--find');
  if (findIdx >= 0) return runFind(args, records, findIdx);

  // ── delete / delete-range / delete-type ──
  const dryRun = args.includes('--dry-run');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;

  const delUuidIdx = args.indexOf('--delete');
  const delRangeIdx = args.indexOf('--delete-range');
  const delTypeIdx = args.indexOf('--delete-type');

  let result = null;
  if (delUuidIdx >= 0) {
    const uuids = args.slice(delUuidIdx + 1).filter(a => !a.startsWith('--'));
    result = deleteByUuid(records, uuids);
  } else if (delRangeIdx >= 0) {
    result = deleteByRangeArg(args, records, delRangeIdx);
  } else if (delTypeIdx >= 0) {
    result = deleteByTypeArg(args, records, delTypeIdx);
  } else {
    console.error('❌ please specify an operation: --delete, --delete-range, --delete-type, --find, --validate, --stats');
    process.exit(1);
  }

  if (result) reportAndWrite(result, records, dryRun, outputPath, filePath);
}

if (require.main === module) {
  main();
}

module.exports = { deleteByIndex, deleteByUuid, deleteByType, deleteByFilter, insertAfter, replaceMessage, findMessages };
