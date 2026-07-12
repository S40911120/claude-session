'use strict';
/**
 * atomic-write.js — crash-safe file replacement for session surgery.
 *
 * Writes a temp file in the target's directory then renames it over the target. rename() is atomic
 * on one filesystem, so an interrupted write can never leave a torn (half-written) session file —
 * the original stays intact until the fully-written temp swaps in. The temp is opened with O_EXCL
 * so a pre-planted symlink at its path can't be followed or clobbered.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* best-effort cleanup; surface the original error */ }
}

// Unpredictable same-directory temp name (pid + time + attempt + random) so a pre-planted symlink can't
// guess it; the O_EXCL open ('wx') is what actually enforces the no-follow/no-clobber guarantee.
function tempName(targetPath, attempt) {
  return `${targetPath}.tmp-${process.pid}-${Date.now()}-${attempt}-${crypto.randomBytes(6).toString('hex')}`;
}

// Create a same-directory temp with O_EXCL (flag 'wx') so a pre-planted symlink at the temp path can't be
// followed/clobbered; retry once with a fresh unpredictable suffix on a rare name collision. A partial write
// (disk-full) may leave a temp behind, so clean it up on any non-EEXIST failure (the O_EXCL refusal itself
// creates nothing of ours). Returns the temp path.
function writeExclusiveTemp(targetPath, content) {
  for (let attempt = 0; ; attempt++) {
    const tmp = tempName(targetPath, attempt);
    try {
      fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
      return tmp;
    } catch (err) {
      if (err.code === 'EEXIST' && attempt < 1) continue; // name taken (symlink/leftover) → fresh suffix
      if (err.code !== 'EEXIST') safeUnlink(tmp);
      throw err;
    }
  }
}

// Open a same-directory temp fd with O_EXCL (flag 'wx') for incremental writing, retrying once on a rare
// name collision. The O_EXCL refusal creates nothing of ours (no fd, no file), so there is nothing to clean
// up on EEXIST — only the caller's subsequent writes can leave a temp behind. Returns { fd, tmp }.
function openExclusiveTemp(targetPath) {
  for (let attempt = 0; ; attempt++) {
    const tmp = tempName(targetPath, attempt);
    try {
      return { fd: fs.openSync(tmp, 'wx'), tmp };
    } catch (err) {
      if (err.code === 'EEXIST' && attempt < 1) continue; // name taken (symlink/leftover) → fresh suffix
      throw err;
    }
  }
}

function atomicWrite(targetPath, content) {
  const tmp = writeExclusiveTemp(targetPath, content);
  try {
    // On Windows, rename() over a target another process currently has open can throw EPERM/EBUSY
    // (POSIX allows the atomic replace; Win32 does not while the file is held). We surface it — clean up
    // the temp and rethrow so the caller sees the failure — rather than swallowing it and losing the write.
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    safeUnlink(tmp);
    throw err;
  }
}

// Streaming sibling of atomicWrite for outputs too large to hold as one string: serializing a very large
// session as records.map(...).join('\n') builds a single string that RangeErrors past V8's MAX_STRING_LENGTH
// (~512 MiB). `lines` is any iterable of already-serialized strings (no trailing newline). The on-disk bytes
// are IDENTICAL to atomicWrite(targetPath, [...lines].join('\n') + '\n') for ANY input, including empty
// (→ "\n"): each line after the first is prefixed with '\n' and a single trailing '\n' closes the file.
// Same O_EXCL symlink-safety and atomic rename as atomicWrite; adds an fsync before close so the bytes are
// on disk before the rename swaps them in. The temp is cleaned up on any error.
function atomicWriteLines(targetPath, lines) {
  const { fd, tmp } = openExclusiveTemp(targetPath);
  let closed = false;
  const closeFd = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* already closed */ } } };
  try {
    // Batch line + separator into a bounded buffer (flush ~1 MiB) so we never build a string anywhere near
    // MAX_STRING_LENGTH. Concatenating whole lines never splits a UTF-8 code point, so the flushed byte
    // stream equals [...lines].join('\n') + '\n' exactly (associativity of concatenation).
    const FLUSH_AT = 1 << 20; // ~1 MiB of UTF-16 units — orders of magnitude under the string limit
    let buf = '';
    let first = true;
    for (const line of lines) {
      buf += first ? line : ('\n' + line);
      first = false;
      if (buf.length >= FLUSH_AT) { fs.writeSync(fd, buf); buf = ''; }
    }
    buf += '\n'; // trailing newline (also the whole file when `lines` is empty → "\n", matching join + '\n')
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    closeFd(); // close before rename — Windows can refuse to rename a still-open file
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    closeFd(); // must close before unlink — Windows can't remove an open file
    safeUnlink(tmp);
    throw err;
  }
}

// Copy filePath to `filePath + '.bak'` before an in-place overwrite so a destructive edit is always
// recoverable. Returns the backup path. Shared by repair (auto-backup on repair) and surgeon
// (--output <source>), so the two stay a single source of truth instead of drifting copies.
function backupFile(filePath) {
  const bak = filePath + '.bak';
  fs.copyFileSync(filePath, bak);
  return bak;
}

module.exports = { atomicWrite, atomicWriteLines, backupFile };
