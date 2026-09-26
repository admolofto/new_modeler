import { describe, expect, it } from 'vitest';
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

const addPanel: Op = {
  op: 'add',
  entity: { kind: 'part', name: 'Panel', material: 'ply-3-4', shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } } },
};
const hole = (at: [number, number], d = inches(1)): Op => ({
  op: 'addFeature',
  part: 'p1',
  feature: { type: 'hole', params: { face: 'face:front', at, d } },
});

describe('applyOps', () => {
  it('adds parts with deterministic ids and default transform', () => {
    const d = ok(emptyDoc(), [addPanel, addPanel]);
    expect(d.roots).toEqual(['p1', 'p2']);
    expect(d.parts.p1!.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it('never mutates the input doc', () => {
    const d0 = emptyDoc();
    const before = JSON.stringify(d0);
    ok(d0, [addPanel, hole([inches(6), inches(10)])]);
    expect(JSON.stringify(d0)).toBe(before);
  });

  it('updates, moves, and deletes', () => {
    let d = ok(emptyDoc(), [addPanel]);
    d = ok(d, [
      { op: 'update', id: 'p1', patch: { name: 'Side', shape: { params: { y: inches(20) } } } },
      { op: 'move', id: 'p1', to: [64, 0, 0] },
      { op: 'move', id: 'p1', by: [64, 64, 0], rotation: [0, 90, 0] },
    ]);
    expect(d.parts.p1!.name).toBe('Side');
    expect(d.parts.p1!.shape.params).toEqual({ x: inches(12), y: inches(20), z: 46 });
    expect(d.parts.p1!.transform).toEqual({ position: [128, 64, 0], rotation: [0, 90, 0] });
    d = ok(d, [{ op: 'delete', id: 'p1' }]);
    expect(d.parts).toEqual({});
    expect(d.roots).toEqual([]);
  });

  it('adds, resolves and deletes notes; stale targets are allowed', () => {
    let d = ok(emptyDoc(), [
      addPanel,
      { op: 'add', entity: { kind: 'annotation', note: 'too tall', targets: [{ node: 'p1', handle: 'face:top', at: [10, 20, 30] }] } },
    ]);
    expect(d.annotations.n1).toEqual({ id: 'n1', note: 'too tall', targets: [{ node: 'p1', handle: 'face:top', at: [10, 20, 30] }], resolved: false });
    d = ok(d, [{ op: 'update', id: 'n1', patch: { resolved: true } }, { op: 'delete', id: 'p1' }]);
    expect(d.annotations.n1!.resolved).toBe(true);
    expect(applyOps(d, [{ op: 'update', id: 'n1', patch: { color: 'red' } }]).ok).toBe(false);
    expect(ok(d, [{ op: 'delete', id: 'n1' }]).annotations).toEqual({});
  });

  it('adds, updates and removes features', () => {
    let d = ok(emptyDoc(), [addPanel, hole([inches(6), inches(10)])]);
    expect(d.parts.p1!.features).toEqual([{ id: 'f1', type: 'hole', params: { face: 'face:front', at: [inches(6), inches(10)], d: 64 } }]);
    d = ok(d, [{ op: 'updateFeature', part: 'p1', feature: 'f1', params: { d: inches(2) } }]);
    expect(d.parts.p1!.features[0]!.params.d).toBe(inches(2));
    d = ok(d, [{ op: 'removeFeature', part: 'p1', feature: 'f1' }]);
    expect(d.parts.p1!.features).toEqual([]);
  });

  it('nests assemblies and reparents', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', name: 'Run' } },
      { op: 'add', entity: { kind: 'assembly', name: 'Drawer' }, parent: 'a1' },
      addPanel,
      { op: 'move', id: 'p1', parent: 'a2' },
    ]);
    expect(d.roots).toEqual(['a1']);
    expect(d.assemblies.a1!.children).toEqual(['a2']);
    expect(d.assemblies.a2!.children).toEqual(['p1']);
  });

  it('rejects the whole batch on any failure, naming the op', () => {
    const d0 = ok(emptyDoc(), [addPanel]);
    const r = applyOps(d0, [
      { op: 'update', id: 'p1', patch: { name: 'Changed' } },
      hole([inches(0.25), inches(10)]), // pokes out the side
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't fit inside face:front/);
  });

  it('gives clear errors for bad input', () => {
    const d0 = ok(emptyDoc(), [addPanel]);
    const cases: [Op, RegExp][] = [
      [{ op: 'update', id: 'nope', patch: {} }, /nothing with id "nope"/],
      [{ op: 'addFeature', part: 'p1', feature: { type: 'laser', params: {} } }, /unknown feature type "laser"/],
      [{ op: 'update', id: 'p1', patch: { material: 'unobtanium' } }, /material "unobtanium" doesn't exist/],
      [{ op: 'update', id: 'p1', patch: { color: 'red' } }, /invalid patch/],
      [{ op: 'delete', id: 'ply-3-4' }, /used by 1 parts/],
      [{ op: 'move', id: 'p1', parent: 'p1' }, /inside itself/],
    ];
    for (const [op, msg] of cases) {
      const r = applyOps(d0, [op]);
      expect(r.ok, JSON.stringify(op)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msg);
    }
  });

  it('rejects overlapping holes', () => {
    const r = applyOps(ok(emptyDoc(), [addPanel]), [hole([inches(6), inches(10)]), hole([inches(6.5), inches(10)])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/overlaps hole f1/);
  });

  it('rejects unknown shapes', () => {
    // A doc can still carry one from a newer version.
    const r = applyOps(emptyDoc(), [
      { op: 'add', entity: { kind: 'part', material: 'ply-3-4', shape: { type: 'turnedLeg', params: {} } } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown shape type "turnedLeg"/);
  });
});

describe('store', () => {
  it('undoes and redoes', () => {
    const s = createStore(emptyDoc());
    s.dispatch([addPanel]);
    s.dispatch([hole([inches(6), inches(10)])]);
    expect(s.doc.parts.p1!.features).toHaveLength(1);
    expect(s.undo()).toBe(true);
    expect(s.doc.parts.p1!.features).toHaveLength(0);
    expect(s.undo()).toBe(true);
    expect(s.doc.parts).toEqual({});
    expect(s.undo()).toBe(false);
    s.redo();
    s.redo();
    expect(s.doc.parts.p1!.features).toHaveLength(1);
    expect(s.canRedo()).toBe(false);
  });

  it('coalesces live edits into one undo step', () => {
    const s = createStore(emptyDoc());
    s.dispatch([addPanel]);
    for (const y of [20, 21, 22]) s.dispatch([{ op: 'update', id: 'p1', patch: { shape: { params: { y: inches(y) } } } }], { coalesce: 'y' });
    expect(s.doc.parts.p1!.shape.params.y).toBe(inches(22));
    s.undo();
    expect(s.doc.parts.p1!.shape.params.y).toBe(inches(30));
  });

  it('leaves state untouched on a failed dispatch', () => {
    const s = createStore(emptyDoc());
    s.dispatch([addPanel]);
    const before = s.doc;
    const r = s.dispatch([{ op: 'delete', id: 'missing' }]);
    expect(r.ok).toBe(false);
    expect(s.doc).toBe(before);
  });
});
