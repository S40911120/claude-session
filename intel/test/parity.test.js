'use strict';
/* Parity guardrail: require('@recensa/claude-session') named-function output == bin CLI `<cmd> --json` (the 8 commands the
   recensa adapter loads). Guards against future drift between index.js and the CLI (change one, forget the other
   → the frontend intel panel silently deforms).
   Uses the smallest real session as a fixture (≥20KB so it has content, smallest for speed); with no session it SKIPs
   (CI / other machines have no jsonl). */
const path = require('path');
const { execFileSync } = require('child_process');
const { listAllSessions } = require('../../lib/resolver');

const ROOT = path.join(__dirname, '..', '..');
const lore = require(path.join(ROOT, 'index.js'));
const BIN = path.join(ROOT, 'bin', 'recensa-session.js');

console.log('[parity.test.js]');

const sessions = listAllSessions().filter((s) => s.size >= 20 * 1024).sort((a, b) => a.size - b.size);
if (sessions.length === 0) {
  console.log('  SKIP  no ≥20KB session available as a fixture');
  process.exit(0);
}
const FILE = sessions[0].path;

function cli(args) {
  try {
    return JSON.parse(execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch (e) {
    if (e.stdout && String(e.stdout).trim()) return JSON.parse(e.stdout);
    throw e;
  }
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) o[k] = sortKeys(x[k]); return o; }
  return x;
}
const norm = (x) => JSON.stringify(sortKeys(JSON.parse(JSON.stringify(x))));

const CASES = [
  ['overview', () => lore.overview(FILE), ['overview', FILE, '--json']],
  ['tasks', () => lore.tasks(FILE), ['tasks', FILE, '--json']],
  ['goal', () => lore.goal(FILE), ['goal', FILE, '--json']],
  ['guard', () => lore.guard(FILE), ['guard', FILE, '--json']],
  ['failures', () => lore.failures(FILE), ['failures', FILE, '--summary', '--json']],
  ['tokenBudget', () => lore.tokenBudget(FILE), ['token-budget', FILE]],
  ['deadContext', () => lore.deadContext(FILE), ['dead-context', FILE, '--json']],
  ['cacheGuard', () => lore.cacheGuard(FILE), ['cache-guard', FILE, '--json']],
];

(async () => {
  let fail = 0;
  for (const [name, fn, args] of CASES) {
    try {
      const a = norm(await fn()), b = norm(cli(args));
      if (a === b) console.log(`  PASS  ${name} (lib == cli, ${a.length}B)`);
      else {
        fail++;
        let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        console.log(`  FAIL  ${name} @${i}: lib=${a.slice(i, i + 50)} | cli=${b.slice(i, i + 50)}`);
      }
    } catch (e) { fail++; console.log(`  FAIL  ${name}: ${String(e.message).split('\n')[0]}`); }
  }
  console.log(`  ── parity: ${CASES.length - fail} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
