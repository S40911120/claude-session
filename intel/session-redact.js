#!/usr/bin/env node
'use strict';

/*
 * session-redact.js — mask API keys / credentials before export/handoff/share
 *
 * Security is the developer's responsibility, not a feature request: whenever you share a session / archive export / handoff,
 * API keys / tokens / passwords inside tool output (env dumps, curl -H, config file contents) can leak.
 * This command scans every string value across the whole jsonl, masks common credential patterns → writes a clean copy (leaves the original untouched).
 *
 * Masking patterns (keep a few leading/trailing chars for recognition, replace the middle with ***REDACTED***):
 *   sk-/sk-ant-…  OpenAI/Anthropic key
 *   ghp_/gho_/ghs_/github_pat_  GitHub token
 *   Bearer <token>  Authorization header
 *   Basic <base64>  Authorization Basic-auth header
 *   AKIA…  AWS access key id
 *   password= / passwd= / pwd= / token= / api_key= / secret=  assignment form
 *   xoxb-/xoxp-  Slack token
 *   eyJ…(long JWT)  JWT
 *
 * Usage: recensa-session redact <session> [--out <f>] [--stdout] [--dry-run] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { resolveFromArgs } = require('../lib/resolver');
const { validateArgs } = require('../lib/argv');
const { atomicWriteLines } = require('../lib/atomic-write');

const FLAGS = [
  { name: '--out', value: 'file', desc: 'output path (default .claude-output/redacted-<id>.jsonl)' },
  { name: '--stdout', desc: 'write to stdout (for piping; does not write a file)' },
  { name: '--dry-run', desc: 'only report how many would be masked with per-type counts, no file written' },
];

// [label, regex(global), replacer]. The replacer keeps a recognizable head/tail and masks the middle.
const MASK = '***REDACTED***';
const keep = (s, head, tail) => s.length <= head + tail ? MASK : s.slice(0, head) + MASK + s.slice(s.length - tail);

const RULES = [
  ['anthropic/openai-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, (m) => keep(m, 6, 0)],
  ['github-token', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g, (m) => keep(m, 4, 0)],
  ['github-pat', /\bgithub_pat_\w{20,}\b/g, () => 'github_pat_' + MASK],
  ['aws-akid', /\bAKIA[0-9A-Z]{16}\b/g, (m) => keep(m, 4, 0)],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, (m) => keep(m, 5, 0)],
  // value class covers base64/base64url (incl. + / = and JWT's .) so an opaque base64 token masks whole —
  // the old [A-Za-z0-9._-] class stopped at the first +/=// and leaked the tail. Class excludes " , { } and
  // whitespace so it can't run past a JSON string boundary. JWTs stay covered (still all valid class chars).
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, () => 'Bearer ' + MASK],
  // Authorization: Basic <base64(user:pass)> — anchored to the header name so the common word "Basic" alone
  // (e.g. "Basic authentication") isn't masked. Preserves the "Authorization...Basic " prefix, masks the base64.
  ['basic-auth', /\b(Authorization["'\s:]*Basic\s+)[A-Z0-9+/=]{8,}/gi, (_m, pre) => pre + MASK],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, () => MASK + '.jwt'],
  ['pem-private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g, () => MASK + '.private-key'],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, (m) => keep(m, 8, 0)],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g, (m) => keep(m, 4, 0)],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g, () => 'npm_' + MASK],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, () => 'SG.' + MASK],
  // the value capture group (40-char base64) is equivalent to [A-Za-z0-9/+] under /i (a-z is redundant with A-Z) → keep [A-Z0-9/+], detection unchanged
  ['aws-secret', /\b(aws_secret_access_key|aws_secret_key)(\s*[=:]\s*)(["']?)([A-Z0-9/+]{40})\3/gi, (_m, k, sep, q) => `${k}${sep}${q}${MASK}${q}`],
  // ── round-7 gap fixes: additional provider credential formats. Each regex: a distinctive long prefix +
  //    a single bounded char class with a length floor → won't over-mask ordinary prose, and no nested/
  //    overlapping quantifiers (neighbouring atoms use disjoint char sets) → no catastrophic backtracking. ──
  // Azure Storage: AccountKey / SharedAccessKey base64 value (the [A-Za-z0-9+/] class excludes '=', so {40,}
  // stops before the padding that ={0,2} then consumes — disjoint, linear). AccountName= is untouched.
  ['azure-storage-key', /\b(AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,}={0,2}/g, (_m, k) => `${k}=${MASK}`],
  // Azure SAS signature (raw or URL-encoded base64; the class also allows % for %2B/%2F/%3D escapes).
  ['azure-sas-sig', /\bsig=[A-Za-z0-9%+/=]{40,}/g, () => 'sig=' + MASK],
  // Slack incoming-webhook URL + xapp- app-level token (xox[baprs]- is already covered above).
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g, () => 'https://hooks.slack.com/services/' + MASK],
  ['slack-app-token', /\bxapp-[A-Za-z0-9-]{12,}/g, (m) => keep(m, 5, 0)],
  // GCP OAuth client secret.
  ['gcp-oauth-secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, (m) => keep(m, 7, 0)],
  // Stripe webhook signing secret (sk_/rk_ live/test keys are already covered by stripe-key above).
  ['stripe-webhook-secret', /\bwhsec_[A-Za-z0-9]{20,}\b/g, () => 'whsec_' + MASK],
  // DigitalOcean personal token + GitLab personal access token.
  ['digitalocean-token', /\bdop_v1_[a-f0-9]{40,}\b/g, () => 'dop_v1_' + MASK],
  ['gitlab-pat', /\bglpat-[A-Za-z0-9_-]{20,}/g, (m) => keep(m, 6, 0)],
  // user/pass exclude " so a URI without an @ (or whose real @ is later) can't let the password class run past
  // the JSON string boundary and mask across the next key/value, corrupting the line. Still excludes @ / and whitespace.
  ['conn-uri-cred', /\b([a-z][a-z0-9+.-]*:\/\/)([^:/?#\s"]+):([^@/?#\s"]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${MASK}@`],
  // Assignment form, shell/env style: key=value / key: value / key="value".
  // A bare `key: word` (colon separator, unquoted) is ambiguous with ordinary prose ("set the token:
  // myVariableName in config"), so only treat the unquoted-colon form as a secret when the value is
  // entropy-ish (contains a digit); the `=` form and any quoted value are unambiguous and always masked.
  // Returning the untouched match for prose reports no hit (redactString counts a rule only when it changes text).
  ['assignment-secret', /\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token)(\s*[=:]\s*)(["']?)([^"'\s,;}\\]{4,})\3/gi,
    (m, k, sep, q, v) => (!q && sep.includes(':') && !/\d/.test(v)) ? m : `${k}${sep}${q}${MASK}${q}`],
  // Assignment form, JSON style: "key":"value" — the key's closing quote breaks the [=:]-after-key rule
  // above, so match the quoted-key form separately. The value class (?:[^"\\]|\\.){4,} consumes each
  // \<char> escape as ONE unit so a secret containing \" or \\ masks IN FULL (no leak) and still stops at
  // the REAL closing quote (no corruption). ReDoS-safe: the two alternatives have disjoint first chars
  // ([^"\\] never starts with \, \\. always does) → each position matches at most one branch, no backtracking.
  ['assignment-secret-json', /"(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token)"(\s*:\s*)"((?:[^"\\]|\\.){4,})"/gi,
    (_m, k, sep) => `"${k}"${sep}"${MASK}"`],
];

// Column width for the --dry-run / --json per-type summary so counts line up: the widest rule label,
// derived from RULES instead of a magic number (= len('assignment-secret-json')).
const LABEL_WIDTH = Math.max(...RULES.map(([label]) => label.length));

/** mask a string, returns { text, hits: {label:count} } */
function redactString(str) {
  let text = str;
  const hits = {};
  for (const [label, re, rep] of RULES) {
    text = text.replace(re, (...a) => {
      const out = rep(...a);
      if (out !== a[0]) hits[label] = (hits[label] || 0) + 1; // count only a real mask (a[0] = full match)
      return out;
    });
  }
  return { text, hits };
}

function printRedactHelp() {
  const fmt = (f) => {
    const valPart = f.value ? ` <${f.value}>` : '';
    return `  ${(f.name + valPart).padEnd(14)}${f.desc}`;
  };
  console.log(`session-redact.js — mask API keys / credentials before export/handoff

Usage: recensa-session redact <session> [flags]
  session = absolute path / UUID prefix (>=6) / --latest

Options:
${FLAGS.map(fmt).join('\n')}

Masks: sk-/ghp_/Bearer/AKIA/xox-/JWT/password=token=secret= etc.`);
}

/** scan the whole file line by line and mask, returning collected counts and output lines (pure reorg, per-line side-effect order unchanged) */
async function scanFile(filePath, { dryRun, toStdout }) {
  const totalHits = {};
  let redactedLines = 0, lineCount = 0;
  const outLines = [];

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) { if (!dryRun && !toStdout) { outLines.push(line); } continue; }
    lineCount++;
    // mask at the whole-line JSON string level (covers all nested values). Masking the serialized string avoids walking the AST.
    const { text, hits } = redactString(line);
    if (Object.keys(hits).length) {
      redactedLines++;
      for (const [k, v] of Object.entries(hits)) totalHits[k] = (totalHits[k] || 0) + v;
    }
    if (toStdout) process.stdout.write(text + '\n');
    else if (!dryRun) outLines.push(text);
  }
  rl.close();
  return { totalHits, redactedLines, lineCount, outLines };
}

/** output the masking summary (json or human-readable), separated from file writing (pure reorg, output strings unchanged) */
function reportRedaction(args, ctx) {
  const { filePath, lineCount, redactedLines, totalHits, totalCount, dryRun, toStdout, outPath } = ctx;
  if (args.includes('--json')) {
    console.error(JSON.stringify({ filePath, lineCount, redactedLines, totalRedacted: totalCount, byType: totalHits, out: dryRun || toStdout ? null : outPath }, null, 2));
  } else {
    console.error(`🔒 scanned ${lineCount} lines, ${redactedLines} contained credentials, masked ${totalCount} in total`);
    for (const [k, v] of Object.entries(totalHits).sort((a, b) => b[1] - a[1])) console.error(`   ${k.padEnd(LABEL_WIDTH)} ${v}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printRedactHelp(); process.exit(0); }
  validateArgs(args, {
    known: FLAGS.map((f) => f.name),
    valueFlags: FLAGS.filter((f) => f.value).map((f) => f.name),
    scriptName: 'redact',
  });

  let resolved;
  try { resolved = resolveFromArgs(args); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  const filePath = resolved.path;

  const dryRun = args.includes('--dry-run');
  const toStdout = args.includes('--stdout');
  const outIdx = args.indexOf('--out');
  const outDir = path.join(process.cwd(), '.claude-output');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(outDir, `redacted-${resolved.sessionId.slice(0, 8)}.jsonl`);

  const { totalHits, redactedLines, lineCount, outLines } = await scanFile(filePath, { dryRun, toStdout });
  const totalCount = Object.values(totalHits).reduce((s, v) => s + v, 0);

  reportRedaction(args, { filePath, lineCount, redactedLines, totalHits, totalCount, dryRun, toStdout, outPath });

  if (dryRun) { console.error('(--dry-run: no file written)'); return; }
  if (toStdout) return;

  fs.mkdirSync(outDir, { recursive: true });
  // Stream to disk instead of outLines.join('\n') — the join builds one string that RangeErrors past V8's
  // MAX_STRING_LENGTH (~512 MiB) on very large sessions, mirroring the per-line --stdout path. Bytes are
  // unchanged: for a non-empty file atomicWriteLines == join('\n') + '\n'; an empty file (no lines at all)
  // stays a 0-byte file, exactly as the old `+ (outLines.length ? '\n' : '')` produced.
  if (outLines.length) atomicWriteLines(outPath, outLines);
  else fs.writeFileSync(outPath, '');
  console.error(`→ ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { redactString, RULES };
