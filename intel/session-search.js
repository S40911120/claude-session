#!/usr/bin/env node
/**
 * session-search.js — cross-session full-text search
 *
 * Usage:
 *   recensa-session search "keyword"                             search all sessions
 *   recensa-session search "keyword" --project myproject         limit to a project
 *   recensa-session search "keyword" --since 7d                  time range
 *   recensa-session search "keyword" --type user                 only user messages
 *   recensa-session search "keyword" --context 3                 show 3 lines of context
 *   recensa-session search --list                                list all sessions
 *   recensa-session search --recent 5                            list the most recent N sessions
 *
 * Pipeline:
 *   recensa-session search "keyword" --json | jq .
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { collapseBlocks } = require('../lib/noise');
const { resolveProjectsDir } = require('../lib/resolver');

// ── Session discovery ─────────────────────────────────────

function getClaudeDir() {
  return resolveProjectsDir();
}

/** decode a project directory name → actual path */
function decodeProjectName(encoded) {
  // Claude Code encoding rule: -- → /., - → /
  let result = '';
  let i = 0;
  while (i < encoded.length) {
    if (encoded[i] === '-' && encoded[i + 1] === '-') {
      result += '/.';
      i += 2;
    } else if (encoded[i] === '-') {
      result += '/';
      i += 1;
    } else {
      result += encoded[i];
      i += 1;
    }
  }
  return result;
}

/** read the real cwd from the session file's first record (the decoder loses info on Windows paths) (pure reorg) */
function readFirstCwd(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8').split('\n')[0];
    if (firstLine.trim()) {
      const r = JSON.parse(firstLine);
      if (r.cwd) return r.cwd;
    }
  } catch {}
  return null;
}

/** collect session jsonl files under a project directory (pure reorg, logic unchanged) */
function collectProjectSessions(projectPath, projectDir, decoded, sessions) {
  let projFiles;
  try { projFiles = fs.readdirSync(projectPath); } catch { return; }
  for (const file of projFiles) {
    if (!file.endsWith('.jsonl')) continue;
    // skip subagent transcripts (they live in subdirectories)
    if (file.startsWith('agent-')) continue;

    const filePath = path.join(projectPath, file);
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    // read the real cwd from the jsonl's first record (the decoder loses info on Windows paths)
    const realCwd = readFirstCwd(filePath);
    sessions.push({
      projectDir,
      projectDecoded: realCwd || decoded,
      sessionId: file.replace('.jsonl', ''),
      filePath,
      size: stat.size,
      mtime: stat.mtime,
    });
  }
}

/** collect subagent transcripts under a project directory (pure reorg, logic unchanged) */
function collectProjectSubagents(projectPath, decoded, sessions) {
  const subagentsDir = path.join(projectPath);
  let subEntries;
  try { subEntries = fs.readdirSync(subagentsDir); } catch { return; }
  for (const sub of subEntries) {
    const subPath = path.join(subagentsDir, sub);
    let subStat;
    try { subStat = fs.statSync(subPath); } catch { continue; }
    if (!subStat.isDirectory()) continue;
    const subagentsInner = path.join(subPath, 'subagents');
    if (fs.existsSync(subagentsInner)) {
      _collectSubagents(subagentsInner, sessions, decoded);
    }
  }
}

/** discover all session JSONL files */
function findAllSessions(projectFilter) {
  const claudeDir = getClaudeDir();
  if (!fs.existsSync(claudeDir)) return [];

  const sessions = [];
  let topDirs;
  try { topDirs = fs.readdirSync(claudeDir); } catch { return sessions; }
  for (const projectDir of topDirs) {
    const projectPath = path.join(claudeDir, projectDir);
    // broken symlink / permission denied → skip this entry without aborting the whole search (matches the _collectSubagents guard)
    let projStat;
    try { projStat = fs.statSync(projectPath); } catch { continue; }
    if (!projStat.isDirectory()) continue;

    const decoded = decodeProjectName(projectDir);
    if (projectFilter && !decoded.includes(projectFilter) && !projectDir.includes(projectFilter)) {
      continue;
    }

    collectProjectSessions(projectPath, projectDir, decoded, sessions);
    collectProjectSubagents(projectPath, decoded, sessions);
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function _collectSubagents(dir, sessions, projectDecoded) {
  const MAX_DEPTH = 10;
  function walk(d, depth = 0) {
    if (depth > MAX_DEPTH) return;
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d)) {
      const ep = path.join(d, entry);
      let stat;
      try { stat = fs.statSync(ep); } catch { continue; }
      if (stat.isDirectory()) {
        walk(ep, depth + 1);
      } else if (entry.endsWith('.jsonl') && entry.startsWith('agent-')) {
        sessions.push({
          projectDir: '',
          projectDecoded: projectDecoded + ' (subagent)',
          sessionId: path.basename(ep, '.jsonl'),
          filePath: ep,
          size: stat.size,
          mtime: stat.mtime,
          isSubagent: true,
        });
      }
    }
  }
  walk(dir);
}

// ── Time filtering ────────────────────────────────────────

function parseSince(since) {
  const match = since.match(/^(\d+)([hdm])$/);
  if (!match) return 0;
  const num = Number.parseInt(match[1]);
  const unit = match[2];
  const multipliers = { m: 60000, h: 3600000, d: 86400000 };
  return Date.now() - num * (multipliers[unit] || 0);
}

// ── Search engine ─────────────────────────────────────────

/** decide whether a record matches the query; returns a match object if so, else null (pure reorg, logic unchanged) */
function matchRecord(record, query, queryLower, opts, lineNum) {
  // type filter
  if (opts.type && record.type !== opts.type) return null;
  // only search conversation content
  if (opts.contentOnly && !['user', 'assistant'].includes(record.type)) return null;
  // --content-only also filters out "user messages that are actually tool_result"
  // otherwise a substring like "tool_use_id" would match tool_result content, not real conversation
  if (opts.contentOnly && record.type === 'user' && record.toolUseResult) return null;

  // --content-only: match only conversation text fields (text/content), not the whole JSON.stringify
  // (otherwise searching "bug" would still hit tool output / paths / tool_use_id and other structural noise)
  const text = (opts.contentOnly
    ? _extractContentText(record)
    : JSON.stringify(record)).toLowerCase();
  if (!text.includes(queryLower)) return null;
  const preview = _buildPreview(record, query, { contextLines: opts.contextLines });
  return { lineNum, preview, type: record.type, timestamp: record.timestamp };
}

/** scan a single session, returning the list of matches (pure reorg, logic unchanged) */
async function scanSessionMatches(session, query, queryLower, opts) {
  const rl = readline.createInterface({
    input: fs.createReadStream(session.filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  const sessionMatches = [];

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const m = matchRecord(record, query, queryLower, opts, lineNum);
      if (m) sessionMatches.push(m);
    } catch { /* corrupt line / non-JSON → skip this line */ }
  }
  rl.close();
  return sessionMatches;
}

async function searchSessions(sessions, query, opts = {}) {
  const results = [];
  const queryLower = query.toLowerCase();
  const sinceMs = opts.since ? parseSince(opts.since) : 0;

  for (const session of sessions) {
    if (sinceMs && session.mtime.getTime() < sinceMs) continue;

    const sessionMatches = await scanSessionMatches(session, query, queryLower, opts);

    if (sessionMatches.length > 0) {
      results.push({
        sessionId: session.sessionId,
        project: session.projectDecoded,
        filePath: session.filePath,
        size: session.size,
        mtime: session.mtime,
        matchCount: sessionMatches.length,
        matches: sessionMatches.slice(0, opts.maxPerSession || 5),
      });
    }
  }

  return results;
}

/** for --content-only matching: extract only conversation text (text/content fields), excluding JSON structure / paths / tool-output noise */
function _extractContentText(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

/** classification label for an empty user message (pure reorg, else-if chain turned into early returns, first-match priority unchanged) */
function emptyUserLabel(content, record) {
  if (record.toolUseResult) return '[tool_result]';
  if (Array.isArray(content)) {
    const allText = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    if (allText.startsWith('<system-reminder>')) return '[system-reminder]';
    if (allText.startsWith('<task-notification>')) return '[task-notification]';
    if (allText.includes('UserPromptSubmit hook')) return '[hook-triggered]';
    if (allText.startsWith('Stop hook feedback:')) return '[hook-feedback]';
    if (content.some(b => b.type === 'tool_result')) return '[tool_result]';
    return '[empty]';
  }
  return '[empty]';
}

/** preview text for a user record (pure reorg, logic unchanged) */
function previewUserText(record) {
  const content = record.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.filter(b => b.type === 'text').map(b => b.text).join(' ');
  }
  // add a classification label to empty user messages (matches parser --user-text-only behavior)
  if (!text.trim()) text = emptyUserLabel(content, record);
  return text;
}

/** preview text for an assistant record (pure reorg, logic unchanged) */
function previewAssistantText(content) {
  let text = '';
  if (Array.isArray(content)) {
    text = content.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
    // matching the empty-user handling — add a classification label to empty assistant text
    if (!text.trim()) {
      const tools = content.filter(b => b.type === 'tool_use');
      const hasThinking = content.some(b => b.type === 'thinking');
      if (tools.length > 0) {
        text = '[tools] ' + tools.map(t => t.name).join(', ');
      } else if (hasThinking) {
        text = '[thinking only]';
      } else {
        text = '[empty assistant]';
      }
    }
  }
  return text;
}

/** --context N: take N lines before and after the matching line (pure reorg, logic unchanged) */
function extractContextLines(text, idx, contextLines) {
  const lines = text.split('\n');
  // find the line containing the keyword
  let hitLine = -1;
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = acc + lines[i].length;
    if (idx >= acc && idx <= lineEnd) { hitLine = i; break; }
    acc = lineEnd + 1; // +1 for \n
  }
  if (hitLine < 0) hitLine = 0;
  const fromLine = Math.max(0, hitLine - contextLines);
  const toLine = Math.min(lines.length - 1, hitLine + contextLines);
  const head = fromLine > 0 ? `…(L${fromLine}-${toLine})\n` : '';
  return head + lines.slice(fromLine, toLine + 1).join('\n');
}

function _buildPreview(record, query, opts = {}) {
  let text = '';
  if (record.type === 'user') {
    text = previewUserText(record);
  } else if (record.type === 'assistant') {
    text = previewAssistantText(record.message?.content);
  } else {
    text = JSON.stringify(record);
  }

  // denoise the preview: collapse large tool / paste / long-fence blocks. But if the query falls inside a collapsed block → keep the original text so the match isn't hidden (collapsing would shift idx)
  const collapsed = collapseBlocks(text);
  if (collapsed.toLowerCase().includes(query.toLowerCase())) text = collapsed;

  // extract context around the keyword (--context N → take N lines before/after instead of the default ±60 chars)
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (opts.contextLines && opts.contextLines > 0) {
    return extractContextLines(text, idx, opts.contextLines);
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  let preview = text.slice(start, end);
  if (start > 0) preview = '...' + preview;
  if (end < text.length) preview = preview + '...';
  return preview;
}

// ── List sessions ─────────────────────────────────────────

function listSessions(sessions, limit) {
  const shown = sessions.slice(0, limit || sessions.length);
  console.log(`📁 ${sessions.length} sessions total, showing ${shown.length}\n`);
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    const date = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const sizeStr = s.size > 1024 * 1024
      ? (s.size / (1024 * 1024)).toFixed(1) + ' MB'
      : (s.size / 1024).toFixed(0) + ' KB';
    const tag = s.isSubagent ? ' [subagent]' : '';
    // print the full UUID + tidy up the project display (strip runs of "/." and similar noise)
    const cleanProject = (s.projectDecoded || s.projectDir || '?')
      .replace(/\/\.+\/+/g, '/')   // /./. → /
      .replace(/\/+$/, '');         // strip a trailing /
    console.log(`${i + 1}. ${date}  ${sizeStr.padStart(10)}  ${s.sessionId}${tag}`);
    console.log(`     Project: ${cleanProject}`);
  }
}

// ── CLI ────────────────────────────────────────────────────

/** scan a single fork-chain segment, deduping by uuid (seenUuid shared across segments) (pure reorg, logic unchanged) */
async function scanChainSegment(seg, query, queryLower, seenUuid, contextLines) {
  const rl = readline.createInterface({ input: fs.createReadStream(seg.path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNum = 0;
  let dupSkipped = 0;
  const hits = [];
  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const text = JSON.stringify(record).toLowerCase();
    if (!text.includes(queryLower)) continue;
    if (record.uuid && seenUuid.has(record.uuid)) { dupSkipped++; continue; }
    if (record.uuid) seenUuid.add(record.uuid);
    hits.push({ lineNum, preview: _buildPreview(record, query, { contextLines }), type: record.type });
  }
  rl.close();
  return { hits, dupSkipped };
}

/** --chain (opt-in): search within a session's fork chain, deduping by record uuid (pure reorg, output unchanged) */
async function runChainMode(args, chainIdx) {
  const { walkChain } = require('../lib/resolver');
  const chainInput = args[chainIdx + 1];
  if (!chainInput || chainInput.startsWith('--')) { console.error('❌ --chain requires a session (path/UUID/--latest)'); process.exit(1); }
  const query = args.find((a, i) => !a.startsWith('--') && i !== chainIdx + 1);
  if (!query) { console.error('❌ please provide a search keyword'); process.exit(1); }
  let chain;
  try { chain = walkChain(chainInput); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  const live = chain.filter(c => c.path);
  const broken = chain.filter(c => c.missing);
  if (broken.length) console.error(`⚠️  broken chain: ${broken.map(c => c.sessionId.slice(0, 8)).join(', ')}`);
  const queryLower = query.toLowerCase();
  const ctxIdx2 = args.indexOf('--context');
  const contextLines = ctxIdx2 >= 0 ? Number.parseInt(args[ctxIdx2 + 1]) || 0 : 0;
  const seenUuid = new Set();
  let totalHits = 0, dupSkipped = 0;
  console.log(`🔗 Searching "${query}" across ${live.length} fork-chain segments (deduped by uuid)...\n`);
  for (const seg of live) {
    const { hits, dupSkipped: segDup } = await scanChainSegment(seg, query, queryLower, seenUuid, contextLines);
    dupSkipped += segDup;
    if (hits.length) {
      totalHits += hits.length;
      console.log(`📄 segment ${seg.sessionId.slice(0, 8)} — ${hits.length} unique matches`);
      for (const m of hits.slice(0, 5)) {
        console.log(`   ┌─ Line ${m.lineNum} [${m.type}]`);
        console.log(`   │  ${m.preview.slice(0, 200)}`);
      }
      console.log('');
    }
  }
  console.log(`✅ ${totalHits} unique matches in the chain (dedup removed ${dupSkipped} fork-duplicated hits)`);
}

/** main search mode: full-text search across all sessions and print results (pure reorg, output unchanged) */
async function runSearchMode(args) {
  const query = args[0];
  if (!query) { console.error('❌ please provide a search keyword'); process.exit(1); }

  const projectIdx = args.indexOf('--project');
  const sinceIdx = args.indexOf('--since');
  const typeIdx = args.indexOf('--type');
  const maxPerIdx = args.indexOf('--max-per-session');

  // --context N (N lines of context before/after, analogous to grep -C)
  const ctxIdx = args.indexOf('--context');
  const contextLines = ctxIdx >= 0 ? Number.parseInt(args[ctxIdx + 1]) || 0 : 0;
  const opts = {
    project: projectIdx >= 0 ? args[projectIdx + 1] : null,
    since: sinceIdx >= 0 ? args[sinceIdx + 1] : null,
    type: typeIdx >= 0 ? args[typeIdx + 1] : null,
    contentOnly: args.includes('--content-only'),
    maxPerSession: maxPerIdx >= 0 ? Number.parseInt(args[maxPerIdx + 1]) : 5,
    contextLines,
  };

  const sessions = findAllSessions(opts.project);
  if (sessions.length === 0) {
    console.log('📭 No sessions found');
    return;
  }

  console.log(`🔍 Searching "${query}" across ${sessions.length} sessions...\n`);
  const results = await searchSessions(sessions, query, opts);

  if (results.length === 0) {
    console.log('❌ No matches found');
    return;
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);
  console.log(`✅ Found ${totalMatches} matches across ${results.length} sessions:\n`);

  for (const r of results) {
    const date = r.mtime.toISOString().slice(0, 16).replace('T', ' ');
    console.log(`📄 ${r.project} | ${date} | ${r.matchCount} matches`);
    console.log(`   Session: ${r.sessionId}`);
    console.log(`   File: ${r.filePath}`);

    for (const m of r.matches) {
      console.log(`   ┌─ Line ${m.lineNum} [${m.type}]`);
      console.log(`   │  ${m.preview.slice(0, 200)}`);
    }
    console.log('');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--content-only', '--list', '--max-per-session', '--project', '--recent', '--since', '--type', '--context', '--chain'],
    valueFlags: ['--max-per-session', '--project', '--recent', '--since', '--type', '--chain'],
    scriptName: 'search',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-search.js — cross-session full-text search

Usage:
  recensa-session search "keyword"                    search all sessions
  recensa-session search "keyword" --project myproj   limit to a project
  recensa-session search "keyword" --since 7d         the last 7 days
  recensa-session search "keyword" --type user         only user messages
  recensa-session search "keyword" --content-only      only conversation content (excludes progress/system)
  recensa-session search "keyword" --context 3         3 lines before/after each match (analogous to grep -C)
  recensa-session search "keyword" --max-per-session 5 print at most N matches per session (default 5)
  recensa-session search "keyword" --chain <session>   search only a session's fork chain, deduped by uuid (removes duplicate hits from forks re-including parent content)
  recensa-session search --list                       list all sessions
  recensa-session search --recent 5                   list the 5 most recent`);
    process.exit(0);
  }

  // --chain (opt-in): search within a session's fork chain, deduped by record uuid
  const chainIdx = args.indexOf('--chain');
  if (chainIdx >= 0) {
    await runChainMode(args, chainIdx);
    return;
  }

  if (args.includes('--list')) {
    const sessions = findAllSessions();
    listSessions(sessions, 50);
    return;
  }

  const recentIdx = args.indexOf('--recent');
  if (recentIdx >= 0) {
    const sessions = findAllSessions();
    const limit = Number.parseInt(args[recentIdx + 1]) || 10;
    listSessions(sessions, limit);
    return;
  }

  await runSearchMode(args);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { findAllSessions, searchSessions, decodeProjectName };
