import type { V3 } from '../geometry/types';
import { inches } from '../model/units';
import type { RoomAnnex, RoomParams } from '../plugins/generators/room';
import { partCorners } from './recognizeWalls';
import type { IRNative, IRPart } from './sketchupImport';

/**
 * The rooms of an imported floor plan: each space its walls close in becomes one of the app's
 * rooms, walls off (the wall pieces are its walls), so it brings its floor, ceiling, name and
 * lighting. Seen from above, the walls' footprints (edges within 1" taken as one, so walls that
 * nearly meet close) cut the plan into cells; cells that don't reach the outside make spaces, each
 * one room: its biggest rectangle, plus annexes for the rest of an L- or T-shaped space. One with
 * a countertop is the kitchen, one under 40 sq ft without cabinets a closet. World coordinates,
 * model units.
 */

const I = inches;
/** Wall edges this close are one. */
const SNAP = I(1);
/** Spaces smaller than this (a gap between walls, a chase) aren't rooms. */
const MIN_AREA = I(12) * I(12) * 12;
/** A room's main rectangle is at least this wide and deep (the room generator's minimum). */
const MIN_SIDE = I(36);
const CLOSET = I(12) * I(12) * 40;

export interface RoomFound {
  name: string;
  params: Pick<RoomParams, 'left' | 'right' | 'back' | 'front' | 'height' | 'walls' | 'openings' | 'baseboard'> & { annexes: RoomAnnex[] };
}

/** Values within `SNAP` of their neighbors as one (the middle of each run). */
function snapper(values: number[]): (v: number) => number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const rep = new Map<number, number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]! - sorted[j]! <= SNAP) j++;
    const mid = Math.round((sorted[i]! + sorted[j]!) / 2);
    for (let k = i; k <= j; k++) rep.set(sorted[k]!, mid);
    i = j + 1;
  }
  return (v) => rep.get(v) ?? v;
}

/** Rectangles covering the true cells, biggest first (cell index ranges, inclusive). */
function rectangles(open: boolean[][], xs: number[], zs: number[]): [number, number, number, number][] {
  const left = open.map((col) => [...col]);
  const out: [number, number, number, number][] = [];
  for (;;) {
    let best: [number, number, number, number] | null = null;
    let bestArea = 0;
    for (let i0 = 0; i0 < left.length; i0++) {
      const run = left[0]!.map(() => true);
      for (let i1 = i0; i1 < left.length; i1++) {
        for (let j = 0; j < run.length; j++) run[j] = run[j]! && left[i1]![j]!;
        const w = xs[i1 + 1]! - xs[i0]!;
        for (let j0 = 0; j0 < run.length; j0++) {
          if (!run[j0]) continue;
          let j1 = j0;
          while (j1 + 1 < run.length && run[j1 + 1]) j1++;
          const area = w * (zs[j1 + 1]! - zs[j0]!);
          if (area > bestArea) [best, bestArea] = [[i0, i1, j0, j1], area];
          j0 = j1;
        }
      }
    }
    if (!best) return out;
    out.push(best);
    for (let i = best[0]; i <= best[1]; i++) for (let j = best[2]; j <= best[3]; j++) left[i]![j] = false;
  }
}

/** The space a point is in (0: outdoors, −1: in a wall or off the plan). */
function labelAt(label: number[][], xs: number[], zs: number[], x: number, z: number): number {
  const i = xs.findIndex((v, k) => k + 1 < xs.length && x > v && x < xs[k + 1]!);
  const j = zs.findIndex((v, k) => k + 1 < zs.length && z > v && z < zs[k + 1]!);
  return i < 0 || j < 0 ? 0 : label[i]![j]!;
}

/**
 * Floor (and ceiling) under the walls along a rectangle's edges, so none shows a gap when the
 * cutaway takes the wall away: to the middle of a wall between two rooms, all the way under an
 * outside one. `beyond` says which space a point is in (0: outdoors).
 */
function underWalls(r: RoomAnnex, walls: [number, number, number, number][], beyond: (x: number, z: number) => number): RoomAnnex[] {
  const out: RoomAnnex[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  for (const [x0, x1, z0, z1] of walls) {
    const [s0, s1] = [Math.max(r.back, z0), Math.min(r.front, z1)];
    const [t0, t1] = [Math.max(r.left, x0), Math.min(r.right, x1)];
    const depth = (t: number, outside: boolean) => (outside ? t : Math.floor(t / 2));
    if (s1 - s0 > 0 && near(x1, r.left)) out.push({ left: r.left - depth(x1 - x0, beyond(x0 - 2, (s0 + s1) / 2) === 0), right: r.left, back: s0, front: s1 });
    if (s1 - s0 > 0 && near(x0, r.right)) out.push({ left: r.right, right: r.right + depth(x1 - x0, beyond(x1 + 2, (s0 + s1) / 2) === 0), back: s0, front: s1 });
    if (t1 - t0 > 0 && near(z1, r.back)) out.push({ left: t0, right: t1, back: r.back - depth(z1 - z0, beyond((t0 + t1) / 2, z0 - 2) === 0), front: r.back });
    if (t1 - t0 > 0 && near(z0, r.front)) out.push({ left: t0, right: t1, back: r.front, front: r.front + depth(z1 - z0, beyond((t0 + t1) / 2, z1 + 2) === 0) });
  }
  return out.filter((a) => a.right > a.left && a.front > a.back).map((a) => ({ ...a, underWall: true as const }));
}

const centerOf = (p: Pick<IRPart, 'R' | 'o' | 'size'>): V3 => {
  const pts = partCorners(p);
  return [0, 1, 2].map((k) => (Math.min(...pts.map((q) => q[k]!)) + Math.max(...pts.map((q) => q[k]!))) / 2) as V3;
};

/** The rooms its walls close in, biggest first. */
export function recognizeRooms(walls: IRNative[], cabinets: IRNative[], counters: IRPart[]): RoomFound[] {
  // Walls square to the plan, by their footprints [x0, x1, z0, z1].
  const prints = walls
    .filter((w) => Math.abs(w.R[0][0]) > 0.999 || Math.abs(w.R[2][0]) > 0.999)
    .map((w) => {
      const pts = partCorners(w);
      return { box: [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[2])), Math.max(...pts.map((p) => p[2]))], height: w.size[1] };
    });
  if (prints.length < 3) return [];
  const sx = snapper(prints.flatMap((p) => [p.box[0]!, p.box[1]!]));
  const sz = snapper(prints.flatMap((p) => [p.box[2]!, p.box[3]!]));
  const boxes = prints.map((p) => [sx(p.box[0]!), sx(p.box[1]!), sz(p.box[2]!), sz(p.box[3]!)] as [number, number, number, number]);
  const pad = I(12);
  const axis = (vals: number[]) => {
    const u = [...new Set(vals)].sort((a, b) => a - b);
    return [u[0]! - pad, ...u, u.at(-1)! + pad];
  };
  const xs = axis(boxes.flatMap((b) => [b[0], b[1]]));
  const zs = axis(boxes.flatMap((b) => [b[2], b[3]]));
  const [nx, nz] = [xs.length - 1, zs.length - 1];
  const blocked = Array.from({ length: nx }, (_, i) =>
    Array.from({ length: nz }, (_, j) => {
      const [cx, cz] = [(xs[i]! + xs[i + 1]!) / 2, (zs[j]! + zs[j + 1]!) / 2];
      return boxes.some((b) => cx > b[0] && cx < b[1] && cz > b[2] && cz < b[3]);
    }),
  );
  // What reaches the edge is outdoors; what's left, in pieces that touch, is the rooms.
  const label = Array.from({ length: nx }, () => new Array<number>(nz).fill(-1));
  const fill = (si: number, sj: number, id: number) => {
    const stack: [number, number][] = [[si, sj]];
    label[si]![sj] = id;
    while (stack.length) {
      const [i, j] = stack.pop()!;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]] as const) {
        if (a < 0 || b < 0 || a >= nx || b >= nz || blocked[a]![b] || label[a]![b] !== -1) continue;
        label[a]![b] = id;
        stack.push([a, b]);
      }
    }
  };
  for (let i = 0; i < nx; i++) for (const j of [0, nz - 1]) if (!blocked[i]![j] && label[i]![j] === -1) fill(i, j, 0);
  for (let j = 0; j < nz; j++) for (const i of [0, nx - 1]) if (!blocked[i]![j] && label[i]![j] === -1) fill(i, j, 0);
  let spaces = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) if (!blocked[i]![j] && label[i]![j] === -1) fill(i, j, ++spaces);

  const height = Math.max(...prints.map((p) => p.height));
  const found: (RoomFound & { area: number; kitchen: boolean; cabinets: number })[] = [];
  for (let s = 1; s <= spaces; s++) {
    const open = label.map((col) => col.map((l) => l === s));
    const rects = rectangles(open, xs, zs).map(([i0, i1, j0, j1]) => ({ left: xs[i0]!, right: xs[i1 + 1]!, back: zs[j0]!, front: zs[j1 + 1]! }));
    const area = rects.reduce((sum, r) => sum + (r.right - r.left) * (r.front - r.back), 0);
    const [main, ...annexes] = rects;
    if (!main || area < MIN_AREA || main.right - main.left < MIN_SIDE || main.front - main.back < MIN_SIDE) continue;
    const inside = (c: V3) => rects.some((r) => c[0] > r.left && c[0] < r.right && c[2] > r.back && c[2] < r.front);
    found.push({
      name: '',
      area,
      kitchen: counters.some((p) => inside(centerOf(p))),
      cabinets: cabinets.filter((c) => inside(centerOf(c))).length,
      params: { ...main, height, walls: [], openings: [], baseboard: null, annexes: [...annexes, ...rects.flatMap((r) => underWalls(r, boxes, (x, z) => labelAt(label, xs, zs, x, z)))] },
    });
  }
  found.sort((a, b) => b.area - a.area);
  const counts = new Map<string, number>();
  const numbered = (kind: string) => {
    const k = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, k);
    return k === 1 && kind !== 'Room' ? kind : `${kind} ${k}`;
  };
  return found.map(({ area, kitchen, cabinets: inCabinets, params }) => ({ name: numbered(kitchen ? 'Kitchen' : area < CLOSET && !inCabinets ? 'Closet' : 'Room'), params }));
}
