import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import { floorPlan } from '../model/plan';
import { roomShell } from '../model/room';
import { inches } from '../model/units';
import type { Mat3 } from '../model/world';
import type { RoomParams } from '../plugins/generators/room';
import type { ColladaNode } from './collada';
import { recognizeRooms } from './recognizeRooms';
import { importSketchUp, type IRNative, type IRPart } from './sketchupImport';

const I = inches;
const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** A wall piece's stand-in over a plan rectangle (inches, x and z), 96" tall. */
function wall(x0: number, x1: number, z0: number, z1: number): IRNative {
  const box = { kind: 'part', name: 'Wall', R: I3, o: [I(x0), 0, I(z0)], size: [I(x1 - x0), I(96), I(z1 - z0)], shape: null, thickness: 0, grain: 'none', mat: null, simplified: false } as IRPart;
  return { kind: 'native', name: 'Wall', R: I3, o: box.o, size: box.size, generator: { type: 'wall', params: {} }, fallback: box };
}
/** A box standing on the floor over a plan rectangle (a cabinet or a countertop's stand-in). */
const thing = (x0: number, x1: number, z0: number, z1: number, y0 = 0, y1 = 34) =>
  ({ kind: 'part', name: 'Thing', R: I3, o: [I(x0), I(y0), I(z0)], size: [I(x1 - x0), I(y1 - y0), I(z1 - z0)], shape: null, thickness: 0, grain: 'none', mat: null, simplified: false }) as IRPart;

/** A 200" × 150" house inside, 6" outside walls, a 4" wall across it at x 100 (`gap`: open from z this far on). */
function house(gap?: number): IRNative[] {
  return [wall(-6, 206, -6, 0), wall(-6, 206, 150, 156), wall(-6, 0, 0, 150), wall(200, 206, 0, 150), wall(100, 104, 0, gap ?? 150)];
}

describe('recognizing rooms in a SketchUp import', () => {
  it('makes each space the walls close in a room, walls off, the floor running under its walls', () => {
    const counter = thing(150, 190, 120, 150, 34, 36);
    const rooms = recognizeRooms(house(), [{ ...wall(150, 190, 126, 150), size: [I(40), I(34), I(24)] }], [counter]);
    // Biggest first; the one with the countertop is the kitchen.
    expect(rooms.map((r) => r.name)).toEqual(['Room 1', 'Kitchen']);
    const [room, kitchen] = rooms;
    expect(kitchen!.params).toMatchObject({ left: I(104), right: I(200), back: 0, front: I(150), height: I(96), walls: [], openings: [], baseboard: null });
    expect(room!.params).toMatchObject({ left: 0, right: I(100), back: 0, front: I(150) });
    // Under the outside walls all the way, under the wall between them halfway.
    const strips = room!.params.annexes.filter((a) => a.underWall);
    expect(strips).toEqual(
      expect.arrayContaining([
        { left: -I(6), right: 0, back: 0, front: I(150), underWall: true },
        { left: I(100), right: I(102), back: 0, front: I(150), underWall: true },
        { left: 0, right: I(100), back: -I(6), front: 0, underWall: true },
        { left: 0, right: I(100), back: I(150), front: I(156), underWall: true },
      ]),
    );
    expect(kitchen!.params.annexes).toContainEqual({ left: I(102), right: I(104), back: 0, front: I(150), underWall: true });
  });

  it('keeps an L-shaped space one room: its biggest rectangle, and annexes for the rest', () => {
    const rooms = recognizeRooms(house(100), [], []);
    expect(rooms).toHaveLength(1);
    const p = rooms[0]!.params;
    expect([p.left, p.right, p.back, p.front]).toEqual([0, I(100), 0, I(150)]);
    const legs = p.annexes.filter((a) => !a.underWall);
    expect(legs).toEqual([{ left: I(104), right: I(200), back: 0, front: I(150) }, { left: I(100), right: I(104), back: I(100), front: I(150) }]);
  });

  it('closes walls that nearly meet, and leaves out spaces too small to be rooms', () => {
    // The right wall stops 1/8" short of the back one; a 6" chase between two walls.
    const walls = [...house().slice(0, 3), wall(200, 206, 0.125, 150), wall(40, 46, 0, 150), wall(52, 58, 0, 150)];
    const names = recognizeRooms(walls, [], []).map((r) => r.name);
    expect(names).toEqual(['Room 1', 'Room 2']);
  });

  it('adds the rooms at the top level with an import, and the plan names them with their areas', () => {
    const node = (x0: number, x1: number, z0: number, z1: number): ColladaNode => {
      const [a, b, c, d] = [I(x0), I(x1), I(z0), I(z1)];
      const h = I(96);
      const q = (p: number[], r: number[], s: number[], t: number[]) => [...p, ...r, ...s, ...p, ...s, ...t];
      const tris = [
        ...q([a, 0, c], [b, 0, c], [b, h, c], [a, h, c]), ...q([a, 0, d], [a, h, d], [b, h, d], [b, 0, d]),
        ...q([a, 0, c], [a, 0, d], [b, 0, d], [b, 0, c]), ...q([a, h, c], [b, h, c], [b, h, d], [a, h, d]),
        ...q([a, 0, c], [a, h, c], [a, h, d], [a, 0, d]), ...q([b, 0, c], [b, 0, d], [b, h, d], [b, h, c]),
      ];
      return { name: 'Component#1', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], meshes: [{ tris, material: null }], children: [] };
    };
    const scene = { inches: 1 / 64, up: 'Y' as const, nodes: [node(-6, 206, -6, 0), node(-6, 206, 150, 156), node(-6, 0, 0, 150), node(200, 206, 0, 150), node(100, 104, 0, 150)] };
    const { doc, summary } = importSketchUp(emptyDoc(), scene, 'House', { recognize: true });
    expect(summary.recognized).toMatchObject({ walls: 5, rooms: 2 });
    const rooms = Object.values(doc.assemblies).filter((a) => a.generator?.type === 'room');
    expect(rooms.map((r) => r.name)).toEqual(['Room 1', 'Room 2']);
    expect(rooms.every((r) => doc.roots.includes(r.id) && r.transform.position.every((v) => v === 0))).toBe(true);
    // Floors and ceilings: a room's own and the strips under its walls; the cutaway takes each ceiling away on its own.
    const shell = roomShell(doc);
    expect(shell.ceilings.length).toBeGreaterThanOrEqual(2 * 5);
    const plan = floorPlan(doc);
    // Inside the walls only: the strips under them aren't the room's.
    expect(plan.rooms.map((r) => [r.name, Math.round(r.area / (I(12) * I(12)))])).toEqual([['Room 1', 104], ['Room 2', 100]]);
    // Into a model that isn't empty, the rooms move with the rest of the import.
    const beside = importSketchUp(doc, scene, 'Again', { recognize: true });
    const moved = Object.values(beside.doc.assemblies).filter((a) => a.generator?.type === 'room' && !doc.assemblies[a.id]);
    const first = (rooms[0]!.generator!.params as unknown as RoomParams).left;
    expect((moved[0]!.generator!.params as unknown as RoomParams).left).toBeGreaterThan(first + I(200));
  });
});
