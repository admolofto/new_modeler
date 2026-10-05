import { describe, expect, it } from 'vitest';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { generators } from './registry';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const T = 46; // 23/32"
const BT = 14; // 7/32"

function carcass(params: Record<string, unknown> = {}): Doc {
  return ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } } },
  ]);
}
const size = (d: Doc, id: string) => d.parts[id]!.shape.params;
const pos = (d: Doc, id: string) => d.parts[id]!.transform.position;
const setParams = (params: Record<string, unknown>): Op => ({ op: 'update', id: 'a1', patch: { params } });

describe('carcass generator', () => {
  it('builds the default base cabinet', () => {
    const d = carcass();
    expect(d.assemblies.a1!.children).toEqual(['a1.side-left', 'a1.side-right', 'a1.bottom', 'a1.top', 'a1.back', 'a1.kick', 'a1.shelf-1']);
    expect(size(d, 'a1.side-left')).toEqual({ x: T, y: inches(34.5), z: inches(24) });
    expect(size(d, 'a1.bottom')).toEqual({ x: inches(36) - 2 * T, y: T, z: inches(24) - BT });
    expect(pos(d, 'a1.bottom')).toEqual([T, inches(4), BT]);
    expect(pos(d, 'a1.side-right')).toEqual([inches(36) - T, 0, 0]);
    expect(size(d, 'a1.back')).toEqual({ x: inches(36) - 2 * T, y: inches(30.5), z: BT });
    expect(pos(d, 'a1.kick')).toEqual([T, 0, inches(24) - inches(3) - T]);
  });

  it('emits joints as metadata', () => {
    const d = carcass();
    const byRole = Object.fromEntries(Object.values(d.joints).map((j) => [j.role, j]));
    expect(byRole['bottom-left']).toMatchObject({ type: 'dado', parts: ['a1.side-left', 'a1.bottom'], params: { depth: 16 } });
    expect(byRole['back-right']).toMatchObject({ type: 'rabbet', parts: ['a1.side-right', 'a1.back'] });
    expect(Object.keys(d.joints)).toHaveLength(8);
    expect(Object.values(carcass({ joinery: 'butt' }).joints).filter((j) => j.type === 'dado')).toHaveLength(0);
  });

  it('handles applied / no back and no toe kick', () => {
    const applied = carcass({ back: 'applied' });
    expect(size(applied, 'a1.back')).toEqual({ x: inches(36), y: inches(30.5), z: BT });
    expect(size(applied, 'a1.side-left').z).toBe(inches(24) - BT);
    const bare = carcass({ back: 'none', toeKick: null });
    expect(bare.parts['a1.back']).toBeUndefined();
    expect(bare.parts['a1.kick']).toBeUndefined();
    expect(pos(bare, 'a1.bottom')).toEqual([T, 0, 0]);
  });

  it('spaces shelves evenly', () => {
    const d = carcass({ shelves: 3 });
    const ys = [1, 2, 3].map((i) => pos(d, `a1.shelf-${i}`)[1]);
    const gaps = [ys[0]! - (inches(4) + T), ys[1]! - ys[0]! - T, ys[2]! - ys[1]! - T, inches(34.5) - T - ys[2]! - T];
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('fills the face with equal drawers', () => {
    const d = carcass({ drawers: [0, 0], shelves: 0 });
    const f1 = d.parts['a1.drawer-1-front']!;
    const f2 = d.parts['a1.drawer-2-front']!;
    // Face 30 1/2", minus 1/16" top reveal and one 1/8" gap, split in two.
    expect(f1.shape.params.y! as number + (f2.shape.params.y as number)).toBe(inches(30.5) - 4 - 8);
    expect(f1.transform.position).toEqual([4, inches(34.5) - 4 - (f1.shape.params.y as number), inches(24)]);
    expect(f2.transform.position[1]).toBe(inches(4)); // bottom front reaches the toe kick
    expect(f1.shape.params.x).toBe(inches(36) - 8);
    for (const n of [1, 2]) {
      for (const piece of ['bottom', 'side-left', 'side-right', 'back', 'sub-front']) expect(d.parts[`a1.drawer-${n}-${piece}`]).toBeDefined();
    }
    // Boxes sit between the sides with 1/2" slide gaps, clear of the carcass top.
    expect(size(d, 'a1.drawer-1-bottom').x).toBe(inches(36) - 2 * T - inches(1));
    const box1Top = pos(d, 'a1.drawer-1-side-left')[1] + (size(d, 'a1.drawer-1-side-left').y as number);
    expect(box1Top).toBeLessThanOrEqual(inches(34.5) - T);
  });

  it('puts shelves in the bay below a partial drawer stack', () => {
    const d = carcass({ drawers: [inches(6)], shelves: 1 });
    const boxBottom = pos(d, 'a1.drawer-1-bottom')[1];
    expect(pos(d, 'a1.shelf-1')[1] + T).toBeLessThan(boxBottom);
    const full = applyOps(carcass(), [setParams({ drawers: [0, 0] })]); // shelves still 1
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toMatch(/set shelves to 0/);
  });

  it('rejects drawer stacks that overflow the face', () => {
    const r = applyOps(carcass(), [setParams({ drawers: [inches(20), inches(20)], shelves: 0 })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/drawer fronts total/);
  });

  it('regenerates on param changes', () => {
    const d = ok(carcass(), [setParams({ width: inches(30) })]);
    expect(size(d, 'a1.bottom').x).toBe(inches(30) - 2 * T);
    expect(pos(d, 'a1.side-right')[0]).toBe(inches(30) - T);
  });

  it('regenerates when a referenced material changes thickness', () => {
    const d = ok(carcass(), [{ op: 'update', id: 'ply-3-4', patch: { thickness: 48 } }]);
    expect(size(d, 'a1.side-left').x).toBe(48);
    expect(size(d, 'a1.bottom').x).toBe(inches(36) - 96);
  });

  it('rejects impossible params with a readable error', () => {
    const r = applyOps(carcass(), [setParams({ toeKick: { height: inches(20), depth: inches(3) } })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/toe kick must be less than half/);
  });
});

describe('generator overrides', () => {
  it('preserves user tweaks across regenerate', () => {
    let d = ok(carcass(), [
      { op: 'move', id: 'a1.shelf-1', by: [0, inches(2), 0] },
      { op: 'update', id: 'a1.top', patch: { name: 'Top panel', material: 'maple-4-4' } },
      { op: 'addFeature', part: 'a1.side-left', feature: { type: 'hole', params: { face: 'face:left', at: [inches(12), inches(20)], d: 64 } } },
      { op: 'delete', id: 'a1.kick' },
    ]);
    const shelfY = pos(d, 'a1.shelf-1')[1];
    expect(Object.keys(d.assemblies.a1!.generator!.overrides).sort()).toEqual(['kick', 'shelf-1', 'side-left', 'top']);
    expect(d.assemblies.a1!.generator!.overrides['shelf-1']).toEqual({ position: [null, shelfY, null] });

    d = ok(d, [setParams({ width: inches(30), depth: inches(22) })]);
    // Shelf keeps its moved height but follows the new width.
    expect(pos(d, 'a1.shelf-1')[1]).toBe(shelfY);
    expect(size(d, 'a1.shelf-1').x).toBe(inches(30) - 2 * T - 4);
    expect(d.parts['a1.top']).toMatchObject({ name: 'Top panel', material: 'maple-4-4' });
    expect(d.parts['a1.side-left']!.features).toHaveLength(1);
    expect(size(d, 'a1.side-left').z).toBe(inches(22));
    expect(d.parts['a1.kick']).toBeUndefined();
    expect(Object.values(d.joints).some((j) => j.role?.startsWith('kick'))).toBe(false);
  });

  it('drops an override once the part matches the generator again', () => {
    let d = ok(carcass(), [{ op: 'move', id: 'a1.shelf-1', by: [0, 64, 0] }]);
    d = ok(d, [{ op: 'move', id: 'a1.shelf-1', by: [0, -64, 0] }]);
    expect(d.assemblies.a1!.generator!.overrides).toEqual({});
  });

  it('keeps overrides for parts that temporarily disappear', () => {
    let d = ok(carcass({ shelves: 2 }), [{ op: 'update', id: 'a1.shelf-2', patch: { name: 'Fixed shelf' } }]);
    d = ok(d, [setParams({ shelves: 1 })]);
    expect(d.parts['a1.shelf-2']).toBeUndefined();
    d = ok(d, [setParams({ shelves: 2 })]);
    expect(d.parts['a1.shelf-2']!.name).toBe('Fixed shelf');
  });

  it('keeps user-added children of a generated assembly', () => {
    let d = ok(carcass(), [
      { op: 'add', entity: { kind: 'part', id: 'nailer', material: 'ply-3-4', shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } }, parent: 'a1' },
    ]);
    d = ok(d, [setParams({ height: inches(30) })]);
    expect(d.assemblies.a1!.children.at(-1)).toBe('nailer');
  });

  it('refuses edits that only make sense on the generator', () => {
    const d = carcass();
    const jointId = Object.keys(d.joints)[0]!;
    for (const op of [
      { op: 'delete', id: jointId },
      { op: 'move', id: 'a1.top', parent: null },
      { op: 'update', id: 'a1.top', patch: { shape: { type: 'outline' } } },
    ] as Op[]) {
      expect(applyOps(d, [op]).ok, JSON.stringify(op)).toBe(false);
    }
  });

  it('rejects a regenerate that would strand a user hole outside its panel', () => {
    const d = ok(carcass(), [
      { op: 'addFeature', part: 'a1.side-left', feature: { type: 'hole', params: { face: 'face:left', at: [inches(20), inches(20)], d: 64 } } },
    ]);
    const r = applyOps(d, [setParams({ depth: inches(16) })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hole f1 .* doesn't fit/);
  });
});

describe('carcass drawer folders', () => {
  const box = ['front', 'bottom', 'side-left', 'side-right', 'back', 'sub-front'];

  it('puts each drawer’s parts in its own folder, where the drawer goes in the case', () => {
    const d = carcass({ drawers: [inches(6), 0], shelves: 0 });
    const a1 = d.assemblies.a1!;
    expect(a1.children).toEqual(['a1.side-left', 'a1.side-right', 'a1.bottom', 'a1.top', 'a1.back', 'a1.kick', 'a1.drawer-1', 'a1.drawer-2']);
    expect(d.assemblies['a1.drawer-1']).toMatchObject({ name: 'Drawer 1', role: 'drawer-1', transform: { position: [0, 0, 0], rotation: [0, 0, 0] } });
    expect(d.assemblies['a1.drawer-2']!.children).toEqual(box.map((s) => `a1.drawer-2-${s}`));
    // Parts keep their ids and assembly-frame positions; the drawer still slides as one.
    expect(pos(d, 'a1.drawer-1-front')[2]).toBe(inches(24));
    expect(d.motions['a1.motion.drawer-1']!.nodes).toEqual(box.map((s) => `a1.drawer-1-${s}`));
    expect(ok(d, [setParams({ drawers: [0] })]).assemblies['a1.drawer-2']).toBeUndefined();
  });

  it('keeps a renamed or hidden folder, and the user’s things in it, across regenerate', () => {
    let d = ok(carcass({ drawers: [0, 0], shelves: 0 }), [
      { op: 'update', id: 'a1.drawer-1', patch: { name: 'Top drawer', hidden: true } },
      { op: 'add', entity: { kind: 'part', id: 'pull', name: 'Pull', material: 'ply-3-4', shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } }, parent: 'a1.drawer-1' },
    ]);
    expect(d.assemblies.a1!.generator!.overrides['drawer-1']).toEqual({ name: 'Top drawer', hidden: true });
    d = ok(d, [setParams({ width: inches(30) })]);
    expect(d.assemblies['a1.drawer-1']).toMatchObject({ name: 'Top drawer', hidden: true });
    expect(d.assemblies['a1.drawer-1']!.children.at(-1)).toBe('pull');
    // The drawer's gone: the pull moves up to the cabinet rather than vanishing.
    d = ok(d, [setParams({ drawers: [], shelves: 1 })]);
    expect(d.assemblies.a1!.children.at(-1)).toBe('pull');
  });

  it('deletes a whole drawer with its folder, and refuses to move generated folders out', () => {
    const d = carcass({ drawers: [0, 0], shelves: 0 });
    const gone = ok(d, [{ op: 'delete', id: 'a1.drawer-2' }]);
    expect(gone.assemblies['a1.drawer-2']).toBeUndefined();
    expect(Object.keys(gone.parts).some((id) => id.startsWith('a1.drawer-2-'))).toBe(false);
    expect(gone.motions['a1.motion.drawer-2']).toBeUndefined();
    expect(ok(gone, [setParams({ height: inches(30) })]).assemblies['a1.drawer-2']).toBeUndefined();
    expect(applyOps(d, [{ op: 'move', id: 'a1.drawer-1', parent: null }]).ok).toBe(false);
    expect(applyOps(d, [{ op: 'move', id: 'a1.drawer-1-front', parent: 'a1' }]).ok).toBe(false);
  });
});

describe('carcass doors and animations', () => {
  const W = inches(36);
  const D = inches(24);
  const motionsOf = (d: Doc) => Object.values(d.motions).map((m) => ({ id: m.id, name: m.name, type: m.type, nodes: m.nodes.length, params: m.params }));

  it('slides every drawer out on full-extension slides', () => {
    const d = carcass({ drawers: [0, 0], shelves: 0 });
    expect(motionsOf(d)).toEqual([
      { id: 'a1.motion.drawer-1', name: 'Drawer 1', type: 'slide', nodes: 6, params: { toward: 'front', distance: D - BT - inches(1), seconds: 0.6 } },
      { id: 'a1.motion.drawer-2', name: 'Drawer 2', type: 'slide', nodes: 6, params: { toward: 'front', distance: D - BT - inches(1), seconds: 0.6 } },
    ]);
    expect(d.motions['a1.motion.drawer-1']!.nodes[0]).toBe('a1.drawer-1-front');
    const more = ok(d, [setParams({ drawers: [0, 0, 0] })]);
    expect(Object.keys(more.motions)).toHaveLength(3);
    expect(ok(d, [setParams({ drawers: [] , shelves: 1 })]).motions).toEqual({});
  });

  it('hangs a pair of doors below the drawers, hinged on their outer sides, with hinge cups', () => {
    const d = carcass({ drawers: [inches(6)], doors: 2 });
    const dh = inches(34.5) - inches(1 / 16) - inches(6) - inches(1 / 8) - inches(4);
    expect(pos(d, 'a1.door-left')).toEqual([inches(1 / 16), inches(4), D]);
    expect(size(d, 'a1.door-left')).toEqual({ x: 1144, y: dh, z: T });
    expect(pos(d, 'a1.door-right')).toEqual([inches(1 / 16) + 1144 + inches(1 / 8), inches(4), D]);
    expect(d.parts['a1.door-left']!.features.map((f) => f.params.at)).toEqual([[57, inches(3.5)], [57, dh - inches(3.5)]]);
    expect(d.parts['a1.door-right']!.features.map((f) => f.params.at)).toEqual([[1144 - 57, inches(3.5)], [1144 - 57, dh - inches(3.5)]]);
    expect(motionsOf(d).map((m) => [m.name, m.type, m.params.side])).toEqual([
      ['Drawer 1', 'slide', undefined],
      ['Left door', 'hinge', 'left'],
      ['Right door', 'hinge', 'right'],
    ]);
    // Door fronts drive the cabinet's depth like drawer fronts.
    expect(generators.get('carcass').faceDrive!(d.assemblies.a1!.generator!.params, { role: 'door-right', axis: 2, max: true, plane: D + T })).toMatchObject({ param: 'depth' });
  });

  it('hinges a single door on the side asked, opening as far as asked', () => {
    const d = carcass({ doors: 1, doorHinge: 'right', doorAngle: 90, height: inches(84) });
    expect(d.motions['a1.motion.door']!.params).toEqual({ side: 'right', angle: 90, seconds: 0.8 });
    const cups = d.parts['a1.door']!.features;
    expect(cups).toHaveLength(4); // an 80" door
    expect(cups.every((f) => (f.params.at as number[])[0] === W - inches(1 / 8) - 57)).toBe(true);
  });

  it('refuses doors that don’t fit', () => {
    const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [0], doors: 2 } } } }]);
    expect(!r.ok && r.error).toMatch(/give every drawer front a height/);
    expect(applyOps(carcass(), [setParams({ drawers: [inches(28)], doors: 1 })])).toMatchObject({ ok: false, error: expect.stringMatching(/no room for doors/) });
  });

  it('keeps generated animations read-only, and a false front without its box still', () => {
    const d = carcass({ drawers: [inches(6), 0], shelves: 0 });
    expect(applyOps(d, [{ op: 'update', id: 'a1.motion.drawer-1', patch: { params: { distance: 64 } } }])).toMatchObject({ ok: false, error: expect.stringMatching(/comes with "Base"; change its params/) });
    expect(applyOps(d, [{ op: 'delete', id: 'a1.motion.drawer-1' }])).toMatchObject({ ok: false });
    // A sink base: take the top drawer's box out and its front stays put.
    const sink = ok(d, ['bottom', 'side-left', 'side-right', 'back', 'sub-front'].map((s): Op => ({ op: 'delete', id: `a1.drawer-1-${s}` })));
    expect(sink.parts['a1.drawer-1-front']).toBeDefined();
    expect(Object.keys(sink.motions)).toEqual(['a1.motion.drawer-2']);
  });

  it('drops a user animation’s generated parts when they go away', () => {
    const d = ok(carcass({ shelves: 2 }), [{ op: 'add', entity: { kind: 'motion', nodes: ['a1.shelf-2'], type: 'slide', params: {} } }]);
    expect(d.motions.mo1!.nodes).toEqual(['a1.shelf-2']);
    expect(ok(d, [setParams({ shelves: 1 })]).motions).toEqual({});
  });
});

describe('demo doc', () => {
  it('is a valid carcass with a hole on the right side', () => {
    const d = demoDoc();
    expect(d.parts['a1.side-right']!.features[0]).toMatchObject({ id: 'f1', type: 'hole' });
  });
});
