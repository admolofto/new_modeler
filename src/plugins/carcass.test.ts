import { describe, expect, it } from 'vitest';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';

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

describe('demo doc', () => {
  it('is a valid carcass with a hole on the right side', () => {
    const d = demoDoc();
    expect(d.parts['a1.side-right']!.features[0]).toMatchObject({ id: 'f1', type: 'hole' });
  });
});
