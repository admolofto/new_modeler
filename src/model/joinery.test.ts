import { describe, expect, it } from 'vitest';
import '../plugins';
import { buildPart } from '../plugins/pipeline';
import { isWatertight } from '../plugins/testMesh';
import { cutList, cutListCsv, cutParts } from './cutlist';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';
import { inches } from './units';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const T = 46;
const BT = 14;
const [W, H, D, kH] = [inches(36), inches(34.5), inches(24), inches(4)];
const carcass = (params: Record<string, unknown> = {}) =>
  ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } } }]);

const panel = (id: string, position: [number, number, number], size: [number, number, number], extra: Record<string, unknown> = {}): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', grain: 'x', transform: { position, rotation: [0, 0, 0] }, shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } }, ...extra },
});

describe('joint cuts', () => {
  it('cuts the carcass dados and rabbets into the sides', () => {
    const d = carcass();
    const cuts = d.parts['a1.side-left']!.joinery!;
    expect(cuts.map((c) => [c.joint, c.params])).toEqual([
      ['a1.j.bottom-left', { face: 'face:right', from: [BT, kH], to: [D, kH + T], depth: 16 }],
      ['a1.j.top-left', { face: 'face:right', from: [BT, H - T], to: [D, H], depth: 16 }],
      ['a1.j.back-left', { face: 'face:right', from: [0, kH], to: [BT, H], depth: 24 }],
    ]);
    expect(d.parts['a1.side-right']!.joinery!.every((c) => c.params.face === 'face:left')).toBe(true);
    expect(d.parts['a1.bottom']!.joinery).toBeUndefined();
    for (const id of ['a1.side-left', 'a1.side-right']) expect(isWatertight(buildPart(d.parts[id]!).mesh)).toBe(true);
    expect(carcass({ joinery: 'butt' }).parts['a1.side-left']!.joinery!.map((c) => c.joint)).toEqual(['a1.j.back-left']);
  });

  it('follows the parts: resizing, deleting the joint, and moving the inserted part', () => {
    let d = ok(emptyDoc(), [
      panel('side', [0, 0, 0], [T, inches(30), inches(12)]),
      panel('shelf', [T, inches(10), 0], [inches(20), T, inches(12)]),
      { op: 'add', entity: { kind: 'joint', id: 'j1', type: 'dado', parts: ['side', 'shelf'], params: { depth: 16 } } },
    ]);
    expect(d.parts.side!.joinery![0]!.params).toEqual({ face: 'face:right', from: [0, inches(10)], to: [inches(12), inches(10) + T], depth: 16 });
    d = ok(d, [{ op: 'move', id: 'shelf', to: [T, inches(15), 0] }]);
    expect(d.parts.side!.joinery![0]!.params.from).toEqual([0, inches(15)]);
    const moved = ok(d, [{ op: 'move', id: 'shelf', to: [T + 64, inches(15), 0] }]);
    expect(moved.parts.side!.joinery).toBeUndefined();
    expect(ok(d, [{ op: 'delete', id: 'j1' }]).parts.side!.joinery).toBeUndefined();
    const r = applyOps(d, [{ op: 'removeFeature', part: 'side', feature: 'j1' }]);
    expect(!r.ok && r.error).toMatch(/cut by joint j1; change or delete the joint/);
  });

  it('keeps joint cuts out of generator overrides', () => {
    const d = ok(carcass(), [{ op: 'addFeature', part: 'a1.side-left', feature: { type: 'hole', params: { face: 'face:left', at: [inches(12), inches(20)], d: 32 } } }]);
    const ov = d.assemblies.a1!.generator!.overrides['side-left']!;
    expect(ov.features!.map((f) => f.type)).toEqual(['hole']);
    expect(d.parts['a1.side-left']!.joinery).toHaveLength(3);
  });

  it('refuses a user feature that collides with a joint cut', () => {
    const r = applyOps(carcass(), [
      { op: 'addFeature', part: 'a1.side-left', feature: { type: 'hole', params: { face: 'face:right', at: [inches(12), kH + 20], d: 16, depth: 8 } } },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('cut list', () => {
  const byName = (d: Doc) => Object.fromEntries(cutParts(d).parts.map((p) => [p.name, p]));

  it('adds dado and rabbet depth to the parts that sit in them', () => {
    const p = byName(carcass());
    const innerW = W - 2 * T;
    expect([p['Left side']!.length, p['Left side']!.width, p['Left side']!.thickness]).toEqual([H, D, T]);
    expect([p.Bottom!.length, p.Bottom!.width, p.Bottom!.thickness]).toEqual([innerW + 32, D - BT, T]);
    expect(p.Bottom!.allowances.map((a) => [a.mate, a.depth, a.along])).toEqual([
      ['Left side', 16, 'length'],
      ['Right side', 16, 'length'],
    ]);
    expect(p.Top!.length).toBe(innerW + 32);
    expect([p.Back!.length, p.Back!.width, p.Back!.thickness]).toEqual([H - kH, innerW + 48, BT]);
    expect(p['Shelf 1']!.length).toBe(innerW - 4); // adjustable: no joinery
  });

  it('describes machining on each part', () => {
    const side = byName(demoDoc())['Left side']!;
    expect(side.ops).toContain('dado 23/32" wide × 1/4" deep, 4" from bottom, stopped 7/32" from back — right face (for Bottom)');
    expect(side.ops).toContain('rabbet 23/32" wide × 1/4" deep, along top edge, stopped 7/32" from back — right face (for Top)');
    expect(side.ops).toContain('rabbet 7/32" wide × 3/8" deep, along back edge, stopped 4" from bottom — right face (for Back)');
    expect(side.ops).toContain('26 × Ø13/64" holes 3/8" deep — right face');
    const top = byName(demoDoc()).Tabletop!;
    expect(top.shaped).toBe(true);
    expect(top.ops).toEqual(['1/4" roundover on 4 edges top-bl, top-br, top-fr, top-fl']);
  });

  it('adds drawer-box rabbet allowances', () => {
    const p = byName(carcass({ drawers: [0, 0], shelves: 0 }));
    const back = p['Drawer 1 back']!;
    expect(back.allowances.map((a) => a.depth)).toEqual([23, 23]);
    expect(p['Drawer 1 left side']!.ops.filter((o) => o.startsWith('rabbet'))).toHaveLength(2);
  });

  it('groups identical parts, estimates sheets and board feet, and exports CSV', () => {
    const list = cutList(carcass({ shelves: 2 }));
    const ply = list.materials.find((m) => m.material.id === 'ply-3-4')!;
    const shelves = ply.rows.find((r) => r.names.includes('Shelf 1'))!;
    expect(shelves.qty).toBe(2);
    expect(shelves.names).toEqual(['Shelf 1', 'Shelf 2']);
    expect(ply.sheets!.count).toBe(2);
    expect(list.materials.find((m) => m.material.id === 'ply-1-4')!.sheets!.count).toBe(1);
    expect(list.problems).toEqual([]);

    const demo = cutList(demoDoc());
    const maple = demo.materials.find((m) => m.material.id === 'maple-4-4')!;
    const [L, Wd] = [inches(37.5), inches(25)];
    expect(maple.boardFeet!.net).toBeCloseTo((37.5 * 25 * 1) / 144);
    expect(maple.rows[0]!.length).toBe(L);
    expect(maple.rows[0]!.width).toBe(Wd);

    const csv = cutListCsv(list, 'in');
    expect(csv.split('\r\n')[0]).toBe('Material,Thickness (in),Qty,Part,Length (in),Width (in),Grain,Joinery allowance,Operations,Notes');
    expect(csv).toContain('"3/4"" plywood",23/32,2,Bottom / Top,35 1/16,23 25/32,length,+1/4 length (Left side); +1/4 length (Right side),,\r\n');
  });

  it('flags joints that do not touch and parts that overrun a sheet', () => {
    const d = ok(emptyDoc(), [
      panel('side', [0, 0, 0], [T, inches(30), inches(12)]),
      panel('shelf', [T + 8, inches(10), 0], [inches(20), T, inches(12)]),
      panel('long', [0, 0, inches(20)], [inches(100), T, inches(12)]),
      { op: 'add', entity: { kind: 'joint', id: 'j1', type: 'dado', parts: ['side', 'shelf'] } },
    ]);
    const list = cutList(d);
    expect(list.problems[0]).toMatch(/j1 .*doesn't touch "side" face to face/);
    expect(list.problems[1]).toMatch(/long is bigger than a 48" × 96" sheet/);
  });
});
