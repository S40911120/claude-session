'use strict';
/* Regression: uuid-engine.detectCycles must walk iteratively (explicit stack), so a very long linear
   parentUuid chain (e.g. produced by autoLinkChain in a big merge) can't overflow the call stack, while
   still reporting 0 cycles on an acyclic chain and still detecting a real cycle. */

const { validateChain } = require('../../lib/uuid-engine');
const A = require('./_assert')('_uuid-engine');
const { eq, ok, summary } = A;

console.log('[_uuid-engine.test.js]');

// ── Long linear chain must not blow the stack ──────────────
// u0 -> u1 -> ... -> u(N-1). The old recursive dfs recursed once per level (~N frames) and threw
// RangeError: Maximum call stack size exceeded around ~10k. The iterative version handles it flat.
{
  const N = 20000;
  const records = [{ uuid: 'u0', parentUuid: null, type: 'user' }];
  for (let i = 1; i < N; i++) records.push({ uuid: `u${i}`, parentUuid: `u${i - 1}`, type: 'user' });

  let res;
  let threw = false;
  try { res = validateChain(records); } catch { threw = true; }
  ok('long linear chain does not throw (no stack overflow)', !threw);
  eq('long linear chain reports 0 cycles', res ? res.stats.cycles : -1, 0);
  ok('long linear chain is valid', res ? res.valid : false);
  eq('long linear chain has a single root chain', res ? res.stats.chains : -1, 1);
}

// ── A real cycle reachable from a root is still detected ──────────────
// R -> A -> B, then a second record reusing uuid A whose parent is B closes an A->B->A loop reachable
// from the root R. detectCycles must revisit 'A' on the path and report the cycle.
{
  const records = [
    { uuid: 'R', parentUuid: null, type: 'user' },
    { uuid: 'A', parentUuid: 'R', type: 'user' },
    { uuid: 'B', parentUuid: 'A', type: 'user' },
    { uuid: 'A', parentUuid: 'B', type: 'user' }, // dup uuid closes the A->B->A loop
  ];
  const res = validateChain(records);
  ok('real cycle is detected (stats.cycles >= 1)', res.stats.cycles >= 1);
  ok('a chain with a cycle is invalid', !res.valid);
  ok('the cycle is reported as an error issue', res.issues.some((i) => i.type === 'cycle' && i.severity === 'error'));
}

// ── W2: a ROOTLESS cycle (no null-parent root) must still be detected ──────────────
// A.parent=B, B.parent=A with no record whose parentUuid is null → the rooted walk has no entry point,
// so both nodes stay unvisited and the loop was silently reported valid (0 cycles). detectCycles must
// also walk from any still-unvisited node so this closed loop is caught.
{
  const records = [
    { uuid: 'A', parentUuid: 'B', type: 'user' },
    { uuid: 'B', parentUuid: 'A', type: 'user' },
  ];
  const res = validateChain(records);
  ok('rootless 2-cycle: reports a cycle (stats.cycles >= 1)', res.stats.cycles >= 1);
  ok('rootless 2-cycle: chain is invalid', !res.valid);
  ok('rootless 2-cycle: cycle reported as an error issue', res.issues.some((i) => i.type === 'cycle' && i.severity === 'error'));
}

process.exit(summary());
