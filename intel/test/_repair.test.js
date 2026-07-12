'use strict';
/* Regression tests for the delete+strip repair path (surgery/session-repair + lib/uuid-engine):
   - FAIL-2: repairChainAfterDelete must not hang when the deleted records form a parentUuid cycle.
   - FAIL-1: a partially-stripped survivor must keep its strip when another record is fully deleted
     in the same pass (previously the chain was rebuilt from unstripped originals, discarding strips). */

const { repairChainAfterDelete } = require('../../lib/uuid-engine');
const { repairOne, repairAll } = require('../../surgery/session-repair');
const A = require('./_assert')('_repair');
const { eq, ok, summary } = A;

// true if any user tool_result references a tool_use id that no longer exists (the resume-API-400 condition)
function hasOrphanToolResult(records) {
  const toolUseIds = new Set();
  for (const r of records) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content))
      for (const b of r.message.content) if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
  }
  for (const r of records) {
    if (r.type === 'user' && Array.isArray(r.message?.content))
      for (const b of r.message.content)
        if (b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id)) return true;
  }
  return false;
}

console.log('[_repair.test.js]');

// ── FAIL-2: cycle guard in the ancestor walk ──────────────
// A and B are deleted and point at each other (A.parent=B, B.parent=A); C survives with parent A.
// Without the guard the ancestor walk oscillates A→B→A→… forever and hangs the process — so this
// test completing at all is the regression signal, plus the survivor must fall back to the chain root.
{
  const cyclic = [
    { uuid: 'A', parentUuid: 'B' },
    { uuid: 'B', parentUuid: 'A' },
    { uuid: 'C', parentUuid: 'A' },
  ];
  const out = repairChainAfterDelete(cyclic, ['A', 'B']);
  eq('cyclic deleted ancestors: only the survivor remains', out.length, 1);
  eq('cyclic deleted ancestors: survivor is C', out[0].uuid, 'C');
  eq('cyclic deleted ancestors: survivor falls back to chain root (null)', out[0].parentUuid, null);
}

// ── FAIL-1: partial strip preserved alongside a full delete ──────────────
// A1 provides the only valid tool_use id ('keep1'). U1 is entirely an orphan tool_result → fully deleted.
// U2 mixes an orphan tool_result + a real text block → must be stripped down to the text (not reverted),
// and its parentUuid must be rewired past the deleted U1 to A1.
{
  const A1 = { uuid: 'A1', parentUuid: null, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'keep1', name: 'X', input: {} }] } };
  const U1 = { uuid: 'U1', parentUuid: 'A1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphanX', content: 'x' }] } };
  const U2 = { uuid: 'U2', parentUuid: 'U1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphanY', content: 'y' }, { type: 'text', text: 'hi' }] } };
  const res = repairOne([A1, U1, U2], 'orphan-tool-results');
  const recs = res.records;
  eq('mixed strip+delete: fixed counts both stripped orphans', res.fixed, 2);
  eq('mixed strip+delete: U1 deleted, 2 records remain', recs.length, 2);
  const u2 = recs.find((r) => r.uuid === 'U2');
  ok('mixed strip+delete: U2 survives', !!u2);
  eq('mixed strip+delete: U2 stripped to a single block', u2 ? u2.message.content.length : -1, 1);
  eq('mixed strip+delete: U2 kept the text (strip preserved, not reverted)', u2 ? u2.message.content[0].type : '', 'text');
  eq('mixed strip+delete: U2 parentUuid rewired past deleted U1 to A1', u2 ? u2.parentUuid : '', 'A1');
}

// ── FIXPOINT: repairAll must clean an orphan that a later repair creates ──────────────
// order-violations (runs 3rd) strips tool_use T1 but leaves its tool_result for orphan-tool-results
// (runs 1st) to clean — one pass leaves U1's tool_result orphaned (still resume-API-400). repairAll now
// loops to a fixpoint, so a later pass's orphan-tool-results removes it. This block fails on the old single-pass code.
{
  const A1 = { uuid: 'A1', parentUuid: null, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'T1', name: 'X', input: {} }] } };
  const E1 = { uuid: 'E1', parentUuid: 'A1', type: 'user', userType: 'external', message: { role: 'user', content: [{ type: 'text', text: 'next prompt' }] } };
  const U1 = { uuid: 'U1', parentUuid: 'E1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'late' }] } };

  ok('fixpoint: fixture starts with a latent order-violation cascade', !hasOrphanToolResult([A1, E1, U1]));
  const out = repairAll([A1, E1, U1]);
  ok('fixpoint: no orphaned tool_result remains after repairAll', !hasOrphanToolResult(out.records));

  // results shape preserved: one entry per repair, each with { repair, description, fixed }
  ok('fixpoint: results is a per-repair array', Array.isArray(out.results)
    && out.results.every((r) => 'repair' in r && 'description' in r && typeof r.fixed === 'number'));
  const orderV = out.results.find((r) => r.repair === 'order-violations');
  const orphanR = out.results.find((r) => r.repair === 'orphan-tool-results');
  eq('fixpoint: order-violations removed the out-of-order tool_use', orderV.fixed, 1);
  eq('fixpoint: orphan-tool-results cleaned the cascade orphan on a later pass', orphanR.fixed, 1);
}

process.exit(summary());
