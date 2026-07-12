#!/usr/bin/env node
'use strict';

/*
 * session-reconstruct.js — walk the forkedFrom chain to restore the full pre-compaction conversation → clean jsonl (offline archive, queried on demand)
 *
 * Mechanism (verified via white-box analysis): compaction = in-place, same file (a mid-file boundary has no forkedFrom;
 *   pre-compaction records stay before the boundary and are not deleted); --resume/fork-session = creates a new file (the first line is a replay block
 *   carrying forkedFrom that points at the parent), so the full history is spread across --resume files along the forkedFrom chain.
 * This command walks the chain collecting all records → dedups by uuid (records re-included across replays) → denoises (compact summary) → sorts by timestamp
 *   → writes one clean, complete jsonl (a first-class artifact that every session-intel command / external tool can consume).
 *
 * "Too big" strategy: write output to disk, don't load it into context; to read the content use parser --find / search to query fragments of the rebuilt file on demand.
 * Purpose = querying / analysis / extraction, not resume (pre-compaction may be 1M tokens, which resume would immediately blow up again).
 *
 * Dual entry: CLI (recensa-session reconstruct <session> [flags]) + library (require('@recensa/claude-session').reconstruct).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { walkChain } = require('../lib/resolver');
const { validateArgs } = require('../lib/argv');
const { atomicWrite } = require('../lib/atomic-write');

const FLAGS = [
  { name: '--out', value: 'file', desc: 'output jsonl path (default .claude-output/reconstruct-<id>.jsonl)' },
  { name: '--md', desc: 'also output human-readable markdown (👤/🤖 conversation)' },
  { name: '--stats', desc: 'print stats only (chain depth / dedup / restored count), no file written' },
  { name: '--include-noise', desc: 'keep compact_boundary/summary/content-replacement (denoised by default)' },
];

const NOISE_TYPES = new Set(['summary', 'content-replacement']);
const isCompactBoundary = (r) => r.type === 'system' && /compact_boundary/.test(r.subtype || '');

/** extract plain text from message content (string passthrough / take text blocks from an array) */
function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

/** process a single line: parse + denoise + uuid dedup, accumulating into state (pure reorg, logic unchanged) */
function ingestReconstructLine(line, state, includeNoise) {
  if (!line.trim()) return;
  let r; try { r = JSON.parse(line); } catch { return; }
  state.rawCount++;
  if (!includeNoise && (NOISE_TYPES.has(r.type) || isCompactBoundary(r))) { state.noiseSkip++; return; }
  if (r.uuid) {
    if (state.byUuid.has(r.uuid)) { state.dupSkip++; return; }
    state.byUuid.set(r.uuid, r);
  } else {
    state.byUuid.set('_nokey_' + (state.nokey++), r);
  }
}

/** walk liveChain collecting records → uuid dedup (re-included across forks) → denoise */
async function collectChainRecords(liveChain, includeNoise) {
  const state = { byUuid: new Map(), rawCount: 0, dupSkip: 0, noiseSkip: 0, nokey: 0 };
  for (const seg of liveChain) {
    const rl = readline.createInterface({ input: fs.createReadStream(seg.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      ingestReconstructLine(line, state, includeNoise);
    }
    rl.close();
  }
  const { byUuid, rawCount, dupSkip, noiseSkip } = state;
  return { byUuid, rawCount, dupSkip, noiseSkip };
}

/** write human-readable markdown (👤/🤖 conversation) */
function writeMarkdown(mdPath, records, curId, liveChain, convCount) {
  const body = records.filter((r) => r.type === 'user' || r.type === 'assistant').map((r) => {
    const role = r.type === 'user' ? '👤 User' : '🤖 Assistant';
    const text = extractText(r.message?.content);
    return `\n### ${role} ${(r.timestamp || '').slice(0, 19)}\n${text}`;
  }).join('\n');
  const md = `# Full pre-compaction conversation restore: ${curId}\n# fork chain ${liveChain.length} layers, ${convCount} conversations\n${body}\n`;
  atomicWrite(mdPath, md);
}

/**
 * Core: walk the fork chain to restore the full pre-compaction conversation (CLI and library share a single path).
 * @param {string} input  session identifier (absolute path / UUID prefix / --latest)
 * @param {{out?:string, md?:boolean, stats?:boolean, includeNoise?:boolean, cwd?:string}} [opts]
 * @returns {Promise<{outPath:(string|null), chainLayers:number, rawCount:number, dupSkip:number, noiseSkip:number, restored:number, convCount:number, broken:number}>}
 */
async function reconstruct(input, opts = {}) {
  const includeNoise = !!opts.includeNoise;
  const wantMd = !!opts.md;
  const statsOnly = !!opts.stats;
  const cwd = opts.cwd || process.cwd();

  // 1. walk the forkedFrom chain back to the root
  const chain = walkChain(input);
  const broken = chain.filter((c) => c.missing);
  if (broken.length) {
    process.stderr.write(`⚠️  broken chain: the parent jsonl referenced by forkedFrom was not found: ${broken.map((c) => c.sessionId.slice(0, 8)).join(', ')}\n`);
    process.stderr.write(`   two possibilities: (a) an earlier segment was deleted/cleaned (pre-compaction content is genuinely lost, irreversible); (b) the session had its UUID remapped by surgery (a branch fork deliberately cut its source, not data loss, expected).\n`);
  }
  const liveChain = chain.filter((c) => c.path);
  const curId = chain.at(-1).sessionId;

  // 2. walk the chain collecting records → uuid dedup (re-included across forks) → denoise
  const { byUuid, rawCount, dupSkip, noiseSkip } = await collectChainRecords(liveChain, includeNoise);

  // 3. sort by timestamp
  const records = [...byUuid.values()].sort((a, b) =>
    new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  const convCount = records.filter((r) => r.type === 'user' || r.type === 'assistant').length;

  const brokenSuffix = broken.length ? ` / ⚠️broken chain ${broken.length}` : '';
  process.stderr.write(`reconstruct ${curId.slice(0, 8)}: chain ${liveChain.length} layers / raw ${rawCount} → dedup -${dupSkip} / denoise -${noiseSkip} → restored ${records.length} records (${convCount} conversations)${brokenSuffix}\n`);

  const stats = {
    outPath: null, chainLayers: liveChain.length, rawCount, dupSkip, noiseSkip,
    restored: records.length, convCount, broken: broken.length,
  };
  if (statsOnly) return stats;

  // 4. write the clean jsonl (offline archive); an explicit out still has its parent dir ensured
  const outPath = opts.out || path.join(cwd, '.claude-output', `reconstruct-${curId.slice(0, 8)}.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  atomicWrite(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.stderr.write(`→ ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB; query on demand: parser <this file> --find "X" / search)\n`);

  // 5. optional human-readable md
  if (wantMd) {
    const mdPath = outPath.replace(/\.jsonl$/, '.md');
    writeMarkdown(mdPath, records, curId, liveChain, convCount);
    process.stderr.write(`→ ${mdPath}\n`);
  }

  return { ...stats, outPath };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    const fmt = (f) => {
      const valuePart = f.value ? ` <${f.value}>` : '';
      return `  ${(f.name + valuePart).padEnd(20)}${f.desc}`;
    };
    console.log('session-reconstruct.js — walk the fork chain to restore the full pre-compaction conversation\n\nUsage: recensa-session reconstruct <session> [flags]\n  session = absolute path / UUID prefix / --latest\n\nOptions:\n' + FLAGS.map(fmt).join('\n'));
    process.exit(0);
  }
  validateArgs(args, { known: FLAGS.map((f) => f.name), valueFlags: FLAGS.filter((f) => f.value).map((f) => f.name), scriptName: 'reconstruct' });

  const input = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  await reconstruct(input, {
    out: outIdx >= 0 ? args[outIdx + 1] : undefined,
    md: args.includes('--md'),
    stats: args.includes('--stats'),
    includeNoise: args.includes('--include-noise'),
  });
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { reconstruct };
