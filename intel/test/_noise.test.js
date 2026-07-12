'use strict';
/* Regression test: lib/noise.js — isNoiseUserMessage / collapseBlocks / NON_HUMAN.
   Tests the actual existing behavior as the baseline, not the ideal behavior. */

const { NON_HUMAN, isNoiseUserMessage, collapseBlocks, PLACEHOLDERS } = require('../../lib/noise');
const A = require('./_assert')('_noise');
const { eq, ok, summary } = A;

console.log('[_noise.test.js]');

// ── NON_HUMAN regex ───────────────────────────────────────
ok('NON_HUMAN matches compaction continuation',
  NON_HUMAN.test('This session is being continued from a previous conversation'));
ok('NON_HUMAN matches Caveat:', NON_HUMAN.test('Caveat: foo'));
ok('NON_HUMAN matches <command-name>', NON_HUMAN.test('<command-name>x</command-name>'));
ok('NON_HUMAN matches <local-command', NON_HUMAN.test('<local-command-stdout>x'));
ok('NON_HUMAN matches <system-reminder', NON_HUMAN.test('<system-reminder>x'));
ok('NON_HUMAN matches <scheduled-task', NON_HUMAN.test('<scheduled-task>x'));
ok('NON_HUMAN matches Please continue', NON_HUMAN.test('Please continue'));
ok('NON_HUMAN matches Continue from where', NON_HUMAN.test('Continue from where you left off'));
ok('NON_HUMAN matches [Request interrupted', NON_HUMAN.test('[Request interrupted by user'));
ok('NON_HUMAN case-insensitive (caveat:)', NON_HUMAN.test('caveat: lower'));
ok('NON_HUMAN does NOT match plain human text', !NON_HUMAN.test('please take a look at this code'));
ok('NON_HUMAN anchored at start (mid-string no match)',
  !NON_HUMAN.test('I mentioned Caveat: in the middle'));

// ── isNoiseUserMessage ────────────────────────────────────
eq('null message → false', isNoiseUserMessage(null), false);
eq('undefined → false', isNoiseUserMessage(undefined), false);
eq('non-user role → false', isNoiseUserMessage({ role: 'assistant', text: 'hi' }), false);
eq('user with emptyKind → true (empty shell)',
  isNoiseUserMessage({ role: 'user', emptyKind: 'tool_result' }), true);
eq('user with NON_HUMAN text → true',
  isNoiseUserMessage({ role: 'user', text: 'Caveat: foo' }), true);
eq('user with NON_HUMAN text + leading whitespace (trim) → true',
  isNoiseUserMessage({ role: 'user', text: '   Please continue' }), true);
eq('user with real human text → false',
  isNoiseUserMessage({ role: 'user', text: 'help me fix this bug' }), false);
eq('user with no text no emptyKind → false',
  isNoiseUserMessage({ role: 'user' }), false);

// ── collapseBlocks (English placeholder set is the only one this public library ships) ──
eq('empty passthrough', collapseBlocks(''), '');
eq('null passthrough', collapseBlocks(null), null);
eq('plain text unchanged', collapseBlocks('plain text with no blocks'), 'plain text with no blocks');

eq('command-name collapsed',
  collapseBlocks('before <command-name>foo</command-name> after'),
  'before [slash-command marker] after');
eq('local-command-stdout collapsed',
  collapseBlocks('<local-command-stdout>lots of output</local-command-stdout>'),
  '[command output]');
eq('system-reminder collapsed',
  collapseBlocks('<system-reminder>reminder text</system-reminder>'),
  '[system-reminder]');
eq('tool_use collapsed',
  collapseBlocks('<tool_use id="x">body</tool_use>'),
  '[tool-call block]');

// Short code fence (< 8 lines) is kept as-is
const shortFence = '```js\nconst a = 1;\nconst b = 2;\n```';
eq('short code fence (<8 lines) preserved', collapseBlocks(shortFence), shortFence);

// Long code fence (≥ 8 lines) collapses to a placeholder
const longBody = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
const longFence = '```js\n' + longBody + '\n```';
const collapsedLong = collapseBlocks(longFence);
ok('long code fence (≥8 lines) collapsed to placeholder',
  collapsedLong.startsWith('[code block omitted') && collapsedLong.includes('(js)'), collapsedLong);

// minFenceLines is adjustable: lower the threshold to 2 → even a short fence collapses
const collapsedTight = collapseBlocks(shortFence, { minFenceLines: 2 });
ok('minFenceLines override lowers threshold',
  collapsedTight.startsWith('[code block omitted'), collapsedTight);

// frontmatter (name: + description: co-occur) collapses
const fm = '---\nname: foo\ndescription: bar\n---';
eq('skill frontmatter collapsed',
  collapseBlocks(fm), '[skill/command frontmatter block]');

// group2 gains a trailing '\n' → 11 split-lines
const longFence2 = '```js\n' + Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n```';
eq('long code fence line count', collapseBlocks(longFence2), '[code block omitted: 11 lines (js)]');
const allBlocks = collapseBlocks(
  '<command-name>c</command-name><local-command-stdout>o</local-command-stdout>' +
  '<tool_use id="1">t</tool_use>\n' + fm + '\n' + longFence2);
ok('default output contains no CJK',
  ![...allBlocks].some((ch) => { const c = ch.charCodeAt(0); return c >= 0x4e00 && c <= 0x9fff; }), allBlocks);
eq('PLACEHOLDERS export is the English set', PLACEHOLDERS.slashCommand, '[slash-command marker]');

// ── placeholders override ─────────────────────────────────
// The mechanism a caller uses to supply its own set (e.g. the maintainer's internal extraction tool,
// which keeps a byte-stable output contract). A custom set fully overrides the English default.
const custom = {
  slashCommand: '<SC>', commandOutput: '<CO>', systemReminder: '<SR>',
  toolCall: '<TC>', frontmatter: '<FM>', codeFence: (lines, suffix) => `<CF ${lines}${suffix}>`,
};
eq('placeholders override: slash-command',
  collapseBlocks('a <command-name>x</command-name> b', { placeholders: custom }), 'a <SC> b');
eq('placeholders override: tool-call',
  collapseBlocks('<tool_use id="1">t</tool_use>', { placeholders: custom }), '<TC>');
eq('placeholders override: code fence',
  collapseBlocks(longFence2, { placeholders: custom }), '<CF 11 (js)>');

process.exit(summary());
