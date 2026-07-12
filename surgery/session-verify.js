#!/usr/bin/env node
/**
 * session-verify.js — full validity check for session resume
 *
 * Runs every check at once and tells you whether this JSONL can be loaded by `claude --resume`.
 * Covers UUID chain integrity, required fields, schema validity, and compact-boundary correctness.
 *
 * Checklist (24 items):
 *   [1]  file exists and is readable
 *   [2]  at least one record
 *   [3]  all lines are valid JSON
 *   [4]  sessionId consistent across the file
 *   [5]  the first conversation record has parentUuid null
 *   [6]  all parentUuid point to existing UUIDs (no orphans)
 *   [7]  no cycles in the UUID chain
 *   [8]  no duplicate UUIDs
 *   [9]  every conversation record has its required fields
 *   [10] timestamps are valid ISO 8601
 *   [11] compact_boundary has the correct subtype
 *   [12] assistant messages have model and usage
 *   [13] the last conversation record is not an orphan tool_use
 *   [14] content-replacement records are complete
 *   [15] reasonable file size
 *   [16] tool_use/tool_result fully paired (hard API 400 error)
 *   [17] compact boundary not deleted (the last one must survive)
 *   [18] isSidechain subagent reference integrity
 *   [19] cache safety (cache-miss impact of the first request after edits)
 *   [20] user message block-type validity (tool_use only allowed in assistant, per the Anthropic API spec)
 *   [21] conversation survival
 *   [22] thinking blocks intact (empty text + signature = a known Claude Code bug)
 *   [23] parentUuid not self-referencing (no self-loop)
 *   [24] overall resume-readiness assessment
 *
 * Usage:
 *   recensa-session verify <session.jsonl>            full validation
 *   recensa-session verify <session.jsonl> --json      JSON output
 *   recensa-session verify <session.jsonl> --quiet     print pass/fail only
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateChain, validateRecord } = require('../lib/uuid-engine');
const { collectAssistantToolUseIds, collectUserToolResultRefs, collectResultsBeforeNextTurn } = require('../lib/tool-blocks');

// ── Individual checks (each returns a check object) ───────

function statusIcon(s) {
  if (s === 'pass') return '✅';
  if (s === 'warn') return '⚠️';
  return '❌';
}

// [3] valid JSON
function buildJsonCheck(records, lines, jsonErrors) {
  if (jsonErrors > 0) {
    return {
      id: 3, name: 'valid JSON',
      status: jsonErrors > lines.length * 0.1 ? 'fail' : 'warn',
      message: `${jsonErrors}/${lines.length} lines failed to parse`,
      detail: records.filter(r => r._error).slice(0, 3).map(r => `line ${r._line}: ${r._error}`).join('; '),
    };
  }
  return { id: 3, name: 'valid JSON', status: 'pass', detail: `${lines.length} lines all passed` };
}

// [4] sessionId consistent across the file
function checkSessionId(records) {
  const sessionIds = new Set();
  for (const r of records) {
    if (r.sessionId) sessionIds.add(r.sessionId);
  }
  if (sessionIds.size === 0) {
    return { id: 4, name: 'sessionId present', status: 'fail', message: 'no sessionId found' };
  }
  if (sessionIds.size > 1) {
    return {
      id: 4, name: 'sessionId consistent',
      status: 'warn',
      message: `${sessionIds.size} distinct sessionIds: ${[...sessionIds].slice(0, 5).join(', ')}`,
      detail: 'resuming across files is valid, but older Claude Code versions may not support it',
    };
  }
  return { id: 4, name: 'sessionId consistent', status: 'pass', detail: [...sessionIds][0] };
}

// [5] the first conversation record has parentUuid null (at least one chain root)
function checkChainRoot(records, chainReport) {
  const hasConvRecords = records.some(r => ['user', 'assistant'].includes(r.type));
  let status = 'pass';
  if (hasConvRecords) status = chainReport.stats.chains > 0 ? 'pass' : 'fail';
  return {
    id: 5, name: 'first parentUuid is null',
    status,
    detail: hasConvRecords ? `${chainReport.stats.chains} chains` : 'no conversation records',
    message: status === 'fail' ? 'every conversation record has a parentUuid → the chain root is missing, resume will fail' : undefined,
  };
}

// [6] no orphan parentUuid (lenient for fork sessions: warn)
function checkOrphans(chainReport, isFork, forkSuffix) {
  let status = 'pass';
  if (chainReport.stats.orphans !== 0) status = isFork ? 'warn' : 'fail';
  return {
    id: 6, name: 'no orphan parentUuid',
    status,
    message: chainReport.stats.orphans > 0 ? `${chainReport.stats.orphans} orphan references${forkSuffix}` : undefined,
  };
}

// [7] no UUID chain cycles
function checkCycles(chainReport, isFork, forkSuffix) {
  let status = 'pass';
  if (chainReport.stats.cycles !== 0) status = isFork ? 'warn' : 'fail';
  return {
    id: 7, name: 'no UUID chain cycles',
    status,
    message: chainReport.stats.cycles > 0 ? `${chainReport.stats.cycles} cycles${forkSuffix}` : undefined,
  };
}

// [8] no duplicate UUIDs
function checkDuplicates(chainReport, isFork, forkSuffix) {
  let status = 'pass';
  if (chainReport.stats.duplicates !== 0) status = isFork ? 'warn' : 'fail';
  return {
    id: 8, name: 'no duplicate UUIDs',
    status,
    message: chainReport.stats.duplicates > 0 ? `${chainReport.stats.duplicates} duplicate UUIDs${forkSuffix}` : undefined,
  };
}

// [9] required fields present
function checkRequiredFields(records) {
  let fieldErrors = 0;
  for (let i = 0; i < records.length; i++) {
    const errs = validateRecord(records[i], i);
    const severe = errs.filter(e => e.severity === 'error');
    if (severe.length > 0) fieldErrors++;
  }
  return {
    id: 9, name: 'required fields present',
    status: fieldErrors === 0 ? 'pass' : 'fail',
    message: fieldErrors > 0 ? `${fieldErrors} records are missing required fields` : undefined,
  };
}

// [10] timestamp validity + roughly increasing
function checkTimestamps(records) {
  let tsErrors = 0;
  let tsBackward = 0;
  let lastTs = 0;
  for (const r of records) {
    if (r.timestamp) {
      const ts = new Date(r.timestamp).getTime();
      if (Number.isNaN(ts)) {
        tsErrors++;
      } else if (lastTs > 0 && ts < lastTs - 60000) {
        // going back more than 1 minute (heuristic; JSONL is append-only, tolerate 1 min of NTP drift)
        tsBackward++;
      }
      if (ts > 0) lastTs = ts;
    }
  }
  let status = 'pass';
  if (tsErrors > 0) status = 'fail';
  else if (tsBackward > 3) status = 'warn';
  let message;
  if (tsErrors > 0) message = `${tsErrors} invalid timestamps`;
  else if (tsBackward > 0) message = `${tsBackward} backward time jumps`;
  return { id: 10, name: 'timestamp valid', status, message };
}

// [11] compact_boundary correctness
function checkCompactBoundary(records) {
  let compactOk = true;
  let compactCount = 0;
  for (const r of records) {
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      compactCount++;
      if (!r.timestamp) compactOk = false;
    }
  }
  return {
    id: 11, name: 'compact boundary correct',
    status: compactOk ? 'pass' : 'fail',
    detail: compactCount > 0 ? `${compactCount} compact boundaries` : 'no compact',
  };
}

// [12] assistant messages have model and usage
function checkAssistantComplete(records) {
  let assistantIssues = 0;
  for (const r of records) {
    if (r.type === 'assistant') {
      if (!r.message?.model) assistantIssues++;
      if (!r.message?.usage) assistantIssues++;
    }
  }
  return {
    id: 12, name: 'assistant message complete',
    status: assistantIssues === 0 ? 'pass' : 'warn',
    message: assistantIssues > 0 ? `${assistantIssues} missing model/usage` : undefined,
    detail: 'missing model/usage does not affect resume, but affects cost tracking',
  };
}

// [13] the last record must not be an orphan tool_use
function checkLastToolUse(records) {
  const lastConv = records.findLast(r => ['user', 'assistant'].includes(r.type));
  let lastToolOk = true;
  if (lastConv?.type === 'assistant' && Array.isArray(lastConv.message?.content)) {
    const hasToolUse = lastConv.message.content.some(b => b.type === 'tool_use');
    const hasText = lastConv.message.content.some(b => b.type === 'text');
    if (hasToolUse && !hasText) lastToolOk = false;
  }
  return {
    id: 13, name: 'no orphan tool_use at the end',
    status: lastToolOk ? 'pass' : 'warn',
    message: lastToolOk ? undefined : 'the last assistant has only tool_use and no text — resume may trigger interruption detection',
  };
}

// number of issues in a single content-replacement record (a structural miss counts as 1, otherwise counted per replacement)
function countReplacementIssues(r) {
  if (!r.replacements || !Array.isArray(r.replacements)) return 1;
  let issues = 0;
  for (const rep of r.replacements) {
    if (!rep.toolUseId || rep.replacement === undefined) issues++;
  }
  return issues;
}

// [14] content-replacement integrity
function checkContentReplacement(records) {
  let crIssues = 0;
  for (const r of records) {
    if (r.type === 'content-replacement') {
      crIssues += countReplacementIssues(r);
    }
  }
  return {
    id: 14, name: 'content-replacement complete',
    status: crIssues === 0 ? 'pass' : 'warn',
    message: crIssues > 0 ? `${crIssues} issues` : undefined,
  };
}

// [15] reasonable file size
function checkFileSize(sessionPath) {
  const fileSize = fs.statSync(sessionPath).size;
  const sizeStatus = fileSize > 500 * 1024 * 1024 ? 'warn' : 'pass';
  return {
    id: 15, name: 'reasonable file size',
    status: sizeStatus,
    message: sizeStatus === 'warn' ? `file too large (${(fileSize / (1024 * 1024)).toFixed(0)} MB), resume may be slow` : undefined,
    detail: `${(fileSize / (1024 * 1024)).toFixed(2)} MB`,
  };
}

// [16] tool_use/tool_result pairing — collect use/result ids and orphan sets
// (collectAssistantToolUseIds / collectUserToolResultRefs live in lib/tool-blocks, shared with repair + merger)
function collectToolPairs(records) {
  const toolUseIds = collectAssistantToolUseIds(records);
  const toolResultRefs = collectUserToolResultRefs(records);
  const orphanedToolUses = [...toolUseIds].filter(id => !toolResultRefs.has(id));
  const orphanedToolResults = [...toolResultRefs].filter(id => !toolUseIds.has(id));
  return { toolUseIds, toolResultRefs, orphanedToolUses, orphanedToolResults };
}

function markVerifyViolations(index, toolUsesInTurn, resultsBeforeNextTurn, orderViolations) {
  for (const id of toolUsesInTurn) {
    if (!resultsBeforeNextTurn.has(id)) {
      orderViolations.push({ index, toolUseId: id, reason: 'missing_before_next_turn' });
    }
  }
}

function detectVerifyOrderViolations(records) {
  const orderViolations = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const toolUsesInTurn = r.message.content
      .filter(b => b.type === 'tool_use' && b.id)
      .map(b => b.id);
    if (toolUsesInTurn.length === 0) continue;
    // collectResultsBeforeNextTurn (lib/tool-blocks) returns reachedNextTurn; alias to the local nextTurnStart name
    const { resultsBeforeNextTurn, reachedNextTurn: nextTurnStart } = collectResultsBeforeNextTurn(records, i);
    // if we reach EOF before a new turn with no match → handled by [13] (orphan tool_use at the end)
    if (!nextTurnStart && resultsBeforeNextTurn.size === 0) continue;
    markVerifyViolations(i, toolUsesInTurn, resultsBeforeNextTurn, orderViolations);
  }
  return orderViolations;
}

function pairingMessage(status, orphanedToolUses, orphanedToolResults, orderViolations, toolUseIds, toolResultRefs) {
  if (status === 'fail') {
    if (orphanedToolUses.length > 0) {
      return `❌ ${orphanedToolUses.length} tool_use missing their tool_result (the API returns 400) → run repair --fix orphan-tool-uses`;
    }
    return `❌ ${orderViolations.length} tool_use whose tool_result does not appear in the next user message (the API returns 400) → run repair --fix order-violations`;
  }
  if (status === 'warn') {
    return `⚠️ ${orphanedToolResults.length} orphan tool_result (Claude Code filters them out automatically) → run repair --fix orphan-tool-results`;
  }
  return `✅ ${toolUseIds.size} tool_use, ${toolResultRefs.size} tool_result, all paired and ordered correctly`;
}

function pairingDetail(status, orphanedToolUses, orphanedToolResults, orderViolations) {
  if (status === 'pass') return undefined;
  let base;
  if (orphanedToolUses.length > 0) {
    base = `tool_use missing a tool_result: ${orphanedToolUses.slice(0, 5).join(', ')}`;
  } else {
    base = `out-of-order tool_use: ${orderViolations.slice(0, 5).map(v => v.toolUseId).join(', ')}`;
  }
  const extra = orphanedToolResults.length > 0 ? ` | orphan tool_result: ${orphanedToolResults.length}` : '';
  return base + extra;
}

function checkToolPairing(records) {
  const { toolUseIds, toolResultRefs, orphanedToolUses, orphanedToolResults } = collectToolPairs(records);

  let pairingStatus;
  if (orphanedToolUses.length === 0 && orphanedToolResults.length === 0) pairingStatus = 'pass';
  else if (orphanedToolUses.length > 0) pairingStatus = 'fail';
  else pairingStatus = 'warn';

  const orderViolations = detectVerifyOrderViolations(records);
  const orderOk = orderViolations.length === 0;
  // [16] not lenient for forks: a violation is a real API 400 risk and must be fixed by repair
  const finalPairingStatus = pairingStatus === 'pass' && !orderOk ? 'fail' : pairingStatus;

  return {
    id: 16, name: 'tool_use/tool_result fully paired + correctly ordered',
    status: finalPairingStatus,
    message: pairingMessage(finalPairingStatus, orphanedToolUses, orphanedToolResults, orderViolations, toolUseIds, toolResultRefs),
    detail: pairingDetail(finalPairingStatus, orphanedToolUses, orphanedToolResults, orderViolations),
  };
}

// [17] compact boundary safety
function checkCompactSafety(records) {
  const compactBoundaries = records
    .map((r, i) => ({ ...r, _idx: i }))
    .filter(r => r.type === 'system' && r.subtype === 'compact_boundary');
  const compactSummaries = records.filter(r =>
    r.type === 'user' && r.isCompactSummary
  ).length;

  let cbStatus = 'pass';
  if (compactBoundaries.length > 0) {
    if (compactSummaries === 0) cbStatus = 'warn';
    else cbStatus = compactSummaries >= compactBoundaries.length ? 'pass' : 'warn';
  }

  let message;
  if (cbStatus === 'warn') {
    message = `${compactBoundaries.length} compact boundaries but only ${compactSummaries} compact summaries — a summary may have been deleted`;
  } else if (compactBoundaries.length > 0) {
    message = `${compactBoundaries.length} boundaries, ${compactSummaries} summaries — normal`;
  } else {
    message = 'no compact boundary (no risk)';
  }

  return {
    id: 17, name: 'compact boundary integrity',
    status: cbStatus,
    message,
    detail: cbStatus === 'warn'
      ? 'deleting a compact boundary causes already-compacted old messages to flood back into context'
      : undefined,
  };
}

// [18] isSidechain subagent reference integrity
function checkSidechain(records) {
  const sidechainMsgs = records.filter(r => r.isSidechain);
  const agentIds = new Set(sidechainMsgs.map(r => r.agentId).filter(Boolean));
  const hasOrphanedSidechain = sidechainMsgs.some(r => !r.agentId);

  let message;
  if (sidechainMsgs.length > 0) {
    const orphanNote = hasOrphanedSidechain ? ' (some missing agentId)' : '';
    message = `${sidechainMsgs.length} sidechain messages, ${agentIds.size} distinct agents` + orphanNote;
  } else {
    message = 'no sidechain messages';
  }

  return {
    id: 18, name: 'isSidechain subagent references',
    status: hasOrphanedSidechain ? 'warn' : 'pass',
    message,
    detail: hasOrphanedSidechain
      ? 'sidechain messages missing an agentId may be routed to the wrong subagent file on resume'
      : undefined,
  };
}

// [19] cache safety assessment
function collectModels(records) {
  const models = new Set();
  for (const r of records) {
    if (r.type === 'assistant' && r.message?.model) models.add(r.message.model);
  }
  return models;
}

function collectCacheBreakingEdits(records) {
  // per Anthropic: editing files loaded into the prompt prefix (CLAUDE.md / settings / MCP config) → cache invalidation
  const cacheBreakingPaths = [
    /(?:^|[\\/])CLAUDE\.md$/i,              // CLAUDE.md anywhere
    /\.claude[\\/]rules[\\/]/i,             // .claude/rules/*
    /\.claude[\\/]memory[\\/]/i,            // .claude/memory/*
    /\.claude[\\/]settings.*\.json$/i,      // .claude/settings*.json
    /\.mcp.*\.json$/i,                      // MCP server config
  ];
  const edits = [];
  for (const r of records) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const block of r.message.content) {
      if (block.type !== 'tool_use' || !['Write', 'Edit'].includes(block.name)) continue;
      const fp = block.input?.file_path || block.input?.filePath || '';
      if (cacheBreakingPaths.some(re => re.test(fp))) edits.push(fp);
    }
  }
  return edits;
}

function checkCacheSafety(records) {
  const cacheRisks = [];
  const models = collectModels(records);
  if (models.size > 1) {
    cacheRisks.push(`${models.size} distinct models (each switch fully resets the cache)`);
  }
  const claudeMdEdits = collectCacheBreakingEdits(records);
  if (claudeMdEdits.length > 0) {
    cacheRisks.push(`CLAUDE.md was edited during the session (all subsequent cache invalidated)`);
  }

  const cacheStat = cacheRisks.length === 0 ? 'pass' : 'warn';
  return {
    id: 19, name: 'cache safety',
    status: cacheStat,
    message: cacheStat === 'pass'
      ? 'no obvious cache-invalidation risk'
      : cacheRisks.join('; '),
    detail: cacheStat === 'warn'
      ? 'the first resume request after edits gets no cache hits at all; input tokens are billed in full'
      : undefined,
  };
}

// [20] user message block-type validity
function checkUserBlockTypes(records) {
  const mixedBlockMessages = [];
  for (const r of records) {
    if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
    const hasToolUse = r.message.content.some(b => b.type === 'tool_use');
    const hasToolResult = r.message.content.some(b => b.type === 'tool_result');
    if (hasToolUse) {
      mixedBlockMessages.push({ uuid: r.uuid, reason: 'tool_use_in_user' });
    }
    if (hasToolUse && hasToolResult) {
      mixedBlockMessages.push({ uuid: r.uuid, reason: 'mixed' });
    }
  }
  return {
    id: 20, name: 'user message block-type validity',
    status: mixedBlockMessages.length === 0 ? 'pass' : 'fail',
    message: mixedBlockMessages.length === 0
      ? '✅ all user messages contain only valid block types'
      : `❌ ${mixedBlockMessages.length} user messages contain a tool_use block (the API requires tool_use only in assistant messages)`,
    detail: mixedBlockMessages.length > 0
      ? mixedBlockMessages.slice(0, 3).map(m => `${m.uuid?.slice(0,8)}: ${m.reason}`).join(', ')
      : undefined,
  };
}

// [21] conversation survival check
function checkConversationSurvival(records) {
  const userCount = records.filter(r => r.type === 'user').length;
  const asstCount = records.filter(r => r.type === 'assistant').length;
  const survivalStatus = records.length >= 5 && (userCount === 0 || asstCount === 0)
    ? 'fail' : 'pass';
  return {
    id: 21, name: 'conversation survival',
    status: survivalStatus,
    message: survivalStatus === 'fail'
      ? `❌ the session has ${records.length} records but user=${userCount}, assistant=${asstCount} — the conversation structure is incomplete`
      : `✅ user=${userCount}, assistant=${asstCount}`,
  };
}

// [22] empty thinking blocks (empty text + signature → resume API 400)
function checkEmptyThinking(records) {
  let emptyThinkingCount = 0;
  for (const r of records) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const block of r.message.content) {
      if (block.type !== 'thinking') continue;
      const text = block.thinking || block.text || '';
      if (!text.trim() && !!block.signature) emptyThinkingCount++;
    }
  }
  return {
    id: 22, name: 'thinking blocks intact',
    status: emptyThinkingCount === 0 ? 'pass' : 'warn',
    message: emptyThinkingCount === 0
      ? '✅ no empty thinking blocks'
      : `⚠️ ${emptyThinkingCount} empty thinking blocks (empty text + a signature — resume may return API 400) → run repair --fix empty-thinking`,
  };
}

// [23] parentUuid self-reference (self-loop)
function checkSelfLoop(records) {
  let selfLoopCount = 0;
  for (const r of records) {
    if (r.uuid && r.parentUuid && r.uuid === r.parentUuid) selfLoopCount++;
  }
  return {
    id: 23, name: 'parentUuid not self-referencing',
    status: selfLoopCount === 0 ? 'pass' : 'fail',
    message: selfLoopCount === 0
      ? '✅ no self-loop'
      : `❌ ${selfLoopCount} records have parentUuid pointing at themselves (resume will hang or cycle) → run repair --fix broken-parent-chain`,
  };
}

// [24] resume-readiness summary (based on the fail/warn counts of all prior checks)
function checkResumeReady(checks) {
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  let status = 'fail';
  let message;
  if (failCount === 0 && warnCount === 0) {
    status = 'pass';
    message = '✅ this session can be safely loaded by claude --resume';
  } else if (failCount === 0) {
    status = 'warn';
    message = `⚠️ resumable, but there are ${warnCount} warnings to note`;
  } else {
    message = `❌ ${failCount} errors, ${warnCount} warnings — resume may fail or lose context`;
  }
  return { id: 24, name: 'resume ready', status, message };
}

// ── Main validation ───────────────────────────────────────

function verify(sessionPath) {
  const checks = [];
  const startTime = Date.now();

  // [1] file exists and is readable
  let raw;
  try {
    if (!fs.existsSync(sessionPath)) {
      checks.push({ id: 1, name: 'file exists', status: 'fail', message: `not found: ${sessionPath}` });
      return finalize(checks, startTime);
    }
    raw = fs.readFileSync(sessionPath, 'utf8');
    checks.push({ id: 1, name: 'file exists and is readable', status: 'pass' });
  } catch (e) {
    checks.push({ id: 1, name: 'file readable', status: 'fail', message: e.message });
    return finalize(checks, startTime);
  }

  // [2] at least one record
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    checks.push({ id: 2, name: 'at least one record', status: 'fail', message: 'file is empty' });
    return finalize(checks, startTime);
  }
  checks.push({ id: 2, name: 'at least one record', status: 'pass', detail: `${lines.length} lines` });

  // [3] all lines are valid JSON
  const records = [];
  let jsonErrors = 0;
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (e) {
      jsonErrors++;
      records.push({ _raw: lines[i], _error: e.message, _line: i + 1 });
    }
  }
  checks.push(buildJsonCheck(records, lines, jsonErrors));

  // fork-session detection: the first record has forkedFrom → the entire parent history snapshot was copied in
  // valid structure but triggers [06]/[07]/[08] false positives, so those checks are downgraded to warn
  const isFork = records.length > 0 && !!records[0].forkedFrom;
  const forkInfo = isFork ? {
    parentSessionId: records[0].forkedFrom.sessionId,
    forkPointUuid: records[0].forkedFrom.messageUuid,
  } : null;
  const forkSuffix = isFork ? ` (forked from ${forkInfo.parentSessionId.slice(0, 8)} — parent history is structural and valid)` : '';

  const chainReport = validateChain(records);

  // [4]-[23] individual checks (order = display order)
  const batchChecks = [
    checkSessionId(records),
    checkChainRoot(records, chainReport),
    checkOrphans(chainReport, isFork, forkSuffix),
    checkCycles(chainReport, isFork, forkSuffix),
    checkDuplicates(chainReport, isFork, forkSuffix),
    checkRequiredFields(records),
    checkTimestamps(records),
    checkCompactBoundary(records),
    checkAssistantComplete(records),
    checkLastToolUse(records),
    checkContentReplacement(records),
    checkFileSize(sessionPath),
    checkToolPairing(records),
    checkCompactSafety(records),
    checkSidechain(records),
    checkCacheSafety(records),
    checkUserBlockTypes(records),
    checkConversationSurvival(records),
    checkEmptyThinking(records),
    checkSelfLoop(records),
  ];
  // [24] resume-readiness summary (based on all prior check stats, including this batch)
  checks.push(...batchChecks, checkResumeReady([...checks, ...batchChecks]));

  return finalize(checks, startTime);
}

function finalize(checks, startTime) {
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const passCount = checks.filter(c => c.status === 'pass').length;

  let status = 'PASS';
  if (failCount > 0) status = 'FAIL';
  else if (warnCount > 0) status = 'WARN';

  return {
    status,
    summary: { total: checks.length, pass: passCount, warn: warnCount, fail: failCount },
    durationMs: Date.now() - startTime,
    checks,
  };
}

// ── CLI ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const { validateArgs } = require('../lib/argv');
  validateArgs(args, {
    known: ['--json', '--quiet'],
    valueFlags: [],
    scriptName: 'verify',
  });
  if (args.length === 0 || args.includes('--help')) {
    console.log(`session-verify.js — full validity check for session resume

Usage:
  recensa-session verify <session.jsonl>            full validation (24 checks)
  recensa-session verify <session.jsonl> --json     JSON output
  recensa-session verify <session.jsonl> --quiet    print PASS/FAIL/WARN only

24 checks (per the Anthropic API spec and Claude Code behavior):
  [1] file exists & readable  [9]  required fields present     [17] compact boundary integrity
  [2] at least one record     [10] timestamp valid             [18] isSidechain references
  [3] valid JSON              [11] compact boundary correct    [19] cache safety
  [4] sessionId consistent    [12] assistant complete          [20] user block-type validity
  [5] first parentUuid        [13] no orphan tool_use          [21] conversation survival
  [6] no orphan parentUuid    [14] content-replacement ok      [22] thinking blocks intact
  [7] no UUID chain cycles    [15] reasonable file size        [23] parentUuid not self-ref
  [8] no duplicate UUID       [16] tool_use/tool_result pairing [24] resume ready`);
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
  const result = verify(filePath);

  if (args.includes('--quiet')) {
    console.log(result.status);
    process.exit(result.status === 'PASS' ? 0 : 1);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const icon = statusIcon;

  console.log(`\n🔍 Session resume validation report`);
  console.log(`File: ${path.basename(filePath)}`);
  console.log(`Status: ${result.status}  |  ${result.summary.pass}✅ ${result.summary.warn}⚠️ ${result.summary.fail}❌  |  ${result.durationMs}ms`);
  console.log('─'.repeat(60));

  for (const check of result.checks) {
    const id = String(check.id).padStart(2, '0');
    console.log(`  ${icon(check.status)} [${id}] ${check.name}`);
    if (check.message) console.log(`      ${check.message}`);
    if (check.detail && check.status !== 'pass') console.log(`      ${check.detail}`);
  }

  console.log(`\n${result.checks[result.checks.length - 1]?.message || ''}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { verify };
