'use strict';
/* Regression test: _resolver.js — parseTimeSpec (relative 3m/2h/1d/30s + ISO), walkChain cycle guard, isInRange.
   Note: the task mentions "path decoding", but decoded() is a private closure inside findLatest and is not
   exported → it cannot be unit-tested, so it is marked as skipped. */

const resolver = require('../../lib/resolver');
const { parseTimeSpec, walkChain, isInRange } = resolver;
const A = require('./_assert')('_resolver');
const { eq, ok, summary } = A;

console.log('[_resolver.test.js]');

// ── parseTimeSpec (fixed baseMs for reproducibility) ─────────────────
const BASE = 1_000_000_000_000; // fixed reference point

eq('null spec → null', parseTimeSpec(null), null);
eq('empty spec → null', parseTimeSpec(''), null);

eq('30s → base - 30000', parseTimeSpec('30s', BASE), BASE - 30_000);
eq('3m → base - 180000', parseTimeSpec('3m', BASE), BASE - 180_000);
eq('2h → base - 7200000', parseTimeSpec('2h', BASE), BASE - 7_200_000);
eq('1d → base - 86400000', parseTimeSpec('1d', BASE), BASE - 86_400_000);

// tolerate whitespace + "ago" suffix
eq('"3m ago" → same as 3m', parseTimeSpec('3m ago', BASE), BASE - 180_000);
eq('"2 h" (space) → 2h', parseTimeSpec('2 h', BASE), BASE - 7_200_000);
eq('uppercase 1D → 1d', parseTimeSpec('1D', BASE), BASE - 86_400_000);

// ISO 8601 → absolute epoch (independent of base)
eq('ISO 8601 parsed to epoch',
  parseTimeSpec('2021-09-09T01:46:40.000Z', BASE),
  new Date('2021-09-09T01:46:40.000Z').getTime());

// unparseable → null
eq('garbage spec → null', parseTimeSpec('notatime', BASE), null);
eq('bad unit 5y → null', parseTimeSpec('5y', BASE), null);

// ── isInRange ─────────────────────────────────────────────
eq('no bounds → true', isInRange('2021-01-01T00:00:00Z', {}), true);
eq('no timestamp → true (metadata not filtered)', isInRange(null, { sinceMs: 100 }), true);
eq('invalid timestamp → true', isInRange('not-a-date', { sinceMs: 100 }), true);
eq('before since → false',
  isInRange('2021-01-01T00:00:00Z', { sinceMs: new Date('2022-01-01').getTime() }), false);
eq('after until → false',
  isInRange('2023-01-01T00:00:00Z', { untilMs: new Date('2022-01-01').getTime() }), false);
eq('within range → true',
  isInRange('2022-06-01T00:00:00Z', {
    sinceMs: new Date('2022-01-01').getTime(),
    untilMs: new Date('2022-12-31').getTime(),
  }), true);

// ── walkChain cycle guard / broken-chain handling ─────────────────────────
// A non-existent UUID should throw (inside resolve), not loop forever. Timeout-free synchronous check.
let walkThrew = false;
try {
  walkChain('00000000-0000-0000-0000-000000000000');
} catch { walkThrew = true; }
ok('walkChain on non-existent full UUID throws (resolve fail), no hang', walkThrew);

// With a real session in the environment, walkChain should return an array and not loop forever (the cycle-guard seen Set holds).
const sessions = resolver.listAllSessions();
if (sessions.length > 0) {
  const chain = walkChain(sessions[0].sessionId);
  ok('walkChain returns array for real session', Array.isArray(chain));
  ok('walkChain chain non-empty for real session', chain.length >= 1);
  // Cycle-guard check: sessionIds within the chain are unique (the seen Set keeps it finite)
  const ids = chain.map((c) => c.sessionId);
  ok('walkChain no duplicate sessionId (cycle-guard seen works)',
    new Set(ids).size === ids.length);
} else {
  console.log('  SKIP  walkChain real-session checks (no session files in this environment)');
}

// ── readForkParent + hintChainIfForked (core of the fork-aware hint) ─────
const { readForkParent, hintChainIfForked } = resolver;
eq('readForkParent nonexistent path → null', readForkParent('/nonexistent-xyz.jsonl'), null);
if (sessions.length > 0) {
  const p = readForkParent(sessions[0].path);
  ok('readForkParent returns null or a 36-char sessionId',
    p === null || (typeof p === 'string' && p.length === 36));
}
// hintChainIfForked is called in the token-budget/tasks main flow; a throw would crash it → it must swallow every error
ok('hintChainIfForked is exported', typeof hintChainIfForked === 'function');
function noThrow(name, fn) { let t = false; try { fn(); } catch { t = true; } ok(name, !t); }
noThrow('hintChainIfForked nonexistent path does not throw', () => hintChainIfForked('/nonexistent-xyz.jsonl', []));
noThrow('hintChainIfForked null path does not throw', () => hintChainIfForked(null, []));
noThrow('hintChainIfForked null args does not throw', () => hintChainIfForked('/x.jsonl', null));
noThrow('hintChainIfForked --chain early-return does not throw', () => hintChainIfForked('/x.jsonl', ['--chain']));

console.log('  NOTE  path decoding decoded() is a private closure inside findLatest, not exported → unit test skipped');

process.exit(summary());
