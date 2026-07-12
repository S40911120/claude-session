/**
 * util.js — shared recensa-session utilities (unified foundation for intel + surgery)
 *
 * Merges the former intel/_utils (estimateTokens) and surgery/_utils (parseJsonl / project-path
 * encoding / conversation classification / protected types) into a single source of truth.
 */

'use strict';

const fs = require('node:fs');

// ── Token estimation (character heuristic) ──────────────────────────────
// English ~4 chars/token, CJK ~1 char/token; `conservative` matches Claude Code microCompact's 4/3 safety multiplier
function estimateTokens(text, { conservative = false } = {}) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) tokens += 1;       // CJK
    else if (code >= 0x3040 && code <= 0x30FF) tokens += 1;  // Hiragana/Katakana
    else if (code >= 0xAC00 && code <= 0xD7AF) tokens += 1;  // Hangul
    else tokens += 0.25;
  }
  return conservative ? Math.ceil(tokens * 4 / 3) : Math.ceil(tokens);
}

// ── JSONL parsing (synchronous variant) ───────────────────────────────
// Replaces the raw.split('\n').filter().map(JSON.parse) pattern scattered across 9+ call sites
function parseJsonlSync(filePathOrRaw, { isPath = true } = {}) {
  const raw = isPath ? fs.readFileSync(filePathOrRaw, 'utf8') : filePathOrRaw;
  return raw.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch (e) { return { _raw: l, _error: e.message }; }
  });
}

// ── Malformed-line sentinel serialization ───────────────────────────
// parseJsonlSync represents a line that failed JSON.parse as a { _raw, _error } sentinel (the original
// text, not a real record). Output maps that should round-trip such a line VERBATIM (session merge,
// extract-type) test with isRawSentinel and emit r._raw via stringifyRecord instead of re-encoding the
// wrapper. NOTE: extractRange deliberately does NOT use this — it keeps the {_raw}-only form and
// JSON.stringify's it so a malformed record surfaces as {"_raw":...} in ranged output (see session-merger).
function isRawSentinel(r) {
  return !!r && typeof r === 'object' && typeof r._raw === 'string';
}

function stringifyRecord(r) {
  return isRawSentinel(r) ? r._raw : JSON.stringify(r);
}

// ── Project path encoding ──────────────────────────────────────────
// Claude Code's sanitization rule: non-alphanumeric → hyphen; overly long names get a djb2 hash suffix
function encodeProjectPath(projectPath) {
  if (!projectPath || projectPath.trim() === '') return 'unnamed-project';
  let encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
  if (!encoded) return 'unnamed-project';
  if (encoded.length > 200) {
    let hash = 5381;
    for (let i = 0; i < projectPath.length; i++) {
      hash = ((hash << 5) + hash + projectPath.charCodeAt(i)) | 0;
    }
    encoded = encoded.slice(0, 180) + '-' + Math.abs(hash).toString(36);
  }
  return encoded;
}

// ── Conversation / structure classification ────────────────────────────────────────
// Conversation chain = the record types to follow when walking parentUuid
// Note: system and attachment are not part of the conversation chain
//   - system: e.g. compact_boundary; parentUuid is null and resets the chain
//   - attachment: metadata, not on the chain
const CONVERSATION_TYPES = new Set(['user', 'assistant']);
const SIDECHAIN_TYPES = new Set(['system', 'attachment']);

function isConversationRecord(record) {
  return CONVERSATION_TYPES.has(record?.type);
}

function isSidechainRecord(record) {
  return SIDECHAIN_TYPES.has(record?.type);
}

// ── Protected metadata types (Single Source of Truth) ─────
// These types are never deleted by any surgery operation:
//   - marble-origami-*: context-collapse state
//   - context-collapse-*: newer naming
//   - content-replacement: tool-output replacement records
//   - summary: compaction summary
//   - custom-title/ai-title/last-prompt: UI display metadata
// Both SKILL.md and references/safety-rules.md reference this constant to avoid duplication
const PROTECTED_METADATA_TYPES = new Set([
  'marble-origami-commit', 'marble-origami-snapshot',
  'context-collapse-commit', 'context-collapse-snapshot',
  'content-replacement',
  'summary', 'custom-title', 'ai-title', 'last-prompt',
]);

function isProtectedMetadata(record) {
  return PROTECTED_METADATA_TYPES.has(record?.type);
}

module.exports = {
  estimateTokens,
  parseJsonlSync,
  isRawSentinel,
  stringifyRecord,
  encodeProjectPath,
  CONVERSATION_TYPES,
  SIDECHAIN_TYPES,
  PROTECTED_METADATA_TYPES,
  isConversationRecord,
  isSidechainRecord,
  isProtectedMetadata,
};
