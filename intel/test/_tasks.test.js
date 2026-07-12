'use strict';
/* Regression test: session-tasks.js structural extraction. Every task marker is keyed off a structural
   tool_use field (not prose), so it is language-universal:
     - TodoWrite.input.todos (a JSON-string snapshot of {content,status,activeForm}[]) → upsert by content
     - TaskCreate / TaskUpdate (incremental) → create + status update by taskId
   Also guards the adversarial case: a malformed todos string must be skipped, never crash the scan. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractTasks } = require('../session-tasks');
const A = require('./_assert')('_tasks');
const { eq, ok, summary } = A;

console.log('[_tasks.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-tasks-'));
const asst = (content) => ({ type: 'assistant', message: { role: 'assistant', content }, timestamp: '2026-01-01T00:00:00Z' });
const at = (content, ts) => ({ type: 'assistant', message: { role: 'assistant', content }, timestamp: ts });
const write = (recs) => {
  const f = path.join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
const bySubject = (tasks, s) => tasks.find((t) => t.subject === s);
const byId = (tasks, id) => tasks.find((t) => t.id === id);

(async () => {
  // 1. TodoWrite: input.todos is a JSON string (the real Claude Code format); two snapshots → transition
  const f1 = write([
    asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: JSON.stringify([
      { content: 'ship parser', status: 'pending', activeForm: 'shipping parser' },
      { content: 'write docs', status: 'in_progress' },
    ]) } }]),
    asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: JSON.stringify([
      { content: 'ship parser', status: 'completed' },
      { content: 'write docs', status: 'in_progress' },
    ]) } }]),
  ]);
  const t1 = await extractTasks(f1);
  eq('TodoWrite: two distinct todos captured', t1.length, 2);
  const ship = bySubject(t1, 'ship parser');
  eq('TodoWrite: status is the latest snapshot value', ship.status, 'completed');
  eq('TodoWrite: updateCount counts the status transition', ship.updateCount, 1);
  eq('TodoWrite: activeForm preserved from first snapshot', ship.activeForm, 'shipping parser');
  const docs = bySubject(t1, 'write docs');
  eq('TodoWrite: unchanged status → updateCount stays 0', docs.updateCount, 0);
  eq('TodoWrite: unchanged todo keeps its status', docs.status, 'in_progress');

  // 2. TodoWrite tolerates an already-parsed array (older builds) too
  const f2 = write([
    asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } }]),
  ]);
  eq('TodoWrite: array-form todos also parsed', (await extractTasks(f2)).length, 1);

  // 3. TaskCreate + TaskUpdate (incremental) still work
  const f3 = write([
    asst([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '1', subject: 'build API' } }]),
    asst([{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }]),
  ]);
  const t3 = await extractTasks(f3);
  eq('TaskCreate/Update: one task', t3.length, 1);
  eq('TaskCreate/Update: id is the taskId', byId(t3, '1').subject, 'build API');
  eq('TaskCreate/Update: status applied by TaskUpdate', byId(t3, '1').status, 'in_progress');

  // 4. Adversarial: a malformed todos JSON string is skipped, never crashes the scan
  const f4 = write([
    asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: '[not valid json' } }]),
    asst([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '9', subject: 'survivor' } }]),
  ]);
  const t4 = await extractTasks(f4);
  eq('malformed todos skipped, scan survives (only the valid task remains)', t4.length, 1);
  ok('the surviving task is the TaskCreate one', bySubject(t4, 'survivor'));

  // 5. finding #1: a TaskCreate dropped by the --since window must not shift the sequence keying, or a later
  //    TaskUpdate (keyed by taskId = create position) mis-correlates → phantom + wrong status.
  const f5 = write([
    at([{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'early' } }], '2026-01-01T04:00:00Z'),
    at([{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'late' } }], '2026-01-01T06:00:00Z'),
    at([{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }], '2026-01-01T06:30:00Z'),
  ]);
  const t5 = await extractTasks(f5, { sinceMs: new Date('2026-01-01T05:00:00Z').getTime() });
  eq('#1 --since lists only the in-window task', t5.length, 1);
  eq('#1 the late task keeps its real completed status (no sequence shift)', (t5[0] || {}).status, 'completed');
  ok('#1 no phantom "(no matching TaskCreate)" is produced', !t5.some((t) => t.phantom));

  // 6. finding #3: empty / duplicate TodoWrite content must not collapse into one entry (silent data loss).
  const fEmpty = write([asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: JSON.stringify([
    { content: '', status: 'pending' }, { content: '', status: 'in_progress' }, { content: '', status: 'completed' },
  ]) } }])]);
  eq('#3 three blank-content todos are kept distinct (not collapsed to one)', (await extractTasks(fEmpty)).length, 3);
  const fDup = write([asst([{ type: 'tool_use', name: 'TodoWrite', input: { todos: JSON.stringify([
    { content: 'write tests', status: 'pending' }, { content: 'write tests', status: 'completed' },
  ]) } }])]);
  eq('#3 two same-content todos in one snapshot are kept distinct', (await extractTasks(fDup)).length, 2);

  // 7. finding #4: one subject tracked by both TaskCreate and TodoWrite must merge, not double-count.
  const fMerge = write([
    at([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '1', subject: 'ship it' } }], '2026-01-01T00:00:00Z'),
    at([{ type: 'tool_use', name: 'TodoWrite', input: { todos: JSON.stringify([{ content: 'ship it', status: 'completed' }]) } }], '2026-01-01T01:00:00Z'),
  ]);
  const tMerge = await extractTasks(fMerge);
  eq('#4 dual-source same subject merges to one task', tMerge.length, 1);
  eq('#4 the merged task keeps the Task-sourced id', tMerge[0].id, '1');
  eq('#4 the merged status is from the most-recent source (completed)', tMerge[0].status, 'completed');

  // 8. finding #5: a TaskUpdate before its TaskCreate (reordered file) must not be reset by the later create.
  const fReorder = write([
    asst([{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }]),
    asst([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '1', subject: 'reordered' } }]),
  ]);
  const tReorder = await extractTasks(fReorder);
  eq('#5 the phantom is filled in, not duplicated', tReorder.length, 1);
  eq('#5 the earlier update status survives the later create', tReorder[0].status, 'in_progress');
  eq('#5 the update count is preserved (not reset to 0)', tReorder[0].updateCount, 1);
  eq('#5 the create fills in the real subject', tReorder[0].subject, 'reordered');
  ok('#5 the phantom flag is cleared by the create', !tReorder[0].phantom);

  // 9. finding #9: a null block in an assistant content array (adversarial jsonl) is skipped, not a crash.
  const fNull = write([asst([null, { type: 'tool_use', name: 'TaskCreate', input: { subject: 'survivor2' } }])]);
  const tNull = await extractTasks(fNull);
  eq('#9 null block skipped, scan survives', tNull.length, 1);
  ok('#9 the real task after the null block is still captured', bySubject(tNull, 'survivor2'));

  // 10. finding #2: --diff must not report semantically opposite tasks as identical (stop-word normalization
  //     used to collapse "add tests" and "remove tests" to the same token → score 1 → "identical").
  const dA = write([asst([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '1', subject: 'add tests' } }])]);
  const dB = write([asst([{ type: 'tool_use', name: 'TaskCreate', input: { taskId: '1', subject: 'remove tests' } }])]);
  const CLI = path.join(__dirname, '..', 'session-tasks.js');
  const diffOut = spawnSync(process.execPath, [CLI, dA, '--diff', dB], { encoding: 'utf8' }).stdout || '';
  ok('#2 opposite tasks are NOT reported identical', !/task lists are identical/i.test(diffOut));
  ok('#2 "add tests" is surfaced as only-in-A', /Only in A[\s\S]*add tests/.test(diffOut));
  ok('#2 "remove tests" is surfaced as only-in-B', /Only in B[\s\S]*remove tests/.test(diffOut));

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(summary());
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  process.exit(1);
});
