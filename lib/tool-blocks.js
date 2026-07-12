/**
 * tool-blocks.js — shared tool_use / tool_result block collectors
 *
 * Byte-identical collectors that were previously copied across surgery/session-verify,
 * surgery/session-repair and surgery/session-merger. Extracted verbatim (behavior-exact) so the
 * three commands share one implementation of the tool-pairing scan.
 */

'use strict';

// collect every assistant tool_use id in the session
function collectAssistantToolUseIds(records) {
  const ids = new Set();
  for (const r of records) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block.type === 'tool_use' && block.id) ids.add(block.id);
      }
    }
  }
  return ids;
}

// collect every tool_use_id referenced by a user tool_result block
function collectUserToolResultRefs(records) {
  const refs = new Set();
  for (const r of records) {
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) refs.add(block.tool_use_id);
      }
    }
  }
  return refs;
}

// scan from after startIdx up to the next external user prompt, collecting tool_result ids along the way.
// returns { resultsBeforeNextTurn: Set, reachedNextTurn: boolean } (reachedNextTurn=false ⇒ hit EOF first)
function collectResultsBeforeNextTurn(records, startIdx) {
  const resultsBeforeNextTurn = new Set();
  let reachedNextTurn = false;
  for (let j = startIdx + 1; j < records.length; j++) {
    const rj = records[j];
    if (rj.type === 'user' && rj.userType === 'external' && !rj.toolUseResult) {
      reachedNextTurn = true;
      break;
    }
    if (rj.type === 'user' && Array.isArray(rj.message?.content)) {
      for (const b of rj.message.content) {
        if (b.type === 'tool_result' && b.tool_use_id) resultsBeforeNextTurn.add(b.tool_use_id);
      }
    }
  }
  return { resultsBeforeNextTurn, reachedNextTurn };
}

module.exports = {
  collectAssistantToolUseIds,
  collectUserToolResultRefs,
  collectResultsBeforeNextTurn,
};
