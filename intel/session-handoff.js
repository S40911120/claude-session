#!/usr/bin/env node
/**
 * session-handoff.js — Write a collaboration handoff file
 *
 * Usage:
 *   recensa-session handoff --from <session> --to <cwd> --message "msg"
 *   recensa-session handoff --from <session> --message "msg"   # to defaults to the source session's cwd
 *   recensa-session handoff --from --latest --message "continue task"
 *
 * Output location: <to-cwd>/.claude-output/session-coordination.md
 *
 * Content (auto-extracted from the source session):
 *   - source session identity
 *   - current goal
 *   - in_progress + top pending tasks
 *   - 10 most recently modified files
 *   - message to the recipient
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveFromArgs, resolve } = require('../lib/resolver');
const { buildOverview } = require('./session-overview');

/** Render the Pending task block (pure reorg, output lines unchanged) */
function renderPendingTasks(lines, pending) {
  if (pending.length === 0) return;
  lines.push('');
  const neverCount = pending.filter(x => (x.updateCount || 0) === 0).length;
  const neverHint = neverCount > 0 ? ` — ${neverCount} of them [never-updated] (never TaskUpdate'd after TaskCreate; the recipient may have finished but forgotten to mark them)` : '';
  lines.push(`### ⏸️ Pending (top 10)${neverHint}`);
  for (const task of pending.slice(0, 10)) {
    const neverMark = (task.updateCount || 0) === 0 ? ' [never-updated]' : '';
    lines.push(`- ${task.subject}${neverMark}`);
  }
  if (pending.length > 10) lines.push(`- ... ${pending.length - 10} more`);
}

/** Render the Task status block (pure reorg, output lines unchanged) */
function renderTaskSection(lines, t) {
  lines.push(`## 📋 Task status (total ${t.summary.total})`);
  const statusParts = [];
  for (const [k, v] of Object.entries(t.summary)) {
    if (k === 'total') continue;
    statusParts.push(`${k}=${v}`);
  }
  lines.push(`${statusParts.join(' | ')}`);
  if (t.inProgress.length > 0) {
    lines.push('', `### ⚙️ In Progress (${t.inProgress.length})`);
    for (const task of t.inProgress) lines.push(`- ${task.subject}`);
  }
  renderPendingTasks(lines, t.pending);
  lines.push('');
}

async function generateHandoff(opts) {
  const { sourcePath, toCwd, message } = opts;
  const o = await buildOverview(sourcePath, { recentPromptCount: 3 });

  const lines = [];
  lines.push(
    `# Session Coordination Handoff`,
    '',
    `**Written**: ${new Date().toISOString()}`,
    // Neutral terms source/target so source is not implied to be the "primary"
    `**Source session (--from)**: ${o.sessionId || '?'} (${o.fileSizeMB} MB)`,
    `**Recipient cwd**: ${toCwd}`,
    `**Message direction**: source → target`,
    '',
  );

  if (o.currentGoal) {
    lines.push(`## 🎯 Current Goal`, `> ${o.currentGoal.condition}`, '');
  }

  if (message) {
    lines.push(`## 📨 Message to recipient`, message, '');
  }

  renderTaskSection(lines, o.tasks);

  if (o.topFilesRanked.length > 0) {
    lines.push(`## 📁 Recently modified files (top 10)`);
    for (const f of o.topFilesRanked.slice(0, 10)) {
      lines.push(`- (${f.editCount}x) ${f.path}`);
    }
    lines.push('');
  }

  if (o.modelSwitches.length > 0) {
    lines.push(`⚠️  source session spans ${o.model.length} models, ${o.modelSwitches.length} switches — cache reset`, '');
  }

  lines.push(`---`, `*by session-handoff.js — source: ${sourcePath}*`);

  return lines.join('\n');
}

/** Resolve --from -> source session path (pure reorg, decision/exit code unchanged) */
function resolveSourcePath(args) {
  const fromIdx = args.indexOf('--from');
  if (fromIdx < 0) {
    console.error('❌ --from <session> required');
    process.exit(1);
  }
  // --from may be followed by --latest or a concrete value
  let fromValue = args[fromIdx + 1];
  if (!fromValue || fromValue.startsWith('--')) {
    // Followed by a flag -> default to --latest
    if (args.includes('--latest')) {
      fromValue = '--latest';
    } else {
      console.error('❌ --from requires a session path/UUID/--latest');
      process.exit(1);
    }
  }
  return resolve(fromValue).path;
}

/** Validate the --to argument: must not be a file path (otherwise error out; decision/exit code unchanged) */
function validateToArg(toCwd) {
  // --to should be a directory, not a file. Detect the common mistake.
  if (toCwd && (toCwd.endsWith('.jsonl') || toCwd.endsWith('.json') || toCwd.endsWith('.md'))) {
    console.error(`❌ handoff: --to should be a directory, not a file (you gave ${toCwd})`);
    console.error(`   --to is the recipient project's cwd (writes to {cwd}/.claude-output/session-coordination.md)`);
    console.error(`   to specify a full output file path, use --output <path>`);
    process.exit(2);
  }
  // Detect an "obvious file path" — exists and isFile
  try {
    if (toCwd && fs.existsSync(toCwd) && fs.statSync(toCwd).isFile()) {
      console.error(`❌ handoff: --to "${toCwd}" is a file, not a directory`);
      console.error(`   --to is the recipient project's cwd; use --output to specify an output file`);
      process.exit(2);
    }
  } catch {}
}

/** Read the first r.cwd from the source session's first 30 lines, or null */
function readCwdFromSession(sourcePath) {
  const head = fs.readFileSync(sourcePath, 'utf8').split('\n').slice(0, 30);
  for (const l of head) {
    try { const r = JSON.parse(l); if (r.cwd) return r.cwd; } catch {}
  }
  return null;
}

/** Resolve the target cwd: validate --to, or read r.cwd from the source session's first 30 lines (pure reorg, decision/exit code unchanged) */
function resolveToCwd(args, sourcePath) {
  let toCwd = null;
  const toIdx = args.indexOf('--to');
  if (toIdx >= 0) {
    toCwd = args[toIdx + 1];
    validateToArg(toCwd);
  }
  if (!toCwd) {
    toCwd = readCwdFromSession(sourcePath);
  }
  if (!toCwd) {
    console.error('❌ target cwd not found (specify with --to <path>)');
    process.exit(1);
  }
  return toCwd;
}

async function main() {
  const args = process.argv.slice(2);
  // Detect unknown flags
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--from', '--to', '--message', '--output', '--no-write'],
    valueFlags: ['--from', '--to', '--message', '--output'],
    scriptName: 'handoff',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-handoff.js — Write a session collaboration handoff

Usage:
  recensa-session handoff --from <session> --message "msg"
  recensa-session handoff --from --latest --message "continue task"
  recensa-session handoff --from <a> --to <b-cwd> --message "msg"
  recensa-session handoff --from <a> --message "msg" --no-write    # print only, do not write a file

Default output path:
  {to-cwd}/.claude-output/session-coordination.md
  to-cwd defaults to the cwd field of the source session's first record; override with --to.
  The full path is printed to stdout on success.

Options:
  --from <session>     source session (path/UUID/--latest)
  --to <cwd>           target cwd (defaults to the source session's cwd)
  --message "msg"      message to the recipient (required)
  --output <path>      specify the full output file path (overrides the default location)
  --no-write           print only, do not write a file`);
    process.exit(0);
  }

  const sourcePath = resolveSourcePath(args);

  const msgIdx = args.indexOf('--message');
  const message = msgIdx >= 0 ? args[msgIdx + 1] : '';

  const toCwd = resolveToCwd(args, sourcePath);

  const content = await generateHandoff({ sourcePath, toCwd, message });

  if (args.includes('--no-write')) {
    console.log(content);
    return;
  }

  const outputIdx = args.indexOf('--output');
  const outDir = path.join(toCwd, '.claude-output');
  const outPath = outputIdx >= 0 ? args[outputIdx + 1]
    : path.join(outDir, 'session-coordination.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  console.log(`✅ Written ${outPath}`);
  console.log(`   ${content.length} chars`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { generateHandoff };
