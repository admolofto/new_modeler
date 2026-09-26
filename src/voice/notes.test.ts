import { describe, expect, it } from 'vitest';
import '../plugins';
import { parseTidyReply, TidyInput, tidyPrompt } from '../ai/tidy';
import { emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { align } from './align';
import { attach, candidates, fromDrafts, fromTidy, noteOps, tidyInput } from './notes';
import { spansOf, wordsOf, type SimStep } from './script';

const panel = (id: string, name: string, parent?: string): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name, material: 'ply-3-4', shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } } },
  ...(parent && { parent }),
});

function doc(): Doc {
  const r = applyOps(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'cab', name: 'Cabinet' } },
    panel('top', 'Top', 'cab'),
    panel('side', 'Side'),
    panel('side2', 'Side'),
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const STEPS: SimStep[] = [
  { at: 0, hover: { node: 'top', handle: 'face:top', at: [1, 2, 3] } },
  { at: 500, say: 'the top should overhang' },
  { at: 1800, hover: null },
  { at: 3000, say: 'um and this side needs holes' },
  { at: 2600, hover: 'side' },
];

function session() {
  const words = wordsOf(STEPS);
  const spans = spansOf(STEPS, 10_000);
  const drafts = align(words, spans);
  return { words, spans, drafts };
}

describe('voice notes → tidy input and ops', () => {
  it('lists drafts’ targets, what was pointed at, parents, then other parts, with unique labels', () => {
    const { spans, drafts } = session();
    const c = candidates(doc(), spans, drafts);
    expect(c.map((x) => [x.id, x.label, x.hovered])).toEqual([
      [1, 'Top · face:top', true],
      [2, 'Side [side]', true],
      [3, 'Top', true],
      [4, 'Cabinet', false],
      [5, 'Side [side2]', false],
    ]);
    expect(c[2]!.target).toEqual({ node: 'top', at: [1, 2, 3] });
  });

  it('writes the transcript with hover markers and pauses, drafts as candidate ids', () => {
    const { words, spans, drafts } = session();
    const input = tidyInput(words, spans, drafts, candidates(doc(), spans, drafts), 0);
    expect(TidyInput.safeParse(input).success).toBe(true);
    expect(input.transcript).toBe('[0.5s → #1 Top · face:top] the top should overhang ‖ [3.0s → #2 Side [side]] um and this side needs holes');
    expect(input.drafts.map((d) => d.targets)).toEqual([[1], [2]]);
    expect(tidyPrompt(input)).toContain('#1 Top · face:top *');
  });

  it('maps tidy ids back to targets, dropping unknown ones and empty notes', () => {
    const { spans, drafts } = session();
    const c = candidates(doc(), spans, drafts);
    expect(fromTidy({ notes: [{ note: ' Overhang the top ', targets: [3, 99] }, { note: '  ', targets: [1] }] }, c)).toEqual([
      { note: 'Overhang the top', targets: [{ node: 'top', at: [1, 2, 3] }] },
    ]);
  });

  it('gives notes with no target the fallback, or skips them', () => {
    const notes = [
      { note: 'a', targets: [{ node: 'top' }] },
      { note: 'b', targets: [] },
    ];
    expect(attach(notes, [{ node: 'cab' }]).notes.map((n) => n.targets)).toEqual([[{ node: 'top' }], [{ node: 'cab' }]]);
    expect(attach(notes, [])).toEqual({ notes: [notes[0]], skipped: ['b'] });
  });

  it('makes one add op per note, which applies', () => {
    const { drafts } = session();
    const ops = noteOps(fromDrafts(drafts));
    expect(ops).toHaveLength(2);
    const r = applyOps(doc(), ops);
    expect(r.ok && Object.values(r.doc.annotations).map((a) => a.note)).toEqual(['The top should overhang.', 'Um and this side needs holes.']);
  });
});

describe('tidy reply', () => {
  const ids = new Set([1, 2, 3]);
  it('reads JSON inside code fences and prose', () => {
    expect(parseTidyReply('Here you go:\n```json\n{"notes":[{"note":"Fix it","targets":[1,1,7]}]}\n```', ids)).toEqual({ notes: [{ note: 'Fix it', targets: [1] }] });
  });
  it('rejects replies that aren’t the notes format', () => {
    expect(() => parseTidyReply('no idea', ids)).toThrow(/no JSON/);
    expect(() => parseTidyReply('{"notes": [}', ids)).toThrow(/valid JSON/);
    expect(() => parseTidyReply('{"notes":[{"note":"","targets":[]}]}', ids)).toThrow(/notes format/);
  });
});
