import { describe, expect, it } from 'vitest';
import '../plugins';
import type { RoomParams } from '../plugins/generators/room';
import { clearance } from './clearance';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { atAlongWall, alongWall, placeOpening, refitRoomOps, roomAround, roomInterior, roomIssues, roomOf, roomShell } from './room';
import type { Doc, Vec3 } from './schema';
import { inches } from './units';
import { union, worldBoxes } from './world';
import { modelPartIds } from './decor';

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
const addRoom = (params: Record<string, unknown>): Op => ({ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params } } });
const paramsOf = (d: Doc) => d.assemblies.room!.generator!.params as unknown as RoomParams;
const ceilInch = (u: number) => Math.ceil(u / 64) * 64;
const modelBox = (d: Doc) => union(modelPartIds(d).map((id) => worldBoxes(d).get(id)!));

describe('roomAround', () => {
  it('makes a 12\' square, 96" high, around nothing', () => {
    expect(roomAround(emptyDoc()).params).toEqual({ left: 0, right: I(144), back: 0, front: I(144), height: I(96) });
  });

  it('puts the back wall flush behind the model, the front 48" ahead and the sides 36" out, to the inch', () => {
    const d = ok(emptyDoc(), [cabinet('a', [I(0.25), 0, 0], { doors: 2 }), cabinet('b', [I(36.25), 0, 0], { width: I(18), drawers: [0, 0] , shelves: 0 })]);
    const B = modelBox(d);
    expect(roomAround(d).params).toEqual({ left: -I(36), right: I(91), back: 0, front: ceilInch(B.max[2] + I(48)), height: I(96) });
    // A room around it leaves the model where it was and isn't part of it.
    const r = ok(d, [addRoom(roomAround(d).params)]);
    expect(modelBox(r)).toEqual(B);
  });

  it('puts a side wall flush where a cabinet backs onto it (a run from wall to wall)', () => {
    // A cabinet turned to face +x at the left end: its back is the left wall.
    const turned = ok(emptyDoc(), [cabinet('a', [I(24), 0, 0]), cabinet('end', [0, 0, I(60)], {}, [0, 90, 0])]);
    const B = modelBox(turned);
    expect(B.min[0]).toBe(0);
    expect(roomAround(turned).params).toMatchObject({ left: 0, right: ceilInch(B.max[0] + I(36)), back: 0 });
    // Facing -x at the right end: the right wall.
    const right = ok(emptyDoc(), [cabinet('a', [0, 0, 0]), cabinet('end', [I(60), 0, 0], {}, [0, -90, 0])]);
    expect(roomAround(right).params.right).toBe(modelBox(right).max[0]);
    // A block that faces +x works the same.
    const block = ok(emptyDoc(), [cabinet('a', [I(24), 0, 0]), { op: 'add', entity: { kind: 'block', transform: { position: [0, 0, I(36)], rotation: [0, 90, 0] }, size: [I(36), I(34.5), I(24)] } }]);
    expect(roomAround(block).params.left).toBe(0);
    // Facing +z (along the back), the ends aren't against side walls.
    expect(roomAround(ok(emptyDoc(), [cabinet('a', [0, 0, 0])])).params.left).toBe(-I(36));
  });

  it('takes margins (0 = flush), a height, the walls and the ceiling', () => {
    const d = ok(emptyDoc(), [cabinet('a', [I(0.25), 0, 0])]);
    const B = modelBox(d);
    const fit = roomAround(d, { margins: { left: 0, right: I(12), back: I(2), front: I(36) }, height: I(108), walls: ['back', 'left'], ceiling: false }).params;
    expect(fit).toEqual({ left: B.min[0], right: B.max[0] + I(12), back: -I(2), front: B.max[2] + I(36), height: I(108), walls: ['back', 'left'], ceiling: false });
    // A tall model raises the ceiling.
    expect(roomAround(ok(emptyDoc(), [cabinet('tall', [0, 0, 0], { height: I(100.5) })])).params.height).toBe(I(101));
  });
});

describe('refitRoomOps', () => {
  it('moves the walls to the model, keeping openings, walls, finishes and height', () => {
    const d0 = ok(emptyDoc(), [cabinet('a', [0, 0, 0])]);
    const fit = roomAround(d0).params;
    const d = ok(d0, [
      addRoom({ ...fit, height: I(108), walls: ['back', 'left', 'right'], finishes: { walls: { preset: 'paint', color: '#335577' } }, openings: [{ kind: 'window', wall: 'back', at: I(18), width: I(36), height: I(48) }] }),
      cabinet('b', [I(36), 0, 0]),
    ]);
    const { ops, notes } = refitRoomOps(d, 'room');
    expect(ops).toEqual([{ op: 'update', id: 'room', patch: { params: { right: fit.right + I(36) } } }]);
    expect(notes).toEqual([]);
    const p = paramsOf(ok(d, ops));
    expect(p).toMatchObject({ height: I(108), walls: ['back', 'left', 'right'], finishes: { walls: { color: '#335577' } } });
    expect(p.openings).toMatchObject([{ id: 'w1', at: I(18) }]);
    // Already fits: nothing to do.
    expect(refitRoomOps(ok(d, ops), 'room').ops).toEqual([]);
  });

  it('slides openings along to stay on a wall that got shorter, and drops ones that no longer fit', () => {
    const d = ok(emptyDoc(), [
      cabinet('a', [0, 0, 0]),
      addRoom({ left: -I(36), right: I(300), back: 0, front: I(100), openings: [
        { kind: 'window', wall: 'back', at: I(250), width: I(36), height: I(48) },
        { kind: 'window', wall: 'back', at: I(150), width: I(120), height: I(48) },
        { kind: 'door', wall: 'right', at: I(50), width: I(32), height: I(80) },
      ] }),
    ]);
    const { ops, notes } = refitRoomOps(d, 'room');
    const p = paramsOf(ok(d, ops));
    expect(p.right).toBe(I(72));
    expect(p.openings.map((o) => [o.id, o.at])).toEqual([['w1', I(72 - 18)], ['d1', I(50)]]);
    expect(notes).toEqual([
      'Window w1 moved 196" to stay on the back wall',
      'Window w2 (120" wide) was removed: the back wall is only 108" inside now',
    ]);
  });
});

describe('roomIssues', () => {
  it('reports openings on walls that are off, and ones something stands in front of', () => {
    const base = ok(emptyDoc(), [
      cabinet('base', [0, 0, 0]),
      addRoom({ left: -I(36), right: I(72), back: 0, front: I(96), walls: ['back', 'left', 'right'], openings: [
        { kind: 'window', wall: 'back', at: I(18), width: I(30), height: I(36), sill: I(40) },
        { kind: 'window', wall: 'front', at: I(18), width: I(30), height: I(36) },
        { kind: 'door', wall: 'right', at: I(60), width: I(32), height: I(80) },
      ] }),
    ]);
    // The base cabinet stays under the window's sill.
    expect(roomIssues(base)).toEqual(['Window w2 (front wall) isn\'t built: the front wall is turned off']);
    const blocked = ok(base, [
      cabinet('upper', [0, I(54), 0], { width: I(30), height: I(30), depth: I(12), toeKick: null }),
      { op: 'update', id: 'upper', patch: { name: 'Wall cabinet 30″' } },
      // Within the door's swing (it opens into the room).
      { op: 'add', entity: { kind: 'block', name: 'Fridge', transform: { position: [I(40), 0, I(46)] }, size: [I(30), I(70), I(30)] } },
    ]);
    expect(roomIssues(blocked)).toEqual([
      'Window w1 (back wall) is covered by “Wall cabinet 30″”',
      'Window w2 (front wall) isn\'t built: the front wall is turned off',
      'Door d1 (right wall) is covered by “Fridge”',
    ]);
    expect(roomIssues(emptyDoc())).toEqual([]);
  });
});

describe('the room’s inside and shell', () => {
  const d = ok(emptyDoc(), [
    cabinet('base', [0, 0, 0]),
    addRoom({ left: -I(36), right: I(108), back: 0, front: I(120), openings: [
      { kind: 'window', wall: 'back', at: I(54), width: I(36), height: I(48) },
      { kind: 'door', wall: 'right', at: I(60), width: I(32), height: I(80) },
      { kind: 'door', wall: 'left', at: I(60), width: I(32), height: I(80), leaf: 'none' },
    ] }),
  ]);

  it('knows its inside and the eye height', () => {
    expect(roomInterior(d)).toEqual({ min: [-I(36), 0, 0], max: [I(108), I(96), I(120)], eyeHeight: I(62) });
    expect(roomInterior(emptyDoc())).toBeNull();
    expect(roomOf(d)!.id).toBe('room');
  });

  it('lists each wall with what it hosts, the ceiling, the floor, the windows, every shell id and the bounds', () => {
    const shell = roomShell(d);
    expect(roomShell(d)).toBe(shell);
    const wall = (side: string) => shell.walls.find((w) => w.side === side)!;
    expect(shell.walls.map((w) => w.side)).toEqual(['back', 'left', 'right', 'front']);
    expect(wall('back').ids).toEqual(['room.wall-back', 'room.window-w1', 'room.casing-w1', 'room.baseboard-back-1']);
    expect(wall('right').ids).toEqual(['room.wall-right', 'room.casing-d1', 'room.door-d1', 'room.baseboard-right-1', 'room.baseboard-right-2']);
    expect(wall('left').ids).toEqual(['room.wall-left', 'room.casing-d2', 'room.baseboard-left-1', 'room.baseboard-left-2']);
    expect(wall('back')).toMatchObject({ point: [I(36), I(48), 0], outward: [0, 0, -1] });
    expect(wall('left')).toMatchObject({ point: [-I(36), I(48), I(60)], outward: [-1, 0, 0] });
    expect(wall('right')).toMatchObject({ point: [I(108), I(48), I(60)], outward: [1, 0, 0] });
    expect(wall('front')).toMatchObject({ point: [I(36), I(48), I(120)], outward: [0, 0, 1] });
    expect(shell.ceilings).toEqual([{ ids: ['room.ceiling'], height: I(96), min: [-I(36), 0], max: [I(108), I(120)] }]);
    expect(shell.floors).toEqual(['room.floor']);
    expect(shell.windows).toEqual([{ id: 'w1', part: 'room.window-w1', center: [I(54), I(60), -I(2.25)], outward: [0, 0, -1], area: I(36) * I(48) }]);
    const roomParts = Object.keys(d.parts).filter((id) => id.startsWith('room.'));
    expect(new Set(shell.shellIds)).toEqual(new Set([...roomParts, 'room.door-d1']));
    expect(shell.shellIds.some((id) => id.startsWith('base'))).toBe(false);
    expect(shell.bounds).toEqual({ min: [-I(40.5), -I(1.5), -I(4.5)], max: [I(112.5), I(97.5), I(124.5)] });
    // Walls that are off aren't there; no ceiling, no ceilings.
    const open = ok(d, [{ op: 'update', id: 'room', patch: { params: { walls: ['back'], ceiling: false } } }]);
    expect(roomShell(open).walls.map((w) => w.side)).toEqual(['back']);
    expect(roomShell(open).ceilings).toEqual([]);
    expect(roomShell(emptyDoc())).toMatchObject({ walls: [], ceilings: [], floors: [], windows: [], shellIds: [], bounds: null });
  });
});

describe('openings in the editor', () => {
  const p = (extra: Partial<RoomParams> = {}) => ({ left: 0, right: I(144), back: 0, front: I(120), height: I(96), walls: ['back', 'left', 'right', 'front'], wallThickness: I(4.5), openings: [], floor: true, ceiling: true, floorGrain: 'x', baseboard: null, finishes: {}, ...extra }) as unknown as RoomParams;

  it('measures along a wall from its left end, seen from inside', () => {
    const room = p();
    expect(alongWall(room, 'back', I(30))).toBe(I(30));
    expect(alongWall(room, 'front', I(30))).toBe(I(114));
    expect(alongWall(room, 'left', I(30))).toBe(I(90));
    expect(alongWall(room, 'right', I(30))).toBe(I(30));
    for (const wall of ['back', 'left', 'right', 'front'] as const) expect(atAlongWall(room, wall, alongWall(room, wall, I(42)))).toBe(I(42));
  });

  it('places a new opening in the widest free stretch of a wall', () => {
    const one = placeOpening(p(), 'window')!;
    expect(one).toMatchObject({ id: 'w1', wall: 'back', at: I(72), width: I(36), sill: I(36) });
    const next = placeOpening(p({ openings: [one] }), 'door')!;
    expect(next).toMatchObject({ id: 'd1', wall: 'back', width: I(32) });
    expect(Math.abs(next.at - I(72))).toBeGreaterThanOrEqual(I(34));
    expect(placeOpening(p({ walls: ['left'] }), 'window')!.wall).toBe('left');
  });
});

describe('clearance with a room', () => {
  it('reports a cabinet door that swings into a wall', () => {
    const d = ok(emptyDoc(), [cabinet('a1', [0, 0, 0], { doors: 1, doorHinge: 'left' }), addRoom({ left: 0, right: I(96), back: 0, front: I(96) })]);
    const hits = clearance(d);
    expect(hits).toMatchObject([{ motion: 'a1.motion.door', part: 'a1.door', hits: 'room.wall-left' }]);
    // Hinged on the other side it opens clear.
    expect(clearance(ok(d, [{ op: 'update', id: 'a1', patch: { params: { doorHinge: 'right' } } }]))).toEqual([]);
  });

  it('lets a room door swing past its own casing and wall, but not into a cabinet', () => {
    const room = addRoom({ left: -I(36), right: I(72), back: 0, front: I(96), openings: [{ kind: 'door', wall: 'right', at: I(24), width: I(32), height: I(80), hinge: 'right' }] });
    expect(clearance(ok(emptyDoc(), [room]))).toEqual([]);
    const near = ok(emptyDoc(), [cabinet('a1', [I(36), 0, 0]), room]);
    expect(clearance(near)).toMatchObject([{ motion: 'room.motion.door-d1', hits: expect.stringMatching(/^a1\./) }]);
  });
});
