#!/usr/bin/env node
/**
 * session-parser.js — Claude Code JSONL Session Parser
 *
 * Core parsing engine: streams JSONL without exhausting memory.
 * Fully covers every known event type and produces structured output.
 *
 * Usage:
 *   recensa-session parser <session.jsonl>                    # full parse, prints stats
 *   recensa-session parser <session.jsonl> --messages         # plain conversation (tool output filtered)
 *   recensa-session parser <session.jsonl> --structure        # full structured JSON
 *   recensa-session parser <session.jsonl> --summary          # summary only
 *   recensa-session parser <session.jsonl> --find "keyword"   # search
 *
 * Pipeline usage:
 *   recensa-session parser <session.jsonl> --messages | recensa-session clean --strip-tools
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

// ── Constants ─────────────────────────────────────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TAIL_WINDOW = 64 * 1024; // 64KB tail window (aligns with Claude Code's lite metadata)

// ── Smart tool input summary (avoid printing raw JSON) ─────
// trunc hoisted to module scope for sharing (formatToolInputSummary + smartRecordSummary each defined an identical copy)
function trunc(s, n) {
  return (s && s.length > n) ? s.slice(0, n) + '…' : (s || '');
}

// per-tool input summary formatters (moved verbatim from the original switch-case bodies, behavior unchanged)
function fmtEditInput(input) {
  const p = input.file_path || '';
  const flag = input.replace_all ? ' *all*' : '';
  const delta = (input.old_string != null && input.new_string != null)
    ? ` Δ${input.old_string.length}→${input.new_string.length}c` : '';
  return `${p}${flag}${delta}`;
}
function fmtWriteInput(input) {
  const p = input.file_path || '';
  const size = input.content ? ` +${input.content.length}c` : '';
  return `${p}${size}`;
}
function fmtReadInput(input) {
  const p = input.file_path || '';
  const range = (input.offset || input.limit) ? ` [${input.offset || 0}+${input.limit || '∞'}]` : '';
  return `${p}${range}`;
}
function fmtBashInput(input) {
  const cmd = trunc(input.command || '', 80);
  const desc = input.description ? ` // ${trunc(input.description, 40)}` : '';
  return `${cmd}${desc}`;
}
function fmtGrepInput(input) {
  const p = trunc(input.pattern || '', 60);
  const where = input.path ? ` in ${input.path}` : '';
  const glob = input.glob ? ` glob=${input.glob}` : '';
  return `${p}${where}${glob}`;
}
function fmtGlobInput(input) {
  const pat = input.pattern || '';
  const where = input.path ? ` in ${input.path}` : '';
  return `${pat}${where}`;
}
function fmtAgentInput(input) {
  const desc = trunc(input.description || '', 60);
  const sub = input.subagent_type ? `[${input.subagent_type}] ` : '';
  return `${sub}${desc}`;
}
function fmtAskUserQuestionInput(input, maxLen) {
  const q = input.questions?.[0]?.question || '';
  return trunc(q, maxLen);
}
function fmtSendMessageInput(input, maxLen) {
  const to = input.to || '?';
  const body = trunc(input.message || '', maxLen - 10);
  return `→${to}: ${body}`;
}

// name → formatter dispatch (replaces the switch; name/default mapping is identical to the original cases)
const TOOL_INPUT_FORMATTERS = {
  Edit: fmtEditInput,
  MultiEdit: fmtEditInput,
  NotebookEdit: fmtEditInput,
  Write: fmtWriteInput,
  Read: fmtReadInput,
  TaskCreate: (input, maxLen) => trunc(input.subject || '', maxLen),
  TaskUpdate: (input) => `#${input.taskId || '?'} → ${input.status || input.subject || '?'}`,
  Bash: fmtBashInput,
  Grep: fmtGrepInput,
  Glob: fmtGlobInput,
  WebSearch: (input, maxLen) => trunc(input.query || '', maxLen),
  WebFetch: (input) => input.url || '',
  Agent: fmtAgentInput,
  ToolSearch: (input, maxLen) => trunc(input.query || '', maxLen),
  AskUserQuestion: fmtAskUserQuestionInput,
  SendMessage: fmtSendMessageInput,
  Skill: (input) => `${input.skill || '?'}${input.args ? ' ' + trunc(input.args, 40) : ''}`,
};

function formatToolInputSummary(name, input, maxLen = 100) {
  if (!input || typeof input !== 'object') return '';
  const fmt = TOOL_INPUT_FORMATTERS[name];
  return fmt ? fmt(input, maxLen) : trunc(JSON.stringify(input), maxLen);
}

// ── Smart record summary (one line for --find instead of raw JSON) ─────
/** assistant content blocks → summary fragments (moved verbatim from the original loop, behavior unchanged) */
function summarizeAssistantBlocks(content) {
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue; // skip a null/non-object block (adversarial jsonl)
    if (b.type === 'text') { parts.push(`text="${trunc(b.text, 80)}"`); }
    else if (b.type === 'tool_use') { parts.push(`tool=${b.name}(${formatToolInputSummary(b.name, b.input, 60)})`); }
    else if (b.type === 'thinking') { parts.push(`thinking="${trunc(b.thinking || b.text, 60)}"`); }
  }
  return parts.join(' | ');
}
/** user content blocks → summary fragments (moved verbatim from the original loop, behavior unchanged) */
function summarizeUserBlocks(content) {
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue; // skip a null/non-object block (adversarial jsonl)
    if (b.type === 'text') parts.push(`text="${trunc(b.text, 80)}"`);
    else if (b.type === 'tool_result') parts.push(`tool_result(${b.tool_use_id?.slice(-8) || '?'})`);
    else if (b.type === 'image') parts.push('[image]');
  }
  return parts.join(' | ');
}

function smartRecordSummary(record, maxLen = 200) {
  if (!record) return '';
  const { type, message } = record;
  if (type === 'assistant' && Array.isArray(message?.content)) {
    return trunc(summarizeAssistantBlocks(message.content), maxLen);
  }
  if (type === 'user' && message) {
    const c = message.content;
    if (typeof c === 'string') return `text="${trunc(c, maxLen - 10)}"`;
    if (Array.isArray(c)) {
      return trunc(summarizeUserBlocks(c), maxLen);
    }
  }
  if (type === 'summary') return `summary="${trunc(record.summary, maxLen - 20)}"`;
  if (type === 'tag') return `tag="${record.tag}"`;
  if (type === 'last-prompt') return `last-prompt="${trunc(record.prompt, maxLen - 30)}"`;
  // other metadata: print key fields, not the whole JSON
  const keys = Object.keys(record).filter(k => !['type', 'sessionId', 'uuid', 'parentUuid', 'timestamp'].includes(k));
  return trunc(keys.map(k => `${k}=${JSON.stringify(record[k]).slice(0, 40)}`).join(' '), maxLen);
}

// ── classifyEmptyUser: classify why a user message has no displayable text ──
/** classify array-type empty content; returns null to the caller when nothing matches (moved verbatim from the original Array branch, behavior unchanged) */
function classifyEmptyArrayContent(content) {
  // guard null/non-object elements (adversarial jsonl) so classification never crashes on a bad block
  const onlyToolResult = content.length > 0 && content.every(b => b?.type === 'tool_result');
  if (onlyToolResult) return 'tool_result';
  const texts = content.filter(b => b?.type === 'text').map(b => b.text || '');
  const allText = texts.join('\n');
  if (allText.startsWith('<system-reminder>')) return 'system_reminder';
  if (allText.includes('UserPromptSubmit hook success') || allText.includes('SKILL CHECK:')) return 'hook_feedback';
  if (allText.startsWith('<task-notification>')) return 'task_notification';
  if (allText.startsWith('Stop hook feedback:')) return 'hook_feedback';
  return null;
}

function classifyEmptyUser(content, extractedText, record) {
  // has real text → not empty
  if (extractedText?.trim()) return null;
  if (record.toolUseResult) return 'tool_result';
  if (Array.isArray(content)) {
    const kind = classifyEmptyArrayContent(content);
    if (kind) return kind;
  } else if (typeof content === 'string') {
    if (content.startsWith('<system-reminder>')) return 'system_reminder';
    if (content.startsWith('<task-notification>')) return 'task_notification';
  }
  return 'empty_input';
}

// Event type taxonomy (derived from analysis of real sessions)
const EVENT_TYPES = {
  CONVERSATION: new Set(['user', 'assistant', 'attachment']),
  SYSTEM: new Set(['system']),
  METADATA: new Set([
    'custom-title', 'ai-title', 'last-prompt', 'tag',
    'agent-name', 'agent-color', 'agent-setting',
    'mode', 'worktree-state', 'pr-link', 'permission-mode',
  ]),
  SNAPSHOT: new Set(['file-history-snapshot', 'attribution-snapshot']),
  PROGRESS: new Set(['progress']),
  QUEUE: new Set(['queue-operation']),
  SUMMARY: new Set(['summary']),
  COMPRESSION: new Set(['content-replacement']),
  COLLAPSE: new Set(['marble-origami-commit', 'marble-origami-snapshot']),
};

const ALL_KNOWN = new Set([
  ...EVENT_TYPES.CONVERSATION,
  ...EVENT_TYPES.SYSTEM,
  ...EVENT_TYPES.METADATA,
  ...EVENT_TYPES.SNAPSHOT,
  ...EVENT_TYPES.PROGRESS,
  ...EVENT_TYPES.QUEUE,
  ...EVENT_TYPES.SUMMARY,
  ...EVENT_TYPES.COMPRESSION,
  ...EVENT_TYPES.COLLAPSE,
]);

// ── Token estimation ──────────────────────────────────────
// imported from _utils to avoid a duplicate definition
const { estimateTokens } = require('../lib/util');
const { isNoiseUserMessage, collapseBlocks } = require('../lib/noise');

// ── Core parser ───────────────────────────────────────────

/** time-range filter: returns true when this record should be skipped (moved verbatim from the inline stream check, behavior unchanged) */
function isOutOfTimeRange(record, sinceMs, untilMs) {
  if (!((sinceMs || untilMs) && record.timestamp)) return false;
  const t = new Date(record.timestamp).getTime();
  if (Number.isNaN(t)) return false;
  if (sinceMs && t < sinceMs) return true;
  if (untilMs && t > untilMs) return true;
  return false;
}

class SessionParser {
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.opts = {
      progressFilter: opts.progressFilter || 'none', // none | summary | all
      maxToolOutputLen: opts.maxToolOutputLen || 0,   // 0 = keep all
      includeThinking: opts.includeThinking || false,
      stopAfterMessages: opts.stopAfterMessages || 0,  // 0 = unlimited
      collectMessages: opts.collectMessages !== false, // false = summary/stats/find modes skip accumulating this.messages (stats still tallied)
      ...opts,
    };
    this.reset();
  }

  reset() {
    this.stats = {
      filePath: this.filePath,
      fileSize: 0,
      lineCount: 0,
      messageCount: 0,
      typeCounts: {},
      unknownTypes: new Set(),
      sessionId: null,
      firstTimestamp: null,
      lastTimestamp: null,
      // token stats (read from the assistant message usage field)
      tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      // tool usage stats
      toolUsage: {},
      // model info
      models: new Set(),
      // compact boundary
      compactCount: 0,
      // parent-UUID chain (used to rebuild the conversation tree)
      uuidMap: new Map(),
      orphanCount: 0,
    };
    this.messages = [];      // structured messages (used by --messages / --structure modes)
    this.errors = [];
  }

  /** stream-parse JSONL, invoking the callback for each parsed record */
  async stream(callback) {
    const stat = fs.statSync(this.filePath);
    this.stats.fileSize = stat.size;

    const rl = readline.createInterface({
      input: fs.createReadStream(this.filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    const sinceMs = this.opts.sinceMs || null;
    const untilMs = this.opts.untilMs || null;
    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (!line.trim()) continue;
      const signal = this._processStreamLine(line, lineNum, sinceMs, untilMs, callback);
      if (signal === 'break') break;
    }
    rl.close();
  }

  /** process a single line (parse + time filter + ingest + callback + stopAfter); returns 'break'/'continue'/'ok' (pure reorg, processing order unchanged) */
  _processStreamLine(line, lineNum, sinceMs, untilMs, callback) {
    try {
      const record = JSON.parse(line);
      // time-range filter (need the parsed record to read its timestamp)
      if (isOutOfTimeRange(record, sinceMs, untilMs)) return 'continue';
      this.stats.lineCount++;
      this._ingestRecord(record, lineNum);
      if (callback) {
        // pass the raw line too so callers (e.g. --find) can search the original text without re-serializing the record
        const shouldContinue = callback(record, lineNum, line);
        if (shouldContinue === false) return 'break';
      }
      if (this.opts.stopAfterMessages > 0 &&
          this.stats.messageCount >= this.opts.stopAfterMessages) {
        return 'break';
      }
    } catch (e) {
      this.errors.push({ line: lineNum, error: e.message, snippet: line.slice(0, 100) });
    }
    return 'ok';
  }

  /** internal: update first/last timestamp (moved verbatim from inline _ingestRecord, behavior unchanged) */
  _trackTimestamp(record) {
    if (!record.timestamp) return;
    const ts = new Date(record.timestamp).getTime();
    if (Number.isNaN(ts)) return;
    if (!this.stats.firstTimestamp || ts < this.stats.firstTimestamp) {
      this.stats.firstTimestamp = ts;
    }
    if (!this.stats.lastTimestamp || ts > this.stats.lastTimestamp) {
      this.stats.lastTimestamp = ts;
    }
  }

  /** internal: UUID tracking + orphan count (moved verbatim from inline _ingestRecord; the set-before-has ordering is preserved) */
  _trackUuid(record, lineNum, type) {
    if (!record.uuid) return;
    this.stats.uuidMap.set(record.uuid, {
      type,
      parentUuid: record.parentUuid || null,
      lineNum,
    });
    if (record.parentUuid && !this.stats.uuidMap.has(record.parentUuid)) {
      this.stats.orphanCount++;
    }
  }

  /** internal: ingest one record and update stats */
  _ingestRecord(record, lineNum) {
    const type = record.type || 'unknown';

    // count type distribution
    this.stats.typeCounts[type] = (this.stats.typeCounts[type] || 0) + 1;
    if (!ALL_KNOWN.has(type)) {
      this.stats.unknownTypes.add(type);
    }

    // sessionId
    if (!this.stats.sessionId && record.sessionId) {
      this.stats.sessionId = record.sessionId;
    }

    // time range
    this._trackTimestamp(record);

    // UUID tracking
    this._trackUuid(record, lineNum, type);

    // dispatch by type
    switch (type) {
      case 'user':
        this.stats.messageCount++;
        this._ingestUser(record);
        break;
      case 'assistant':
        this.stats.messageCount++;
        this._ingestAssistant(record);
        break;
      case 'system':
        this._ingestSystem(record);
        break;
      case 'progress':
        this._ingestProgress(record);
        break;
      case 'file-history-snapshot':
        break; // not counted
      case 'summary':
      case 'pr-link':
      case 'custom-title':
      case 'ai-title':
      case 'last-prompt':
      case 'tag':
      case 'agent-name':
      case 'agent-color':
      case 'agent-setting':
      case 'mode':
      case 'worktree-state':
      case 'attachment':
      case 'permission-mode':
      case 'queue-operation':
      case 'content-replacement':
      case 'marble-origami-commit':
      case 'marble-origami-snapshot':
      case 'attribution-snapshot':
        break; // known, no extra handling
      default:
        break;
    }
  }

  _ingestUser(record) {
    if (this.opts.collectMessages === false) return; // summary/stats/find don't read this.messages; user records carry no extra stats
    const content = record.message?.content;
    if (!content) return;
    const text = this._extractText(content);
    if (text && this.opts.progressFilter !== 'none' &&
        (text.startsWith('tool_use_id') || text.includes('[Request interrupted'))) {
      return; // filter out tool results and user interrupts
    }
    // classify why a user message is empty so --user-text-only can print a meaningful label
    const emptyKind = classifyEmptyUser(content, text, record);
    this.messages.push({
      role: 'user',
      type: 'user',
      text: text || '',
      emptyKind, // 'tool_result' | 'system_reminder' | 'task_notification' | 'hook_feedback' | 'empty_input' | null
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      timestamp: record.timestamp,
      isSidechain: record.isSidechain || false,
      hasToolResult: !!record.toolUseResult,
    });
  }

  _ingestAssistant(record) {
    const msg = record.message;
    if (!msg) return;

    // token stats
    const usage = msg.usage;
    if (usage) {
      this.stats.tokenUsage.input += usage.input_tokens || 0;
      this.stats.tokenUsage.output += usage.output_tokens || 0;
      this.stats.tokenUsage.cacheCreate += usage.cache_creation_input_tokens || 0;
      this.stats.tokenUsage.cacheRead += usage.cache_read_input_tokens || 0;
    }

    // model
    if (msg.model) this.stats.models.add(msg.model);

    const content = msg.content || [];
    const textParts = [];
    const toolUses = [];
    const thinkingBlocks = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue; // skip a null/non-object block (adversarial jsonl), never crash
      switch (block.type) {
        case 'text':
          if (block.text) textParts.push(block.text);
          break;
        case 'tool_use':
          toolUses.push({ name: block.name, id: block.id, input: block.input });
          this.stats.toolUsage[block.name] = (this.stats.toolUsage[block.name] || 0) + 1;
          break;
        case 'thinking':
          thinkingBlocks.push(block.thinking || block.text || '');
          break;
      }
    }

    // Token/tool/model stats above are always tallied; only the message array (read by --messages/--structure/
    // --compact/--tool-summary) is skipped for summary/stats/find, which never touch this.messages.
    if (this.opts.collectMessages === false) return;

    const fullText = textParts.join('\n');
    const thinkingText = thinkingBlocks.join('\n');

    this.messages.push({
      role: 'assistant',
      type: 'assistant',
      text: fullText,
      thinking: this.opts.includeThinking ? thinkingText : '',
      hasThinking: thinkingBlocks.length > 0,
      toolUses,
      model: msg.model,
      stopReason: msg.stop_reason,
      tokenUsage: usage ? { ...usage } : null,
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      timestamp: record.timestamp,
      isSidechain: record.isSidechain || false,
    });
  }

  _ingestSystem(record) {
    // recognize compact_boundary and microcompact_boundary (the latter is another compaction record type, documented in the jsonl-format spec)
    if (/compact_boundary/.test(record.subtype || '')) {
      this.stats.compactCount++;
    }
  }

  _ingestProgress(record) {
    if (this.opts.collectMessages === false) return; // keep this.messages empty when message collection is off
    if (this.opts.progressFilter === 'all') {
      const data = record.data;
      if (data?.type === 'agent_progress' && data.prompt) {
        this.messages.push({
          role: 'progress',
          subtype: 'agent',
          text: data.prompt,
          agentId: data.agentId,
          uuid: record.uuid,
          timestamp: record.timestamp,
        });
      }
    }
  }

  _extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
    }
    return '';
  }

  /** produce a summary report */
  summary() {
    const s = this.stats;
    const duration = (s.firstTimestamp && s.lastTimestamp)
      ? s.lastTimestamp - s.firstTimestamp
      : 0;
    return {
      filePath: s.filePath,
      fileSize: s.fileSize,
      fileSizeMB: (s.fileSize / MB).toFixed(2),
      sessionId: s.sessionId,
      lineCount: s.lineCount,
      messageCount: s.messageCount,
      durationMs: duration,
      durationMin: (duration / 60000).toFixed(1),
      firstTimestamp: s.firstTimestamp ? new Date(s.firstTimestamp).toISOString() : null,
      lastTimestamp: s.lastTimestamp ? new Date(s.lastTimestamp).toISOString() : null,
      typeCounts: s.typeCounts,
      unknownTypes: [...s.unknownTypes],
      tokenUsage: s.tokenUsage,
      models: [...s.models],
      toolUsage: s.toolUsage,
      compactCount: s.compactCount,
      uuidCount: s.uuidMap.size,
      orphanCount: s.orphanCount,
      errorCount: this.errors.length,
    };
  }

  /** decide whether user message text is SKILL.md / system-reminder / task-notification noise */
  static isNoiseText(text, { noSkillMd = false, noSystemReminder = false, noTaskNotification = false } = {}) {
    if (!text) return false;
    if (noSystemReminder && (text.startsWith('<system-reminder>') ||
        text.includes('UserPromptSubmit hook success') ||
        text.includes('SKILL CHECK:'))) {
      return true;
    }
    if (noTaskNotification && text.startsWith('<task-notification>')) {
      return true;
    }
    if (noSkillMd) {
      // pattern: 50+ consecutive lines of markdown headers + frontmatter
      const lines = text.split('\n');
      if (lines.length > 50) {
        const headerCount = lines.filter(l => /^#{1,6}\s/.test(l)).length;
        const hasFrontmatter = lines[0] === '---' && lines.slice(1, 10).some(l => l.startsWith('name:') || l.startsWith('description:'));
        if (hasFrontmatter || headerCount > 10) return true;
      }
    }
    return false;
  }

  /** get the filtered plain-text conversation */
  getConversationText(opts = {}) {
    const { noSkillMd, noSystemReminder, noTaskNotification, dialogue, collapse, collapseMin } = opts;
    return this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !(dialogue && isNoiseUserMessage(m)))   // both-sides-clean: drop user-side noise (tool_result-only / compaction summaries / caveat), keep all assistant
      .filter(m => !SessionParser.isNoiseText(m.text, { noSkillMd, noSystemReminder, noTaskNotification }))
      // filter by emptyKind (user messages that are genuinely noise)
      .filter(m => {
        if (m.role !== 'user' || !m.emptyKind) return true;
        if (noSystemReminder && (m.emptyKind === 'system_reminder' || m.emptyKind === 'hook_feedback')) return false;
        if (noTaskNotification && m.emptyKind === 'task_notification') return false;
        return true;
      })
      .map(m => {
        const prefix = m.role === 'user' ? '👤 User' : '🤖 Assistant';
        let text = m.text || '';
        // assistant tool-only / thinking-only turn → print a tool summary instead of an empty string
        if (m.role === 'assistant' && !text) {
          if (m.toolUses && m.toolUses.length > 0) {
            text = '[tools] ' + m.toolUses.map(tu =>
              `${tu.name}(${formatToolInputSummary(tu.name, tu.input, 60)})`
            ).join(' | ');
          } else if (m.hasThinking) {
            text = '[thinking only]';
          }
        }
        // add a classification label to empty user messages
        if (m.role === 'user' && !text && m.emptyKind) {
          const labels = {
            tool_result: '[tool_result only]',
            system_reminder: '[filtered: system-reminder]',
            hook_feedback: '[hook-triggered]',
            task_notification: '[task-notification]',
            empty_input: '[empty input]',
          };
          text = labels[m.emptyKind] || '[empty]';
        }
        // opt-in block collapsing (tool calls / slash-command / system-reminder / frontmatter / long fences → placeholders)
        if (collapse) text = collapseBlocks(text, { minFenceLines: collapseMin });
        // truncate overly long tool output
        if (m.role === 'user' && m.hasToolResult && this.opts.maxToolOutputLen > 0) {
          if (text.length > this.opts.maxToolOutputLen) {
            text = text.slice(0, this.opts.maxToolOutputLen) +
              `\n... [${estimateTokens(text.slice(this.opts.maxToolOutputLen))} tokens truncated]`;
          }
        }
        return `${prefix}: ${text}`;
      })
      // filter out empty user messages (pure tool_result follow-ups that user-text-only mode should not print)
      .filter(s => {
        if (!noSkillMd && !noSystemReminder && !noTaskNotification) return true;
        // user-text-only enabled → filter out empty prefix lines
        return !/^(👤 User|🤖 Assistant): \s*$/.test(s.trim());
      })
      .join('\n\n---\n\n');
  }

  /** tool-summary mode: list only tool_use name + smart input summary */
  getToolSummary({ maxInputChars = 100, types = null } = {}) {
    const lines = [];
    for (const m of this.messages) {
      if (m.role !== 'assistant' || !m.toolUses || m.toolUses.length === 0) continue;
      for (const tu of m.toolUses) {
        if (types && !types.includes(tu.name)) continue;
        const summary = formatToolInputSummary(tu.name, tu.input, maxInputChars);
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '?';
        lines.push(`${ts}  ${tu.name.padEnd(15)}  ${summary}`);
      }
    }
    return lines.join('\n');
  }

  /** get conversation text (uses token estimation to trim tool output) */
  getCompactConversation(maxTokens = 50000) {
    const lines = [];
    let tokenCount = 0;
    for (const msg of this.messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      // uniform prefix format (aligned with getConversationText)
      const prefix = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
      let text = msg.text || '';

      // tool results: truncate to a reasonable length
      if (msg.role === 'user' && msg.hasToolResult && text.length > 2000) {
        text = text.slice(0, 2000) + '\n[tool output truncated]';
      }

      const line = `${prefix}: ${text}`;
      const lineTokens = estimateTokens(line);
      if (tokenCount + lineTokens > maxTokens) break;
      tokenCount += lineTokens;
      lines.push(line);
    }
    return lines.join('\n\n');
  }
}

// ── CLI entry ─────────────────────────────────────────────

// single source of truth for flag definitions (--help + validateArgs known/valueFlags all derive from this; exported for the session-help-sync lint)
const PARSER_FLAGS = [
  { name: '--messages', group: 'mode', desc: 'output plain-text conversation (pairs well with --user-text-only)' },
  { name: '--structure', group: 'mode', desc: 'output structured JSON' },
  { name: '--summary', group: 'mode', desc: 'output summary only' },
  { name: '--compact', group: 'mode', desc: 'output a condensed conversation (<= 50000 tokens)' },
  { name: '--tool-summary', group: 'mode', desc: 'list tool_use only (name + input summary)' },
  { name: '--find', group: 'mode', value: 'str', desc: 'search (substring, case-insensitive, matches the whole JSON string)' },
  { name: '--user-text-only', group: 'filter', desc: 'keep human conversation only (= --no-skill-md + --no-system-reminder + --no-task-notification)' },
  { name: '--dialogue', group: 'filter', desc: 'both-sides-clean conversation: keep user+assistant but drop user-side noise (tool_result-only / compaction summaries / caveat / reminder). For distilling genuine human review reflexes (implies the three no-* flags)' },
  { name: '--collapse-blocks', group: 'filter', desc: 'in-message tool calls / slash-command markers / system-reminder / skill & command frontmatter / long code fences → placeholders (denoise, opt-in, off by default = full original text)' },
  { name: '--collapse-min', group: 'filter', value: 'N', desc: 'with --collapse-blocks: only collapse code fences of >= N lines (default 8)' },
  { name: '--no-skill-md', group: 'filter', desc: 'exclude whole SKILL.md blocks pulled in via Read (heuristic)' },
  { name: '--no-system-reminder', group: 'filter', desc: 'exclude <system-reminder> blocks' },
  { name: '--no-task-notification', group: 'filter', desc: 'exclude <task-notification> blocks' },
  { name: '--filter-type', group: 'filter', value: 'user|assistant|tool_use|tool_result', desc: 'parse only the given type' },
  { name: '--include-thinking', group: 'filter', desc: 'keep thinking blocks' },
  { name: '--strip-progress', group: 'filter', desc: 'skip progress events' },
  { name: '--brief', group: 'filter', desc: '--find mode: one condensed line per record' },
  { name: '--since', group: 'filter', value: '7d|1h|ISO', desc: 'only records after this time (for exited sessions, based on file mtime)' },
  { name: '--until', group: 'filter', value: '7d|1h|ISO', desc: 'only records before this time' },
  { name: '--max-tool-output', group: 'filter', value: 'N', desc: 'truncate tool output longer than N characters' },
  { name: '--max-messages', group: 'filter', value: 'N', desc: 'process only the first N messages' },
  { name: '--max-tool-input', group: 'filter', value: 'N', desc: 'tool-summary: input summary cap (default 100)' },
  { name: '--tool-types', group: 'filter', value: 'n1,n2', desc: 'tool-summary: list only the given tool names' },
];

/** --help output (moved verbatim from inline main, output unchanged) */
function printParserHelp() {
  const fmt = (f) => { const l = f.name + (f.value ? ` <${f.value}>` : ''); return `  ${l.padEnd(34)}${l.length >= 34 ? '  ' : ''}${f.desc}`; };
  const byGroup = (g) => PARSER_FLAGS.filter(f => f.group === g).map(fmt).join('\n');
  console.log(`session-parser.js — Claude Code JSONL Session Parser

Usage: recensa-session parser <session> [flags]
  session = absolute path / short UUID prefix (>=6) / --latest / --latest-in "fragment"

Modes (choose one, default stats):
${byGroup('mode')}

Filter options:
${byGroup('filter')}

Search syntax (--find):
  --find 'Edit'                 substring: records containing 'Edit' (i.e. tool_use Edit)
  --find '"type":"user"'        JSON substring: find user messages
  --find '"name":"TaskCreate"'  find TaskCreate tool_use
  note: substring match (case-insensitive); key=value syntax is not supported`);
}

/** mode selection (replaces the nested ternary, decision order unchanged) */
function selectMode(args) {
  if (args.includes('--messages')) return 'messages';
  if (args.includes('--structure')) return 'structure';
  if (args.includes('--summary')) return 'summary';
  if (args.includes('--compact')) return 'compact';
  if (args.includes('--tool-summary')) return 'tool-summary';
  return 'stats';
}

/** parse CLI flag values (moved verbatim from inline main, logic unchanged) */
function parseParserArgs(args) {
  const findIdx = args.indexOf('--find');
  const maxToolIdx = args.indexOf('--max-tool-output');
  const maxMsgIdx = args.indexOf('--max-messages');
  const filterTypeIdx = args.indexOf('--filter-type');
  const filterType = filterTypeIdx >= 0 ? args[filterTypeIdx + 1] : null;
  const maxToolInputIdx = args.indexOf('--max-tool-input');
  const maxToolInput = maxToolInputIdx >= 0 ? Number.parseInt(args[maxToolInputIdx + 1]) || 100 : 100;
  const toolTypesIdx = args.indexOf('--tool-types');
  const toolTypes = toolTypesIdx >= 0 ? args[toolTypesIdx + 1].split(',').map(s => s.trim()) : null;
  // --user-text-only = --no-skill-md + --no-system-reminder + --no-task-notification
  const userTextOnly = args.includes('--user-text-only');
  const dialogue = args.includes('--dialogue');
  const collapse = args.includes('--collapse-blocks');
  const collapseMinIdx = args.indexOf('--collapse-min');
  const collapseMin = collapseMinIdx >= 0 ? (Number(args[collapseMinIdx + 1]) || 8) : 8;
  const noSkillMd = userTextOnly || dialogue || args.includes('--no-skill-md');
  const noSystemReminder = userTextOnly || dialogue || args.includes('--no-system-reminder');
  const noTaskNotification = userTextOnly || dialogue || args.includes('--no-task-notification');
  const maxToolOutputLen = maxToolIdx >= 0 ? Number.parseInt(args[maxToolIdx + 1]) || 0 : 0;
  const stopAfterMessages = maxMsgIdx >= 0 ? Number.parseInt(args[maxMsgIdx + 1]) || 0 : 0;
  return {
    findIdx, filterType, maxToolInput, toolTypes, dialogue, collapse, collapseMin,
    noSkillMd, noSystemReminder, noTaskNotification, maxToolOutputLen, stopAfterMessages,
  };
}

/** --find mode (moved verbatim from inline main, output unchanged) */
async function runFindMode(parser, args, findIdx, filterType) {
  const query = args[findIdx + 1];
  if (!query) {
    console.error(`❌ --find requires a search string
examples:
  --find 'Edit'                  find records containing 'Edit'
  --find '"type":"user"'         find user messages
  --find '"name":"TaskCreate"'   find TaskCreate tool_use
note: substring match (case-insensitive); key=value syntax is not supported`);
    process.exit(1);
  }
  // detect suspicious syntax: users may assume --find supports key=value
  if (/^\w+=\w+$/.test(query.trim()) || /^\w+:\w+$/.test(query.trim())) {
    console.error(`⚠️  "${query}" looks like key=value syntax, but --find does a substring match.`);
    console.error(`   try:   --find '"${query.split(/[=:]/)[0]}":"${query.split(/[=:]/)[1]}"'`);
    console.error(`   or:    --filter-type ${query.split(/[=:]/)[1]}`);
    console.error(``);
  }
  const queryLower = query.toLowerCase();
  const briefMode = args.includes('--brief');
  let matches = [];
  await parser.stream((record, lineNum, rawLine) => {
    if (filterType && record.type !== filterType) return true;
    // search the raw JSONL line directly (already in hand) instead of re-serializing the parsed record every time
    const text = rawLine.toLowerCase();
    if (text.includes(queryLower)) {
      const summary = smartRecordSummary(record);
      matches.push({ lineNum, summary, timestamp: record.timestamp, type: record.type });
      const ts = record.timestamp ? new Date(record.timestamp).toISOString().slice(11, 19) : '?';
      if (briefMode) {
        process.stdout.write(`L${String(lineNum).padStart(5)}  ${ts}  ${(record.type || 'unknown').padEnd(11)}  ${summary}\n`);
      } else {
        process.stdout.write(`\n📌 Line ${lineNum} [${record.type}] ${record.timestamp || ''}\n${summary}\n`);
        process.stdout.write('─'.repeat(80) + '\n');
      }
    }
  });
  if (matches.length === 0) {
    console.error(`\n🔍 Found 0 matches for "${query}"`);
    console.error(`hint: --find is a substring match. try:`);
    console.error(`  --find '"name":"${query}"'    # find a tool name`);
    console.error(`  --find '"type":"${query}"'    # find a record type`);
  } else {
    console.log(`\n🔍 Found ${matches.length} matches for "${query}"`);
  }
}

/** output according to mode (moved verbatim from the original main switch, output unchanged) */
function printParserOutput(parser, mode, ctx) {
  switch (mode) {
    case 'messages':
      console.log(parser.getConversationText({
        noSkillMd: ctx.noSkillMd,
        noSystemReminder: ctx.noSystemReminder,
        noTaskNotification: ctx.noTaskNotification,
        dialogue: ctx.dialogue,
        collapse: ctx.collapse,
        collapseMin: ctx.collapseMin,
      }));
      break;
    case 'compact':
      console.log(parser.getCompactConversation());
      break;
    case 'tool-summary':
      console.log(parser.getToolSummary({ maxInputChars: ctx.maxToolInput, types: ctx.toolTypes }));
      break;
    case 'structure':
      console.log(JSON.stringify({
        summary: parser.summary(),
        messages: parser.messages,
        errors: parser.errors,
      }, null, 2));
      break;
    case 'summary':
    case 'stats':
    default:
      console.log(JSON.stringify(parser.summary(), null, 2));
      break;
  }
}

async function main() {
  const args = process.argv.slice(2);
  // single source of truth: flag definitions live here; --help and validateArgs known/valueFlags all derive from it
  // add a new flag only here → help + validation stay in sync, curing the "added a flag but forgot the help" drift (PARSER_FLAGS is exported for the lint to verify)
  const known = PARSER_FLAGS.map(f => f.name);
  const valueFlags = PARSER_FLAGS.filter(f => f.value).map(f => f.name);

  // unknown-flag detection
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, { known, valueFlags, scriptName: 'parser' });

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printParserHelp();
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

  const mode = selectMode(args);
  const opts = parseParserArgs(args);

  // time range (for exited sessions, baseMs defaults to the file mtime)
  const { parseTimeRange } = require('../lib/resolver');
  const { sinceMs, untilMs, baseSource } = parseTimeRange(args, { sessionPath: filePath });
  if (args.includes('--since') || args.includes('--until')) {
    console.error(`ℹ️  time basis: ${baseSource === 'session-mtime' ? 'session last-modified time (exited session)' : 'current time (active session)'}`);
  }

  // summary/stats/find never read this.messages; only messages/structure/compact/tool-summary do → skip the array otherwise
  const collectMessages = opts.findIdx < 0 && ['messages', 'structure', 'compact', 'tool-summary'].includes(mode);

  const parser = new SessionParser(filePath, {
    includeThinking: args.includes('--include-thinking'),
    progressFilter: args.includes('--strip-progress') ? 'none' : 'summary',
    maxToolOutputLen: opts.maxToolOutputLen,
    stopAfterMessages: opts.stopAfterMessages,
    collectMessages,
    sinceMs,
    untilMs,
  });

  if (opts.findIdx >= 0) {
    await runFindMode(parser, args, opts.findIdx, opts.filterType);
    return;
  }

  await parser.stream();

  // corrupt-jsonl notice
  if (parser.errors.length > 0) {
    const samples = parser.errors.slice(0, 3).map(e => `L${e.line}`).join(', ');
    const more = parser.errors.length > 3 ? `, ... +${parser.errors.length - 3}` : '';
    console.error(`⚠️  ${parser.errors.length} lines with JSON parse errors, skipped: ${samples}${more}`);
  }
  // empty-session notice
  if (parser.stats.lineCount === 0) {
    console.error(`⚠️ empty session (0 valid records) — file: ${filePath}`);
  }

  printParserOutput(parser, mode, opts);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { SessionParser, estimateTokens, EVENT_TYPES, ALL_KNOWN, formatToolInputSummary, smartRecordSummary, PARSER_FLAGS };
