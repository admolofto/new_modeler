import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import { applyOps } from '../model/ops';
import { roomOf, roomParams } from '../model/room';
import { inches } from '../model/units';
import type { RoomOpening, RoomParams } from '../plugins/generators/room';
import { openingDims, openingEdges, openingGrips, openingReadout, openingUnder, readoutText, resizeOpening, roomPick, slideOpening, wallPoint, wallUnder, withOpening } from './openings';
import type { Ray } from './rays';

const I = inches;

/** A 12' × 10' room, 8' high: a window and a door on the back wall, a cased opening on the right. */
function room(openings: unknown[] = [
  { kind: 'window', wall: 'back', at: I(36), width: I(36), height: I(48) },
  { kind: 'door', wall: 'back', at: I(110), width: I(32), height: I(80) },
  { kind: 'opening', wall: 'right', at: I(60), width: I(36), height: I(80) },
]): RoomParams {
  const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: 0, right: I(144), back: 0, front: I(120), openings } } } }]);
  if (!r.ok) throw new Error(r.error);
  return roomParams(roomOf(r.doc)!);
}
/** The room still validates with an opening changed. */
function valid(p: RoomParams, o: RoomOpening): boolean {
  const base = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: p as unknown as Record<string, unknown> } } }]);
  if (!base.ok) throw new Error(base.error);
  return applyOps(base.doc, [{ op: 'update', id: 'room', patch: { params: { openings: withOpening(p, o).openings } } }]).ok;
}
const fmt = (u: number) => `${u / 64}"`;

describe('sliding an opening along the walls', () => {
  const p = room();

  it('follows the cursor on a 1/2" grid, between the corners', () => {
    expect(openingEdges(p, slideOpening(p, 'w1', 'back', I(40.2), 32)!.opening)).toEqual([I(40), I(76)]);
    expect(openingEdges(p, slideOpening(p, 'w1', 'back', -I(30), 32)!.opening)).toEqual([0, I(36)]);
    expect(openingEdges(p, slideOpening(p, 'o1', 'right', I(500), 32)!.opening)).toEqual([I(84), I(120)]);
  });

  it('stops against a neighbor, and hops past it when there is room beyond', () => {
    // The door is 94"–126": the window stops flush left of it; the 18" beyond is too little for it.
    expect(openingEdges(p, slideOpening(p, 'w1', 'back', I(70), 32)!.opening)).toEqual([I(58), I(94)]);
    const stuck = slideOpening(p, 'w1', 'back', I(120), 32)!.opening;
    expect(openingEdges(p, stuck)).toEqual([I(58), I(94)]);
    expect(valid(p, stuck)).toBe(true);
    // The door, dragged left across the window (18"–54"), lands on its far side only once it fits there.
    expect(openingEdges(p, slideOpening(p, 'd1', 'back', I(40), 32)!.opening)).toEqual([I(54), I(86)]);
    const narrow = withOpening(p, { ...p.openings[1]!, width: I(16), at: I(110) });
    expect(openingEdges(narrow, slideOpening(narrow, 'd1', 'back', I(6), 32)!.opening)).toEqual([I(2), I(18)]);
  });

  it('goes round the corner onto another wall, measured from that wall\'s left corner', () => {
    const s = slideOpening(p, 'w1', 'left', I(12), 32)!.opening;
    expect(s.wall).toBe('left');
    expect(openingEdges(p, s)).toEqual([I(12), I(48)]);
    // The left wall runs front → back as seen from inside.
    expect(s.at).toBe(I(120 - 30));
    expect(valid(p, s)).toBe(true);
    const front = slideOpening(p, 'w1', 'front', I(10), 32)!.opening;
    expect(front.at).toBe(I(144 - 28));
    expect(valid(p, front)).toBe(true);
  });

  it('snaps to the middle of the wall', () => {
    const only = room([{ kind: 'window', wall: 'back', at: I(36), width: I(36), height: I(48) }]);
    expect(slideOpening(only, 'w1', 'back', I(54.3), 32, I(1))).toMatchObject({ note: 'centered', opening: { at: I(72) } });
    expect(slideOpening(only, 'w1', 'back', I(54.3), 32)!.note).toBe('');
  });

  it('has nowhere to go on a wall that is too short or full', () => {
    const tight = room([{ kind: 'window', wall: 'back', at: I(72), width: I(130), height: I(48) }]);
    expect(slideOpening(tight, 'w1', 'left', I(10), 32)).toBeNull();
  });
});

describe('resizing an opening by an edge', () => {
  const p = room();

  it('moves one side and keeps the other', () => {
    const wider = resizeOpening(p, 'w1', 'right', I(60.1), 32)!;
    expect(openingEdges(p, wider)).toEqual([I(18), I(60)]);
    const narrower = resizeOpening(p, 'w1', 'left', I(30), 32)!;
    expect(openingEdges(p, narrower)).toEqual([I(30), I(54)]);
    expect(valid(p, wider) && valid(p, narrower)).toBe(true);
  });

  it('stops at 12", at the corner and against a neighbor', () => {
    expect(resizeOpening(p, 'w1', 'right', I(20), 32)!.width).toBe(I(12));
    expect(openingEdges(p, resizeOpening(p, 'w1', 'left', -I(40), 32)!)).toEqual([0, I(54)]);
    const stopped = resizeOpening(p, 'w1', 'right', I(130), 32)!;
    expect(openingEdges(p, stopped)).toEqual([I(18), I(94)]);
    expect(valid(p, stopped)).toBe(true);
  });

  it('pulls the top up to 1" under the ceiling and the sill down to the floor', () => {
    expect(resizeOpening(p, 'w1', 'top', I(90), 32)).toMatchObject({ sill: I(36), height: I(54) });
    expect(resizeOpening(p, 'w1', 'top', I(200), 32)).toMatchObject({ height: I(59) });
    expect(resizeOpening(p, 'w1', 'bottom', I(30), 32)).toMatchObject({ sill: I(30), height: I(54) });
    expect(resizeOpening(p, 'w1', 'bottom', -I(20), 32)).toMatchObject({ sill: 0, height: I(84) });
    expect(resizeOpening(p, 'w1', 'bottom', I(83), 32)).toMatchObject({ sill: I(72), height: I(12) });
  });

  it('gives a door a top but no bottom to pull', () => {
    expect(resizeOpening(p, 'd1', 'top', I(84), 32)).toMatchObject({ height: I(84) });
    expect(resizeOpening(p, 'd1', 'bottom', I(10), 32)).toBeNull();
    expect(openingGrips(p, p.openings[1]!).map((g) => g.grip)).toEqual(['left', 'right', 'top']);
  });

  it('works on walls that run the other way', () => {
    // The front wall's left (seen from inside) is the room's right.
    const f = room([{ kind: 'window', wall: 'front', at: I(100), width: I(36), height: I(48) }]);
    expect(openingEdges(f, f.openings[0]!)).toEqual([I(26), I(62)]);
    const r = resizeOpening(f, 'w1', 'right', I(70), 32)!;
    expect(openingEdges(f, r)).toEqual([I(26), I(70)]);
    expect(valid(f, r)).toBe(true);
  });
});

describe('the readout while dragging', () => {
  const p = room();

  it('says how far it is from each corner and from its nearest neighbor', () => {
    const r = openingReadout(p, p.openings[0]!);
    expect(r).toEqual({ left: I(18), right: I(90), neighbor: { label: 'door d1', gap: I(40), side: 'right' } });
    expect(readoutText(r, fmt)).toBe('18" from left corner · 90" from right corner · 40" from door d1');
    expect(openingReadout(p, p.openings[2]!)).toEqual({ left: I(42), right: I(42), neighbor: null });
  });

  it('draws a row of dimensions above it, and the gap to its neighbor', () => {
    const lines = openingDims(p, p.openings[0]!, 'move');
    expect(lines.map((l) => l.value)).toEqual([I(18), I(90), I(40)]);
    // On the back wall's inside face, at the window's top.
    expect(lines[0]).toMatchObject({ a: [0, I(84), 0], b: [I(18), I(84), 0], out: [0, 1, 0] });
    expect(lines[2]).toMatchObject({ a: [I(54), I(84), 0], b: [I(94), I(84), 0], out: [0, -1, 0] });
    for (const l of lines) expect(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2])).toBe(l.value);
    expect(openingDims(p, p.openings[0]!, 'right').map((l) => l.value)).toEqual([I(18), I(36), I(90), I(40)]);
  });

  it('draws a column beside it when its top or bottom moves', () => {
    expect(openingDims(p, p.openings[0]!, 'top').map((l) => l.value)).toEqual([I(36), I(48), I(12)]);
    // A door starts at the floor: nothing under it.
    expect(openingDims(p, p.openings[1]!, 'top').map((l) => l.value)).toEqual([I(80), I(16)]);
  });
});

describe('aiming the pointer at the room', () => {
  const p = room();
  const eye: [number, number, number] = [I(72), I(60), I(100)];
  const toward = (x: number, y: number, z: number): Ray => {
    const d = [x - eye[0], y - eye[1], z - eye[2]];
    const l = Math.hypot(...d);
    return { o: eye, d: [d[0]! / l, d[1]! / l, d[2]! / l] };
  };

  it('finds the wall under the cursor and where along it', () => {
    expect(wallUnder(p, toward(I(50), I(40), 0))).toEqual({ wall: 'back', along: expect.closeTo(I(50), 3) });
    expect(wallUnder(p, toward(I(144), I(40), I(30)))).toEqual({ wall: 'right', along: expect.closeTo(I(30), 3) });
    expect(wallUnder(p, toward(0, I(40), I(30)))).toEqual({ wall: 'left', along: expect.closeTo(I(90), 3) });
  });

  it('takes the nearest wall when the cursor is on the floor, holding on to the one it follows', () => {
    expect(wallUnder(p, toward(I(60), 0, I(10)))).toMatchObject({ wall: 'back' });
    expect(wallUnder(p, toward(I(138), 0, I(50)))).toMatchObject({ wall: 'right' });
    // 5" from the back wall and 3" from the left one: the nearer wins, unless the back is being followed.
    expect(wallUnder(p, toward(I(3), 0, I(5)))).toMatchObject({ wall: 'left' });
    expect(wallUnder(p, toward(I(3), 0, I(5)), 'back')).toMatchObject({ wall: 'back' });
  });

  it('skips walls that are off or seen from outside', () => {
    const open = { ...p, walls: p.walls.filter((w) => w !== 'back') };
    expect(wallUnder(open, toward(I(50), I(40), 0))).toBeNull();
    // From outside the front wall, looking in: the back wall, not the front one.
    const outside: Ray = { o: [I(72), I(60), I(300)], d: [0, 0, -1] };
    expect(wallUnder(p, outside)).toMatchObject({ wall: 'back' });
  });

  it('finds the opening the ray goes through', () => {
    expect(openingUnder(p, toward(I(36), I(60), 0))?.opening.id).toBe('w1');
    expect(openingUnder(p, toward(I(110), I(40), 0))?.opening.id).toBe('d1');
    expect(openingUnder(p, toward(I(144), I(40), I(60)))?.opening.id).toBe('o1');
    expect(openingUnder(p, toward(I(72), I(60), 0))).toBeNull();
  });

  it('reads a point on a wall even off its ends', () => {
    expect(wallPoint(p, 'back', toward(I(200), I(120), 0))).toEqual({ along: expect.closeTo(I(200), 3), y: expect.closeTo(I(120), 3) });
  });
});

describe('what of the room is selected', () => {
  const r = applyOps(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: 0, right: I(144), back: 0, front: I(120), openings: [{ kind: 'window', wall: 'left', at: I(60), width: I(36), height: I(48) }, { kind: 'door', wall: 'back', at: I(40), width: I(32), height: I(80) }] } } } },
    { op: 'add', entity: { kind: 'part', id: 'b', name: 'b', material: 'ply-3-4', shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } } },
  ]);
  if (!r.ok) throw new Error(r.error);
  const doc = r.doc;

  it('is the room, the wall and the opening the selection is on', () => {
    expect(roomPick(doc, [{ node: 'room' }])).toEqual({ room: 'room', wall: null, opening: null });
    expect(roomPick(doc, [{ node: 'room.wall-right', handle: 'face:front' }])).toEqual({ room: 'room', wall: 'right', opening: null });
    expect(roomPick(doc, [{ node: 'room.window-w1' }])).toMatchObject({ wall: 'left', opening: { id: 'w1' } });
    expect(roomPick(doc, [{ node: 'room.door-d1-leaf', handle: 'face:front' }])).toMatchObject({ wall: 'back', opening: { id: 'd1' } });
    expect(roomPick(doc, [{ node: 'room.wall-back', handle: 'd1:jamb-left' }])).toMatchObject({ wall: 'back', opening: { id: 'd1' } });
    expect(roomPick(doc, [{ node: 'room.floor' }])).toEqual({ room: 'room', wall: null, opening: null });
  });

  it('is nothing when the selection is on the model', () => {
    expect(roomPick(doc, [{ node: 'b' }])).toBeNull();
    expect(roomPick(doc, [])).toBeNull();
  });
});
