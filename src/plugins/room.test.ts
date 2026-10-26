import { describe, expect, it } from 'vitest';
import type { V3 } from '../geometry/types';
import { actionsFor } from '../edit/actions';
import { dragChanges, driveOps, handleDrives } from '../edit/drives';
import { gizmoNodes, targetsOf } from '../edit/gizmo';
import { emptyDoc } from '../model/defaults';
import { sceneLights, surfaceFor } from '../model/look';
import { roomShell } from '../model/room';
import { finishDef } from '../model/finishes';
import { motionBasis, movedAffines } from '../model/motion';
import { applyOps, type Op } from '../model/ops';
import type { Doc, Part } from '../model/schema';
import { inches } from '../model/units';
import { apply, localBox, nodeAffine, transformBox, union, worldBoxes, type Box3 } from '../model/world';
import './index';
import { ROOM_SIDES, WALL_OUTWARD, type RoomParams, type RoomSide } from './generators/room';
import { hingePoint } from './motions/hinge';
import { buildPart } from './pipeline';
import { generators, shapes } from './registry';
import { frameLayout, WINDOW_STYLES, type TrimParams } from './shapes/decor/room';
import { bounds, isWatertight, tagArea, volume } from './testMesh';

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

/** A part of a decor shape, built from its params (defaults filled). */
function piece(type: string, params: Record<string, unknown>): Part {
  return { id: 'p', name: type, grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type, params: shapes.parse(type, params) }, features: [] };
}
const meshOf = (type: string, params: Record<string, unknown>) => buildPart(piece(type, params)).mesh;

const expectBounds = (m: ReturnType<typeof meshOf>, max: V3) => {
  const b = bounds(m);
  b.min.forEach((v) => expect(v).toBeCloseTo(0, 6));
  b.max.forEach((v, k) => expect(v).toBeCloseTo(max[k]!, 6));
};

/** Every tag has a surface of its own (exact or by prefix), and only glass tags look like glass. */
function expectSurfaces(type: string, params: Record<string, unknown>, explicit = true) {
  const parsed = shapes.parse(type, params);
  const map = shapes.get(type).surfaces!(parsed);
  for (const tag of meshOf(type, params).tags) {
    if (explicit) expect(!!map.tags?.[tag] || !!map.prefixes?.some(([p]) => tag.startsWith(p)), `${type} tag ${tag}`).toBe(true);
    expect(finishDef(surfaceFor(map, tag).finish.preset)?.family === 'glass').toBe(tag === 'glass');
  }
}

describe('room pieces (internal decor shapes)', () => {
  it('are internal decor, hidden from the AI; trim is not solid', () => {
    for (const type of ['wall', 'slab', 'trim', 'window', 'doorLeaf']) expect(shapes.get(type).decor).toMatchObject({ category: 'room', internal: true });
    expect(shapes.get('trim').decor!.solid).toBe(false);
    expect(shapes.get('wall').decor!.solid).toBeUndefined();
  });

  describe('wall', () => {
    const wall = (openings: Record<string, unknown>[], size: V3 = [6000, 6144, 288]) => ({ x: size[0], y: size[1], z: size[2], openings });
    const w1 = { id: 'w1', x: 1000, y: 2304, w: 2304, h: 3072 };
    const d1 = { id: 'd1', x: 4000, y: 0, w: 1500, h: 5120 };

    it('is the box less its openings, watertight, with each reveal tagged by the way it faces', () => {
      const m = meshOf('wall', wall([w1, d1]));
      expect(isWatertight(m)).toBe(true);
      expect(volume(m)).toBeCloseTo(6000 * 6144 * 288 - (2304 * 3072 + 1500 * 5120) * 288, -3);
      expectBounds(m, [6000, 6144, 288]);
      expect(m.tags).toEqual(expect.arrayContaining(['face:front', 'face:back', 'w1:jamb-left', 'w1:jamb-right', 'w1:head', 'w1:sill', 'd1:jamb-left', 'd1:jamb-right', 'd1:head']));
      // A door starts at the floor: no sill.
      expect(m.tags).not.toContain('d1:sill');
      expect(tagArea(m, 'w1:jamb-left')).toBeCloseTo(3072 * 288);
      expect(tagArea(m, 'w1:sill')).toBeCloseTo(2304 * 288);
      // The left jamb is the wall at the opening's left, facing into it (+X).
      const g = buildPart(piece('wall', wall([w1]))).geom;
      expect(g.faces.find((f) => f.tag === 'w1:jamb-left')!.origin[0]).toBe(1000);
      expect(g.faces.find((f) => f.tag === 'w1:jamb-left')!.normal).toEqual([1, 0, 0]);
      expect(g.faces.find((f) => f.tag === 'w1:head')!.normal).toEqual([0, -1, 0]);
    });

    it('refuses openings that overlap, run off it, or leave no wall above', () => {
      const build = (openings: Record<string, unknown>[]) => () => buildPart(piece('wall', wall(openings)));
      expect(build([w1, { ...d1, id: 'd2', x: 1500 }])).toThrow(/openings w1 and d2 overlap/);
      expect(build([{ ...w1, x: 5000 }])).toThrow(/runs past the ends/);
      expect(build([{ ...d1, h: 6144 }])).toThrow(/leaves no wall above it/);
      expect(build([{ ...w1, y: -10 }])).toThrow(/below the floor/);
    });

    it('has face handles only, and one look', () => {
      const { handles } = buildPart(piece('wall', wall([w1])));
      expect(handles.map((h) => h.kind)).toEqual(Array(6).fill('face'));
      expectSurfaces('wall', wall([w1, d1]), false);
    });
  });

  it('slab: a closed box with box faces', () => {
    const m = meshOf('slab', { x: 9000, y: 96, z: 7000 });
    expect(isWatertight(m)).toBe(true);
    expectBounds(m, [9000, 96, 7000]);
    expect(new Set(m.tags)).toEqual(new Set(['face:left', 'face:right', 'face:bottom', 'face:top', 'face:back', 'face:front']));
    expectSurfaces('slab', { x: 9000, y: 96, z: 7000 }, false);
  });

  describe('trim', () => {
    const frames: TrimParams[] = [
      { style: 'frame', w: I(32), h: I(80), width: I(3), thickness: I(3 / 4), sides: 3, stool: null, apron: null, finish: { preset: 'paint' } },
      { style: 'frame', w: I(36), h: I(48), width: I(3), thickness: I(3 / 4), sides: 4, stool: null, apron: null, finish: { preset: 'paint' } },
      { style: 'frame', w: I(36), h: I(48), width: I(3), thickness: I(3 / 4), sides: 3, stool: { depth: I(1.75), thickness: I(1), horn: I(3 / 4) }, apron: I(3), finish: { preset: 'paint' } },
    ];

    it('runs and frames are closed, sized by their layout, in casing, stool and apron', () => {
      const run = meshOf('trim', { style: 'run', x: 3000, y: 288, z: 32 });
      expect(isWatertight(run)).toBe(true);
      expectBounds(run, [3000, 288, 32]);
      expect(run.tags).toEqual(['trim']);
      for (const f of frames) {
        const m = meshOf('trim', f as unknown as Record<string, unknown>);
        expect(isWatertight(m)).toBe(true);
        expectBounds(m, frameLayout(f as Extract<TrimParams, { style: 'frame' }>).size);
        expectSurfaces('trim', f as unknown as Record<string, unknown>);
      }
      expect(new Set(meshOf('trim', frames[2] as unknown as Record<string, unknown>).tags)).toEqual(new Set(['casing', 'stool', 'apron']));
      // A 3-sided casing leaves the opening open at the bottom: legs + head.
      const door = frameLayout(frames[0] as Extract<TrimParams, { style: 'frame' }>);
      expect(door.size).toEqual([I(32 + 6), I(80 + 3), I(3 / 4)]);
      expect(door.opening).toEqual([I(3), 0]);
    });
  });

  describe('window', () => {
    const cases = WINDOW_STYLES.flatMap((style) => [
      { style, x: I(36), y: I(48), z: I(4.5) },
      { style, x: I(48), y: I(60), z: I(2), grid: [2, 3] },
    ]);
    it.each(cases)('$style ($x × $y, grid $grid) is closed and fills its opening exactly', (params) => {
      const m = meshOf('window', params);
      expect(isWatertight(m)).toBe(true);
      expect(volume(m)).toBeGreaterThan(0);
      expectBounds(m, [params.x, params.y, params.z]);
      expect(m.tags).toEqual(expect.arrayContaining(['frame', 'sash', 'glass']));
      if (params.grid) expect(m.tags).toContain('muntin');
      expectSurfaces('window', params);
    });

    it('pairs wide casements with a mullion', () => {
      const g = buildPart(piece('window', { style: 'casement', x: I(60), y: I(48), z: I(4.5) })).geom;
      expect(g.faces.filter((f) => f.tag === 'glass' && f.normal[2] === 1)).toHaveLength(2);
    });
  });

  describe('door leaf', () => {
    it.each(['slab', 'panel', 'glass'] as const)('%s is closed and its size', (style) => {
      const params = { x: I(31.75), y: I(79.125), z: I(1 + 3 / 8), style };
      const m = meshOf('doorLeaf', params);
      expect(isWatertight(m)).toBe(true);
      expectBounds(m, [params.x, params.y, params.z]);
      expect(m.tags.includes('glass')).toBe(style === 'glass');
      expectSurfaces('doorLeaf', params);
    });

    it('recesses its panels into both faces', () => {
      const params = { x: I(32), y: I(80), z: I(1 + 3 / 8), style: 'panel' };
      const slab = volume(meshOf('doorLeaf', { ...params, style: 'slab' }));
      expect(volume(meshOf('doorLeaf', params))).toBeLessThan(slab);
      expect(meshOf('doorLeaf', params).tags).toContain('panel');
    });
  });
});

// ── the generator ─────────────────────────────────────────────────────────────

const ROOM = { left: 0, right: I(144), back: 0, front: I(120) };
const T = I(4.5);
const addRoom = (params: Record<string, unknown>): Op => ({ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { ...ROOM, ...params } } } });
const roomDoc = (params: Record<string, unknown> = {}) => ok(emptyDoc(), [addRoom(params)]);
const paramsOf = (d: Doc) => d.assemblies.room!.generator!.params as unknown as RoomParams;
const meets = (a: Box3, b: Box3) => [0, 1, 2].every((k) => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) > 0);
const area = (b: Box3) => (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);

describe('the room generator', () => {
  it('fills in defaults and ids, and is surroundings that collapse with locked parts', () => {
    const def = generators.get('room');
    expect([def.surroundings, def.collapse, def.lockedParts]).toEqual([true, true, true]);
    expect(def.materialRefs({})).toEqual([]);
    const p = paramsOf(roomDoc({ openings: [{ kind: 'window', wall: 'back', at: I(72), width: I(36), height: I(48) }, { kind: 'door', wall: 'left', at: I(60), width: I(32), height: I(80) }, { kind: 'window', wall: 'front', at: I(72), width: I(36), height: I(48) }] }));
    expect(p).toMatchObject({ height: I(96), wallThickness: T, walls: ['back', 'left', 'right', 'front'], floor: true, ceiling: true, baseboard: { height: I(4.5), thickness: I(0.5) } });
    expect(p.openings.map((o) => o.id)).toEqual(['w1', 'd1', 'w2']);
    expect(p.openings[0]).toMatchObject({ sill: I(36), style: 'double-hung', stool: true, casing: true });
    expect(p.openings[1]).toMatchObject({ leaf: 'panel', hinge: 'left', swing: 'in', angle: 90, handle: 'lever' });
    expect(p.finishes.walls).toEqual({ preset: 'paint', color: '#ece8df' });
  });

  it('places the walls exactly for every set of walls: corners covered once, nothing overlapping', () => {
    for (let mask = 0; mask < 16; mask++) {
      const walls = ROOM_SIDES.filter((_, i) => mask & (1 << i));
      const d = roomDoc({ walls });
      const boxes = worldBoxes(d);
      const t = (s: RoomSide) => (walls.includes(s) ? T : 0);
      const neg = (s: RoomSide) => (walls.includes(s) ? -T : 0);
      const wallBoxes = walls.map((s) => boxes.get(`room.wall-${s}`)!);
      const expected: Record<RoomSide, Box3> = {
        back: { min: [neg('left'), 0, -T], max: [I(144) + t('right'), I(96), 0] },
        front: { min: [neg('left'), 0, I(120)], max: [I(144) + t('right'), I(96), I(120) + T] },
        left: { min: [-T, 0, 0], max: [0, I(96), I(120)] },
        right: { min: [I(144), 0, 0], max: [I(144) + T, I(96), I(120)] },
      };
      walls.forEach((s, i) => expect(wallBoxes[i], `${walls.join(',')}: ${s}`).toEqual(expected[s]));
      for (let i = 0; i < wallBoxes.length; i++) for (let j = i + 1; j < wallBoxes.length; j++) expect(meets(wallBoxes[i]!, wallBoxes[j]!)).toBe(false);
      // The walls are exactly the ring between the inside and the outside footprint.
      const outer = (I(144) + t('left') + t('right')) * (I(120) + t('back') + t('front'));
      expect(wallBoxes.reduce((s, b) => s + area(b), 0)).toBe(outer - I(144) * I(120));
      expect(boxes.get('room.floor')).toEqual({ min: [neg('left'), -I(1.5), neg('back')], max: [I(144) + t('right'), 0, I(120) + t('front')] });
      expect(boxes.get('room.ceiling')!.min[1]).toBe(I(96));
    }
  });

  it('puts an opening where its `at` says on every wall, flush with the inside face', () => {
    const at: Record<RoomSide, number> = { back: I(40), left: I(30), right: I(80), front: I(100) };
    const d = roomDoc({ openings: ROOM_SIDES.map((wall) => ({ kind: 'window', id: `w-${wall}`, wall, at: at[wall], width: I(36), height: I(48) })) });
    const boxes = worldBoxes(d);
    for (const wall of ROOM_SIDES) {
      const b = boxes.get(`room.window-w-${wall}`)!;
      const k = wall === 'back' || wall === 'front' ? 0 : 2;
      expect([b.min[k], b.max[k]], wall).toEqual([at[wall] - I(18), at[wall] + I(18)]);
      expect([b.min[1], b.max[1]]).toEqual([I(36), I(84)]);
      // Its room face is the wall's inside face.
      const inside = { back: b.max[2], front: b.min[2], left: b.max[0], right: b.min[0] }[wall];
      expect(inside).toBe({ back: 0, front: I(120), left: 0, right: I(144) }[wall]);
      // The wall has the hole at the matching wall-local spot.
      const wp = d.parts[`room.wall-${wall}`]!.shape.params as { openings: { id: string; x: number }[] };
      const hole = wp.openings.find((o) => o.id === `w-${wall}`)!;
      const box = boxes.get(`room.wall-${wall}`)!;
      const start = { back: box.min[0], left: I(120), right: 0, front: box.max[0] }[wall];
      expect(Math.abs(start - (at[wall] + (wall === 'back' || wall === 'right' ? -1 : 1) * I(18)))).toBe(hole.x);
    }
  });

  it('hangs each door in a folder in its wall that swings in on the hinge side seen from inside', () => {
    for (const wall of ROOM_SIDES) {
      for (const hinge of ['left', 'right'] as const) {
        for (const swing of ['in', 'out'] as const) {
          const at = wall === 'back' || wall === 'front' ? I(72) : I(60);
          const d = roomDoc({ openings: [{ kind: 'door', wall, at, width: I(32), height: I(80), hinge, swing }] });
          const folder = d.assemblies['room.door-d1']!;
          expect(folder.children).toEqual(['room.door-d1-leaf', 'room.door-d1-handle']);
          expect(folder.transform).toEqual({ position: d.parts[`room.wall-${wall}`]!.transform.position, rotation: d.parts[`room.wall-${wall}`]!.transform.rotation });
          const m = d.motions['room.motion.door-d1']!;
          expect(m).toMatchObject({ nodes: ['room.door-d1'], params: { side: hinge, toward: swing === 'in' ? 'front' : 'back', angle: 90 } });
          // Open, the leaf stands out of the wall on the hinge side, into (or out of) the room.
          const leaf = 'room.door-d1-leaf';
          const open = transformBox(movedAffines(d, m, 1).get(leaf)!, localBox(d, leaf));
          const closed = worldBoxes(d).get(leaf)!;
          const mid = (b: Box3) => [0, 1, 2].map((k) => (b.min[k]! + b.max[k]!) / 2) as V3;
          const [o, c] = [mid(open), mid(closed)];
          const out = WALL_OUTWARD[wall];
          const along: V3 = { back: [1, 0, 0], left: [0, 0, -1], right: [0, 0, 1], front: [-1, 0, 0] }[wall] as V3;
          const dot = (v: V3, u: V3) => v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
          const moved: V3 = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
          expect(dot(moved, out) * (swing === 'in' ? -1 : 1), `${wall} ${hinge} ${swing}`).toBeGreaterThan(I(12));
          expect(dot(moved, along) * (hinge === 'left' ? -1 : 1), `${wall} ${hinge} ${swing}`).toBeGreaterThan(I(12));
          // The hinge line is at the leaf's edge on the hinge side.
          const pivot = apply(nodeAffine(d, 'room.door-d1'), hingePoint(motionBasis(d, m), hinge, swing === 'in' ? 'front' : 'back'));
          const opening = { lo: at - I(16), hi: at + I(16) };
          const pAlong = dot(pivot, along);
          const end = dot(along, [1, 0, 1]) > 0 ? (hinge === 'left' ? opening.lo : opening.hi) : hinge === 'left' ? -opening.hi : -opening.lo;
          expect(Math.abs(pAlong - end)).toBeLessThanOrEqual(I(1 / 8));
        }
      }
    }
  });

  it('puts the handle at the latch edge on both faces, the lever pointing to the hinge', () => {
    const d = roomDoc({ openings: [{ kind: 'door', wall: 'back', at: I(72), width: I(32), height: I(80), hinge: 'left' }] });
    const boxes = worldBoxes(d);
    const leaf = boxes.get('room.door-d1-leaf')!;
    const handle = boxes.get('room.door-d1-handle')!;
    // Latch on the right (+x on the back wall), both faces, about 36" up.
    expect(handle.max[0]).toBeLessThan(leaf.max[0]);
    expect(handle.min[0]).toBeGreaterThan(leaf.min[0] + I(10));
    expect(handle.min[2]).toBeLessThan(leaf.min[2]);
    expect(handle.max[2]).toBeGreaterThan(leaf.max[2]);
    expect((handle.min[1] + handle.max[1]) / 2).toBeCloseTo(I(36), -1);
    // A cased opening (leaf none) has no folder, leaf or motion, just its casing.
    const cased = roomDoc({ openings: [{ kind: 'door', wall: 'back', at: I(72), width: I(32), height: I(80), leaf: 'none' }] });
    expect(cased.assemblies['room.door-d1']).toBeUndefined();
    expect(Object.keys(cased.motions)).toEqual([]);
    expect(cased.parts['room.casing-d1']).toBeDefined();
  });

  it('breaks baseboards at doors and floor-level openings; side runs butt into the back and front runs', () => {
    const d = roomDoc({ openings: [{ kind: 'door', wall: 'back', at: I(72), width: I(32), height: I(80) }, { kind: 'window', wall: 'back', at: I(30), width: I(24), height: I(36) }] });
    const boxes = worldBoxes(d);
    const runs = Object.keys(d.parts).filter((id) => id.startsWith('room.baseboard-back-')).map((id) => boxes.get(id)!);
    expect(runs.map((b) => [b.min[0], b.max[0]])).toEqual([[0, I(72 - 16 - 3)], [I(72 + 16 + 3), I(144)]]);
    expect(runs.every((b) => b.min[2] === 0 && b.max[2] === I(0.5) && b.max[1] === I(4.5))).toBe(true);
    const left = boxes.get('room.baseboard-left-1')!;
    expect([left.min[2], left.max[2]]).toEqual([I(0.5), I(120 - 0.5)]);
    expect(d.parts['room.baseboard-back-1']!.unclickable).toBe(true);
    expect(d.parts['room.floor']!.unclickable).toBe(true);
    expect(d.parts['room.wall-back']!.unclickable).toBeUndefined();
    expect(d.parts['room.window-w1']!.unclickable).toBeUndefined();
    // No baseboard at all.
    expect(Object.keys(roomDoc({ baseboard: null }).parts).some((id) => id.includes('baseboard'))).toBe(false);
  });

  it('keeps openings on walls that are off, without building them', () => {
    const d = roomDoc({ walls: ['back', 'left'], openings: [{ kind: 'window', wall: 'front', at: I(72), width: I(36), height: I(48) }] });
    expect(paramsOf(d).openings).toHaveLength(1);
    expect(d.parts['room.window-w1']).toBeUndefined();
  });

  it('explains what doesn’t fit', () => {
    const win = (o: Record<string, unknown>) => ({ kind: 'window', wall: 'back', width: I(36), height: I(48), ...o });
    expect(fails(emptyDoc(), [addRoom({ right: I(168), openings: [win({ at: I(160) })] })])).toContain('openings[w1]: a 36" window centered at 160" runs 10" past the right wall');
    expect(fails(emptyDoc(), [addRoom({ openings: [win({ wall: 'left', at: I(10) })] })])).toContain('runs 8" past the back wall');
    expect(fails(emptyDoc(), [addRoom({ openings: [win({ at: I(40) }), win({ at: I(60) })] })])).toContain('openings[w2]: it overlaps window w1 on the back wall');
    expect(fails(emptyDoc(), [addRoom({ openings: [win({ at: I(40), sill: I(50) })] })])).toContain('openings[w1]: its top at 98" leaves less than 1" of wall under the 96" ceiling');
    expect(fails(emptyDoc(), [addRoom({ openings: [win({ at: I(40), id: 'a' }), win({ at: I(100), id: 'a' })] })])).toContain('two openings are both a');
    expect(fails(emptyDoc(), [addRoom({ right: I(30) })])).toContain('the room is 30" wide inside');
    expect(fails(emptyDoc(), [addRoom({ walls: ['back', 'back'] })])).toContain('list each wall once');
    expect(fails(emptyDoc(), [addRoom({ openings: [win({ at: I(40), id: 'w.1' })] })])).toMatch(/opening ids/);
    // Stacked windows on one wall are fine.
    expect(paramsOf(roomDoc({ openings: [win({ at: I(40), sill: I(4), height: I(24) }), win({ at: I(40), sill: I(40), height: I(24) })] })).openings).toHaveLength(2);
  });

  it('moves a wall by pushing its inside face, through the real drive path, leaving the openings where they are', () => {
    const d = roomDoc({ openings: [{ kind: 'window', wall: 'back', at: I(72), width: I(36), height: I(48) }, { kind: 'window', wall: 'left', at: I(60), width: I(36), height: I(48) }] });
    const before = worldBoxes(d);
    const hd = handleDrives(d, { node: 'room.wall-left', handle: 'face:front' })!;
    expect(hd.drives).toMatchObject([{ owner: { kind: 'generator', asm: 'room' }, path: 'left', kind: 'position' }]);
    // Inward is the face's normal, local +Z.
    const ops = driveOps(d, 'room.wall-left', dragChanges(hd, [0, 0, I(6)]));
    expect(ops).toEqual([{ op: 'update', id: 'room', patch: { params: { left: I(6) } } }]);
    const after = ok(d, ops);
    const { openings: o1, ...p1 } = paramsOf(after);
    const { openings: o0, ...p0 } = paramsOf(d);
    expect(p1).toEqual({ ...p0, left: I(6) });
    expect(o1).toEqual(o0);
    const boxes = worldBoxes(after);
    // The back wall's window stays put; the left wall's rides with its wall, at the same place along it.
    expect(boxes.get('room.window-w1')).toEqual(before.get('room.window-w1'));
    const [w2, was] = [boxes.get('room.window-w2')!, before.get('room.window-w2')!];
    expect([w2.min[2], w2.max[2], w2.min[0] - was.min[0], w2.max[0] - was.max[0]]).toEqual([was.min[2], was.max[2], I(6), I(6)]);
    expect(boxes.get('room.wall-left')!.max[0]).toBe(I(6));

    // The other faces: right (pull it into the room = smaller), front, the top, the outside, the ceiling; the ends are locked.
    const drive = (node: string, handle: string) => handleDrives(d, { node, handle })!.drives[0];
    expect(drive('room.wall-right', 'face:front')).toMatchObject({ path: 'right', kind: 'position' });
    expect(driveOps(d, 'room.wall-right', dragChanges(handleDrives(d, { node: 'room.wall-right', handle: 'face:front' })!, [0, 0, I(2)]))).toEqual([{ op: 'update', id: 'room', patch: { params: { right: I(142) } } }]);
    expect(drive('room.wall-front', 'face:front')).toMatchObject({ path: 'front', kind: 'position' });
    expect(drive('room.wall-back', 'face:front')).toMatchObject({ path: 'back', kind: 'position' });
    expect(drive('room.wall-back', 'face:top')).toMatchObject({ path: 'height' });
    expect(drive('room.wall-back', 'face:back')).toMatchObject({ path: 'wallThickness' });
    expect(drive('room.ceiling', 'face:bottom')).toMatchObject({ path: 'height' });
    expect(handleDrives(d, { node: 'room.wall-back', handle: 'face:left' })!.drives).toEqual([]);
    expect(handleDrives(d, { node: 'room.window-w1', handle: 'face:front' })!.drives).toEqual([]);
  });

  it('offers to add an opening where a wall was clicked, and to remove one', () => {
    const d = roomDoc({ openings: [{ kind: 'window', wall: 'back', at: I(100), width: I(36), height: I(48) }] });
    // The back wall starts 4 1/2" left of the room (it covers the corner): local x 40 1/2" is room x 36".
    const back = actionsFor(d, [{ node: 'room.wall-back', handle: 'face:front', at: [I(40.5) + 9, I(50), T] }]);
    expect(back.map((a) => a.label)).toEqual(['Add window here', 'Add door here', 'Add opening here']);
    const added = ok(d, back[0]!.run({}));
    expect(paramsOf(added).openings[1]).toMatchObject({ id: 'w2', kind: 'window', wall: 'back', at: I(36), width: I(36), height: I(48), sill: I(36) });
    const door = ok(d, back[1]!.run({}));
    expect(paramsOf(door).openings[1]).toMatchObject({ id: 'd1', kind: 'door', at: I(36), width: I(32), height: I(80) });
    // On the left wall local x runs from the front: x 20" is z 100"; near a corner it slides along to fit.
    const left = actionsFor(d, [{ node: 'room.wall-left', handle: 'face:back', at: [I(20), I(50), 0] }]);
    expect(paramsOf(ok(d, left[2]!.run({}))).openings[1]).toMatchObject({ kind: 'opening', wall: 'left', at: I(100), width: I(36), height: I(80), sill: 0 });
    const corner = actionsFor(d, [{ node: 'room.wall-left', handle: 'face:front', at: [I(2), I(50), T] }]);
    expect(paramsOf(ok(d, corner[0]!.run({}))).openings[1]).toMatchObject({ wall: 'left', at: I(120 - 18) });
    // Not on a top face, nor without a point.
    expect(actionsFor(d, [{ node: 'room.wall-back', handle: 'face:top', at: [100, I(96), 100] }]).map((a) => a.label)).toEqual([]);
    // Remove: from a reveal of its hole, the window itself, or its casing.
    for (const t of [{ node: 'room.wall-back', handle: 'w1:jamb-left' }, { node: 'room.window-w1' }, { node: 'room.window-w1', handle: 'face:front' }]) {
      const remove = actionsFor(d, [t]).find((a) => a.label === 'Remove window w1');
      expect(remove, JSON.stringify(t)).toBeDefined();
      expect(paramsOf(ok(d, remove!.run({}))).openings).toEqual([]);
    }
  });

  it('stays put: the gizmo leaves the room, its parts and its door folders alone', () => {
    const d = roomDoc({ openings: [{ kind: 'door', wall: 'back', at: I(72), width: I(32), height: I(80) }] });
    expect(gizmoNodes(d, [{ node: 'room.wall-back' }])).toBeNull();
    expect(gizmoNodes(d, targetsOf(d, ['room']))).toBeNull();
    expect(gizmoNodes(d, targetsOf(d, ['room.door-d1']))).toBeNull();
  });

  it('draws within its slabs: the floor top at y = 0, under the walls', () => {
    const d = roomDoc();
    const all = union([...worldBoxes(d).values()]);
    expect(all.min[1]).toBe(-I(1.5));
    expect(worldBoxes(d).get('room.floor')!.max[1]).toBe(0);
  });
});

describe('room annexes (an imported house)', () => {
  it('lays more floor and ceiling over its annexes; pushing any ceiling still sets the height', () => {
    const annex = { left: I(144), right: I(200), back: 0, front: I(60) };
    const d = roomDoc({ walls: [], baseboard: null, annexes: [annex, { left: -I(6), right: 0, back: 0, front: I(120), underWall: true }] });
    const boxes = worldBoxes(d);
    expect(boxes.get('room.floor-annex-1')).toEqual({ min: [I(144), -I(1.5), 0], max: [I(200), 0, I(60)] });
    expect(boxes.get('room.ceiling-annex-1')).toEqual({ min: [I(144), I(96), 0], max: [I(200), I(97.5), I(60)] });
    expect(boxes.get('room.floor-annex-2')!.min[0]).toBe(-I(6));
    // No walls of its own, so no baseboards or wall parts.
    expect(Object.keys(d.parts).filter((id) => /wall|baseboard/.test(id))).toEqual([]);
    const shell = roomShell(d);
    expect(shell.floors).toEqual(['room.floor', 'room.floor-annex-1', 'room.floor-annex-2']);
    expect(shell.ceilings.map((c) => c.min)).toEqual([[0, 0], [I(144), 0], [-I(6), 0]]);
    const hd = handleDrives(d, { node: 'room.ceiling-annex-1', handle: 'face:bottom' })!;
    expect(driveOps(d, 'room.ceiling-annex-1', dragChanges(hd, [0, I(12), 0]))).toEqual([{ op: 'update', id: 'room', patch: { params: { height: I(108) } } }]);
    expect(fails(emptyDoc(), [addRoom({ annexes: [{ left: I(10), right: I(5), back: 0, front: I(10) }] })])).toMatch(/an annex is \{left, right, back, front\}/);
  });
});

describe('recessed cans (phase 7)', () => {
  it('are off by default, and an even grid of unclickable lights under the ceiling when set', () => {
    expect(paramsOf(roomDoc()).cans).toBeNull();
    expect(Object.keys(roomDoc().parts).some((id) => id.startsWith('room.can-'))).toBe(false);
    const d = roomDoc({ cans: { rows: 2, cols: 3 } });
    expect(paramsOf(d).cans).toEqual({ rows: 2, cols: 3, diameter: I(4) });
    const cans = Object.values(d.parts).filter((p) => p.role?.startsWith('can-'));
    expect(cans.map((p) => p.role)).toEqual(['can-1-1', 'can-1-2', 'can-1-3', 'can-2-1', 'can-2-2', 'can-2-3']);
    const boxes = worldBoxes(d);
    for (const can of cans) {
      expect(can).toMatchObject({ unclickable: true, shape: { type: 'recessedLight' } });
      // Flush under the ceiling, inside the room.
      expect(boxes.get(can.id)!.max[1]).toBe(I(96));
    }
    // Centered in their cells: x at 1/6, 1/2, 5/6 of the 144" room, z at 1/4 and 3/4 of its 120".
    const center = (id: string) => {
      const b = boxes.get(id)!;
      return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    };
    expect(center('room.can-1-1')).toEqual([I(24), I(30)]);
    expect(center('room.can-2-3')).toEqual([I(120), I(90)]);
    // They light the scene, and go with the ceiling when it's cut away.
    const lights = sceneLights(d).filter((l) => l.part.startsWith('room.can-'));
    expect(lights).toHaveLength(6);
    expect(lights[0]!.spec).toMatchObject({ kind: 'spot', lumens: 650, kelvin: 3000, beam: 60 });
    // Full params (generated parts aren't parsed), so the looks have their trim.
    expect(cans[0]!.shape.params).toEqual(shapes.parse('recessedLight', { diameter: I(4) }));
    expect(roomShell(d).ceilings[0]!.ids).toEqual(['room.ceiling', ...cans.map((c) => c.id)]);
    // No ceiling, no cans.
    expect(Object.values(roomDoc({ cans: { rows: 2, cols: 2 }, ceiling: false }).parts).some((p) => p.role?.startsWith('can-'))).toBe(false);
  });
});
