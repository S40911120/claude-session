#!/usr/bin/env node
/**
 * uuid-engine.js — session UUID-chain operation engine
 *
 * The foundation layer for all session structure operations. Contains no I/O; pure functions.
 *
 * Capabilities:
 *   - Validate UUID-chain integrity (orphans, cycles, duplicates, broken links)
 *   - Batch UUID remapping (for fork)
 *   - parentUuid chain repair (rebuild after deleting messages)
 *   - Structural validity checks (minimum fields, type correctness)
 *   - UUID generation (v4 + turn_ prefix format)
 *
 * Usage:
 *   const UuidEngine = require('./uuid-engine');
 *   const report = UuidEngine.validateChain(records);
 *   const remapped = UuidEngine.remapAll(records);
 *   const repaired = UuidEngine.repairChain(records, deletedUuids);
 */

'use strict';

const crypto = require('node:crypto');
const { isConversationRecord } = require('./util');

// ── UUID generation ─────────────────────────────────────────────

function uuid4() {
  return crypto.randomUUID();
}

/** The turn_ prefix format commonly used internally by Claude Code */
function turnUuid() {
  return 'turn_' + crypto.randomUUID();
}

// ── Required-field validation (minimum valid structure per type) ────────────

const REQUIRED_FIELDS = {
  user:       ['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'message'],
  assistant:  ['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'message'],
  system:     ['type', 'sessionId', 'timestamp'],
  summary:    ['type', 'sessionId', 'timestamp'],
  'custom-title': ['type', 'sessionId'],
  'ai-title': ['type', 'sessionId'],
  'last-prompt': ['type', 'sessionId'],  // lastPrompt is optional (older versions may omit it)
  tag:        ['type', 'sessionId', 'tag'],
  'pr-link':  ['type', 'sessionId'],
  'file-history-snapshot': ['type', 'messageId'],
  'queue-operation': ['type', 'sessionId', 'timestamp', 'operation'],
  'content-replacement': ['type', 'sessionId'],
  'marble-origami-commit': ['type', 'sessionId'],
  'marble-origami-snapshot': ['type', 'sessionId'],
  'attribution-snapshot': ['type', 'sessionId'],
  'agent-name': ['type', 'sessionId', 'agentName'],
  'agent-color': ['type', 'sessionId'],
  'agent-setting': ['type', 'sessionId'],
  mode:       ['type', 'sessionId', 'mode'],
  'worktree-state': ['type', 'sessionId'],
  'permission-mode': ['type', 'permissionMode'],
  progress:   ['type', 'sessionId', 'timestamp'],
  attachment: ['type', 'sessionId'],
};

function validateRecord(record, index) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return [{ index, severity: 'error', message: 'not a valid JSON object' }];
  }
  const type = record.type;
  if (!type) {
    errors.push({ index, severity: 'error', message: 'missing type field' });
    return errors;
  }
  const required = REQUIRED_FIELDS[type];
  if (!required) {
    errors.push({ index, severity: 'warning', message: `unknown type: ${type}` });
    return errors; // do not block unknown types (forward compat)
  }
  for (const field of required) {
    if (record[field] === undefined || record[field] === null) {
      // parentUuid may be null (marks the chain start)
      if (field === 'parentUuid' && record[field] === null) continue;
      errors.push({ index, severity: 'error', message: `${type}: missing required field ${field}` });
    }
  }
  return errors;
}

// ── UUID-chain validation ───────────────────────────────────────────

// Pass 1: collect every UUID (any type) and check for duplicates
// Collect all records that have a uuid, because a conversation record's parentUuid may point at other types such as attachment
function collectUuids(records, issues, stats) {
  const uuidSet = new Set();
  const parentRefs = new Map(); // parentUuid → [child records]
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r.uuid) continue;
    if (isConversationRecord(r)) stats.conversations++;

    if (uuidSet.has(r.uuid)) {
      issues.push({
        severity: 'error',
        type: 'duplicate_uuid',
        index: i,
        message: `duplicate UUID: ${r.uuid} (previously seen in this UUID chain)`,
        uuid: r.uuid,
      });
      stats.duplicates++;
    }
    uuidSet.add(r.uuid);

    if (r.parentUuid !== undefined && r.parentUuid !== null) {
      if (!parentRefs.has(r.parentUuid)) {
        parentRefs.set(r.parentUuid, []);
      }
      parentRefs.get(r.parentUuid).push({ index: i, uuid: r.uuid });
    }
  }
  return { uuidSet, parentRefs };
}

// Pass 2: check orphan references (conversation-chain members only)
function checkOrphanRefs(records, uuidSet, issues, stats) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!isConversationRecord(r)) continue;
    if (r.parentUuid && !uuidSet.has(r.parentUuid)) {
      issues.push({
        severity: 'warning',
        type: 'orphan_parent',
        index: i,
        message: `parentUuid ${r.parentUuid} points at a non-existent UUID`,
        uuid: r.uuid,
        parentUuid: r.parentUuid,
      });
      stats.orphans++;
    }
  }
}

// Pass 3: detect cycles (walk from each conversation-chain root)
function detectCycles(records, parentRefs, issues, stats) {
  const roots = findRoots(records);
  stats.chains = roots.length;

  // Iterative DFS over every branch (each sibling must be visited in fork scenarios), using an explicit
  // stack instead of recursion so a long linear parentUuid chain (~7k+ nodes, e.g. autoLinkChain in a big
  // merge) can't overflow the call stack. Split into helpers to keep each function's cognitive complexity
  // low; cycle detection (path/visited sets) + issue reporting + stats.cycles are unchanged.
  const ctx = { records, parentRefs, issues, stats, visited: new Set(), reportedCycles: new Set() };
  for (const root of roots) walkChainFromRoot(root, ctx);

  // Rooted walks alone miss a ROOTLESS cycle (e.g. A.parent=B, B.parent=A with no null-parent root):
  // with no entry root its nodes stay unvisited and the loop is silently reported valid. After the rooted
  // pass, also walk from any still-unvisited conversation node so every node is covered and such a closed
  // loop is caught. Nodes already reached from a root are skipped via ctx.visited, so the rooted-chain
  // behavior and stats.chains (roots.length) are unchanged.
  for (const r of records) {
    if (isConversationRecord(r) && r.uuid && !ctx.visited.has(r.uuid)) walkChainFromRoot(r, ctx);
  }
}

// Walk one root's subtree with an explicit stack. An 'exit' frame runs after a node's whole subtree,
// mirroring the recursive pathSet.delete backtracking; pathSet holds the uuids on the current path.
function walkChainFromRoot(root, ctx) {
  const pathSet = new Set();
  const stack = [{ exit: false, node: root }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.exit) { pathSet.delete(frame.uuid); continue; }
    const node = frame.node;
    if (!node) continue;
    if (pathSet.has(node.uuid)) { reportCycle(node, ctx); continue; }
    if (ctx.visited.has(node.uuid)) continue; // already visited from another root
    pathSet.add(node.uuid);
    ctx.visited.add(node.uuid);
    stack.push({ exit: true, uuid: node.uuid }); // backtrack marker: pops after the whole subtree
    pushChildFrames(stack, ctx.parentRefs.get(node.uuid), ctx.records);
  }
}

// Report a UUID-chain cycle at most once per uuid.
function reportCycle(node, ctx) {
  if (ctx.reportedCycles.has(node.uuid)) return;
  ctx.reportedCycles.add(node.uuid);
  ctx.issues.push({
    severity: 'error',
    type: 'cycle',
    message: `UUID chain cycle: ${node.uuid}`,
    uuid: node.uuid,
  });
  ctx.stats.cycles++;
}

// Push a node's children in reverse so the explicit stack processes them in original (forward) order.
function pushChildFrames(stack, children, records) {
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    stack.push({ exit: false, node: records[children[i].index] });
  }
}

/**
 * Validate the UUID-chain integrity of an entire session.
 * Returns { valid, issues[], stats }
 */
function validateChain(records) {
  const issues = [];
  const stats = { total: records.length, conversations: 0, orphans: 0, cycles: 0, duplicates: 0, chains: 0 };

  const { uuidSet, parentRefs } = collectUuids(records, issues, stats);
  checkOrphanRefs(records, uuidSet, issues, stats);
  detectCycles(records, parentRefs, issues, stats);

  return {
    valid: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    stats,
  };
}

// ── UUID remapping ───────────────────────────────────────────

/**
 * Generate brand-new UUIDs for every conversation record while updating the parentUuid chain.
 * Used for session fork.
 *
 * @returns {{ records, mapping }} mapping is oldUuid → newUuid
 */
function remapAll(records) {
  const mapping = new Map(); // oldUuid → newUuid
  const result = [];

  // Remap every record that has a uuid (not just the conversation chain, since a fork must re-UUID the whole file)
  for (const r of records) {
    const newRecord = { ...r };

    if (r.uuid) {
      const newUuid = uuid4();
      mapping.set(r.uuid, newUuid);
      newRecord.uuid = newUuid;
    }

    // subagent info must be swapped too
    if (r.agentId && mapping.has(r.agentId)) {
      newRecord.agentId = mapping.get(r.agentId);
    }

    result.push(newRecord);
  }

  // Pass 2: update parentUuid
  for (const r of result) {
    if (r.parentUuid && mapping.has(r.parentUuid)) {
      r.parentUuid = mapping.get(r.parentUuid);
    }
    // assign a new sessionId
    if (r.sessionId && mapping.has(r.sessionId)) {
      r.sessionId = mapping.get(r.sessionId);
    }
  }

  return { records: result, mapping };
}

/**
 * Partial remap: swap only the sessionId while keeping the internal parentUuid chain.
 * Used when merging sessions to avoid sessionId collisions.
 */
function remapSessionId(records, newSessionId) {
  const oldSessionId = records.find(r => r.sessionId)?.sessionId;
  if (!oldSessionId) return records;

  return records.map(r => {
    const c = { ...r };
    if (c.sessionId === oldSessionId) c.sessionId = newSessionId;
    return c;
  });
}

// ── parentUuid chain repair ─────────────────────────────────────

/** Walk up from a deleted parentUuid to the nearest surviving ancestor; returns null when the deleted
 *  records form a parentUuid cycle (guarded by `seen`, so the walk can't hang). */
function nearestSurvivingAncestor(parentUuid, deleteSet, parentMap) {
  let ancestor = parentMap.get(parentUuid);
  const seen = new Set([parentUuid]);
  while (ancestor && deleteSet.has(ancestor)) {
    if (seen.has(ancestor)) return null;
    seen.add(ancestor);
    ancestor = parentMap.get(ancestor);
  }
  return ancestor || null;
}

/**
 * Delete the given UUIDs from records and repair the links.
 * When msg X is deleted, X's children (every record whose parentUuid points at X) have their
 * parentUuid repointed to X's parentUuid.
 *
 * @param {string[]} deletedUuids - list of UUIDs to delete
 */
function repairChainAfterDelete(records, deletedUuids) {
  const deleteSet = new Set(deletedUuids);
  const parentMap = new Map(); // uuid → parentUuid (the parent of each deleted item)

  // Collect the parent of each deleted item
  for (const r of records) {
    if (deleteSet.has(r.uuid)) {
      parentMap.set(r.uuid, r.parentUuid || null);
    }
  }

  // Filter + repair
  const result = [];
  for (const r of records) {
    if (deleteSet.has(r.uuid)) continue;

    const copy = { ...r };
    // If this record's parentUuid was deleted, rewire it to the nearest surviving ancestor
    if (copy.parentUuid && deleteSet.has(copy.parentUuid)) {
      copy.parentUuid = nearestSurvivingAncestor(copy.parentUuid, deleteSet, parentMap);
    }
    result.push(copy);
  }

  return result;
}

// ── Fast structural validity check ────────────────────────────────────

/**
 * Return the first error, or null (valid).
 * Faster than validateChain: structural checks only, no chain walk.
 */
function quickValidate(records) {
  if (!Array.isArray(records)) return 'records must be an array';
  if (records.length === 0) return 'records is empty';

  const sessionId = records[0]?.sessionId;
  if (!sessionId) return 'missing sessionId';

  for (let i = 0; i < records.length; i++) {
    const fieldErrors = validateRecord(records[i], i);
    if (fieldErrors.some(e => e.severity === 'error')) {
      return `record[${i}]: ${fieldErrors.map(e => e.message).join('; ')}`;
    }
    if (records[i].sessionId && records[i].sessionId !== sessionId) {
      return `record[${i}]: sessionId mismatch (${records[i].sessionId} ≠ ${sessionId})`;
    }
  }

  return null; // OK
}

// ── UUID-chain rebuild (rebuild parentUuid from flat records) ─────────

/**
 * Assuming records are already sorted by time, set the correct parentUuid on each conversation record.
 * Used to auto-link the chain when building a session from scratch.
 *
 * Note: only the user/assistant chain is linked.
 * - system (including compact_boundary) keeps its original parentUuid (usually null = segment start)
 * - attachment is not part of the conversation chain
 * This matches Claude Code's actual structure and avoids forcing compact_boundary into the conversation chain.
 */
function autoLinkChain(records) {
  let lastConvUuid = null;
  const result = [];

  for (const r of records) {
    const copy = { ...r };
    if (isConversationRecord(r)) {
      if (!copy.uuid) copy.uuid = uuid4();
      copy.parentUuid = lastConvUuid;
      lastConvUuid = copy.uuid;
    }
    // system/attachment keep their original parentUuid unchanged
    result.push(copy);
  }

  return result;
}

// ── Find chain endpoints ────────────────────────────────────────────

/**
 * Find every chain endpoint (leaf node).
 * leaf = no other record's parentUuid points at it.
 */
function findLeaves(records) {
  const uuidSet = new Set();
  const parentSet = new Set();

  for (const r of records) {
    if (r.uuid) uuidSet.add(r.uuid);
    if (r.parentUuid) parentSet.add(r.parentUuid);
  }

  // leaf: uuid exists but is nobody's parent
  return [...uuidSet].filter(u => !parentSet.has(u));
}

/**
 * Find every chain start (root node).
 * root = parentUuid is null or absent.
 */
function findRoots(records) {
  return records.filter(r => isConversationRecord(r) && !r.parentUuid);
}

// ── Exports ──────────────────────────────────────────────────

module.exports = {
  uuid4,
  turnUuid,
  validateRecord,
  validateChain,
  remapAll,
  remapSessionId,
  repairChainAfterDelete,
  quickValidate,
  autoLinkChain,
  findLeaves,
  findRoots,
  REQUIRED_FIELDS,
};
