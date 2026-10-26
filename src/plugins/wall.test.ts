import { describe, expect, it } from 'vitest';
import { actionsFor } from '../edit/actions';
import { dragChanges, driveOps, handleDrives } from '../edit/drives';
import { gizmoNodes, targetsOf } from '../edit/gizmo';
import { cutaway } from '../render/cutaway';
import { modelPartIds } from '../model/decor';
import { emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import { floorPlan } from '../model/plan';
import { roomShell } from '../model/room';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import './index';
import type { WallPieceParams } from './generators/wall';
import { generators } from './registry';

const I = (n: number) => inches(n);

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

const WINDOW = { kind: 'window', at: I(30), width: I(36), height: I(48), sill: I(36) };
const DOOR = { kind: 'door', at: I(90), width: I(32), height: I(80), hinge: 'right' };
const addWall = (params: Record<string, unknown>, position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0]): Op => ({
  op: 'add',
  entity: { kind: 'assembly', id: 'w', name: 'Wall', transform: { position, rotation }, generator: { type: 'wall', params: { length: I(120), height: I(96), thickness: I(4.5), ...params } } },
});
const params = (d: Doc) => d.assemblies.w!.generator!.params as unknown as WallPieceParams;

describe('wall piece generator', () => {
  it('cuts its openings through one wall part and builds the room’s window, door and casings on them', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [WINDOW, DOOR] })]);
    const p = params(d);
    expect(p.openings.map((o) => o.id)).toEqual(['w1', 'd1']);
    const wall = d.parts['w.wall']!;
    expect(wall.shape.params).toMatchObject({ x: I(120), y: I(96), z: I(4.5) });
    expect((wall.shape.params as { openings: unknown[] }).openings).toEqual([
      { id: 'w1', x: I(12), y: I(36), w: I(36), h: I(48) },
      { id: 'd1', x: I(74), y: 0, w: I(32), h: I(80) },
    ]);
    // Casings on both faces, the window flush with the front, the door in a folder that swings.
    for (const role of ['casing-w1', 'casing-back-w1', 'window-w1', 'casing-d1', 'casing-back-d1', 'door-d1-leaf', 'door-d1-handle']) expect(d.parts[`w.${role}`], role).toBeDefined();
    expect(d.assemblies['w.door-d1']).toBeDefined();
    const motion = Object.values(d.motions).find((m) => m.nodes.includes('w.door-d1'))!;
    expect(motion).toMatchObject({ type: 'hinge', params: { side: 'right', toward: 'front' } });
    // The back casing is turned onto the back face, its opening on the window's.
    const back = d.parts['w.casing-back-w1']!;
    expect(back.transform.rotation).toEqual([0, 180, 0]);
    const boxes = worldBoxes(d);
    const front = boxes.get('w.casing-w1')!;
    const behind = boxes.get('w.casing-back-w1')!;
    expect(behind.max[2]).toBe(0);
    expect(front.min[2]).toBe(I(4.5));
    // Same width round the same opening (no stool at the back).
    expect(behind.min[0]).toBe(I(12) - I(3));
    expect(behind.max[0]).toBe(I(48) + I(3));
  });

  it('can keep its casings to the front face', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [DOOR], casings: 'front' })]);
    expect(d.parts['w.casing-d1']).toBeDefined();
    expect(d.parts['w.casing-back-d1']).toBeUndefined();
  });

  it('says what’s wrong with an opening that doesn’t fit', () => {
    expect(fails(emptyDoc(), [addWall({ openings: [{ ...WINDOW, at: I(10) }] })])).toMatch(/runs 8" past the wall's start/);
    expect(fails(emptyDoc(), [addWall({ openings: [{ ...DOOR, at: I(110) }] })])).toMatch(/runs 6" past the wall's end/);
    expect(fails(emptyDoc(), [addWall({ openings: [{ ...DOOR, height: I(96) }] })])).toMatch(/leaves less than 1" of wall/);
    expect(fails(emptyDoc(), [addWall({ openings: [WINDOW, { ...DOOR, at: I(40) }] })])).toMatch(/overlaps window w1/);
  });

  it('is surroundings that move: left out of the model’s parts, but the gizmo moves it whole', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [DOOR] }, [I(10), 0, I(-50)], [0, 90, 0])]);
    expect(modelPartIds(d)).toEqual([]);
    expect(generators.get('wall').surroundings).toBe(true);
    expect(gizmoNodes(d, targetsOf(d, ['w']))).toEqual(['w']);
    // Turned a quarter: it runs along −z from its start.
    const box = worldBoxes(d).get('w.wall')!;
    expect(box.min[0]).toBe(I(10));
    expect(box.max[0]).toBe(I(14.5));
    expect(box.max[2]).toBe(I(-50));
    expect(box.min[2]).toBe(I(-170));
  });

  it('pushes and pulls: the end sets the length, the top the height, the back face the thickness (outward)', () => {
    const d = ok(emptyDoc(), [addWall({})]);
    const drag = (handle: string, by: [number, number, number]) => driveOps(d, 'w.wall', dragChanges(handleDrives(d, { node: 'w.wall', handle })!, by));
    expect(drag('face:right', [I(6), 0, 0])).toEqual([{ op: 'update', id: 'w', patch: { params: { length: I(126) } } }]);
    expect(drag('face:top', [0, I(12), 0])).toEqual([{ op: 'update', id: 'w', patch: { params: { height: I(108) } } }]);
    expect(handleDrives(d, { node: 'w.wall', handle: 'face:left' })!.drives).toEqual([]);
    const thicker = ok(d, drag('face:back', [0, 0, I(-1)]));
    expect(params(thicker).thickness).toBe(I(5.5));
    // The front face stayed put.
    expect(worldBoxes(thicker).get('w.wall')!.max[2]).toBe(I(4.5));
  });

  it('offers to add an opening where the wall is clicked, and to remove one', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [DOOR] })]);
    const add = actionsFor(d, [{ node: 'w.wall', handle: 'face:front', at: [I(30), I(50), I(4.5)] }]);
    expect(add.map((a) => a.label)).toEqual(['Add window here', 'Add door here', 'Add opening here']);
    const next = ok(d, add[0]!.run({}));
    expect(params(next).openings.find((o) => o.kind === 'window')).toMatchObject({ id: 'w1', at: I(30), width: I(36), sill: I(36) });
    // Near the start it slides along to fit.
    const start = actionsFor(d, [{ node: 'w.wall', handle: 'face:back', at: [I(4), I(50), 0] }]);
    expect(params(ok(d, start[0]!.run({}))).openings.find((o) => o.kind === 'window')).toMatchObject({ at: I(18) });
    // Over the door nothing new fits.
    expect(actionsFor(d, [{ node: 'w.wall', handle: 'face:front', at: [I(90), I(50), I(4.5)] }]).map((a) => a.label)).toEqual([]);
    // Remove: from a reveal of its hole or the leaf.
    for (const t of [{ node: 'w.wall', handle: 'd1:jamb-left' }, { node: 'w.door-d1-leaf' }]) {
      const remove = actionsFor(d, [t]).find((a) => a.label === 'Remove door d1');
      expect(remove, JSON.stringify(t)).toBeDefined();
      expect(params(ok(d, remove!.run({}))).openings).toEqual([]);
    }
  });

  it('is a wall in the plan: hatched stretches broken at its openings, its door’s swing drawn', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [WINDOW, DOOR] }, [0, 0, 0], [0, 180, 0])]);
    const plan = floorPlan(d);
    const item = plan.items.find((i) => i.id === 'w')!;
    expect(item.kind).toBe('wall');
    // Turned half round: it runs from x 0 to −120", its front facing −z.
    expect(item.wall!.pieces.length).toBe(3);
    const xs = item.wall!.pieces.flat().map((p) => p[0]);
    expect(Math.min(...xs)).toBe(-I(120));
    expect(Math.max(...xs)).toBe(0);
    const [w1, d1] = item.wall!.openings;
    expect(w1).toMatchObject({ id: 'w1', kind: 'window', width: I(36) });
    expect(w1!.inside[0]).toEqual([-I(12), -I(4.5)]);
    // Hinged right (seen from the front), swinging toward the front.
    expect(d1!.door!.hinge).toEqual([-I(106), -I(4.5)]);
    expect(Math.min(...d1!.door!.arc.map((p) => p[1]))).toBeLessThan(-I(30));
  });

  it('cuts away like a room wall when the eye is behind it, its window lighting the room', () => {
    const d = ok(emptyDoc(), [addWall({ openings: [WINDOW, DOOR] })]);
    const shell = roomShell(d);
    expect(shell.walls).toHaveLength(1);
    const [w] = shell.walls;
    expect(w!.side).toBeUndefined();
    expect(w!.ids).toEqual(['w.wall', 'w.window-w1', 'w.casing-w1', 'w.casing-back-w1', 'w.casing-d1', 'w.casing-back-d1', 'w.door-d1']);
    expect(w!.outward).toEqual([0, 0, -1]);
    expect(shell.windows).toEqual([expect.objectContaining({ id: 'w1', part: 'w.window-w1', outward: [0, 0, -1], area: I(36) * I(48) })]);
    expect(shell.bounds).toEqual({ min: [0, 0, 0], max: [I(120), I(96), I(4.5)] });
    // Behind it (−z), it goes; in front, it stays.
    expect(cutaway(shell.walls, shell.ceilings, [I(60), I(60), -I(100)], 'orbit', new Set()).has('w.wall')).toBe(true);
    expect(cutaway(shell.walls, shell.ceilings, [I(60), I(60), I(100)], 'orbit', new Set()).size).toBe(0);
  });
});
