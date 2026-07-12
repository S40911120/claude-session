'use strict';
/* C5 surgeon insertAfter: the inserted node joins the linear chain as afterUuid -> insert -> (former
   children). Every record that used to hang directly off afterUuid must be re-parented to the inserted
   node (not left pointing at afterUuid, which would fork the chain). */

const { insertAfter } = require('../../surgery/session-surgeon');
const A = require('./_assert')('_surgeon');
const { eq, ok, summary } = A;

console.log('[_surgeon.test.js]');

// A is the anchor; B and C both hang directly off A (its "former children").
const records = [
  { uuid: 'A', parentUuid: null, type: 'user', message: { role: 'user', content: 'a' } },
  { uuid: 'B', parentUuid: 'A', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
  { uuid: 'C', parentUuid: 'A', type: 'user', message: { role: 'user', content: 'c' } },
];

const res = insertAfter(records, 'A', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'inserted' }] } });
ok('insertAfter reports inserted', res.inserted === true);
ok('a new uuid was assigned', !!res.newUuid);

const byUuid = (u) => res.records.find((r) => r.uuid === u);
const N = res.newUuid;
eq('inserted node is parented to the anchor A', byUuid(N).parentUuid, 'A');
eq('former child B re-parented to the inserted node', byUuid('B').parentUuid, N);
eq('former child C re-parented to the inserted node', byUuid('C').parentUuid, N);
eq('anchor A is unchanged (still a root)', byUuid('A').parentUuid, null);
eq('record count grew by exactly one', res.records.length, records.length + 1);

// missing anchor is a clean no-op error (not a throw / silent success)
const miss = insertAfter(records, 'NOPE', { type: 'user' });
ok('insertAfter on a missing anchor returns inserted:false', miss.inserted === false && !!miss.error);

process.exit(summary());
