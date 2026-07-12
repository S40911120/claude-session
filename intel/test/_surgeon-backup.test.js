'use strict';
/* FIX 4: surgeon --output <source> (in-place overwrite) must first write a .bak, matching repair's
   auto-backup, so a destructive message-level edit is always recoverable. Driven end-to-end through the
   real CLI (not the unit fns) because the backup happens in the CLI write path. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('./_assert')('_surgeon-backup');
const { eq, ok, summary } = A;

console.log('[_surgeon-backup.test.js]');

const BIN = path.join(__dirname, '..', '..', 'surgery', 'session-surgeon.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-surgeon-bak-'));

const RECORDS = [
  '{"uuid":"u1","parentUuid":null,"type":"user","message":{"role":"user","content":"hi"}}',
  '{"uuid":"u2","parentUuid":"u1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}',
];
const ORIGINAL = RECORDS.join('\n') + '\n';

// run the surgeon CLI, tolerating a non-zero exit (return combined output; we assert on filesystem state)
function run(args) {
  try {
    return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

try {
  // in-place overwrite (--output === source) → a .bak byte-copy of the original must exist, source modified
  {
    const src = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(src, ORIGINAL);
    // --output placed before --delete so the source path can't be swallowed by --delete's value slurp
    run([src, '--output', src, '--delete', 'u2']);
    const bak = src + '.bak';
    ok('.bak created on in-place overwrite', fs.existsSync(bak));
    eq('.bak is a byte-identical copy of the original', fs.readFileSync(bak, 'utf8'), ORIGINAL);
    ok('source was actually modified (u2 removed)', !fs.readFileSync(src, 'utf8').includes('"uuid":"u2"'));
  }

  // dry-run must NOT create a backup and must NOT touch the source (nothing was written)
  {
    const src = path.join(dir, 'sess-dry.jsonl');
    fs.writeFileSync(src, ORIGINAL);
    run([src, '--output', src, '--delete', 'u2', '--dry-run']);
    ok('no .bak on dry-run (nothing written)', !fs.existsSync(src + '.bak'));
    eq('source untouched on dry-run', fs.readFileSync(src, 'utf8'), ORIGINAL);
  }

  // writing to a DIFFERENT output path is not an in-place overwrite → no .bak of the source
  {
    const src = path.join(dir, 'sess-out.jsonl');
    const out = path.join(dir, 'result.jsonl');
    fs.writeFileSync(src, ORIGINAL);
    run([src, '--output', out, '--delete', 'u2']);
    ok('no .bak of the source when output is a different file', !fs.existsSync(src + '.bak'));
    eq('source left intact when output is a different file', fs.readFileSync(src, 'utf8'), ORIGINAL);
    ok('separate output file written', fs.existsSync(out) && !fs.readFileSync(out, 'utf8').includes('"uuid":"u2"'));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
