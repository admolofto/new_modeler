import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { emptyDoc } from '../model/defaults';
import { applyOps } from '../model/ops';
import { roomShell } from '../model/room';
import { inches } from '../model/units';
import { cutaway, CUT_MARGIN, sameCut } from './cutaway';

const I = (n: number) => inches(n);

// A 12' × 10' room, 8' high, with a window in the front wall and a door in the left.
const r = applyOps(emptyDoc(), [
  {
    op: 'add',
    entity: {
      kind: 'assembly',
      id: 'room',
      name: 'Room',
      generator: {
        type: 'room',
        params: {
          left: 0, right: I(144), back: 0, front: I(120),
          openings: [{ kind: 'window', wall: 'front', at: I(72), width: I(36), height: I(48) }, { kind: 'door', wall: 'left', at: I(60), width: I(32), height: I(80) }],
        },
      },
    },
  },
]);
if (!r.ok) throw new Error(r.error);
const shell = roomShell(r.doc);
const wallIds = (side: string) => shell.walls.find((w) => w.side === side)!.ids;
const cut = (eye: V3, prev: ReadonlySet<string> = new Set(), mode: 'orbit' | 'walk' = 'orbit') => cutaway(shell.walls, shell.ceilings, eye, mode, prev);
const sides = (ids: ReadonlySet<string>) => shell.walls.filter((w) => ids.has(w.ids[0]!)).map((w) => w.side);

describe('cutaway', () => {
  it('takes away the walls between an eye outside and the room, with what they host', () => {
    const front = cut([I(72), I(60), I(200)]);
    expect(sides(front)).toEqual(['front']);
    for (const id of wallIds('front')) expect(front.has(id)).toBe(true);
    expect(wallIds('front')).toEqual(expect.arrayContaining(['room.window-w1', 'room.casing-w1']));
    // Outside the footprint: the ceiling goes too.
    expect(front.has('room.ceiling')).toBe(true);
    // From the front-left corner, both near walls; the door's folder goes with the left wall.
    const corner = cut([-I(60), I(60), I(200)]);
    expect(sides(corner)).toEqual(['left', 'front']);
    expect(corner.has('room.door-d1')).toBe(true);
    expect(corner.has('room.casing-d1')).toBe(true);
  });

  it('takes away nothing from inside, and only the ceiling from above', () => {
    expect(cut([I(72), I(60), I(60)])).toEqual(new Set());
    expect(cut([I(72), I(140), I(60)])).toEqual(new Set(['room.ceiling']));
  });

  it('keeps a wall as it was near its plane (no flicker), and never cuts while walking', () => {
    const face = I(120);
    const front = new Set(wallIds('front'));
    const at = (dz: number) => [I(72), I(60), face + dz] as V3;
    // Just outside: hidden only if it was.
    expect(sides(cut(at(CUT_MARGIN / 2)))).toEqual([]);
    expect(sides(cut(at(CUT_MARGIN / 2), front))).toEqual(['front']);
    // Just inside, still hidden if it was; well inside it comes back.
    expect(sides(cut(at(-CUT_MARGIN / 2), front))).toEqual(['front']);
    expect(sides(cut(at(-CUT_MARGIN - 1), front))).toEqual([]);
    expect(sides(cut(at(CUT_MARGIN + 1)))).toEqual(['front']);
    expect(cut([I(72), I(60), I(500)], new Set(), 'walk')).toEqual(new Set());
  });

  it('compares cutaways by what they take', () => {
    expect(sameCut(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameCut(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});
