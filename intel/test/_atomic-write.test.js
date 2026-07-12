'use strict';
/* C1: lib/atomic-write.js — crash-safe replace + O_EXCL temp. Real invariants (not shells):
   content swap, no .tmp leftover on success, temp cleanup when rename is forced to fail, and that the
   'wx' flag atomic-write opens with refuses a pre-planted symlink (never follows/clobbers its target).
   The temp name is randomized by design, so the O_EXCL guarantee is asserted at the exact flag ('wx')
   that writeExclusiveTemp uses. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, atomicWriteLines } = require('../../lib/atomic-write');
const A = require('./_assert')('_atomic-write');
const { eq, ok, summary } = A;

console.log('[_atomic-write.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-atomic-'));
const leftoverTmps = (base) => fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(base) + '.tmp-'));

try {
  // 1) content replaced correctly + no .tmp leftover on success
  {
    const target = path.join(dir, 'session.jsonl');
    fs.writeFileSync(target, 'OLD CONTENT');
    atomicWrite(target, 'NEW CONTENT');
    eq('content replaced correctly', fs.readFileSync(target, 'utf8'), 'NEW CONTENT');
    eq('no .tmp leftover on success', leftoverTmps(target).length, 0);
  }

  // 2) temp cleaned up when rename is forced to fail (rename file -> existing directory fails)
  {
    const targetDir = path.join(dir, 'target-is-a-dir');
    fs.mkdirSync(targetDir);
    let threw = false;
    try { atomicWrite(targetDir, 'X'); } catch { threw = true; }
    ok('rename failure surfaces (error is not swallowed)', threw);
    eq('temp cleaned up after a rename failure (no .tmp leftover)', leftoverTmps(targetDir).length, 0);
  }

  // 3) O_EXCL: 'wx' refuses a pre-planted symlink and never clobbers its target
  {
    const secret = path.join(dir, 'victim-secret');
    fs.writeFileSync(secret, 'DO-NOT-CLOBBER');
    const linkPath = path.join(dir, 'planted-link');
    let viaSymlink = true;
    try { fs.symlinkSync(secret, linkPath, 'file'); }
    catch { viaSymlink = false; fs.writeFileSync(linkPath, 'planted-regular'); } // still exercises O_EXCL EEXIST refusal
    let threw = false, code = '';
    try { fs.writeFileSync(linkPath, 'EVIL', { flag: 'wx' }); } catch (e) { threw = true; code = e.code; }
    ok(`'wx' refuses a pre-planted path with EEXIST${viaSymlink ? ' [symlink]' : ' [regular-file fallback]'}`, threw && code === 'EEXIST');
    eq("'wx' did not follow/clobber the symlink target", fs.readFileSync(secret, 'utf8'), 'DO-NOT-CLOBBER');
  }

  // 4) atomicWriteLines streams byte-identically to atomicWrite(path, lines.join('\n') + '\n') — this is the
  //    invariant that keeps the merge/redact large-session fixes byte-exact. Includes CJK + a JSON line with an
  //    embedded newline to prove UTF-8 batching never splits a code point and never mangles the separators.
  {
    const lines = ['{"a":1}', '{"msg":"h\u00e9llo \u4e16\u754c"}', '{"b":"line\\nwith escaped nl"}', ''];
    const streamed = path.join(dir, 'streamed.jsonl');
    const joined = path.join(dir, 'joined.jsonl');
    atomicWriteLines(streamed, lines);
    atomicWrite(joined, lines.join('\n') + '\n');
    ok('streamed output == joined output (byte-identical)', fs.readFileSync(streamed).equals(fs.readFileSync(joined)));
    eq('no .tmp leftover on streamed success', leftoverTmps(streamed).length, 0);
    // empty input matches join('\n') + '\n' → a lone "\n"
    const empty = path.join(dir, 'empty-lines.jsonl');
    atomicWriteLines(empty, []);
    eq('empty input yields "\\n" (matches [].join + \'\\n\')', fs.readFileSync(empty, 'utf8'), '\n');

    // cross the internal ~1 MiB flush boundary many times: the small case above never flushes, so this is the
    // only assertion that proves the batched writer stitches chunks + separators correctly (== join + '\n').
    const many = Array.from({ length: 40000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(50) }));
    const bigStreamed = path.join(dir, 'big-streamed.jsonl');
    const bigJoined = path.join(dir, 'big-joined.jsonl');
    atomicWriteLines(bigStreamed, many);
    atomicWrite(bigJoined, many.join('\n') + '\n');
    ok('multi-MiB streamed output == joined (flush boundary stitched correctly)',
      fs.readFileSync(bigStreamed).equals(fs.readFileSync(bigJoined)));
  }

  // 5) atomicWriteLines cleans up its temp when the rename is forced to fail (rename file -> existing dir)
  {
    const targetDir = path.join(dir, 'lines-target-is-a-dir');
    fs.mkdirSync(targetDir);
    let threw = false;
    try { atomicWriteLines(targetDir, ['X', 'Y']); } catch { threw = true; }
    ok('atomicWriteLines rename failure surfaces (error not swallowed)', threw);
    eq('atomicWriteLines temp cleaned up after rename failure (no .tmp leftover)', leftoverTmps(targetDir).length, 0);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
