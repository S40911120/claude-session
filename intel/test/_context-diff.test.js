'use strict';
/* Regression test: context-diff.js (driven through the real CLI as a subprocess).
     - finding #7: topic keyword frequency uses word boundaries, so a short keyword ("ui"/"api") is not
       counted as a substring of an unrelated word ("build"/"rapid") — while a real standalone word still is.
     - finding #10: --show-fork-point tolerates a crafted/empty forkedFrom object without crashing. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./_assert')('_context-diff');
const { eq, ok, summary } = A;

console.log('[_context-diff.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-diff-'));
const CLI = path.join(__dirname, '..', 'context-diff.js');
const userMsg = (txt) => ({ type: 'user', message: { role: 'user', content: txt }, timestamp: '2026-01-01T00:00:00Z', uuid: 'u', sessionId: 'S' });
const write = (recs) => {
  const f = path.join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
const topics = (a, b) => spawnSync(process.execPath, [CLI, a, b, '--focus', 'topics'], { encoding: 'utf8' }).stdout || '';

try {
  // finding #7: "ui" must not be counted inside build/rebuild/quickly, nor "api" inside "rapid"
  const a = write([userMsg('please build and rebuild it quickly, run the rapid loop')]);
  const b = write([userMsg('nothing relevant here at all')]);
  const out = topics(a, b);
  ok('#7 "ui" is not inflated by build/rebuild/quickly', !/\bui:/.test(out));
  ok('#7 "api" is not inflated by "rapid"', !/\bapi:/.test(out));

  // …but a real standalone "UI" word is still counted
  const c = write([userMsg('the UI is broken, please fix the UI')]);
  const d = write([userMsg('plain unrelated text')]);
  ok('#7 a real standalone "UI" word is still counted twice', /ui: 2/.test(topics(c, d)));

  // finding #10: --show-fork-point tolerates a crafted empty forkedFrom without crashing
  const fk = path.join(dir, 'fk.jsonl');
  fs.writeFileSync(fk, JSON.stringify({ sessionId: 'aaaaaaaa', forkedFrom: {} }) + '\n');
  const fk2 = path.join(dir, 'fk2.jsonl');
  fs.writeFileSync(fk2, JSON.stringify({ sessionId: 'bbbbbbbb', forkedFrom: null }) + '\n');
  const fork = spawnSync(process.execPath, [CLI, fk, fk2, '--show-fork-point'], { encoding: 'utf8' });
  eq('#10 --show-fork-point exits 0 on a crafted empty forkedFrom', fork.status, 0);
  ok('#10 no TypeError on the missing forkedFrom fields', !/TypeError/.test(fork.stderr || ''));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
