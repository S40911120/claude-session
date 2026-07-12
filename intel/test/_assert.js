'use strict';
/* Minimal zero-dependency assert: prints PASS/FAIL, returns the fail count. Each test file carries its own copy.
   Usage: const { eq, ok, throws, summary } = require('./_assert')(); ... process.exit(summary()); */

module.exports = function makeAssert(label) {
  let pass = 0;
  let fail = 0;

  function record(name, good, detail) {
    if (good) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ''}`); }
  }

  function eq(name, got, exp) {
    const g = JSON.stringify(got);
    const e = JSON.stringify(exp);
    record(name, g === e, g === e ? '' : `got ${g} exp ${e}`);
  }

  function ok(name, cond, detail) {
    record(name, !!cond, detail);
  }

  function throws(name, fn) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    record(name, threw, threw ? '' : 'did not throw');
  }

  function summary() {
    console.log(`  ── ${label}: ${pass} pass, ${fail} fail`);
    return fail;
  }

  return { eq, ok, throws, summary };
};
