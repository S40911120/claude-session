'use strict';
/* C6 CLI mass-deletion guards (surgery/session-surgeon.js): a reversed or negative --delete-range must be
   rejected (exit 2, nothing deleted), and protected metadata types must be skipped by --delete-type.
   Driven through the real CLI as a subprocess so the guard + exit code are exercised end to end. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./_assert')('_cli-guards');
const { eq, ok, summary } = A;

console.log('[_cli-guards.test.js]');

const SURGEON = path.join(__dirname, '..', '..', 'surgery', 'session-surgeon.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-cli-'));

try {
  const fixture = path.join(dir, 'session.jsonl');
  fs.writeFileSync(fixture, [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'S', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'S', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } },
    { type: 'summary', sessionId: 'S', timestamp: '2026-01-01T00:00:02Z', summary: 'a protected summary' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const run = (extra) => spawnSync(process.execPath, [SURGEON, fixture, ...extra], { encoding: 'utf8' });

  // reversed range rejected
  {
    const r = run(['--delete-range', '10-5']);
    eq('reversed --delete-range exits 2', r.status, 2);
    ok('reversed range is reported as reversed', /reversed/i.test(r.stderr));
  }

  // negative range rejected (Number('') coercion trap: -5--1 must not parse as 0-5)
  {
    const r = run(['--delete-range', '-5--1']);
    eq('negative --delete-range exits 2', r.status, 2);
    ok('negative range is reported as malformed', /malformed/i.test(r.stderr));
  }

  // protected type skipped
  {
    const r = run(['--delete-type', 'summary', '--dry-run']);
    eq('delete-type of a protected type exits 0', r.status, 0);
    ok('protected type is reported as skipped', /skipping protected types:\s*summary/i.test(r.stderr));
    ok('nothing was deleted (protected type preserved)', /deleted:\s*0/.test(r.stderr));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
