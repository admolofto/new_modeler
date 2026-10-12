import type { V3 } from '../geometry/types';
import { generatedOwner } from '../model/generate';
import { alongWall, atAlongWall, roomParams } from '../model/room';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import {
  HEADER,
  insideSpan,
  openingBottom,
  openingOf,
  openingLabel,
  openingSpan,
  WALL_OUTWARD,
  type RoomOpening,
  type RoomParams,
  type RoomSide,
} from '../plugins/generators/room';
import type { DimLine } from './dimensions';
import type { Ray } from './rays';
import type { Target } from './targets';

/**
 * Dragging a room's windows, doors and cased openings in the viewport: sliding one along the walls
 * (and round a corner onto the next), pulling an edge to resize it, and what to show while that
 * happens (how far it is from each corner of its wall and from its nearest neighbor). Room
 * coordinates, model units; "along" is the distance from a wall's left corner as seen from inside.
 * Pure: ui/interaction.ts aims the pointer's ray and applies the result as one `update` op.
 */

/** What a drag pulls: the whole opening, or one of its edges (left and right as seen from inside). */
export type OpeningGrip = 'move' | 'left' | 'right' | 'top' | 'bottom';

/** The smallest opening either way (the room schema's minimum). */
const MIN_SIZE = inches(12);
/** On the floor, the wall being followed keeps the cursor until another is this much nearer. */
const STICKY = inches(4);
/** Readout lines sit this far off the opening. */
const DIM_OFFSET = inches(5);

const built = (p: RoomParams, side: RoomSide) => p.walls.includes(side);
const wallLength = (p: RoomParams, side: RoomSide) => {
  const [min, max] = insideSpan(p, side);
  return max - min;
};
/** The axis a wall's plane is across (0: x, 2: z); it runs along the other. */
const planeAxis = (side: RoomSide) => (WALL_OUTWARD[side][0] !== 0 ? 0 : 2);
const snapTo = (n: number, step: number) => Math.round(n / step) * step;

/** An opening's left and right edges along its wall, as seen from inside. */
export function openingEdges(p: RoomParams, o: Pick<RoomOpening, 'wall' | 'at' | 'width'>): [number, number] {
  const [a, b] = openingSpan(o).map((c) => alongWall(p, o.wall, c)) as [number, number];
  return [Math.min(a, b), Math.max(a, b)];
}

/** The opening with its edges put at `left` and `right` along a wall. */
function placed<T extends RoomOpening>(p: RoomParams, o: T, wall: RoomSide, left: number, right: number): T {
  const width = right - left;
  const lo = Math.min(atAlongWall(p, wall, left), atAlongWall(p, wall, right));
  return { ...o, wall, at: lo + Math.floor(width / 2), width };
}

/** The others on a wall that an opening this high would run into, as [left, right] along it. */
function beside(p: RoomParams, o: RoomOpening, wall: RoomSide): [number, number][] {
  const [y0, y1] = [openingBottom(o), openingBottom(o) + o.height];
  return p.openings.filter((q) => q.id !== o.id && q.wall === wall && openingBottom(q) < y1 && y0 < openingBottom(q) + q.height).map((q) => openingEdges(p, q));
}

/** The room's params with one opening replaced. */
export function withOpening(p: RoomParams, o: RoomOpening): RoomParams {
  return { ...p, openings: p.openings.map((q) => (q.id === o.id ? o : q)) };
}

export interface Slide {
  opening: RoomOpening;
  /** Why it stopped where it did (`centered`), or ''. */
  note: string;
}

/**
 * An opening slid along `wall` so its left edge is as near `left` (along the wall) as it can be:
 * on the `step` grid, centered on the wall when within `tol` of that, kept between the corners and
 * clear of the wall's other openings (it stops against them, or hops past when the cursor does).
 * null when the wall has no room for it.
 */
export function slideOpening(p: RoomParams, id: string, wall: RoomSide, left: number, step: number, tol = 0): Slide | null {
  const o = p.openings.find((q) => q.id === id);
  if (!o) return null;
  const max = wallLength(p, wall) - o.width;
  if (max < 0) return null;
  // Where its left edge can't be: (neighbor's left − its width, neighbor's right), merged.
  const blocked: [number, number][] = [];
  for (const [a, b] of beside(p, o, wall).map(([l, r]) => [l - o.width, r] as [number, number]).sort((m, n) => m[0] - n[0])) {
    const last = blocked[blocked.length - 1];
    if (last && a < last[1]) last[1] = Math.max(last[1], b);
    else blocked.push([a, b]);
  }
  const clamp = (l: number) => Math.min(Math.max(l, 0), max);
  const free = (l: number) => l >= 0 && l <= max && !blocked.some(([a, b]) => l > a && l < b);
  const centered = Math.floor(max / 2);
  if (tol > 0 && Math.abs(left - centered) <= tol && free(centered)) return { opening: placed(p, o, wall, centered, centered + o.width), note: 'centered' };
  const want = clamp(snapTo(left, step));
  if (free(want)) return { opening: placed(p, o, wall, want, want + o.width), note: '' };
  // Against whatever's in the way, on the side the cursor is nearer.
  const ends = [0, max, ...blocked.flat()].filter(free).sort((a, b) => Math.abs(a - left) - Math.abs(b - left));
  if (!ends.length) return null;
  return { opening: placed(p, o, wall, ends[0]!, ends[0]! + o.width), note: '' };
}

/**
 * An opening with one edge pulled to `value` — along the wall for its left and right edges, a
 * height off the floor for its top and bottom — its size landing on the `step` grid. The other
 * edges stay put. It stops at 12", at the corners, 1" under the ceiling, at the floor and against
 * the openings beside, above and below it. Doors have no bottom edge to pull.
 */
export function resizeOpening(p: RoomParams, id: string, grip: Exclude<OpeningGrip, 'move'>, value: number, step: number): RoomOpening | null {
  const o = p.openings.find((q) => q.id === id);
  if (!o) return null;
  const [l, r] = openingEdges(p, o);
  const [y0, y1] = [openingBottom(o), openingBottom(o) + o.height];
  const size = (raw: number, most: number) => Math.max(MIN_SIZE, Math.min(snapTo(raw, step), most));
  if (grip === 'left' || grip === 'right') {
    const others = beside(p, o, o.wall);
    if (grip === 'left') {
      const stop = Math.max(0, ...others.filter(([, b]) => b <= l).map(([, b]) => b));
      return placed(p, o, o.wall, r - size(r - value, r - stop), r);
    }
    const stop = Math.min(wallLength(p, o.wall), ...others.filter(([a]) => a >= r).map(([a]) => a));
    return placed(p, o, o.wall, l, l + size(value - l, stop - l));
  }
  // Above and below: the wall's others that share some of its width.
  const stacked = p.openings.filter((q) => {
    if (q.id === o.id || q.wall !== o.wall) return false;
    const [a, b] = openingEdges(p, q);
    return a < r && l < b;
  });
  if (grip === 'top') {
    const stop = Math.min(p.height - HEADER, ...stacked.filter((q) => openingBottom(q) >= y1).map((q) => openingBottom(q)));
    return { ...o, height: size(value - y0, stop - y0) };
  }
  if (o.kind === 'door') return null;
  const stop = Math.max(0, ...stacked.filter((q) => openingBottom(q) + q.height <= y0).map((q) => openingBottom(q) + q.height));
  const height = size(y1 - value, y1 - stop);
  return { ...o, sill: y1 - height, height };
}

// ── aiming ───────────────────────────────────────────────────────────────────

/** Where a ray crosses the plane a wall's inside face is in, moved `out` beyond it: along the wall (a room coordinate) and up. */
function crossing(p: RoomParams, side: RoomSide, ray: Ray, out = 0): { c: number; y: number; t: number; den: number } | null {
  const n = WALL_OUTWARD[side];
  const ax = planeAxis(side);
  const den = ray.d[ax]! * n[ax]!;
  if (Math.abs(den) < 1e-6) return null;
  const t = (p[side] + n[ax]! * out - ray.o[ax]!) / ray.d[ax]!;
  if (t <= 0) return null;
  return { c: ray.o[2 - ax]! + ray.d[2 - ax]! * t, y: ray.o[1] + ray.d[1] * t, t, den };
}

/** Where on a wall's inside face (taken as endless) the ray points: along the wall from its left corner, and up. */
export function wallPoint(p: RoomParams, side: RoomSide, ray: Ray): { along: number; y: number } | null {
  const hit = crossing(p, side, ray);
  return hit && { along: alongWall(p, side, hit.c), y: hit.y };
}

/**
 * The wall the cursor is on, and where along it (from its left corner): the wall whose inside face
 * the ray lands on; over the floor, the nearest wall (`prefer`, the one being followed, holds on a
 * little so corners don't flicker); past the top of the walls, the one the ray passes over. Walls
 * seen from outside (the cutaway has them away) and walls that are off don't count.
 */
export function wallUnder(p: RoomParams, ray: Ray, prefer?: RoomSide): { wall: RoomSide; along: number } | null {
  const hits = p.walls.flatMap((side) => {
    const hit = crossing(p, side, ray);
    if (!hit || hit.den <= 0) return [];
    const [min, max] = insideSpan(p, side);
    return hit.c >= min && hit.c <= max ? [{ side, ...hit }] : [];
  });
  const on = hits.find((h) => h.y >= 0 && h.y <= p.height);
  if (on) return { wall: on.side, along: alongWall(p, on.side, on.c) };
  if (ray.d[1] < -1e-6 && ray.o[1] > 0) {
    const t = -ray.o[1] / ray.d[1];
    const at: V3 = [ray.o[0] + ray.d[0] * t, 0, ray.o[2] + ray.d[2] * t];
    if (at[0] >= p.left && at[0] <= p.right && at[2] >= p.back && at[2] <= p.front) {
      const near = p.walls
        .map((side) => ({ side, far: Math.abs(at[planeAxis(side)]! - p[side]) - (side === prefer ? STICKY : 0) }))
        .sort((a, b) => a.far - b.far)[0];
      return near ? { wall: near.side, along: alongWall(p, near.side, at[2 - planeAxis(near.side)]!) } : null;
    }
  }
  const over = hits.sort((a, b) => a.t - b.t)[0];
  return over ? { wall: over.side, along: alongWall(p, over.side, over.c) } : null;
}

/**
 * The opening the ray goes through (halfway through its wall), looking from inside the room, and
 * how far along the ray that is. The nearest, when it passes through more than one.
 */
export function openingUnder(p: RoomParams, ray: Ray): { opening: RoomOpening; t: number } | null {
  let best: { opening: RoomOpening; t: number } | null = null;
  for (const o of p.openings) {
    if (!built(p, o.wall)) continue;
    const hit = crossing(p, o.wall, ray, Math.floor(p.wallThickness / 2));
    if (!hit || hit.den <= 0) continue;
    const [lo, hi] = openingSpan(o);
    const y = openingBottom(o);
    if (hit.c < lo || hit.c > hi || hit.y < y || hit.y > y + o.height) continue;
    if (!best || hit.t < best.t) best = { opening: o, t: hit.t };
  }
  return best;
}

/** A point on a wall's inside face: `along` from its left corner, `y` up. */
export function onWall(p: RoomParams, side: RoomSide, along: number, y: number): V3 {
  const c = atAlongWall(p, side, along);
  return planeAxis(side) === 0 ? [p[side], y, c] : [c, y, p[side]];
}

/** The way along a wall, left to right as seen from inside. */
const alongDir = (p: RoomParams, side: RoomSide): V3 => {
  const [a, b] = [onWall(p, side, 0, 0), onWall(p, side, 1, 0)];
  return [b[0] - a[0], 0, b[2] - a[2]];
};

/** The middles of an opening's edges on the inside face of its wall: where its resize grips sit. */
export function openingGrips(p: RoomParams, o: RoomOpening): { grip: Exclude<OpeningGrip, 'move'>; at: V3; ends: [V3, V3] }[] {
  const [l, r] = openingEdges(p, o);
  const [y0, y1] = [openingBottom(o), openingBottom(o) + o.height];
  const pt = (along: number, y: number) => onWall(p, o.wall, along, y);
  const mid = Math.round((l + r) / 2);
  const half = Math.round((y0 + y1) / 2);
  return [
    { grip: 'left' as const, at: pt(l, half), ends: [pt(l, y0), pt(l, y1)] as [V3, V3] },
    { grip: 'right' as const, at: pt(r, half), ends: [pt(r, y0), pt(r, y1)] as [V3, V3] },
    { grip: 'top' as const, at: pt(mid, y1), ends: [pt(l, y1), pt(r, y1)] as [V3, V3] },
    ...(o.kind === 'door' ? [] : [{ grip: 'bottom' as const, at: pt(mid, y0), ends: [pt(l, y0), pt(r, y0)] as [V3, V3] }]),
  ];
}

// ── the readout ──────────────────────────────────────────────────────────────

export interface OpeningReadout {
  /** Wall left between it and each corner of its wall, as seen from inside. */
  left: number;
  right: number;
  /** The nearest opening on the same wall, and the wall left between them. */
  neighbor: { label: string; gap: number; side: 'left' | 'right' } | null;
}

export function openingReadout(p: RoomParams, o: RoomOpening): OpeningReadout {
  const [l, r] = openingEdges(p, o);
  let neighbor: OpeningReadout['neighbor'] = null;
  for (const q of p.openings) {
    if (q.id === o.id || q.wall !== o.wall) continue;
    const [a, b] = openingEdges(p, q);
    const side = b <= l ? 'left' : a >= r ? 'right' : null;
    if (!side) continue;
    const gap = side === 'left' ? l - b : a - r;
    if (!neighbor || gap < neighbor.gap) neighbor = { label: openingLabel(q), gap, side };
  }
  return { left: l, right: wallLength(p, o.wall) - r, neighbor };
}

/** `24" from left corner · 60" from right corner · 12" from window w2`, with lengths written by `fmt`. */
export function readoutText(r: OpeningReadout, fmt: (u: number) => string): string {
  return [`${fmt(r.left)} from left corner`, `${fmt(r.right)} from right corner`, ...(r.neighbor ? [`${fmt(r.neighbor.gap)} from ${r.neighbor.label}`] : [])].join(' · ');
}

/**
 * Dimension lines to draw on the wall while an opening is dragged (room coordinates). Sliding it or
 * pulling a side: a row above it — corner to its left edge, its right edge to the other corner, and
 * (resizing) its width between — plus the gap to its nearest neighbor, across the middle. Pulling
 * its top or bottom: a column beside it — floor to sill, its height, its top to the ceiling.
 */
export function openingDims(p: RoomParams, o: RoomOpening, grip: OpeningGrip): DimLine[] {
  const [l, r] = openingEdges(p, o);
  const [y0, y1] = [openingBottom(o), openingBottom(o) + o.height];
  const pt = (along: number, y: number) => onWall(p, o.wall, along, y);
  const lines: DimLine[] = [];
  if (grip === 'top' || grip === 'bottom') {
    const dir = alongDir(p, o.wall);
    const out: V3 = [-dir[0], 0, -dir[2]];
    for (const [a, b] of [[0, y0], [y0, y1], [y1, p.height]] as const) lines.push({ a: pt(l, a), b: pt(l, b), out, offset: DIM_OFFSET, value: b - a });
  } else {
    const len = wallLength(p, o.wall);
    const row = (a: number, b: number) => lines.push({ a: pt(a, y1), b: pt(b, y1), out: [0, 1, 0], offset: DIM_OFFSET, value: b - a });
    row(0, l);
    if (grip !== 'move') row(l, r);
    row(r, len);
    const n = openingReadout(p, o).neighbor;
    // Across the middle of the wall between them (the corner's row already says it when there's nothing else that side).
    if (n && n.gap !== (n.side === 'left' ? l : len - r)) {
      const [a, b] = n.side === 'left' ? [l - n.gap, l] : [r, r + n.gap];
      lines.push({ a: pt(a, y1), b: pt(b, y1), out: [0, -1, 0], offset: Math.round(o.height / 2), value: n.gap });
    }
  }
  return lines.filter((d) => d.value > 0);
}

// ── the selection ────────────────────────────────────────────────────────────

/**
 * What of a room the selection is on, for the room's toolbar: the room (itself, or any wall, window
 * or door of it), the wall the first selected thing is on, and the opening it belongs to. null when
 * nothing of a room is selected.
 */
export function roomPick(doc: Doc, targets: readonly Target[]): { room: string; wall: RoomSide | null; opening: RoomOpening | null } | null {
  for (const t of targets) {
    const own = doc.assemblies[t.node];
    const asm = own?.generator?.type === 'room' ? own : generatedOwner(doc, t.node);
    if (asm?.generator?.type !== 'room') continue;
    const p = roomParams(asm);
    const role = (doc.parts[t.node] ?? doc.assemblies[t.node])?.role ?? '';
    const opening = asm === own ? null : openingOf(p, role, t.handle);
    const wall = opening?.wall ?? (/^(?:wall|baseboard)-(back|left|right|front)/.exec(role)?.[1] as RoomSide | undefined) ?? null;
    return { room: asm.id, wall, opening };
  }
  return null;
}
