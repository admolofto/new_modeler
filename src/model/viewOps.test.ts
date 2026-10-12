import { describe, expect, it } from 'vitest';
import '../plugins';
import { diffDocs } from '../ai/diff';
import { aiOpSchema } from '../ai/tools';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';
import { createStore } from './store';
import { inches } from './units';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const fails = (doc: Doc, ops: Op[]) => {
  const r = applyOps(doc, ops);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};

/** A drawer base with two doors under two drawers, and a stool. */
const kitchen = () =>
  ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [inches(6), inches(6)], doors: 2 } } } },
    { op: 'add', entity: { kind: 'decor', id: 'stool', shape: { type: 'barStool', params: {} }, transform: { position: [0, 0, inches(40)] } } },
  ]);

const view = (id: string, name: string, extra: Record<string, unknown> = {}): Op => ({ op: 'add', entity: { kind: 'view', id, name, frame: { nodes: [] }, ...extra } as never });
const ids = (d: Doc) => d.presentation?.views.map((v) => v.id);

describe('view ops', () => {
  it('adds views in order (ids view1, view2…), at an index when given', () => {
    let d = ok(kitchen(), [
      { op: 'add', entity: { kind: 'view', name: 'Whole', frame: {} } },
      { op: 'add', entity: { kind: 'view', name: 'Drawers', frame: { nodes: ['a1'], from: 'front' }, open: ['a1.drawer-1'], caption: 'Soft-close drawers' } },
    ]);
    expect(ids(d)).toEqual(['view1', 'view2']);
    expect(d.presentation!.views[0]!.frame).toEqual({ nodes: [], from: 'front-left' });
    d = ok(d, [{ op: 'add', entity: { kind: 'view', name: 'First', camera: { position: [0, 64, 6400], target: [0, 0, 0] } }, index: 0 }]);
    expect(ids(d)).toEqual(['view3', 'view1', 'view2']);
    expect(d.presentation!.views[0]!.camera!.fov).toBe(50);
  });

  it('refuses a view with neither or both of camera and frame, or ids that do not exist', () => {
    expect(fails(kitchen(), [{ op: 'add', entity: { kind: 'view', name: 'X' } }])).toMatch(/camera or a frame/);
    expect(fails(kitchen(), [view('v', 'X', { camera: { position: [0, 0, 1], target: [0, 0, 0] } })])).toMatch(/not both/);
    expect(fails(kitchen(), [view('v', 'X', { open: ['nope'] })])).toMatch(/"nope" to open/);
    expect(fails(kitchen(), [view('v', 'X', { hide: ['nope'] })])).toMatch(/"nope" to hide/);
    expect(fails(kitchen(), [view('v', 'X', { frame: { nodes: ['nope'] } })])).toMatch(/"nope" to frame/);
    expect(fails(kitchen(), [view('a1', 'X')])).toMatch(/already in use/);
  });

  it('updates a view, keeping a camera or a frame', () => {
    let d = ok(kitchen(), [view('v', 'Island', { frame: { nodes: ['a1'], from: 'front', azimuth: 10 } })]);
    // frame merges; null clears one of its fields.
    d = ok(d, [{ op: 'update', id: 'v', patch: { frame: { from: 'above', azimuth: null }, caption: 'Top down' } }]);
    expect(d.presentation!.views[0]).toEqual({ id: 'v', name: 'Island', frame: { nodes: ['a1'], from: 'above' }, caption: 'Top down' });
    // A camera replaces the frame, and the other way round.
    d = ok(d, [{ op: 'update', id: 'v', patch: { camera: { position: [0, 3968, 6400], target: [0, 0, 0], fov: 60 }, mode: 'walk' } }]);
    expect(d.presentation!.views[0]!.frame).toBeUndefined();
    expect(d.presentation!.views[0]!.camera?.fov).toBe(60);
    d = ok(d, [{ op: 'update', id: 'v', patch: { frame: { nodes: [] }, mode: null, caption: null } }]);
    expect(d.presentation!.views[0]).toEqual({ id: 'v', name: 'Island', frame: { nodes: [], from: 'front-left' } });
    // Clearing the frame without a camera breaks the rule.
    expect(fails(d, [{ op: 'update', id: 'v', patch: { frame: null } }])).toMatch(/camera or a frame/);
    expect(fails(d, [{ op: 'update', id: 'v', patch: { camera: { position: [0, 0, 1], target: [0, 0, 0] }, frame: { from: 'eye' } } }])).toMatch(/not both/);
    expect(fails(d, [{ op: 'update', id: 'v', patch: { position: [0, 0, 0] } }])).toMatch(/invalid patch/);
    expect(fails(d, [{ op: 'update', id: 'v', patch: { open: ['ghost'] } }])).toMatch(/ghost/);
  });

  it('deletes and reorders views', () => {
    let d = ok(kitchen(), [view('a', 'A'), view('b', 'B'), view('c', 'C')]);
    d = ok(d, [{ op: 'move', id: 'c', index: 0 }]);
    expect(ids(d)).toEqual(['c', 'a', 'b']);
    d = ok(d, [{ op: 'move', id: 'c', index: 9 }]);
    expect(ids(d)).toEqual(['a', 'b', 'c']);
    expect(fails(d, [{ op: 'move', id: 'a', to: [0, 0, 0] }])).toMatch(/reorders the tour/);
    expect(fails(d, [{ op: 'move', id: 'a' }])).toMatch(/index/);
    d = ok(d, [{ op: 'delete', id: 'b' }]);
    expect(ids(d)).toEqual(['a', 'c']);
    // The last view gone, nothing else saved: no empty presentation.
    d = ok(d, [{ op: 'delete', id: 'a' }, { op: 'delete', id: 'c' }]);
    expect(d.presentation).toBeUndefined();
  });

  it('keeps a presentation that still has lighting when its views go', () => {
    const d = ok(kitchen(), [view('a', 'A'), { op: 'setPresentation', lighting: { preset: 'night' } }, { op: 'delete', id: 'a' }]);
    expect(d.presentation).toEqual({ views: [], lighting: { preset: 'night' } });
  });

  it('prunes ids that no longer resolve when things are deleted', () => {
    let d = ok(kitchen(), [
      { op: 'add', entity: { kind: 'motion', id: 'spin', nodes: ['stool'], type: 'slide', params: {} } },
      view('v', 'V', { frame: { nodes: ['a1', 'stool'] }, open: ['a1.motion.drawer-1', 'spin', 'a1.drawer-2'], hide: ['stool'] }),
    ]);
    d = ok(d, [{ op: 'delete', id: 'stool' }]);
    expect(d.presentation!.views[0]).toEqual({ id: 'v', name: 'V', frame: { nodes: ['a1'], from: 'front-left' }, open: ['a1.motion.drawer-1', 'a1.drawer-2'] });
    // One drawer left: its folder and motion go, and so do the view's references to them.
    d = ok(d, [{ op: 'update', id: 'a1', patch: { params: { drawers: [inches(6)] } } }]);
    expect(d.presentation!.views[0]!.open).toEqual(['a1.motion.drawer-1']);
    d = ok(d, [{ op: 'delete', id: 'a1' }]);
    expect(d.presentation!.views[0]).toEqual({ id: 'v', name: 'V', frame: { nodes: [], from: 'front-left' } });
  });

  it('is one undo step per change', () => {
    const store = createStore(kitchen());
    store.dispatch([view('v', 'V')]);
    store.dispatch([{ op: 'update', id: 'v', patch: { name: 'Island' } }]);
    expect(store.doc.presentation!.views[0]!.name).toBe('Island');
    store.undo();
    expect(store.doc.presentation!.views[0]!.name).toBe('V');
    store.undo();
    expect(store.doc.presentation).toBeUndefined();
  });

  it('is in the AI op schema', () => {
    const schema = aiOpSchema();
    expect(schema.safeParse({ op: 'add', entity: { kind: 'view', name: 'Island', frame: { nodes: ['a1'] }, open: ['a1'], caption: 'Drawers open' } }).success).toBe(true);
    expect(schema.safeParse({ op: 'add', entity: { kind: 'view', name: 'Bad', frame: { from: 'below' } } }).success).toBe(false);
  });

  it('words view changes in a diff', () => {
    const a = kitchen();
    const b = ok(a, [view('v', 'Island', { open: ['a1.motion.drawer-1'] }), view('w', 'Sink')]);
    expect(diffDocs(a, b).lines).toEqual(['+ view "Island"', '+ view "Sink"']);
    const c = ok(b, [{ op: 'update', id: 'v', patch: { camera: { position: [0, 64, 6400], target: [0, 0, 0] }, open: ['a1.motion.drawer-2'], caption: 'Open drawer' } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ view "Island": camera moved; opens Drawer 2; caption "Open drawer"']);
    const e = ok(c, [{ op: 'move', id: 'w', index: 0 }]);
    expect(diffDocs(c, e).lines).toEqual(['~ views reordered: "Sink", "Island"']);
    const f = ok(e, [{ op: 'delete', id: 'w' }, { op: 'update', id: 'v', patch: { name: 'Island 2', open: null, lighting: 'evening' } }]);
    expect(diffDocs(e, f).lines).toEqual(['~ view "Island 2": renamed (was "Island"); opens nothing; lighting → evening', '− view "Sink"']);
  });
});
