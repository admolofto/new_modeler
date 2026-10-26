import type { V2, V3 } from '../geometry/types';
import { inches } from '../model/units';
import type { Mat3 } from '../model/world';
import { HEADER } from '../plugins/generators/room';
import type { WallPieceOpening, WallPieceParams } from '../plugins/generators/wall';
import type { Flat, IRNative, IRPart } from './sketchupImport';

/**
 * Walls in an imported SketchUp model (a floor plan's), as wall pieces: upright boards 72"–240" tall,
 * 2 3/4"–16" thick and longer than twice that. Their openings come from what the model shows: holes
 * and notches cut through the board, and rectangles drawn on either face (a door's outline, a window's;
 * of a pair one inside the other, the inner one — the leaf, not the casing). At the floor that's a door
 * (a cased opening when it's wider than 42"), above it a window. Each wall's front faces its room:
 * the side with another wall beyond it (the other side is outdoors), else the side with more cabinets
 * and things in front of it, else the house's middle. World coordinates, model units.
 */

const I = inches;
const MIN_HEIGHT = I(72);
const MAX_HEIGHT = I(240);
const MIN_THICK = I(2.75);
const MAX_THICK = I(16);
const MIN_LENGTH = I(12);
/** A flat this close to a wall's face is drawn on it. */
const ON_FACE = I(0.75);
/** …and may run this far past the wall's ends and top. */
const OVERHANG = I(1);
/** Openings at least this wide and tall. */
const MIN_OPENING = I(12);
/** A bottom this close to the floor: a door, or a cased opening. */
const AT_FLOOR = I(2);
/** Wider than this at the floor: a cased opening. */
const MAX_DOOR = I(42);
/** How far in front of a wall its room's cabinets and furniture stand. */
const ROOM_STRIP = I(36);
/** How far to look across for the next wall. */
const REACH = I(1200);

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const column = (m: Mat3, k: number): V3 => [m[0][k]!, m[1][k]!, m[2][k]!];
const fromColumns = (a: V3, b: V3, c: V3): Mat3 => [0, 1, 2].map((i) => [a[i]!, b[i]!, c[i]!]) as Mat3;
const UP: V3 = [0, 1, 0];
/** To 1/16". */
const sixteenth = (u: number) => Math.round(u / 4) * 4;

/** An opening's rectangle on a wall: along it from the wall's start (`u`), up from its bottom (`v`). */
interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface WallBox {
  part: IRPart;
  /** World directions along it and across it (one face's normal). */
  along: V3;
  across: V3;
  /** World extents along, across and up. */
  u: [number, number];
  n: [number, number];
  y: [number, number];
  rects: Rect[];
  /** Flats used as its openings' outlines. */
  markers: Flat[];
}

export function partCorners(p: Pick<IRPart, 'R' | 'o' | 'size'>): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const l: V3 = [i & 1 ? p.size[0] : 0, i & 2 ? p.size[1] : 0, i & 4 ? p.size[2] : 0];
    out.push([0, 1, 2].map((r) => p.o[r]! + p.R[r]![0]! * l[0] + p.R[r]![1]! * l[1] + p.R[r]![2]! * l[2]) as V3);
  }
  return out;
}
const extent = (pts: V3[], dir: V3): [number, number] => {
  const ds = pts.map((p) => dot(p, dir));
  return [Math.min(...ds), Math.max(...ds)];
};

/** A board standing up like a wall, or null. */
function wallBox(p: IRPart): WallBox | null {
  if (p.shape?.type !== 'box' && p.shape?.type !== 'outline') return null;
  const cols = [0, 1, 2].map((k) => column(p.R, k));
  const up = cols.findIndex((c) => Math.abs(c[1]) > 0.999);
  if (up < 0) return null;
  const [k1, k2] = [0, 1, 2].filter((k) => k !== up) as [number, number];
  const [ka, kt] = p.size[k1]! >= p.size[k2]! ? [k1, k2] : [k2, k1];
  const [H, L, T] = [p.size[up]!, p.size[ka]!, p.size[kt]!];
  if (H < MIN_HEIGHT || H > MAX_HEIGHT || T < MIN_THICK || T > MAX_THICK || L < Math.max(MIN_LENGTH, 2 * T)) return null;
  // An outline must run through the thickness: its cap is the wall's face.
  if (p.shape.type === 'outline' && (p.shape.params as { axis: string }).axis !== 'xyz'[kt]) return null;
  const pts = partCorners(p);
  const [along, across] = [cols[ka]!, cols[kt]!];
  return { part: p, along, across, u: extent(pts, along), n: extent(pts, across), y: extent(pts, UP), rects: [], markers: [] };
}

function inPolygon(pt: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i]!, poly[j]!];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Where a wall's face outline leaves rectangles uncovered: its holes, and notches up from its bottom
 * (doorways). The outline is cut into cells at every corner's coordinates; uncovered cells that touch
 * make one opening when they fill a rectangle. Notches from the top or at an end aren't openings.
 */
export function outlineGaps(rings: V2[][], L: number, H: number): Rect[] {
  const [outer, ...holes] = rings;
  if (!outer) return [];
  const cuts = (k: 0 | 1, max: number) => [...new Set([0, max, ...rings.flat().map((p) => Math.round(Math.min(max, Math.max(0, p[k]))))])].sort((a, b) => a - b);
  const xs = cuts(0, L);
  const ys = cuts(1, H);
  const open = xs.slice(1).map((x1, i) => ys.slice(1).map((y1, j) => {
    const c: V2 = [(xs[i]! + x1) / 2, (ys[j]! + y1) / 2];
    return !inPolygon(c, outer) || holes.some((h) => inPolygon(c, h));
  }));
  const seen = open.map((col) => col.map(() => false));
  const out: Rect[] = [];
  open.forEach((col, i) =>
    col.forEach((isOpen, j) => {
      if (!isOpen || seen[i]![j]) return;
      const cells: [number, number][] = [];
      const stack: [number, number][] = [[i, j]];
      seen[i]![j] = true;
      while (stack.length) {
        const [a, b] = stack.pop()!;
        cells.push([a, b]);
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const [na, nb] = [a + da, b + db];
          if (open[na]?.[nb] && !seen[na]![nb]) {
            seen[na]![nb] = true;
            stack.push([na, nb]);
          }
        }
      }
      const [ia, ib] = [Math.min(...cells.map((c) => c[0])), Math.max(...cells.map((c) => c[0]))];
      const [ja, jb] = [Math.min(...cells.map((c) => c[1])), Math.max(...cells.map((c) => c[1]))];
      if (cells.length !== (ib - ia + 1) * (jb - ja + 1)) return;
      const r = { u0: xs[ia]!, u1: xs[ib + 1]!, v0: ys[ja]!, v1: ys[jb + 1]! };
      if (r.v1 >= H || r.u0 <= 0 || r.u1 >= L) return;
      out.push(r);
    }),
  );
  return out;
}

/** The rectangle a flat draws on a wall's face, or null when it isn't one of its openings. */
function markerOn(w: WallBox, f: Flat): Rect | null {
  if (Math.abs(dot(f.normal, w.across)) < 0.999) return null;
  const d = dot(f.points[0]!, w.across);
  if (Math.abs(d - w.n[0]) > ON_FACE && Math.abs(d - w.n[1]) > ON_FACE) return null;
  const us = f.points.map((p) => dot(p, w.along) - w.u[0]);
  const vs = f.points.map((p) => p[1] - w.y[0]);
  const [L, H] = [w.u[1] - w.u[0], w.y[1] - w.y[0]];
  const r = { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
  if (r.u0 < -OVERHANG || r.u1 > L + OVERHANG || r.v0 < -OVERHANG || r.v1 > H + OVERHANG) return null;
  const c = { u0: Math.max(0, r.u0), u1: Math.min(L, r.u1), v0: Math.max(0, r.v0), v1: Math.min(H, r.v1) };
  // A full-height patch is paint, not an opening.
  if (c.v1 - c.v0 >= H - I(2) || c.u1 - c.u0 < MIN_OPENING || c.v1 - c.v0 < MIN_OPENING) return null;
  return c;
}

const contains = (a: Rect, b: Rect, tol = I(0.5)) => a.u0 <= b.u0 + tol && a.u1 >= b.u1 - tol && a.v0 <= b.v0 + tol && a.v1 >= b.v1 - tol;
const overlaps = (a: Rect, b: Rect) => a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;

/** One opening per spot: the inner of nested outlines, the first of overlapping ones. */
function distinct(rects: Rect[]): Rect[] {
  const kept: Rect[] = [];
  for (const r of [...rects].sort((a, b) => (a.u1 - a.u0) * (a.v1 - a.v0) - (b.u1 - b.u0) * (b.v1 - b.v0))) {
    if (kept.some((k) => contains(r, k) || overlaps(r, k))) continue;
    kept.push(r);
  }
  return kept.sort((a, b) => a.u0 - b.u0);
}

/** Whether a world box lies across the ray from `from` along `dir` (in plan). */
function crosses(box: { min: V3; max: V3 }, from: V3, dir: V3): boolean {
  let [t0, t1] = [0, REACH];
  for (const k of [0, 2]) {
    if (Math.abs(dir[k]!) < 1e-9) {
      if (from[k]! < box.min[k]! || from[k]! > box.max[k]!) return false;
      continue;
    }
    const [a, b] = [(box.min[k]! - from[k]!) / dir[k]!, (box.max[k]! - from[k]!) / dir[k]!];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

const boxOf = (pts: V3[]) => ({ min: [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]!))) as V3, max: [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]!))) as V3 });

/** +1 when its front is the `across` side, −1 when it's the other. */
function frontSide(w: WallBox, walls: WallBox[], others: { min: V3; max: V3 }[], middle: V3): 1 | -1 {
  const mid = (a: [number, number]) => (a[0] + a[1]) / 2;
  const center = (side: 1 | -1): V3 => {
    const n = side > 0 ? w.n[1] + 1 : w.n[0] - 1;
    return [0, 1, 2].map((k) => w.along[k]! * mid(w.u) + w.across[k]! * n) as V3;
  };
  const beyond = (side: 1 | -1) => {
    const dir = w.across.map((c) => c * side) as V3;
    const from = center(side);
    return walls.some((o) => o !== w && crosses(boxOf(partCorners(o.part)), [from[0], mid(w.y), from[2]], dir));
  };
  const [plus, minus] = [beyond(1), beyond(-1)];
  if (plus !== minus) return plus ? 1 : -1;
  // Indoors both ways (or out): the side its room's things stand on.
  const used = (side: 1 | -1) => {
    const face = side > 0 ? w.n[1] : w.n[0];
    const [n0, n1] = side > 0 ? [face, face + ROOM_STRIP] : [face - ROOM_STRIP, face];
    let v = 0;
    for (const b of others) {
      const pts = [b.min, b.max];
      const [bu, bn] = [extent(pts, w.along), extent(pts, w.across)];
      const du = Math.min(bu[1], w.u[1]) - Math.max(bu[0], w.u[0]);
      const dn = Math.min(bn[1], n1) - Math.max(bn[0], n0);
      const dy = Math.min(b.max[1], w.y[1]) - Math.max(b.min[1], w.y[0]);
      if (du > 0 && dn > 0 && dy > 0) v += du * dn * dy;
    }
    return v;
  };
  const [a, b] = [used(1), used(-1)];
  if (a !== b) return a > b ? 1 : -1;
  // Toward the middle of the house.
  return dot(middle, w.across) >= mid(w.n) ? 1 : -1;
}

/** An opening's params from its rectangle (`u` along the wall's x from its start). */
function openingFrom(r: Rect, H: number): WallPieceOpening {
  const width = sixteenth(r.u1 - r.u0);
  const at = sixteenth((r.u0 + r.u1) / 2);
  const top = Math.min(r.v1, H - HEADER);
  if (r.v0 <= AT_FLOOR) {
    const height = sixteenth(top);
    if (width > MAX_DOOR) return { id: '', kind: 'opening', at, width, height, casing: true, sill: 0 };
    return { id: '', kind: 'door', at, width, height, casing: true, leaf: 'panel', hinge: 'left', swing: 'in', angle: 90, handle: 'lever' };
  }
  const sill = sixteenth(r.v0);
  return { id: '', kind: 'window', at, width, height: sixteenth(top - r.v0), casing: true, sill, style: 'double-hung', stool: true };
}

export interface WallsFound {
  walls: IRNative[];
  /** Raw parts they replace: the walls' boards, and surfaces that only marked openings. */
  consumed: Set<IRPart>;
  openings: number;
}


/** Finds the walls among an import's parts (and their openings among its flats). */
export function recognizeWalls(parts: IRPart[], flats: Flat[]): WallsFound {
  const walls = parts.map(wallBox).filter((w): w is WallBox => w !== null);
  const consumed = new Set<IRPart>(walls.map((w) => w.part));
  if (!walls.length) return { walls: [], consumed, openings: 0 };

  for (const w of walls) {
    const [L, H] = [w.u[1] - w.u[0], w.y[1] - w.y[0]];
    if (w.part.loops?.length) {
      const rings = w.part.loops.map((l) => l.map((p): V2 => [dot(p, w.along) - w.u[0], p[1] - w.y[0]]));
      w.rects.push(...outlineGaps(rings, L, H));
    }
  }
  // Each flat marks at most one wall's opening: the wall whose face it's drawn on.
  for (const f of flats) {
    for (const w of walls) {
      const r = markerOn(w, f);
      if (!r) continue;
      w.rects.push(r);
      w.markers.push(f);
      break;
    }
  }

  const others = parts.filter((p) => !consumed.has(p)).map((p) => boxOf(partCorners(p)));
  const all = boxOf(walls.flatMap((w) => partCorners(w.part)));
  const middle: V3 = [(all.min[0] + all.max[0]) / 2, 0, (all.min[2] + all.max[2]) / 2];
  let openings = 0;
  let n = 0;
  const natives = walls.map((w): IRNative => {
    for (const f of w.markers) if (f.source) consumed.add(f.source);
    const side = frontSide(w, walls, others, middle);
    // Its frame: x along it (left to right seen from the front), y up, z out of its front.
    const z = w.across.map((c) => c * side) as V3;
    const x: V3 = [z[2], 0, -z[0]];
    const pts = partCorners(w.part);
    const [mx, my, mz] = [extent(pts, x)[0], extent(pts, UP)[0], extent(pts, z)[0]];
    const o = [0, 1, 2].map((k) => x[k]! * mx + UP[k]! * my + z[k]! * mz) as V3;
    const [L, H, T] = [w.u[1] - w.u[0], w.y[1] - w.y[0], w.n[1] - w.n[0]].map(Math.round) as [number, number, number];
    // Rectangles run along `along` from its start; x may run the other way.
    const flip = dot(x, w.along) < 0;
    const list = distinct(w.rects)
      .map((r) => (flip ? { ...r, u0: L - r.u1, u1: L - r.u0 } : r))
      .filter((r) => r.u1 - r.u0 >= MIN_OPENING && Math.min(r.v1, H - HEADER) - (r.v0 <= AT_FLOOR ? 0 : r.v0) >= MIN_OPENING)
      .map((r) => openingFrom(r, H))
      .map(({ id: _id, ...o }) => o as WallPieceOpening);
    openings += list.length;
    const params: Omit<WallPieceParams, 'finishes'> = { length: L, height: H, thickness: T, openings: list, casings: 'both' };
    // SketchUp walls are seldom named; a name that says wall is kept.
    const name = /wall/i.test(w.part.name) ? w.part.name : `Wall ${++n}`;
    return { kind: 'native', name, R: fromColumns(x, UP, z), o, size: [L, H, T], generator: { type: 'wall', params: params as unknown as Record<string, unknown> }, fallback: w.part };
  });
  return { walls: natives, consumed, openings };
}
