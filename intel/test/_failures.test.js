'use strict';
/* Regression test: session-failures.js classification + adversarial robustness.
     - finding #6: a Bash "exit code 2" is a real shell error (bash-exit), not agent-validation; only a
       subagent/Task tool's exit 2 is the agent-validation convention.
     - finding #9: a null element inside a tool_result content array must be skipped, never crash the scan. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, scanFailures } = require('../session-failures');
const A = require('./_assert')('_failures');
const { eq, ok, summary } = A;

console.log('[_failures.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fail-'));
const write = (recs) => {
  const f = path.join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};

(async () => {
  // finding #6: exit-code-2 classification is gated on the failing tool
  eq('#6 Bash exit code 2 → bash-exit (real shell error, not validation)', classify('Exit code 2\nls: unrecognized option', 'Bash'), 'bash-exit');
  eq('#6 Task exit code 2 → agent-validation (subagent convention)', classify('Exit code 2', 'Task'), 'agent-validation');
  eq('#6 Bash exit code 1 → bash-exit', classify('Exit code 1', 'Bash'), 'bash-exit');
  eq('#6 prose "validation" stays agent-validation regardless of tool', classify('schema validation failed', 'Bash'), 'agent-validation');

  // finding #9: a null element in a user tool_result content array must not crash scanFailures
  const f9 = write([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/x' } }] }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'user', message: { role: 'user', content: [null, { type: 'tool_result', tool_use_id: 't', is_error: true, content: [null] }] }, timestamp: '2026-01-01T00:00:01Z' },
  ]);
  let list;
  let crashed = false;
  try { list = await scanFailures(f9); } catch { crashed = true; }
  ok('#9 null blocks skipped, scan does not crash', !crashed);
  eq('#9 the real failure is still recorded', (list || []).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(summary());
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  process.exit(1);
});
