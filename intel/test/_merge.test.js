'use strict';
/* C2 merge UUID deconfliction: merging two sources that SHARE uuids must yield 0 duplicate UUIDs.
   C3 extractRange orphan trim: extracting a sub-range that cuts a tool_use away from its tool_result
   must leave the output resumable (no tool_use whose tool_result is out of range). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { merge, extractRange } = require('../../surgery/session-merger');
const A = require('./_assert')('_merge');
const { eq, ok, summary } = A;

console.log('[_merge.test.js]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-merge-'));
const write = (name, lines) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const allUuids = (records) => records.map((r) => r.uuid).filter(Boolean);

try {
  // ── C2: two sources deliberately reuse the same uuids (r1/r2) to force a collision ──
  {
    const mk = (sid) => ([
      { type: 'user', uuid: 'r1', parentUuid: null, sessionId: sid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'r2', parentUuid: 'r1', sessionId: sid, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } },
    ]);
    const s1 = write('s1.jsonl', mk('S1'));
    const s2 = write('s2.jsonl', mk('S2'));

    const res = merge([s1, s2]);
    ok('merge succeeds (chain validates)', res.success);
    eq('validation reports 0 duplicate UUIDs', res.validation.stats.duplicates, 0);
    const ids = allUuids(res.records);
    eq('no duplicate UUID across the merged sources', new Set(ids).size, ids.length);
    ok('both sources contributed their conversation records', res.validation.stats.conversations >= 4);
  }

  // ── C3: assistant tool_use T1 keeps a text block; its tool_result sits OUTSIDE the extracted range ──
  {
    const recs = [
      { type: 'assistant', uuid: 'a1', parentUuid: null, sessionId: 'S', timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', id: 'T1', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'u1', parentUuid: 'a1', sessionId: 'S', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'out' }] } },
    ];
    const src = write('range.jsonl', recs);

    const res = extractRange(src, 0, 0); // keep only the assistant → T1's tool_result is out of range
    ok('extractRange succeeded', res.success);
    ok('at least one orphan tool_use was trimmed', res.trimmedToolUses >= 1);

    // resumability invariant: every tool_use left in the output has a matching tool_result in the output
    const toolResultIds = new Set();
    for (const r of res.records)
      if (Array.isArray(r.message?.content))
        for (const b of r.message.content) if (b.type === 'tool_result' && b.tool_use_id) toolResultIds.add(b.tool_use_id);
    let orphanToolUses = 0, toolUseCount = 0;
    for (const r of res.records)
      if (Array.isArray(r.message?.content))
        for (const b of r.message.content)
          if (b.type === 'tool_use') { toolUseCount++; if (!toolResultIds.has(b.id)) orphanToolUses++; }
    eq('no orphan tool_use remains (output stays resumable)', orphanToolUses, 0);
    eq('the cut-off tool_use was removed entirely', toolUseCount, 0);

    // the record itself survived on its remaining text block (strip, not drop)
    const survivor = res.records.find((r) => r.type === 'assistant');
    ok('assistant survived on its text block', !!survivor && survivor.message.content.some((b) => b.type === 'text'));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
