#!/usr/bin/env node
'use strict';

/*
 * session-help-sync.js — Guardrail: verify each session subcommand's --help stays
 * in sync with its validateArgs known-flag list.
 *
 * Regression guard: a flag can exist in `known` yet be missing from --help, which
 * makes the model believe the feature does not exist and skip it. This lint runs
 * each subcommand's real output (--help vs the known list echoed back by an
 * unknown-flag probe) and compares the two-way difference: it catches "in known but
 * not shown in help" (missing) and "shown in help but not recognized by known"
 * (ghost flag).
 *
 * Usage: node session-help-sync.js   (exit 1 if drift)
 * Intended for pre-commit / health-check hooks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;
const UNIVERSAL = new Set(['--latest', '--latest-in', '--session-id', '--help', '-h', '--json', '-b']);
const FLAG_RE = /--[a-z][a-z0-9-]*/g;
const PROBE = '--zz_helpsync_probe_zz';

function run(script, args) {
  try {
    const out = execFileSync('node', [path.join(DIR, script), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    return { out, err: '' };
  } catch (e) {
    return { out: e.stdout || '', err: e.stderr || '' };
  }
}

// Include every subcommand script in the intel directory (including non-session- prefixes:
// token-budget/cache-guard/context-diff/dead-context etc.); exclude helpers
// (_ prefix), this file, and test files. Scripts without validateArgs are skipped
// automatically below (their probe echoes no known list), so a wide net is safe.
const scripts = fs.readdirSync(DIR).filter((f) =>
  f.endsWith('.js') && !f.startsWith('_') && f !== 'session-help-sync.js' && !f.endsWith('.test.js'));
const problems = [];
let checked = 0;

for (const s of scripts) {
  // 1. Trigger an unknown flag -> extract the "known options" list echoed by _argv-validate
  const probe = run(s, [PROBE]);
  const m = probe.err.match(/known options:\s*(.+)/);
  if (!m) continue; // this script does not use validateArgs (no known list) -> skip
  checked++;
  const known = new Set(m[1].split(',').map((x) => x.trim()).filter((x) => x.startsWith('--')));

  // 2. Flags actually listed by --help (first confirm the script really handles --help,
  //    otherwise --help runs as a normal invocation and pollutes the output)
  const help = run(s, ['--help']);
  const helpOut = help.out + help.err;
  const hasHelp = /usage:/i.test(helpOut.slice(0, 600)) || /\.js — /.test(helpOut.slice(0, 200));
  if (!hasHelp) {
    problems.push(`${s}: missing --help handling (--help runs as a normal invocation -> users cannot see usage)`);
    continue;
  }
  const helpFlags = new Set(helpOut.match(FLAG_RE) || []);

  // 3. Two-way difference (excluding flags common to all scripts)
  for (const k of known) {
    if (UNIVERSAL.has(k)) continue;
    if (!helpFlags.has(k)) problems.push(`${s}: known flag ${k} not listed in --help (missing -> users cannot see this feature)`);
  }
  for (const h of helpFlags) {
    if (UNIVERSAL.has(h)) continue;
    if (!known.has(h)) problems.push(`${s}: --help lists ${h} but validateArgs does not recognize it (ghost flag -> rejected when used)`);
  }
}

if (problems.length) {
  console.error(`❌ session-help-sync: ${problems.length} help<->flag mismatches (checked ${checked} subcommands with validateArgs)`);
  problems.forEach((p) => console.error(`   ${p}`));
  process.exit(1);
}
console.log(`✅ session-help-sync: --help and known flags fully in sync across ${checked} subcommands`);
process.exit(0);
