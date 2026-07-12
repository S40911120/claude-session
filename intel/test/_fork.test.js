'use strict';
/* C4 fork: the source file must be byte-identical after a fork (fork never mutates the original), and the
   forked UUID set must be disjoint from the source's (a real independent duplicate, safe to resume alone). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('../../surgery/session-forker');
const { parseJsonlSync } = require('../../lib/util');
const A = require('./_assert')('_fork');
const { eq, ok, summary } = A;

console.log('[_fork.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fork-'));
const uuidSet = (records) => new Set(records.map((r) => r.uuid).filter(Boolean));

try {
  const src = path.join(dir, 'source.jsonl');
  const recs = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'SESS', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'SESS', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'SESS', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: 'again' } },
  ];
  fs.writeFileSync(src, recs.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const before = fs.readFileSync(src); // Buffer

  const out = path.join(dir, 'forked.jsonl');
  const res = fork(src, { outputPath: out });
  ok('fork succeeded', res.success);

  // 1) source byte-identical after the fork
  const after = fs.readFileSync(src);
  ok('source file is byte-identical after fork', before.equals(after));

  // 2) forked UUID set disjoint from the source UUID set
  const srcIds = uuidSet(recs);
  const forkedIds = uuidSet(parseJsonlSync(out));
  ok('fork produced fresh UUIDs (non-empty)', forkedIds.size >= recs.length);
  const overlap = [...forkedIds].filter((u) => srcIds.has(u));
  eq('forked UUID set is disjoint from the source', overlap.length, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
