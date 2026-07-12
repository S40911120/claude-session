'use strict';
/* Regression test: _utils.js — estimateTokens (ASCII / CJK / Hangul / Hiragana branches + conservative).
   Follows the actual heuristic: CJK/Hiragana/Katakana/Hangul = 1 token/char, everything else = 0.25/char, then Math.ceil. */

const { estimateTokens, isRawSentinel, stringifyRecord } = require('../../lib/util');
const A = require('./_assert')('_utils');
const { eq, summary } = A;

console.log('[_utils.test.js]');

// Boundaries
eq('empty string → 0', estimateTokens(''), 0);
eq('null → 0', estimateTokens(null), 0);
eq('undefined → 0', estimateTokens(undefined), 0);

// ASCII branch: 0.25/char, ceil
eq('4 ASCII chars → 1 (4*0.25=1)', estimateTokens('abcd'), 1);
eq('1 ASCII char → 1 (ceil 0.25)', estimateTokens('a'), 1);
eq('8 ASCII chars → 2', estimateTokens('abcdefgh'), 2);
eq('5 ASCII chars → 2 (ceil 1.25)', estimateTokens('abcde'), 2);

// CJK branch: 1/char
eq('1 CJK char → 1', estimateTokens('\u4e2d'), 1);
eq('3 CJK chars → 3', estimateTokens('\u4e2d\u6587\u5b57'), 3);

// Hiragana branch (0x3040-0x30FF): 1/char
eq('Hiragana \u3042 → 1', estimateTokens('\u3042'), 1);
eq('Katakana \u30ab → 1', estimateTokens('\u30ab'), 1);
eq('3 Hiragana → 3', estimateTokens('\u3042\u308a\u304c'), 3);

// Hangul branch (0xAC00-0xD7AF): 1/char
eq('Hangul \ud55c → 1', estimateTokens('\ud55c'), 1);
eq('3 Hangul → 3', estimateTokens('\ud55c\uad6d\uc5b4'), 3);

// Mixed: 2 CJK (2) + 4 ASCII (1) = 3
eq('mixed CJK+ASCII (\u4e2d\u6587abcd) → 3', estimateTokens('\u4e2d\u6587abcd'), 3);

// conservative multiplier 4/3 then ceil
// '\u4e2d\u6587\u5b57' = 3 tokens → ceil(3*4/3)=ceil(4)=4
eq('conservative 3 CJK → 4', estimateTokens('\u4e2d\u6587\u5b57', { conservative: true }), 4);
// 'abcd' = 1 → ceil(1*4/3)=ceil(1.333)=2
eq('conservative 4 ASCII → 2', estimateTokens('abcd', { conservative: true }), 2);

// Q1: shared malformed-line sentinel serializer (used by merge / extract-type; extractRange keeps its own form)
const { ok } = A;
ok('isRawSentinel true for {_raw}', isRawSentinel({ _raw: 'not json' }));
ok('isRawSentinel true for {_raw,_error}', isRawSentinel({ _raw: '{bad', _error: 'Unexpected token' }));
ok('isRawSentinel false for a real record', !isRawSentinel({ type: 'user', uuid: 'a' }));
ok('isRawSentinel false for null', !isRawSentinel(null));
ok('isRawSentinel false for a record with non-string _raw', !isRawSentinel({ _raw: 123 }));
eq('stringifyRecord emits a sentinel verbatim (drops the _error wrapper)', stringifyRecord({ _raw: '{bad json', _error: 'e' }), '{bad json');
eq('stringifyRecord JSON.stringifies a real record', stringifyRecord({ type: 'user' }), '{"type":"user"}');

process.exit(summary());
