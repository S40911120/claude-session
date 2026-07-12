#!/usr/bin/env node
/**
 * session-watch.js — poll-mode watcher for records appended to a given session
 *
 * Usage:
 *   recensa-session watch <session>
 *   recensa-session watch --latest
 *   recensa-session watch <session> --interval 5    # poll every 5 seconds
 *   recensa-session watch <session> --filter assistant  # only assistant
 *   recensa-session watch <session> --once           # print the current delta and exit
 *
 * Use case: collaboration / observing new activity in someone else's session (tool_use / user prompt / task)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveFromArgs } = require('../lib/resolver');

let formatToolInputSummary;
try {
  formatToolInputSummary = require('./session-parser').formatToolInputSummary || null;
} catch { formatToolInputSummary = null; }

function extractUserText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  return '';
}

function summarizeUser(record, ts) {
  const txt = extractUserText(record.message?.content);
  if (record.toolUseResult) return `${ts}  👤 [tool_result]`;
  return `${ts}  👤 ${txt.replace(/\s+/g, ' ').slice(0, 200)}`;
}

function summarizeAssistant(record, ts) {
  const c = record.message?.content;
  if (!Array.isArray(c)) return `${ts}  🤖 (empty)`;
  const text = c.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  const tools = c.filter(b => b.type === 'tool_use');
  if (text) return `${ts}  🤖 ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
  if (tools.length > 0 && formatToolInputSummary) {
    return tools.map(t => `${ts}  🔧 ${t.name}(${formatToolInputSummary(t.name, t.input, 80)})`).join('\n');
  }
  if (tools.length > 0) return `${ts}  🔧 ${tools.map(t => t.name).join(', ')}`;
  return `${ts}  🤖 (thinking)`;
}

function summarizeRecord(record) {
  const ts = record.timestamp ? new Date(record.timestamp).toISOString().slice(11, 19) : '?';
  if (record.type === 'user') return summarizeUser(record, ts);
  if (record.type === 'assistant') return summarizeAssistant(record, ts);
  if (record.type === 'summary') return `${ts}  📝 [summary] ${(record.summary || '').slice(0, 150)}`;
  if (record.type === 'system' && /compact_boundary/.test(record.subtype || '')) return `${ts}  🗜️ [${record.subtype}]`;
  return null; // don't print metadata
}

function readNewLines(filePath, fromOffset) {
  const stat = fs.statSync(filePath);
  if (stat.size <= fromOffset) return { offset: fromOffset, lines: [] };
  const fd = fs.openSync(filePath, 'r');
  const len = stat.size - fromOffset;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, fromOffset);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  // safety: the last line may be incomplete → find the last newline
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { offset: fromOffset, lines: [] };
  const complete = text.slice(0, lastNl);
  const newOffset = fromOffset + Buffer.byteLength(complete + '\n', 'utf8');
  return { offset: newOffset, lines: complete.split('\n').filter(Boolean) };
}

function collectSummaries(lines, filter) {
  const out = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (filter && r.type !== filter) continue;
    const s = summarizeRecord(r);
    if (s) out.push(s);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  // unknown-flag detection
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--interval', '--filter', '--once', '--tail'],
    valueFlags: ['--interval', '--filter', '--tail'],
    scriptName: 'watch',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-watch.js — poll-watch a session for new activity

Usage:
  recensa-session watch <session>                       watch (poll every 3 seconds)
  recensa-session watch --latest
  recensa-session watch <session> --interval 5          poll every 5 seconds
  recensa-session watch <session> --filter assistant    only assistant
  recensa-session watch <session> --once                snapshot mode: print the last 20 events then exit
  recensa-session watch <session> --once --tail 50      snapshot mode: print the last 50 events

Notes:
  Watch mode — start from the current file offset and check for new lines every N seconds. See live activity on an active session.
  Snapshot mode (--once) — scan the whole file from the start, print the last N meaningful events then exit.
                          Good for a quick "what happened last" review of an exited session.`);
    process.exit(0);
  }

  let sessionPath;
  try { sessionPath = resolveFromArgs(args).path; }
  catch (e) { console.error('❌', e.message); process.exit(1); }

  const intervalIdx = args.indexOf('--interval');
  const interval = intervalIdx >= 0 ? Number.parseInt(args[intervalIdx + 1]) * 1000 || 3000 : 3000;
  const filterIdx = args.indexOf('--filter');
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
  const once = args.includes('--once');
  // --tail N (default 20) controls how many trailing events the once/snapshot mode grabs
  const tailIdx = args.indexOf('--tail');
  const defaultTail = once ? 20 : 0;
  const tailN = tailIdx >= 0 ? Number.parseInt(args[tailIdx + 1]) || 20 : defaultTail;

  // --once acts as snapshot — print the last N events then exit, regardless of new records arriving while watching
  if (once) {
    const size = fs.statSync(sessionPath).size;
    console.log(`📸 Snapshot ${path.basename(sessionPath)} (file ${(size / 1024 / 1024).toFixed(2)} MB, offset ${size}, printing the last ${tailN} events)`);
    // read from the start, collect the last N matching the filter
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const collected = collectSummaries(lines, filter);
    for (const s of collected.slice(-tailN)) console.log(s);
    return;
  }

  // start from the current size (no replay) — watch mode
  let offset = fs.statSync(sessionPath).size;
  // show the filter setting so the user can confirm it took effect
  const filterTag = filter ? `  filter: ${filter}` : '';
  console.log(`👀 Watching ${path.basename(sessionPath)} (starting from offset ${offset} byte / ${(offset / 1024 / 1024).toFixed(2)} MB)  polling every ${interval / 1000}s${filterTag}`);

  const processNew = () => {
    let result;
    try { result = readNewLines(sessionPath, offset); }
    catch (e) { console.error('⚠️', e.message); return; }
    offset = result.offset;
    for (const s of collectSummaries(result.lines, filter)) console.log(s);
  };

  setInterval(processNew, interval);
  process.on('SIGINT', () => { console.log('\n👋 watch ended'); process.exit(0); });
  // keep the process alive
  setTimeout(() => {}, 1 << 30);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { readNewLines, summarizeRecord };
