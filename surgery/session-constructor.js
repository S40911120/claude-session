#!/usr/bin/env node
/**
 * session-constructor.js — build a valid Claude Code session from scratch
 *
 * Produces a complete JSONL session file with a correct UUID chain and all required fields.
 * The resulting session can be loaded directly with `claude --resume <sessionId>`.
 *
 * Usage:
 *   recensa-session construct --new --project /path/to/project      create a blank session
 *   recensa-session construct --from-context ctx.json --output s.jsonl  build a session from context
 *   recensa-session construct --inject ctx.json --target s.jsonl    inject context into an existing session
 *
 * Programmatic use:
 *   const { createSession, addMessage, injectContext } = require('./session-constructor');
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uuid4 } = require('../lib/uuid-engine');
const { encodeProjectPath, parseJsonlSync, stringifyRecord } = require('../lib/util');
const { resolveProjectsDir } = require('../lib/resolver');

// ── Constants ─────────────────────────────────────────────

const CLAUDE_PROJECTS = resolveProjectsDir();

const { atomicWrite } = require('../lib/atomic-write');

// ── Message factory ───────────────────────────────────────

function makeUserMessage(text, opts = {}) {
  return {
    type: 'user',
    uuid: opts.uuid || uuid4(),
    parentUuid: opts.parentUuid || null,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp || new Date().toISOString(),
    isSidechain: opts.isSidechain || false,
    cwd: opts.cwd,
    userType: 'external',
    message: {
      role: 'user',
      content: typeof text === 'string'
        ? [{ type: 'text', text }]
        : text,
    },
  };
}

function makeAssistantMessage(text, opts = {}) {
  return {
    type: 'assistant',
    uuid: opts.uuid || uuid4(),
    parentUuid: opts.parentUuid || null,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp || new Date().toISOString(),
    isSidechain: opts.isSidechain || false,
    cwd: opts.cwd,
    message: {
      id: opts.messageId || 'msg_' + uuid4().replaceAll('-', '').slice(0, 24),
      type: 'message',
      role: 'assistant',
      model: opts.model || 'claude-sonnet-4-6',
      content: typeof text === 'string'
        ? [{ type: 'text', text }]
        : text,
      stop_reason: opts.stopReason || 'end_turn',
      stop_sequence: null,
      usage: opts.usage || { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function makeSystemMessage(content, opts = {}) {
  return {
    type: 'system',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp || new Date().toISOString(),
    subtype: opts.subtype || 'local_command',
    content,
    isMeta: opts.isMeta || false,
  };
}

function makeContextInjection(contextData, opts = {}) {
  const summary = [
    `[Cross-session context injection]`,
    `Source session: ${contextData.sessionId || 'unknown'}`,
    `Time: ${contextData.extractedAt || new Date().toISOString()}`,
    '',
    '## Task background',
    ...(contextData.tasks || []).slice(0, 10).map((t, i) => `${i + 1}. ${t}`),
    '',
    '## User requests',
    ...(contextData.userRequests || []).slice(0, 5).map((r, i) => `${i + 1}. ${r}`),
    '',
    '## Key decisions',
    ...(contextData.decisions || []).slice(0, 10).map((d, i) => `${i + 1}. ${d}`),
    '',
    '## Technical info',
    `Models: ${(contextData.model || []).join(', ')}`,
    `Token: input ${contextData.tokenUsage?.input || 0} / output ${contextData.tokenUsage?.output || 0}`,
    `Duration: ${((contextData.duration || 0) / 60000).toFixed(0)} minutes`,
  ].join('\n');

  return {
    type: 'user',
    uuid: opts.uuid || uuid4(),
    parentUuid: opts.parentUuid || null,
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    userType: 'external',
    message: {
      role: 'user',
      content: [{ type: 'text', text: summary }],
    },
  };
}

// ── Session builder ───────────────────────────────────────

/**
 * Build a minimal valid session and write it to disk.
 * @returns {{ sessionId, filePath }}
 */
function createSession(projectPath, opts = {}) {
  const sessionId = opts.sessionId || uuid4();
  const now = new Date().toISOString();
  const cwd = projectPath;

  const records = [
    {
      type: 'last-prompt',
      sessionId,
      timestamp: now,
      lastPrompt: opts.firstPrompt || 'Session started',
    },
  ];

  if (opts.title) {
    records.push({
      type: 'custom-title',
      sessionId,
      timestamp: now,
      customTitle: opts.title,
    });
  }

  // if there's an initial message, add the first message
  if (opts.initialMessage) {
    const userMsg = makeUserMessage(opts.initialMessage, { sessionId, cwd, timestamp: now });
    const assistantMsg = makeAssistantMessage(
      opts.initialResponse || 'Ready.',
      { sessionId, cwd, timestamp: now, parentUuid: userMsg.uuid }
    );
    records.push(userMsg, assistantMsg);
  }

  // write to disk
  const encoded = encodeProjectPath(projectPath);
  const dir = path.join(CLAUDE_PROJECTS, encoded);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  atomicWrite(filePath, content);

  return { sessionId, filePath, projectEncoded: encoded };
}

/**
 * Build a session whose content is a context injection, from context data.
 */
function createFromContext(contextData, projectPath, opts = {}) {
  const sessionId = opts.sessionId || uuid4();
  const now = new Date().toISOString();
  const cwd = projectPath;

  const records = [
    { type: 'last-prompt', sessionId, timestamp: now, lastPrompt: contextData.userRequests?.[0] || 'Context restored' },
    { type: 'custom-title', sessionId, timestamp: now, customTitle: opts.title || `Context: ${contextData.sessionId?.slice(0, 8)}` },
  ];

  // Context injection as user message
  const ctxMsg = makeContextInjection(contextData, { sessionId, parentUuid: null });
  records.push(ctxMsg);

  // Assistant acknowledgment
  const ackMsg = makeAssistantMessage(
    `Loaded context from session ${contextData.sessionId?.slice(0, 8)}.\n\n` +
    `Includes ${contextData.tasks?.length || 0} tasks and ${contextData.decisions?.length || 0} decision records.`,
    { sessionId, cwd, timestamp: now, parentUuid: ctxMsg.uuid }
  );
  records.push(ackMsg);

  const encoded = encodeProjectPath(projectPath);
  const dir = path.join(CLAUDE_PROJECTS, encoded);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  atomicWrite(filePath, content);

  return { sessionId, filePath, projectEncoded: encoded, records };
}

/**
 * Inject context into an existing session JSONL (inserted after the compact_boundary).
 * Does not modify the original file; produces a new file.
 */
function injectContext(targetPath, contextData, opts = {}) {
  // malformed lines (rare) kept as {_raw} and written back verbatim on output
  const records = parseJsonlSync(targetPath);

  const sessionId = records.find(r => r.sessionId)?.sessionId || uuid4();

  // find the position of the last compact_boundary
  let insertIdx = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'system' && records[i].subtype === 'compact_boundary') {
      insertIdx = i + 1;
      break;
    }
  }

  // find the parentUuid for the insertion point (the uuid of the last conversation record)
  let lastConvUuid = null;
  for (let i = insertIdx - 1; i >= 0; i--) {
    const r = records[i];
    if (['user', 'assistant', 'system', 'attachment'].includes(r.type) && r.uuid) {
      lastConvUuid = r.uuid;
      break;
    }
  }

  // build the context injection message
  const ctxMsg = makeContextInjection(contextData, {
    sessionId,
    uuid: uuid4(),
    parentUuid: lastConvUuid,
  });

  const ackUuid = uuid4();
  const ackMsg = makeAssistantMessage(
    `[Context injected from session ${contextData.sessionId?.slice(0, 8)}]`,
    { sessionId, parentUuid: ctxMsg.uuid, uuid: ackUuid }
  );

  // compact boundary marker
  const boundary = makeSystemMessage('', {
    sessionId,
    parentUuid: ackUuid,
    subtype: 'compact_boundary',
    isMeta: true,
  });

  const result = [
    ...records.slice(0, insertIdx),
    ctxMsg,
    ackMsg,
    boundary,
    ...records.slice(insertIdx),
  ];

  // fix the parentUuid of the next record cut off by the boundary
  // the first conversation record after a compact_boundary should have parentUuid pointing at the boundary (or null)
  // actual Claude Code behavior: records after a boundary have parentUuid null (the start of a new segment)

  const outputPath = opts.output || targetPath.replace('.jsonl', '-injected.jsonl');
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const content = result.map(stringifyRecord).join('\n') + '\n';
  atomicWrite(outputPath, content);

  return { outputPath, injectedAt: insertIdx, records: result };
}

// ── CLI ────────────────────────────────────────────────────

function runNew(args, projectPath) {
  const titleIdx = args.indexOf('--title');
  const msgIdx = args.indexOf('--msg');
  const result = createSession(projectPath, {
    title: titleIdx >= 0 ? args[titleIdx + 1] : undefined,
    initialMessage: msgIdx >= 0 ? args[msgIdx + 1] : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  console.error(`✅ Session created: claude --resume ${result.sessionId}`);
}

function runFromContext(args, projectPath) {
  const ctxIdx = args.indexOf('--from-context');
  const ctxPath = args[ctxIdx + 1];
  if (!fs.existsSync(ctxPath)) {
    console.error(`❌ not found: ${ctxPath}`);
    process.exit(1);
  }
  const context = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
  const titleIdx = args.indexOf('--title');
  const result = createFromContext(context, projectPath, {
    title: titleIdx >= 0 ? args[titleIdx + 1] : undefined,
  });
  console.log(JSON.stringify({ sessionId: result.sessionId, filePath: result.filePath }, null, 2));
  console.error(`✅ Context session created: claude --resume ${result.sessionId}`);
}

function runInject(args) {
  const ctxIdx = args.indexOf('--inject');
  const targetIdx = args.indexOf('--target');
  const outIdx = args.indexOf('--output');
  const ctxPath = args[ctxIdx + 1];
  const targetPath = targetIdx >= 0 ? args[targetIdx + 1] : null;

  if (!ctxPath || !fs.existsSync(ctxPath)) {
    console.error(`❌ context not found: ${ctxPath}`);
    process.exit(1);
  }
  if (!targetPath || !fs.existsSync(targetPath)) {
    console.error(`❌ target not found: ${targetPath}`);
    process.exit(1);
  }

  const context = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
  const result = injectContext(targetPath, context, {
    output: outIdx >= 0 ? args[outIdx + 1] : undefined,
  });
  console.log(JSON.stringify({ outputPath: result.outputPath, injectedAt: result.injectedAt }, null, 2));
  console.error(`✅ context injected: ${result.outputPath}`);
}

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--new', '--from-context', '--inject', '--target', '--project', '--title', '--msg', '--output'],
    valueFlags: ['--from-context', '--inject', '--target', '--project', '--title', '--msg', '--output'],
    scriptName: 'constructor',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-constructor.js — build a valid Claude Code session from scratch

Usage:
  recensa-session construct --new --project /path/to/project
  recensa-session construct --new --project /path --title "Title" --msg "First message"
  recensa-session construct --from-context ctx.json --project /path
  recensa-session construct --inject ctx.json --target session.jsonl

Options:
  --project    project path (required for --new / --from-context; not needed for --inject)
  --title      session title
  --msg        initial user message
  --output     output path (overrides the default)`);
    process.exit(0);
  }

  const projectIdx = args.indexOf('--project');
  const projectPath = projectIdx >= 0 ? args[projectIdx + 1] : null;
  const requireProject = () => {
    if (!projectPath) {
      console.error('❌ this mode requires --project <path>');
      process.exit(1);
    }
  };

  if (args.includes('--new')) {
    requireProject();
    runNew(args, projectPath);
  }
  else if (args.includes('--from-context')) {
    requireProject();
    runFromContext(args, projectPath);
  }
  else if (args.includes('--inject')) {
    runInject(args);
  }
  else {
    console.error('❌ please specify --new, --from-context, or --inject');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createSession, createFromContext, injectContext, makeUserMessage, makeAssistantMessage, makeContextInjection, encodeProjectPath };
