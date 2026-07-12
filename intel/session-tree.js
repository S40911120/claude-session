#!/usr/bin/env node
/**
 * session-tree.js — fork-tree visualization (read-only)
 *
 * Every forked Claude Code session carries a forkedFrom field on its jsonl records:
 *   { sessionId, messageUuid }
 *
 * This tool scans all sessions, reads the first line's forkedFrom, builds a parent→children map,
 * and outputs an ASCII tree or Mermaid.
 *
 * Usage:
 *   recensa-session tree                          fork tree of all sessions
 *   recensa-session tree --project myproj         filter by project-path keyword
 *   recensa-session tree --mermaid > tree.md      Mermaid output
 *   recensa-session tree --json                   JSON map
 *   recensa-session tree --root <sessionId>       show only the given root's subtree
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listAllSessions } = require('../lib/resolver');

/** read the first line's forkedFrom + meta from the jsonl (does not fully parse the whole file) */
function readFirstRecord(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8').split('\n')[0];
    if (!firstLine.trim()) return null;
    return JSON.parse(firstLine);
  } catch { return null; }
}

/** extract plain text from message content (string passthrough / take text blocks from an array) */
function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  return '';
}

/** get a summary of the first valid prompt from a user record (skips empty / tag / too-short); null if none */
function extractFirstPrompt(r) {
  const txt = extractText(r.message?.content);
  if (txt && !txt.startsWith('<') && txt.length > 5) {
    return txt.replace(/\s+/g, ' ').slice(0, 80);
  }
  return null;
}

/** merge a record's useful fields into meta (only fills fields not yet set) */
function mergeRecordIntoMeta(meta, r) {
  if (!meta.sessionId && r.sessionId) meta.sessionId = r.sessionId;
  if (!meta.cwd && r.cwd) meta.cwd = r.cwd;
  if (!meta.forkedFrom && r.forkedFrom) meta.forkedFrom = r.forkedFrom;
  if (!meta.firstTimestamp && r.timestamp) meta.firstTimestamp = r.timestamp;
  if (r.type === 'custom-title' && r.title) meta.customTitle = r.title;
  if (!meta.firstPrompt && r.type === 'user' && r.userType === 'external' && !r.toolUseResult) {
    const prompt = extractFirstPrompt(r);
    if (prompt) meta.firstPrompt = prompt;
  }
}

/** read the head lines to find a title (summary of the first user prompt) */
function readSessionMeta(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const headSize = Math.min(stat.size, 32768);
  const buf = Buffer.alloc(headSize);
  fs.readSync(fd, buf, 0, headSize, 0);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  const meta = {
    sessionId: null,
    cwd: null,
    firstPrompt: null,
    firstTimestamp: null,
    forkedFrom: null,
    customTitle: null,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      mergeRecordIntoMeta(meta, r);
      if (meta.sessionId && meta.forkedFrom !== null && meta.firstPrompt) break;
    } catch {}
  }
  return meta;
}

/** build the whole fork forest (parent → children) */
function buildForest(sessions, opts = {}) {
  const projectFilter = opts.project ? opts.project.toLowerCase() : null;

  const metaById = new Map();
  for (const s of sessions) {
    const meta = readSessionMeta(s.path);
    if (!meta.sessionId) continue;
    meta.path = s.path;
    meta.mtime = s.mtime;
    meta.size = s.size;
    meta.project = s.project;
    if (projectFilter && !s.project.toLowerCase().includes(projectFilter)) continue;
    metaById.set(meta.sessionId, meta);
  }

  // build parent → children
  const children = new Map(); // parentId → [{childId, forkPoint}]
  const roots = [];
  for (const [id, m] of metaById) {
    if (m.forkedFrom?.sessionId && metaById.has(m.forkedFrom.sessionId)) {
      const parentId = m.forkedFrom.sessionId;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push({ id, forkPoint: m.forkedFrom.messageUuid });
    } else {
      roots.push(id);
    }
  }
  return { metaById, children, roots };
}

/** render the ASCII tree */
function renderAscii(forest, rootId) {
  const { metaById, children } = forest;
  const lines = [];
  function visit(id, prefix, isLast, isRoot) {
    const m = metaById.get(id);
    if (!m) return;
    const date = m.firstTimestamp ? m.firstTimestamp.slice(0, 16).replace('T', ' ') : '?';
    const title = m.customTitle || m.firstPrompt || '(untitled)';
    const sizeMB = (m.size / (1024 * 1024)).toFixed(1);
    let branchSym = '';
    if (!isRoot) branchSym = isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${branchSym}${m.sessionId.slice(0, 8)}  (${date})  ${sizeMB} MB  "${title}"`);
    const kids = children.get(id) || [];
    let indent = '';
    if (!isRoot) indent = isLast ? '   ' : '│  ';
    const childPrefix = prefix + indent;
    for (let i = 0; i < kids.length; i++) {
      visit(kids[i].id, childPrefix, i === kids.length - 1, false);
    }
  }
  visit(rootId, '', true, true);
  return lines.join('\n');
}

/** render the Mermaid diagram */
function renderMermaid(forest) {
  const { metaById, children } = forest;
  // first collect all nodes that appear in edges (avoid duplicate declarations)
  const involvedNodes = new Set();
  const edges = [];
  for (const [parentId, kids] of children) {
    involvedNodes.add(parentId);
    for (const k of kids) {
      involvedNodes.add(k.id);
      edges.push([parentId.slice(0, 8), k.id.slice(0, 8)]);
    }
  }
  const lines = ['```mermaid', 'graph TD'];
  // declare all nodes once up front
  for (const id of involvedNodes) {
    const m = metaById.get(id);
    const short = id.slice(0, 8);
    const title = (m?.customTitle || m?.firstPrompt || short).slice(0, 40);
    lines.push(`    ${short}["${short}: ${title.replaceAll('"', "'")}"]`);
  }
  // then list the edges
  for (const [p, c] of edges) {
    lines.push(`    ${p} --> ${c}`);
  }
  lines.push('```');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--project', '--mermaid', '--root'],
    valueFlags: ['--project', '--root'],
    scriptName: 'tree',
  });
  if (args.includes('--help')) {
    console.log(`session-tree.js — fork-tree visualization (read-only)

Usage:
  recensa-session tree                          fork tree of all sessions
  recensa-session tree --project myproj         filter by project keyword
  recensa-session tree --root <sessionId>       show only the given root's subtree (accepts a short prefix)
  recensa-session tree --mermaid                Mermaid diagram
  recensa-session tree --json                   JSON map

Detection: every Claude Code session JSONL record carries a forkedFrom field
({sessionId, messageUuid}); this tool reads the first record to infer fork relationships, with zero guessing.

Example output:
  e2ddd692  (2026-06-09 11:52)   6.1 MB  "main task"
  ├─ 19489d3a  (2026-06-09 11:52) 12.7 MB  "forked branch"
  └─ 1eec2378  (2026-06-11 10:17)  6.6 MB  "another fork"`);
    process.exit(0);
  }

  const projectIdx = args.indexOf('--project');
  const project = projectIdx >= 0 ? args[projectIdx + 1] : null;
  const rootIdx = args.indexOf('--root');
  const rootArg = rootIdx >= 0 ? args[rootIdx + 1] : null;

  const all = listAllSessions();
  const forest = buildForest(all, { project });

  // resolve root (accepts a short prefix)
  let targetRoots = forest.roots;
  if (rootArg) {
    const matched = [...forest.metaById.keys()].filter(id => id.startsWith(rootArg.toLowerCase()));
    if (matched.length === 0) {
      console.error(`❌ no session found starting with "${rootArg}"`);
      process.exit(1);
    }
    if (matched.length > 1) {
      console.error(`❌ "${rootArg}" ambiguously matches ${matched.length} sessions, please give a longer prefix`);
      process.exit(1);
    }
    targetRoots = [matched[0]];
  }

  if (args.includes('--json')) {
    const result = {
      totalSessions: forest.metaById.size,
      roots: forest.roots.length,
      children: Object.fromEntries(forest.children),
      metadata: Object.fromEntries([...forest.metaById].map(([id, m]) => [id, {
        sessionId: m.sessionId,
        firstTimestamp: m.firstTimestamp,
        firstPrompt: m.firstPrompt,
        cwd: m.cwd,
        sizeBytes: m.size,
        forkedFrom: m.forkedFrom,
      }])),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.includes('--mermaid')) {
    console.log(renderMermaid(forest));
    return;
  }

  // ASCII tree
  const totalForks = [...forest.children.values()].reduce((s, k) => s + k.length, 0);
  const filterNote = project ? ` (project filter: "${project}")` : '';
  console.log(`🌳 Fork forest: ${forest.metaById.size} sessions, ${forest.roots.length} roots, ${totalForks} fork edges${filterNote}\n`);
  for (const rid of targetRoots) {
    console.log(renderAscii(forest, rid));
    console.log('');
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildForest, readSessionMeta };
