import { describe, expect, it } from 'vitest';
import { actionsFor } from '../edit/actions';
import { dimensionBoxes } from '../edit/dimensions';
import { handleDrives } from '../edit/drives';
import { duplicateOps } from '../edit/duplicate';
import { inferLine } from '../edit/snap';
import { registerShape, shapes } from '../plugins';
import '../plugins/testDecor';
import { clearance } from './clearance';
import { cutParts } from './cutlist';
import { decorInfo, isDecor, isShopPart, isSolid, modelPartIds, surroundingsOf } from './decor';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, numberedName, type Op } from './ops';
import { captureRecipe, insertRecipe, placeRecipe } from './recipes';
import type { Doc, Vec3 } from './schema';
import { docErrors } from './validate';
import { overlaps, union, worldBoxes } from './world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
function fails(doc: Doc, ops: Op[]): string {
  const r = applyOps(doc, ops);
  if (r.ok) throw new Error('expected the ops to fail');
  return r.error;
}

const decor = (type: string, size: Vec3, position: Vec3 = [0, 0, 0], extra: Record<string, unknown> = {}): Op => ({
  op: 'add',
  entity: { kind: 'decor', shape: { type, params: { x: size[0], y: size[1], z: size[2] } }, transform: { position }, ...extra },
});
const board = (id: string, size: Vec3, position: Vec3 = [0, 0, 0]): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position }, shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } } },
});
const room: Op = { op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'testRoom', params: { width: 9000, depth: 6000, height: 3000 } } } };

describe('decor shapes', () => {
  it('must say how they look', () => {
    expect(() => registerShape({ ...shapes.get('box'), type: 'badDecor', decor: { category: 'accessory', label: 'Bad' } })).toThrow(/needs surfaces/);
    expect(decorInfo('testStool')).toMatchObject({ category: 'furniture', label: 'Test stool' });
    expect(decorInfo('box')).toBeUndefined();
  });
});

describe('the decor entity', () => {
  it('adds decor parts with p ids, named for their shape, with no material', () => {
    const d = ok(emptyDoc(), [decor('testStool', [960, 1920, 960]), decor('testStool', [960, 1920, 960], [2000, 0, 0], { name: 'Stool 2', grain: 'x' })]);
    expect(d.roots).toEqual(['p1', 'p2']);
    expect(d.parts.p1).toEqual({ id: 'p1', name: 'Test stool 1', grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type: 'testStool', params: { x: 960, y: 1920, z: 960 } }, features: [] });
    expect(d.parts.p2).toMatchObject({ name: 'Stool 2', grain: 'x' });
    const p1 = d.parts.p1!;
    expect([isDecor(p1), isShopPart(p1), isSolid(p1)]).toEqual([true, false, true]);
    expect(isSolid(ok(d, [decor('testRug', [1920, 16, 1280])]).parts.p3!)).toBe(false);
  });

  it('numbers default names past the highest one in use, so siblings never share one', () => {
    const d = ok(emptyDoc(), [decor('testStool', [960, 1920, 960]), decor('testStool', [960, 1920, 960]), decor('testLamp', [320, 320, 320])]);
    expect(Object.values(d.parts).map((p) => p.name)).toEqual(['Test stool 1', 'Test stool 2', 'Test lamp 1']);
    const e = ok(d, [{ op: 'delete', id: 'p1' }, { op: 'update', id: 'p2', patch: { name: 'Test stool 7' } }, decor('testStool', [960, 1920, 960])]);
    expect(e.parts.p1!.name).toBe('Test stool 8');
    expect(numberedName(emptyDoc(), 'Bar stool')).toBe('Bar stool 1');
  });

  it('refuses the wrong kind for a shape, and materials, finishes and features on decor', () => {
    const shape = { type: 'testStool', params: { x: 960, y: 1920, z: 960 } };
    expect(fails(emptyDoc(), [{ op: 'add', entity: { kind: 'part', material: 'ply-3-4', shape } }])).toMatch(/"testStool" is a decor shape \(test stool\): add it with kind "decor"/);
    expect(fails(emptyDoc(), [{ op: 'add', entity: { kind: 'decor', shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } } }])).toMatch(/isn't a decor shape/);
    const d = ok(emptyDoc(), [decor('testStool', [960, 1920, 960]), board('side', [46, 1920, 640], [3000, 0, 0])]);
    expect(fails(d, [{ op: 'update', id: 'p1', patch: { material: 'ply-3-4' } }])).toMatch(/is decor: it has no material or finish/);
    expect(fails(d, [{ op: 'update', id: 'p1', patch: { finish: { preset: 'paint' } } }])).toMatch(/is decor: it has no material or finish/);
    expect(fails(d, [{ op: 'addFeature', part: 'p1', feature: { type: 'hole', params: { face: 'face:front', at: [480, 960], d: 64 } } }])).toMatch(/takes no features/);
    expect(fails(d, [{ op: 'update', id: 'p1', patch: { shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } } }])).toMatch(/between a stock part and decor/);
    expect(fails(d, [{ op: 'add', entity: { kind: 'joint', type: 'butt', parts: ['side', 'p1'] } }])).toMatch(/is decor; joints join real parts/);
    // Its name, grain (texture direction), size and place change like any part's.
    const e = ok(d, [{ op: 'update', id: 'p1', patch: { name: 'Bar stool', grain: 'z', shape: { params: { y: 1984 } } } }, { op: 'move', id: 'p1', to: [64, 0, 0] }]);
    expect(e.parts.p1).toMatchObject({ name: 'Bar stool', grain: 'z', shape: { params: { y: 1984 } }, transform: { position: [64, 0, 0] } });
  });

  it('is validated: no material, finish or features', () => {
    const d = ok(emptyDoc(), [decor('testStool', [960, 1920, 960])]);
    const bad = structuredClone(d);
    Object.assign(bad.parts.p1!, { material: 'ply-3-4', finish: { preset: 'paint' } });
    expect(docErrors(bad)).toEqual(expect.arrayContaining([expect.stringMatching(/decor has no material/), expect.stringMatching(/decor has no finish/)]));
  });
});

describe('decor in the shop and the checks', () => {
  it('stays out of the cut list', () => {
    const d = ok(emptyDoc(), [board('shelf', [1280, 46, 640]), decor('testStool', [960, 1920, 960], [0, 0, 2000])]);
    expect(cutParts(d).parts.map((p) => p.id)).toEqual(['shelf']);
  });

  it('counts overlaps with solid decor only', () => {
    const d = ok(emptyDoc(), [
      board('shelf', [1280, 46, 640], [0, 640, 0]),
      decor('testRug', [1920, 1280, 1280]), // p1: through the shelf, but a rug
      decor('testStool', [960, 1920, 960], [3000, 0, 0]), // p2
    ]);
    expect(overlaps(d, ['shelf', 'p1'])).toEqual([]);
    const e = ok(d, [{ op: 'move', id: 'p2', to: [0, 0, 0] }]);
    expect(overlaps(e, ['p2']).map((o) => [o.a, o.b].sort())).toEqual([['p2', 'shelf']]);
  });

  it('lets a room door swing past its own casing, but not past something in the way', () => {
    const d = ok(emptyDoc(), [room]);
    expect(d.motions['room.motion.door']).toMatchObject({ nodes: ['room.door'] });
    expect(clearance(d)).toEqual([]);
    // A rug in its path doesn't stop it; a cabinet side there does.
    const rug = ok(d, [decor('testRug', [64, 1280, 64], [4500 + 128, 0, 6000 + 64])]);
    expect(clearance(rug)).toEqual([]);
    const side = ok(d, [board('side', [64, 1280, 64], [4500 + 128, 0, 6000 + 64])]);
    expect(clearance(side)).toMatchObject([{ motion: 'room.motion.door', part: 'room.door-leaf', hits: 'side' }]);
  });

  it('knows what surrounds the model', () => {
    const d = ok(emptyDoc(), [room, { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }, decor('testStool', [960, 1920, 960], [3000, 0, 2000])]);
    expect([...surroundingsOf(d)].sort()).toEqual(['room.casing', 'room.door-leaf', 'room.floor', 'room.wall-back']);
    expect(modelPartIds(d)).toContain('p1');
    expect(modelPartIds(d).some((id) => id.startsWith('room.'))).toBe(false);
    // Whole-model dims measure the cabinet: not the room, not the stool.
    expect(dimensionBoxes(d, [])).toEqual([worldBoxes(d).get('a1')]);
  });
});

describe('editing decor', () => {
  it('duplicates decor as decor, and finishes with stock parts and folders', () => {
    const d = ok(emptyDoc(), [
      decor('testStool', [960, 1920, 960], [0, 0, 0], { name: 'Bar stool' }),
      { op: 'add', entity: { kind: 'assembly', id: 'box', name: 'Box', finish: { preset: 'paint', color: '#1f2a44' } } },
      { op: 'add', parent: 'box', entity: { kind: 'part', id: 'lid', name: 'Lid', material: 'ply-3-4', finish: { preset: 'wood:walnut' }, shape: { type: 'box', params: { x: 640, y: 46, z: 640 } } } },
    ]);
    const { ops, doc, copies } = duplicateOps(d, ['p1', 'box']);
    expect(ops[0]).toMatchObject({ op: 'add', entity: { kind: 'decor', name: 'Bar stool', shape: { type: 'testStool' } } });
    const [stool, box] = copies;
    expect(isDecor(doc.parts[stool!]!)).toBe(true);
    expect(doc.assemblies[box!]!.finish).toEqual({ preset: 'paint', color: '#1f2a44' });
    expect(doc.parts[doc.assemblies[box!]!.children[0]!]!.finish).toEqual({ preset: 'wood:walnut' });
  });

  it('carries decor and finishes through recipes, and places them beside the model, not the room', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'bench', name: 'Bench', finish: { preset: 'paint', color: '#e0ddd5' } } },
      { op: 'add', parent: 'bench', entity: { kind: 'part', id: 'seat', name: 'Seat', material: 'ply-3-4', finish: { preset: 'wood:walnut' }, shape: { type: 'box', params: { x: 2304, y: 46, z: 768 } } } },
      { op: 'add', parent: 'bench', entity: { kind: 'decor', id: 'cushion', name: 'Cushion', transform: { position: [0, 46, 0] }, shape: { type: 'testStool', params: { x: 2304, y: 128, z: 768 } } } },
    ]);
    const recipe = captureRecipe(d, { name: 'Bench', nodeIds: ['bench'], id: 'r1', now: '2026-10-06T00:00:00.000Z' });
    const inserted = insertRecipe(emptyDoc(), recipe);
    const ids = inserted.idMap;
    expect(isDecor(inserted.doc.parts[ids.cushion!]!)).toBe(true);
    expect(inserted.doc.parts[ids.seat!]!.finish).toEqual({ preset: 'wood:walnut' });
    expect(inserted.doc.assemblies[ids.bench!]!.finish).toEqual({ preset: 'paint', color: '#e0ddd5' });
    // Beside the cabinet (12" to its right), though the room around it is much wider.
    const target = ok(emptyDoc(), [room, { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    const placed = placeRecipe(target, recipe);
    const cabinet = union(modelPartIds(target).map((id) => worldBoxes(target).get(id)!));
    expect(worldBoxes(placed.doc).get(placed.wrapperId)!.min[0]).toBe(cabinet.max[0] + 12 * 64);
  });

  it('offers the generator\'s actions, and no machining or joints on decor', () => {
    const d = ok(emptyDoc(), [room, board('side', [46, 1280, 640], [100, 0, 100]), decor('testStool', [960, 1920, 960], [3000, 0, 2000])]);
    const wall = actionsFor(d, [{ node: 'room.wall-back', handle: 'face:front', at: [1000, 1000, 256] }]);
    const add = wall.find((a) => a.label === 'Add window here')!;
    expect(add.run({})).toEqual([{ op: 'update', id: 'room', patch: { params: { width: 9000, depth: 6000, height: 3000, windows: 1 } } }]);
    expect(wall.map((a) => a.id)).not.toContain('hole');
    expect(actionsFor(d, [{ node: 'p1', handle: 'face:front' }]).map((a) => a.id)).toEqual([]);
    expect(actionsFor(d, [{ node: 'side' }, { node: 'p1' }]).map((a) => a.id)).toEqual(['delete']);
  });

  it('pushes only the faces a locked generator claims, and snaps a position without size matches', () => {
    const d = ok(emptyDoc(), [room, board('panel', [640, 640, 6100], [-2000, 0, 0])]);
    const front = handleDrives(d, { node: 'room.wall-back', handle: 'face:front' })!;
    expect(front.drives).toMatchObject([{ owner: { kind: 'generator', asm: 'room' }, path: 'depth', kind: 'position' }]);
    expect(handleDrives(d, { node: 'room.wall-back', handle: 'face:top' })!.drives).toEqual([]);
    expect(handleDrives(d, { node: 'room.wall-back', handle: 'edge:top-front' })!.drives).toEqual([]);
    // The panel is 100 deeper than the room: a size drive would offer "back wall = panel depth" at -100.
    const asSize = { ...front, drives: front.drives.map((x) => ({ ...x, kind: undefined })) };
    expect(inferLine(d, asSize, [0, 0, 1], -100, 8)?.label).toMatch(/back wall = panel depth/);
    expect(inferLine(d, front, [0, 0, 1], -100, 8)?.label ?? '').not.toMatch(/=/);
  });
});
