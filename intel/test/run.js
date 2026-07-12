'use strict';
/* Aggregate runner for every *.test.js (pure node, zero dependencies). Any failure → exit 1.
   Each test file runs in a child process (process.exit isolation); pass/fail is decided by the exit code. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
const results = [];

for (const f of files) {
  const fp = path.join(dir, f);
  try {
    const out = execFileSync(process.execPath, [fp], { encoding: 'utf8' });
    process.stdout.write(out);
    results.push({ file: f, ok: true });
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    failed++;
    results.push({ file: f, ok: false });
  }
}

console.log('\n══════════ run.js summary ══════════');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`);
console.log(`  ${files.length} files, ${files.length - failed} pass, ${failed} fail`);

process.exit(failed ? 1 : 0);
