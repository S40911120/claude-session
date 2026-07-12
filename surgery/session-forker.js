#!/usr/bin/env node
/**
 * session-forker.js — safe session fork
 *
 * Copy a session and remap all UUIDs to produce a fully independent duplicate.
 * The original session is left completely unaffected.
 *
 * Usage:
 *   recensa-session fork <session.jsonl>                       fork to stdout
 *   recensa-session fork <session.jsonl> --output fork.jsonl   fork to a file
 *   recensa-session fork <session.jsonl> --split-at <uuid>     split at the given UUID
 *   recensa-session fork <session.jsonl> --up-to <uuid>        keep only up to the given UUID
 *   recensa-session fork <session.jsonl> --register            register the fork with Claude Code
 *
 * Programmatic use:
 *   const { fork, split, trim } = require('./session-forker');
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uuid4, remapAll, validateChain } = require('../lib/uuid-engine');
const { encodeProjectPath, parseJsonlSync, stringifyRecord } = require('../lib/util');
const { resolveProjectsDir } = require('../lib/resolver');

const CLAUDE_PROJECTS = resolveProjectsDir();

const { atomicWrite } = require('../lib/atomic-write');

// ── Core operations ───────────────────────────────────────

/**
 * Full fork: copy all records and remap every UUID.
 * Produces a fully independent new session that can be resumed on its own.
 *
 * @param {string} sourcePath - path to the original session JSONL
 * @param {object} opts
 * @param {string} opts.outputPath - output path (default: same directory, filename suffixed with -fork)
 * @param {string} opts.title - the fork's custom-title
 */
function fork(sourcePath, opts = {}) {
  const records = parseJsonlSync(sourcePath);

  const sourceSessionId = records.find(r => r.sessionId)?.sessionId;
  if (!sourceSessionId) {
    throw new Error('sessionId not found');
  }

  // UUID remap
  const { records: remapped, mapping } = remapAll(records);
  const newSessionId = mapping.get(sourceSessionId) || uuid4();

  // keep sessionId consistent after remapping
  for (const r of remapped) {
    if (r.sessionId && mapping.has(r.sessionId)) {
      r.sessionId = mapping.get(r.sessionId);
    }
  }

  // add a fork-source marker (metadata entry)
  const now = new Date().toISOString();
  remapped.push({
    type: 'custom-title',
    sessionId: newSessionId,
    timestamp: now,
    customTitle: opts.title || `Fork of ${sourceSessionId.slice(0, 8)}`,
  });

  // validate
  const validation = validateChain(remapped);
  if (!validation.valid) {
    return {
      success: false,
      error: 'UUID chain validation failed',
      validation,
      newSessionId,
    };
  }

  // output
  const outputDir = opts.outputDir || path.dirname(sourcePath);
  const outputPath = opts.outputPath || path.join(outputDir, `${newSessionId}.jsonl`);
  const content = remapped.map(stringifyRecord).join('\n') + '\n';

  atomicWrite(outputPath, content);

  return {
    success: true,
    sourceSessionId,
    newSessionId,
    outputPath,
    recordCount: remapped.length,
    sourceCount: records.length,
    mapping,
  };
}

/**
 * Split a session at the given UUID.
 * Produces two sessions: before (records before splitUuid) and after (records from splitUuid onward).
 *
 * @returns {{ before, after }}
 */
function split(sourcePath, splitUuid, opts = {}) {
  const records = parseJsonlSync(sourcePath); // _raw fallback for non-JSON lines is written back verbatim on output

  const splitIdx = records.findIndex(r => r.uuid === splitUuid);
  if (splitIdx === -1) {
    return { success: false, error: `UUID not found: ${splitUuid}` };
  }

  const beforeRecords = records.slice(0, splitIdx);
  const afterRecords = records.slice(splitIdx);

  // fork each side — supports outputPrefix to auto-generate prefix-before.jsonl / prefix-after.jsonl
  const beforeDir = opts.outputDir || path.dirname(sourcePath);
  const beforePath = opts.outputBefore || (opts.outputPrefix ? `${opts.outputPrefix}-before.jsonl` : undefined);
  const afterPath = opts.outputAfter || (opts.outputPrefix ? `${opts.outputPrefix}-after.jsonl` : undefined);
  const beforeResult = _writeForked(beforeRecords, beforeDir, opts.beforeTitle || 'Split (before)', { outputPath: beforePath });
  const afterResult = _writeForked(afterRecords, beforeDir, opts.afterTitle || 'Split (after)', { outputPath: afterPath });

  return {
    success: true,
    splitUuid,
    splitIndex: splitIdx,
    before: beforeResult,
    after: afterResult,
  };
}

/**
 * Keep only up to the given UUID (inclusive).
 */
function trimTo(sourcePath, targetUuid, opts = {}) {
  const records = parseJsonlSync(sourcePath); // _raw fallback for non-JSON lines is written back verbatim on output

  const targetIdx = records.findIndex(r => r.uuid === targetUuid);
  if (targetIdx === -1) {
    return { success: false, error: `UUID not found: ${targetUuid}` };
  }

  const trimmed = records.slice(0, targetIdx + 1);
  const result = _writeForked(trimmed, opts.outputDir || path.dirname(sourcePath), opts.title || 'Trimmed', { outputPath: opts.outputPath });

  return {
    success: true,
    targetUuid,
    targetIndex: targetIdx,
    originalCount: records.length,
    trimmedCount: trimmed.length,
    ...result,
  };
}

function _writeForked(records, outputDir, title, opts = {}) {
  const sourceSessionId = records.find(r => r.sessionId)?.sessionId;
  const { records: remapped, mapping } = remapAll(records);
  const newSessionId = mapping.get(sourceSessionId) || uuid4();

  for (const r of remapped) {
    if (r.sessionId && mapping.has(r.sessionId)) {
      r.sessionId = mapping.get(r.sessionId);
    }
  }

  remapped.push({
    type: 'custom-title',
    sessionId: newSessionId,
    timestamp: new Date().toISOString(),
    customTitle: title,
  });

  // an explicit outputPath takes priority; otherwise use outputDir + sessionId
  const outputPath = opts.outputPath || path.join(outputDir, `${newSessionId}.jsonl`);
  const content = remapped.map(stringifyRecord).join('\n') + '\n';

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  atomicWrite(outputPath, content);

  return { sessionId: newSessionId, outputPath, recordCount: remapped.length };
}

// ── Register with Claude Code ─────────────────────────────

/**
 * Infer the project path from an existing session's project dir,
 * so the forked session can be found by `claude --resume`.
 */
function registerSession(sessionPath, projectPath) {
  const encoded = encodeProjectPath(projectPath);
  const targetDir = path.join(CLAUDE_PROJECTS, encoded);
  fs.mkdirSync(targetDir, { recursive: true });

  // read the real sessionId from inside the jsonl (no longer derive it from path.basename)
  // otherwise claude --resume looks up by the real UUID and won't find a filename prefix like "fork-v3"
  let sessionId = null;
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.sessionId) { sessionId = r.sessionId; break; }
    }
  } catch {}
  if (!sessionId) {
    return { success: false, error: `could not read a sessionId from ${sessionPath}` };
  }
  const targetPath = path.join(targetDir, `${sessionId}.jsonl`);

  if (fs.existsSync(targetPath) && targetPath !== sessionPath) {
    return { success: false, error: `session already exists: ${targetPath}` };
  }

  // copy to the correct location
  if (sessionPath !== targetPath) {
    fs.copyFileSync(sessionPath, targetPath);
  }

  return { success: true, sessionId, filePath: targetPath, projectEncoded: encoded };
}

// ── CLI ────────────────────────────────────────────────────

function runRegister(args, sourcePath, outputIdx) {
  // --register and --output are mutually exclusive (--register's destination is set by projectPath, so --output is meaningless)
  if (outputIdx >= 0) {
    console.error('❌ --register and --output cannot be used together.');
    console.error('   the --register destination is determined by --project (written to ~/.claude/projects/{encoded}/).');
    console.error('   to fork to a custom location first and then register, do it in two steps:');
    console.error('     1. forker source.jsonl --output fork.jsonl');
    console.error('     2. forker fork.jsonl --register --project /path');
    process.exit(2);
  }
  const projIdx = args.indexOf('--project');
  const projectPath = projIdx >= 0 ? args[projIdx + 1] : process.cwd();
  const result = registerSession(sourcePath, projectPath);
  console.log(JSON.stringify(result, null, 2));
  if (result.success) {
    console.error(`✅ registered: claude --resume ${result.sessionId}`);
  } else {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
}

function runSplit(args, sourcePath, splitIdx, outputIdx) {
  const splitUuid = args[splitIdx + 1];
  // treat --output X as a prefix (produces X-before.jsonl / X-after.jsonl)
  // otherwise use the --output directory + an auto sessionId name
  const outputArg = outputIdx >= 0 ? args[outputIdx + 1] : null;
  const prefix = outputArg ? outputArg.replace(/\.jsonl$/, '') : undefined;
  const result = split(sourcePath, splitUuid, { outputPrefix: prefix });
  console.log(JSON.stringify(result, null, 2));
}

function runUpTo(args, sourcePath, upToIdx, outputIdx) {
  const targetUuid = args[upToIdx + 1];
  // treat --output X directly as the output path (single file)
  const result = trimTo(sourcePath, targetUuid, {
    outputPath: outputIdx >= 0 ? args[outputIdx + 1] : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

function runFork(args, sourcePath, outputIdx) {
  // default: full fork
  const result = fork(sourcePath, {
    outputPath: outputIdx >= 0 ? args[outputIdx + 1] : undefined,
  });
  console.log(JSON.stringify({
    success: result.success,
    sourceSessionId: result.sourceSessionId,
    newSessionId: result.newSessionId,
    outputPath: result.outputPath,
    recordCount: result.recordCount,
  }, null, 2));
  if (result.success) {
    console.error(`✅ Fork complete: ${result.outputPath}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--output', '--split-at', '--up-to', '--register', '--project'],
    valueFlags: ['--output', '--split-at', '--up-to', '--project'],
    scriptName: 'forker',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-forker.js — safe session fork

Usage:
  recensa-session fork <session.jsonl>                       fork to stdout
  recensa-session fork <session.jsonl> --output fork.jsonl   fork to a file
  recensa-session fork <session.jsonl> --split-at <uuid>     split at the given UUID
  recensa-session fork <session.jsonl> --up-to <uuid>        keep only up to the given UUID
  recensa-session fork <session.jsonl> --register --project /path  register with Claude Code`);
    process.exit(0);
  }

  // resolve the session path (supports --latest and short UUID prefixes)
  let sourcePath;
  try {
    const { resolveFromArgs } = require('../lib/resolver');
    sourcePath = resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const outputIdx = args.indexOf('--output');
  const splitIdx = args.indexOf('--split-at');
  const upToIdx = args.indexOf('--up-to');

  if (args.includes('--register')) return runRegister(args, sourcePath, outputIdx);
  if (splitIdx >= 0) return runSplit(args, sourcePath, splitIdx, outputIdx);
  if (upToIdx >= 0) return runUpTo(args, sourcePath, upToIdx, outputIdx);

  runFork(args, sourcePath, outputIdx);
}

if (require.main === module) {
  main();
}

module.exports = { fork, split, trimTo, registerSession };
