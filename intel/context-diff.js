#!/usr/bin/env node
/**
 * context-diff.js — Information diff analysis between two sessions
 *
 * Compares two sessions across:
 *   - task/topic evolution
 *   - file operation differences
 *   - token usage differences
 *   - tool usage pattern changes
 *   - model/config changes
 *   - conversation structure differences
 *
 * Usage:
 *   recensa-session diff <session1.jsonl> <session2.jsonl>          full diff
 *   recensa-session diff <s1.jsonl> <s2.jsonl> --focus files        files only
 *   recensa-session diff <s1.jsonl> <s2.jsonl> --focus tokens       tokens only
 *   recensa-session diff <s1.jsonl> <s2.jsonl> --focus topics       topic evolution only
 */

'use strict';

const fs = require('node:fs');
const { SessionParser } = require('./session-parser');

// ── Diff engine ──────────────────────────────────────────

async function diffSessions(pathA, pathB, opts = {}) {
  const parserA = new SessionParser(pathA, { progressFilter: 'summary', includeThinking: false });
  const parserB = new SessionParser(pathB, { progressFilter: 'summary', includeThinking: false });

  await Promise.all([parserA.stream(), parserB.stream()]);

  // Collect user message text
  const userA = extractUserTexts(parserA.messages);
  const userB = extractUserTexts(parserB.messages);

  // Collect file paths
  const filesA = extractFiles(parserA.messages);
  const filesB = extractFiles(parserB.messages);

  // Token stats
  const tokensA = parserA.stats.tokenUsage;
  const tokensB = parserB.stats.tokenUsage;

  // Tool usage
  const toolsA = parserA.stats.toolUsage;
  const toolsB = parserB.stats.toolUsage;

  const result = {
    sessionA: { id: parserA.stats.sessionId, path: pathA },
    sessionB: { id: parserB.stats.sessionId, path: pathB },

    overview: {
      messageCountDiff: parserB.stats.messageCount - parserA.stats.messageCount,
      durationDiff: parserB.stats.durationMs - parserA.stats.durationMs,
      sessionAMessages: parserA.stats.messageCount,
      sessionBMessages: parserB.stats.messageCount,
    },

    // File diff
    files: {
      added: [...filesB].filter(f => !filesA.has(f)),
      removed: [...filesA].filter(f => !filesB.has(f)),
      common: [...filesA].filter(f => filesB.has(f)),
      summary: `${filesA.size} → ${filesB.size} files`,
    },

    // Token diff
    tokens: {
      input: { A: tokensA.input, B: tokensB.input, diff: tokensB.input - tokensA.input },
      output: { A: tokensA.output, B: tokensB.output, diff: tokensB.output - tokensA.output },
      cacheCreate: { A: tokensA.cacheCreate, B: tokensB.cacheCreate, diff: tokensB.cacheCreate - tokensA.cacheCreate },
      cacheRead: { A: tokensA.cacheRead, B: tokensB.cacheRead, diff: tokensB.cacheRead - tokensA.cacheRead },
    },

    // Tool diff
    tools: {
      added: Object.keys(toolsB).filter(t => !toolsA[t]),
      removed: Object.keys(toolsA).filter(t => !toolsB[t]),
      increased: Object.entries(toolsB)
        .filter(([t, c]) => toolsA[t] && c > toolsA[t])
        .map(([t, c]) => ({ tool: t, from: toolsA[t], to: c })),
      decreased: Object.entries(toolsA)
        .filter(([t, c]) => toolsB[t] && c < toolsB[t])
        .map(([t, c]) => ({ tool: t, from: c, to: toolsB[t] || 0 })),
    },

    // Models
    models: {
      A: [...parserA.stats.models],
      B: [...parserB.stats.models],
    },

    // Topic evolution (keyword frequency change in user messages)
    topics: diffTopics(userA, userB),
  };

  return result;
}

function extractUserTexts(messages) {
  return messages
    .filter(m => m.role === 'user' && m.text && !m.text.startsWith('tool_use_id'))
    .map(m => m.text);
}

function extractFiles(messages) {
  // Only look at file_path of Edit/Write/Read etc. tool_use, do not scrape text content
  // An earlier regex approach would grab strings inside backticks
  const files = new Set();
  const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit', 'Glob']);
  for (const m of messages) {
    if (!m.toolUses) continue;
    for (const t of m.toolUses) {
      if (!FILE_TOOLS.has(t.name)) continue;
      const fp = t.input?.file_path || t.input?.filePath || t.input?.path;
      if (fp && typeof fp === 'string') files.add(fp);
    }
  }
  return files;
}

function diffTopics(userTextsA, userTextsB) {
  // Free-text topic frequency over user prose (no structural marker to key off) → English keywords only.
  const keywords = ['fix', 'bug', 'add', 'refactor', 'test', 'optimize', 'deploy', 'review',
    'api', 'ui', 'db', 'database', 'auth', 'error', 'config', 'migrate'];

  const freqA = {};
  const freqB = {};
  const allTextA = userTextsA.join(' ').toLowerCase();
  const allTextB = userTextsB.join(' ').toLowerCase();

  for (const kw of keywords) {
    // \b word boundaries so a short keyword is not counted as a substring of an unrelated word
    // (without them "ui" matches "build"/"quickly", "api" matches "rapid" → inflated topic frequency)
    const re = new RegExp(String.raw`\b${kw}\b`, 'gi');
    freqA[kw] = (allTextA.match(re) || []).length;
    freqB[kw] = (allTextB.match(re) || []).length;
  }

  const changes = [];
  for (const kw of keywords) {
    const diff = freqB[kw] - freqA[kw];
    if (diff !== 0) {
      changes.push({ keyword: kw, from: freqA[kw], to: freqB[kw], diff });
    }
  }

  changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    changes: changes.slice(0, 15),
    topKeywordsA: Object.entries(freqA).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topKeywordsB: Object.entries(freqB).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// ── CLI ────────────────────────────────────────────────────

// --show-fork-point — read forkedFrom from the first record and compare
function printForkPoint(pathA, pathB) {
  const readFork = (fp) => {
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(2048);
      fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const r = JSON.parse(buf.toString('utf8').split('\n')[0]);
      return { sessionId: r.sessionId, forkedFrom: r.forkedFrom || null };
    } catch { return { sessionId: null, forkedFrom: null }; }
  };
  const a = readFork(pathA);
  const b = readFork(pathB);
  console.log(`🔱 Fork lineage analysis\n`);
  console.log(`A: ${a.sessionId?.slice(0, 8)}  forkedFrom: ${a.forkedFrom ? a.forkedFrom.sessionId?.slice(0, 8) + ' @ msg ' + a.forkedFrom.messageUuid?.slice(0, 8) : '(root)'}`);
  console.log(`B: ${b.sessionId?.slice(0, 8)}  forkedFrom: ${b.forkedFrom ? b.forkedFrom.sessionId?.slice(0, 8) + ' @ msg ' + b.forkedFrom.messageUuid?.slice(0, 8) : '(root)'}`);
  // Determine the relationship
  if (a.forkedFrom?.sessionId === b.sessionId) {
    console.log(`\n→ A is a fork of B (branched from B's msg ${a.forkedFrom.messageUuid?.slice(0, 8)})`);
  } else if (b.forkedFrom?.sessionId === a.sessionId) {
    console.log(`\n→ B is a fork of A (branched from A's msg ${b.forkedFrom.messageUuid?.slice(0, 8)})`);
  } else if (a.forkedFrom?.sessionId && a.forkedFrom?.sessionId === b.forkedFrom?.sessionId) {
    console.log(`\n→ A and B share a parent: ${a.forkedFrom.sessionId?.slice(0, 8)} (sibling fork)`);
    if (a.forkedFrom.messageUuid === b.forkedFrom.messageUuid) {
      console.log(`   same fork point: msg ${a.forkedFrom.messageUuid?.slice(0, 8)}`);
    }
  } else {
    console.log(`\n→ A and B have no direct fork relationship`);
  }
  console.log(`\n────────────────────────────────`);
}

function printFilesFocus(result) {
  console.log(`📁 File diff (${result.files.summary})\n`);
  if (result.files.added.length > 0) {
    console.log(`Added (${result.files.added.length}):`);
    result.files.added.forEach(f => console.log(`  + ${f}`));
  }
  if (result.files.removed.length > 0) {
    console.log(`\nRemoved (${result.files.removed.length}):`);
    result.files.removed.forEach(f => console.log(`  - ${f}`));
  }
  console.log(`\nCommon: ${result.files.common.length}`);
}

function printTokensFocus(result) {
  console.log(`Token diff:\n`);
  const t = result.tokens;
  console.log(`Input:    ${t.input.A.toLocaleString()} → ${t.input.B.toLocaleString()} (${t.input.diff >= 0 ? '+' : ''}${t.input.diff.toLocaleString()})`);
  console.log(`Output:   ${t.output.A.toLocaleString()} → ${t.output.B.toLocaleString()} (${t.output.diff >= 0 ? '+' : ''}${t.output.diff.toLocaleString()})`);
  console.log(`Cache W:  ${t.cacheCreate.A.toLocaleString()} → ${t.cacheCreate.B.toLocaleString()}`);
  console.log(`Cache R:  ${t.cacheRead.A.toLocaleString()} → ${t.cacheRead.B.toLocaleString()}`);
}

function printTopicsFocus(result) {
  console.log('Topic keyword changes:\n');
  for (const c of result.topics.changes) {
    const arrow = c.diff > 0 ? '↗' : '↘';
    console.log(`  ${arrow} ${c.keyword}: ${c.from} → ${c.to} (${c.diff >= 0 ? '+' : ''}${c.diff})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--focus', '--show-fork-point'],
    valueFlags: ['--focus'],
    scriptName: 'diff',
  });
  if (args.length < 2 || args.includes('--help')) {
    console.log(`context-diff.js — Information diff analysis between sessions

Usage:
  recensa-session diff <session1.jsonl> <session2.jsonl>
  recensa-session diff <s1.jsonl> <s2.jsonl> --focus files
  recensa-session diff <s1.jsonl> <s2.jsonl> --focus tokens
  recensa-session diff <s1.jsonl> <s2.jsonl> --focus topics
  recensa-session diff <s1.jsonl> <s2.jsonl> --show-fork-point  include fork lineage analysis`);
    process.exit(0);
  }

  const [pathA, pathB] = args.filter(a => !a.startsWith('--'));
  if (!fs.existsSync(pathA)) { console.error(`❌ Not found: ${pathA}`); process.exit(1); }
  if (!fs.existsSync(pathB)) { console.error(`❌ Not found: ${pathB}`); process.exit(1); }

  const result = await diffSessions(pathA, pathB);

  if (args.includes('--show-fork-point')) {
    printForkPoint(pathA, pathB);
  }

  const focus = args.includes('--focus') ? args[args.indexOf('--focus') + 1] : 'all';

  if (focus === 'files') { printFilesFocus(result); return; }
  if (focus === 'tokens') { printTokensFocus(result); return; }
  if (focus === 'topics') { printTopicsFocus(result); return; }

  // Full report
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { diffSessions };
