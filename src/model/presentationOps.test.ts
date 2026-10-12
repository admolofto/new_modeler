import { describe, expect, it } from 'vitest';
import '../plugins';
import { diffDocs } from '../ai/diff';
import { aiOpSchema } from '../ai/tools';
import { emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';
import { createStore } from './store';
import { inches } from './units';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('setPresentation', () => {
  it('saves lighting and the eye height, and clears them with null', () => {
    let d = ok(emptyDoc(), [{ op: 'setPresentation', lighting: { preset: 'evening', exposure: 0.5 } }]);
    expect(d.presentation).toEqual({ views: [], lighting: { preset: 'evening', exposure: 0.5 } });
    d = ok(d, [{ op: 'setPresentation', eyeHeight: inches(60) }]);
    expect(d.presentation?.eyeHeight).toBe(inches(60));
    expect(d.presentation?.lighting?.preset).toBe('evening');
    // Lighting is replaced whole.
    d = ok(d, [{ op: 'setPresentation', lighting: { preset: 'night', underCabinet: true } }]);
    expect(d.presentation?.lighting).toEqual({ preset: 'night', underCabinet: true });
    d = ok(d, [{ op: 'setPresentation', lighting: null, eyeHeight: null }]);
    // Nothing left: no empty presentation.
    expect(d.presentation).toBeUndefined();
  });

  it('defaults the preset to auto', () => {
    const d = ok(emptyDoc(), [{ op: 'setPresentation', lighting: { exposure: -1 } }]);
    expect(d.presentation?.lighting).toEqual({ preset: 'auto', exposure: -1 });
  });

  it('refuses bad values, leaving the doc as it was', () => {
    for (const op of [
      { op: 'setPresentation', lighting: { preset: 'dusk' } },
      { op: 'setPresentation', lighting: { preset: 'day', exposure: 5 } },
      { op: 'setPresentation', lighting: { preset: 'day', sun: { azimuth: 10, elevation: 95 } } },
      { op: 'setPresentation', eyeHeight: -3 },
    ]) {
      const r = applyOps(emptyDoc(), [op as Op]);
      expect(r.ok).toBe(false);
    }
  });

  it('is one undo step', () => {
    const store = createStore(emptyDoc());
    store.dispatch([{ op: 'setPresentation', lighting: { preset: 'day' } }]);
    store.dispatch([{ op: 'setPresentation', lighting: { preset: 'night' } }]);
    expect(store.doc.presentation?.lighting?.preset).toBe('night');
    store.undo();
    expect(store.doc.presentation?.lighting?.preset).toBe('day');
    store.undo();
    expect(store.doc.presentation).toBeUndefined();
  });

  it('is in the AI op schema', () => {
    expect(aiOpSchema().safeParse({ op: 'setPresentation', lighting: { preset: 'evening' } }).success).toBe(true);
    expect(aiOpSchema().safeParse({ op: 'setPresentation', lighting: { preset: 'sunset' } }).success).toBe(false);
  });

  it('words the change in a diff', () => {
    const a = emptyDoc();
    const b = ok(a, [{ op: 'setPresentation', lighting: { preset: 'evening' } }]);
    expect(diffDocs(a, b).lines).toEqual(['~ lighting → evening']);
    const c = ok(b, [{ op: 'setPresentation', lighting: { preset: 'evening', exposure: 0.5, underCabinet: false } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ lighting: brightness +0.5 EV, under-cabinet lights off']);
    const e = ok(c, [{ op: 'setPresentation', lighting: null, eyeHeight: inches(60) }]);
    expect(diffDocs(c, e).lines).toEqual(['~ lighting reset', '~ eye height → 60"']);
  });
});
