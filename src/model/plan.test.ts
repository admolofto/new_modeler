import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { floorPlan } from './plan';
import type { Doc, Vec3 } from './schema';
import { inches } from './units';

const I = (n: number) => inches(n);

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const cabinet = (id: string, position: Vec3, params: Record<string, unknown> = {}, rotation: Vec3 = [0, 0, 0]): Op => ({
  op: 'add',
  entity: { kind: 'assembly', id, name: id, transform: { position, rotation }, generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } },
});
const room = (params: Record<string, unknown>): Op => ({
  op: 'add',
  entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: 0, right: I(120), back: 0, front: I(96), height: I(96), ...params } } },
});

describe('floorPlan', () => {
  it('is empty for an empty model', () => {
    expect(floorPlan(emptyDoc())).toEqual({ rooms: [], items: [], bounds: null });
  });

  it('draws each cabinet as its footprint, front edge last, with its level', () => {
    const d = ok(emptyDoc(), [cabinet('a', [0, 0, 0]), cabinet('up', [I(40), I(54), 0], { height: I(30), depth: I(12) })]);
    const plan = floorPlan(d);
    expect(plan.items.map((i) => [i.id, i.kind, i.level])).toEqual([
      ['a', 'cabinet', 'base'],
      ['up', 'cabinet', 'upper'],
    ]);
    const a = plan.items[0]!;
    // Back-left, back-right, front-right, front-left: the front is +z (toward the bottom of the plan).
    expect(a.corners[0][1]).toBeLessThan(a.corners[3][1]);
    expect(a.corners[1][0]).toBeGreaterThan(a.corners[0][0]);
    expect(a.width).toBe(a.corners[1][0] - a.corners[0][0]);
  });

  it('turns a turned cabinet’s footprint with it', () => {
    const d = ok(emptyDoc(), [cabinet('a', [0, 0, 0], {}, [0, 90, 0])]);
    const [a] = floorPlan(d).items;
    // Turned a quarter about +Y its front faces +x: the front edge is the one furthest along x.
    const front = (a!.corners[2][0] + a!.corners[3][0]) / 2;
    const back = (a!.corners[0][0] + a!.corners[1][0]) / 2;
    expect(front).toBeGreaterThan(back);
  });

  it('cuts the walls at openings and draws doors with their swing', () => {
    const d = ok(emptyDoc(), [
      room({
        openings: [
          { kind: 'window', wall: 'back', at: I(60), width: I(36), height: I(48) },
          { kind: 'door', wall: 'front', at: I(30), width: I(32), height: I(80), hinge: 'left', swing: 'in' },
        ],
      }),
    ]);
    const plan = floorPlan(d);
    expect(plan.items).toEqual([]);
    const [r] = plan.rooms;
    expect(r!.min).toEqual([0, 0]);
    expect(r!.max).toEqual([I(120), I(96)]);
    const back = r!.walls.find((w) => w.side === 'back')!;
    expect(back.pieces).toHaveLength(2);
    expect(r!.walls.find((w) => w.side === 'left')!.pieces).toHaveLength(1);

    const win = r!.openings.find((o) => o.kind === 'window')!;
    expect(win.inside.map((p) => p[1])).toEqual([0, 0]);
    expect(win.inside.map((p) => p[0]).sort((x, y) => x - y)).toEqual([I(42), I(78)]);
    expect(win.door).toBeUndefined();

    const door = r!.openings.find((o) => o.kind === 'door')!;
    // It swings into the room (toward −z from the front wall), a full leaf long.
    expect(door.door!.hinge[1]).toBe(I(96));
    expect(door.door!.leaf[1]).toBeCloseTo(I(96) - I(32), 0);
    expect(door.door!.arc.length).toBeGreaterThan(4);
    expect(plan.bounds!.min[1]).toBeLessThan(0);
  });

  it('leaves out hidden pieces and the room’s own parts', () => {
    const d = ok(emptyDoc(), [room({}), cabinet('a', [0, 0, 0]), { op: 'update', id: 'a', patch: { hidden: true } } as Op]);
    expect(floorPlan(d).items).toEqual([]);
  });
});
