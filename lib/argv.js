/**
 * argv.js — shared args validator
 *
 * Purpose: called at the top of each script's main() to detect unknown flags.
 *
 * Usage:
 *   const { validateArgs } = require('./argv');
 *   validateArgs(args, {
 *     known: ['--since', '--until', '--json', '--help'],
 *     valueFlags: ['--since', '--until'],   // flags that take a following value
 *     scriptName: 'overview',
 *   });
 *   // unknown flag → prints stderr ❌ + lists known flags + process.exit(2)
 */

'use strict';

// Flags common to every script (recognized by resolver / the recensa-session dispatcher)
const UNIVERSAL_FLAGS = ['--latest', '--latest-in', '--session-id', '--help', '-h', '--json'];

function validateArgs(args, opts = {}) {
  const known = new Set([...UNIVERSAL_FLAGS, ...(opts.known || [])]);
  const valueFlags = new Set(opts.valueFlags || []);
  const scriptName = opts.scriptName || 'script';

  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') && a !== '-h' && a !== '-b') continue;
    // skip the value of a known flag (so a value is not mistaken for a flag)
    if (i > 0 && valueFlags.has(args[i - 1])) continue;
    if (!known.has(a) && a !== '-b') {
      unknown.push(a);
    }
  }

  if (unknown.length > 0) {
    console.error(`❌ ${scriptName}: unknown option ${unknown.join(', ')}`);
    console.error(`   known options: ${[...known].sort((a, b) => (a < b ? -1 : Number(a > b))).join(', ')}`);
    console.error(`   run with --help for full usage`);
    process.exit(2);
  }
}

module.exports = { validateArgs, UNIVERSAL_FLAGS };
