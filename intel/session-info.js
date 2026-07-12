#!/usr/bin/env node
/**
 * session-info.js — Session metadata and quick summary
 *
 * Reads session file head/tail to obtain metadata without a full parse.
 * Aligned with Claude Code's lite metadata strategy (64KB head/tail window).
 *
 * Usage:
 *   recensa-session info <session.jsonl>                  full info
 *   recensa-session info <session.jsonl> --brief           short
 *   recensa-session info --all                             list and summarize all sessions
 *   recensa-session info --all --sort size                 sort by size
 */

'use strict';

const fs = require('node:fs');
const { findAllSessions } = require('./session-search');

const TAIL_WINDOW = 64 * 1024; // aligned with Claude Code

/** Map the fields of a single record into meta (pure reorg, field logic unchanged) */
function applyRecordToMeta(meta, r) {
  switch (r.type) {
    case 'user':
      if (!meta.firstPrompt) {
        const c = r.message?.content;
        let fp = '';
        if (typeof c === 'string') fp = c;
        else if (Array.isArray(c)) fp = c.filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 200);
        meta.firstPrompt = fp;
        meta.createdAt = r.timestamp;
      }
      break;
    case 'custom-title':
      meta.customTitle = r.title;
      break;
    case 'ai-title':
      meta.aiTitle = r.title;
      break;
    case 'last-prompt':
      meta.lastPrompt = r.prompt?.slice(0, 200);
      break;
    case 'tag':
      meta.tags.push(r.tag);
      break;
    case 'summary':
      meta.summary = r.summary?.slice(0, 500);
      break;
    case 'agent-name':
      meta.agentName = r.agentName || r.name;
      break;
    case 'mode':
      meta.mode = r.mode;
      break;
    case 'worktree-state':
      meta.worktreeState = r.state;
      break;
    case 'pr-link':
      meta.prLink = r.prUrl;
      break;
    case 'assistant':
      if (!meta.modelName && r.message?.model) {
        meta.modelName = r.message.model;
      }
      break;
  }
}

/** Read metadata from the session file head/tail (no full parse) */
function extractMetadata(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;

  const fd = fs.openSync(filePath, 'r');

  // Read the first 64KB (find sessionId, firstPrompt, createdAt)
  const headSize = Math.min(stat.size, TAIL_WINDOW);
  const headBuf = Buffer.alloc(headSize);
  fs.readSync(fd, headBuf, 0, headSize, 0);

  // Read the last 64KB (find title, lastPrompt, tag, summary)
  const tailStart = Math.max(0, stat.size - TAIL_WINDOW);
  const tailSize = Math.min(stat.size - tailStart, TAIL_WINDOW);
  const tailBuf = Buffer.alloc(tailSize);
  fs.readSync(fd, tailBuf, 0, tailSize, tailStart);
  fs.closeSync(fd);

  const headText = headBuf.toString('utf8');
  const tailText = tailBuf.toString('utf8');

  const meta = {
    filePath,
    fileSize: stat.size,
    mtime: stat.mtime,
    sessionId: null,
    firstPrompt: null,
    createdAt: null,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    tags: [],
    summary: null,
    agentName: null,
    mode: null,
    worktreeState: null,
    prLink: null,
    modelName: null,
    messageCount: 0,
  };

  // Extract from all lines in the head + tail
  // If the file is < 128KB the head/tail windows overlap -> dedupe with a Set
  const allLines = [...headText.split('\n'), ...tailText.split('\n')];
  const seen = new Set();
  const uniqueLines = [];
  for (const line of allLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    uniqueLines.push(line);
  }

  for (const line of uniqueLines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!meta.sessionId && r.sessionId) meta.sessionId = r.sessionId;
      applyRecordToMeta(meta, r);
    } catch { /* corrupt line / non-JSON metadata -> skip this line */ }
  }

  // Estimate message count (rough approximation from file size)
  if (stat.size > 0) {
    meta.messageCount = Math.round(stat.size / 800); // ~800 bytes per line on average
  }

  return meta;
}

/** Find and summarize all sessions */
function summarizeAllSessions(opts = {}) {
  const sessions = findAllSessions();

  const summaries = [];
  for (const s of sessions) {
    const meta = extractMetadata(s.filePath);
    if (meta) summaries.push(meta);
  }

  // Sort
  if (opts.sort === 'size') {
    summaries.sort((a, b) => b.fileSize - a.fileSize);
  } else if (opts.sort === 'date') {
    summaries.sort((a, b) => b.mtime - a.mtime);
  }

  return summaries;
}

// ── CLI ────────────────────────────────────────────────────

/** --all mode: list all session summaries (pure reorg, output unchanged) */
function runAllMode(args) {
  const sortIdx = args.indexOf('--sort');
  // Validate the --sort value (only size / date allowed)
  const VALID_SORTS = ['size', 'date'];
  const sortVal = sortIdx >= 0 ? args[sortIdx + 1] : 'date';
  if (!VALID_SORTS.includes(sortVal)) {
    console.error(`❌ info: unknown --sort value "${sortVal}"`);
    console.error(`   known values: ${VALID_SORTS.join(', ')}`);
    process.exit(2);
  }
  const summaries = summarizeAllSessions({ sort: sortVal });

  console.log(`📁 ${summaries.length} sessions\n`);
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const date = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const sizeMB = (s.fileSize / (1024 * 1024)).toFixed(2);
    const name = s.customTitle || s.aiTitle || s.firstPrompt?.slice(0, 50) || '(untitled)';
    console.log(`${(i + 1).toString().padStart(3)}. ${date}  ${sizeMB.padStart(8)} MB  ${name}`);
    // Print the full UUID so users can copy it (no truncation)
    console.log(`     ID: ${s.sessionId || '?'}`);
    console.log(`     Model: ${s.modelName || '?'}  msgs: ~${s.messageCount}`);
    if (s.prLink) console.log(`     PR: ${s.prLink}`);
    if (s.tags.length > 0) console.log(`     Tags: ${s.tags.join(', ')}`);
    console.log('');
  }
}

/** Collect positional args (not a --flag and not the value of a value-flag; pure reorg) */
function collectPositionals(args) {
  return args.filter((a, i) => {
    if (a.startsWith('-')) return false;
    const prev = args[i - 1];
    if (prev === '--session-id' || prev === '--latest-in') return false;
    return true;
  });
}

/** Print multiple sessions at once (positional args >= 2) (pure reorg, output unchanged) */
function runMultiMode(args, positionals) {
  const { resolve } = require('../lib/resolver');
  const brief = args.includes('-b') || args.includes('--brief');
  for (const arg of positionals) {
    let fp;
    try { fp = resolve(arg).path; } catch (e) { console.error(`❌ ${arg}: ${e.message}`); continue; }
    const m = extractMetadata(fp);
    if (!m) { console.error(`❌ ${fp} unreadable`); continue; }
    if (args.includes('--json')) {
      console.log(JSON.stringify(m, null, 2));
      continue;
    }
    const date = m.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const sizeMB = (m.fileSize / (1024 * 1024)).toFixed(2);
    if (brief) {
      console.log(`${date}  ${sizeMB.padStart(8)} MB  ${m.sessionId?.slice(0, 8)}  ${(m.customTitle || m.firstPrompt || '').slice(0, 60)}`);
    } else {
      console.log(`\n=== ${m.sessionId} ===`);
      console.log(`Cwd: ${m.firstPrompt?.slice(0, 100) || '?'}`);
      console.log(`Size: ${sizeMB} MB  |  Modified: ${date}  |  Model: ${m.modelName || '?'}`);
      console.log(`Title: ${m.customTitle || m.aiTitle || '(none)'}`);
    }
  }
}

/** Single session output (json / brief / full) (pure reorg, output unchanged) */
function printSingleMeta(meta, args) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  if (args.includes('-b') || args.includes('--brief')) {
    const date = meta.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const sizeMB = (meta.fileSize / (1024 * 1024)).toFixed(2);
    console.log(`${date}  ${sizeMB} MB  ${meta.customTitle || meta.firstPrompt?.slice(0, 60) || '(untitled)'}`);
    return;
  }

  const sizeMB = (meta.fileSize / (1024 * 1024)).toFixed(2);
  console.log(`Session:   ${meta.sessionId}`);
  console.log(`Size:      ${sizeMB} MB`);
  console.log(`Modified:  ${meta.mtime.toISOString()}`);
  console.log(`Title:     ${meta.customTitle || '(none)'}`);
  console.log(`AI title:  ${meta.aiTitle || '(none)'}`);
  console.log(`First prompt:  ${meta.firstPrompt || '(none)'}`);
  console.log(`Last prompt:   ${meta.lastPrompt || '(none)'}`);
  console.log(`Model:     ${meta.modelName || '(unknown)'}`);
  console.log(`Tags:      ${meta.tags.join(', ') || '(none)'}`);
  console.log(`PR:        ${meta.prLink || '(none)'}`);
  console.log(`Mode:      ${meta.mode || '(none)'}`);
  console.log(`Worktree:  ${meta.worktreeState || '(none)'}`);
  console.log(`Est. messages:  ~${meta.messageCount}`);
}

function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--all', '--brief', '-b', '--sort'],
    valueFlags: ['--sort'],
    scriptName: 'info',
  });

  if (args.includes('--all')) {
    runAllMode(args);
    return;
  }

  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-info.js — Session metadata

Usage:
  recensa-session info <session.jsonl>          full info
  recensa-session info <session.jsonl> -b       short (single line)
  recensa-session info <session.jsonl> --brief  same as -b
  recensa-session info --all                    summarize all sessions
  recensa-session info --all --sort size    sort by size`);
    process.exit(0);
  }

  // Print multiple sessions at once (positional args >= 2)
  // Collect all positional args (not a --flag and not the -b/--brief value)
  const positionals = collectPositionals(args);
  if (positionals.length >= 2) {
    runMultiMode(args, positionals);
    return;
  }

  // Resolve the session path (supports --latest, UUID short prefix)
  let filePath;
  try {
    const { resolveFromArgs } = require('../lib/resolver');
    filePath = resolveFromArgs(args).path;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const meta = extractMetadata(filePath);
  if (!meta) { console.error('❌ unreadable'); process.exit(1); }

  printSingleMeta(meta, args);
}

if (require.main === module) {
  main();
}

module.exports = { extractMetadata, summarizeAllSessions };
