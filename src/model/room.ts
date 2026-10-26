import type { V3 } from '../geometry/types';
import {
  HEADER,
  insideSpan,
  newOpening,
  openingBottom,
  openingLabel,
  openingSpan,
  ROOM_HEIGHT,
  ROOM_SIDES,
  SLAB,
  WALL_OUTWARD,
  wallFrame,
  wallOpening,
  wallToRoom,
  type OpeningKind,
  type RoomOpening,
  type RoomParams,
  type RoomSide,
} from '../plugins/generators/room';
import { wallCut, type WallPieceParams } from '../plugins/generators/wall';
import { isSolid, modelPartIds } from './decor';
import { descendants } from './doc';
import { generatedOwner, genPartId } from './generate';
import type { Op } from './ops';
import type { Assembly, Doc } from './schema';
import { formatInches as f, inches } from './units';
import { hiddenNodes } from './visibility';
import { allAffines, apply, IDENTITY, nodeAffine, rotate, transformBox, union, worldBoxes, type Affine, type Box3 } from './world';

/**
 * The room around the model (A6), pure: fitting one around the model (`roomAround`, `refitRoomOps`),
 * what's wrong with its openings (`roomIssues`), its inside (`roomInterior`, for cameras and walking),
 * and its shell for the renderer (`roomShell`: walls with what they host, ceilings, floors, windows),
 * which the cutaway and, later, presentation lighting read. World coordinates, model units.
 */

export type { RoomOpening, RoomParams, RoomSide } from '../plugins/generators/room';

/** Every room in the doc (one is the rule; the snapshot and tools use the first). */
export const rooms = (doc: Doc): Assembly[] => Object.values(doc.assemblies).filter((a) => a.generator?.type === 'room');
export const roomOf = (doc: Doc): Assembly | null => rooms(doc)[0] ?? null;
/** Every wall piece (a floor plan's walls, each on its own: the `wall` generator). */
export const wallPieces = (doc: Doc): Assembly[] => Object.values(doc.assemblies).filter((a) => a.generator?.type === 'wall');
export const roomParams = (asm: Assembly): RoomParams => asm.generator!.params as unknown as RoomParams;

const built = (p: RoomParams, side: RoomSide) => p.walls.includes(side);
const thick = (p: RoomParams, side: RoomSide) => (built(p, side) ? p.wallThickness : 0);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── fitting ──────────────────────────────────────────────────────────────────

export interface RoomFitOptions {
  /** Inside distance from the model to each wall; overrides the flush / margin rules for that side. */
  margins?: Partial<Record<RoomSide, number>>;
  height?: number;
  walls?: RoomSide[];
  ceiling?: boolean;
}

/** Margins when a side isn't flush: 36" at the sides, 48" in front. */
export const SIDE_MARGIN = inches(36);
export const FRONT_MARGIN = inches(48);
/** A cabinet's back this close to the model's edge puts that wall right behind it. */
const FLUSH = inches(1 / 2);
const MIN_ROOM = inches(36);
const EMPTY_ROOM = inches(144);

const floorInch = (u: number) => Math.floor(u / 64) * 64;
const ceilInch = (u: number) => Math.ceil(u / 64) * 64;

/**
 * Sides a cabinet (a generator assembly) or block backs onto: its back (local −Z) faces that side
 * and it reaches the model's edge there, within 1/2".
 */
function flushSides(doc: Doc, model: Box3, boxes: Map<string, Box3>): Set<'left' | 'right'> {
  const out = new Set<'left' | 'right'>();
  const affines = allAffines(doc);
  const ids = [
    ...Object.values(doc.assemblies).filter((a) => a.generator && a.generator.type !== 'room').map((a) => a.id),
    ...Object.values(doc.parts).filter((p) => p.block).map((p) => p.id),
  ];
  for (const id of ids) {
    const A = affines.get(id);
    const box = boxes.get(id);
    if (!A || !box) continue;
    const front = rotate(A.m, [0, 0, 1]);
    if (front[0] > 0.999 && Math.abs(box.min[0] - model.min[0]) <= FLUSH) out.add('left');
    if (front[0] < -0.999 && Math.abs(box.max[0] - model.max[0]) <= FLUSH) out.add('right');
  }
  return out;
}

/**
 * A room around the model: the back wall flush behind it, the front 48" in front of it (to the inch),
 * each side flush where a cabinet backs onto it, else 36" out (to the inch), at least 96" high.
 * Nothing yet: a 12' square. Returns the params to make it with (the generator fills the rest) and
 * the model's bounds.
 */
export function roomAround(doc: Doc, opts: RoomFitOptions = {}): { params: Pick<RoomParams, 'left' | 'right' | 'back' | 'front' | 'height'> & Partial<RoomParams>; model: Box3 | null } {
  const boxes = worldBoxes(doc);
  const ids = modelPartIds(doc).filter((id) => boxes.has(id));
  const m = opts.margins ?? {};
  let planes: { left: number; right: number; back: number; front: number; height: number };
  let model: Box3 | null = null;
  if (!ids.length) {
    planes = { left: 0, right: EMPTY_ROOM, back: 0, front: EMPTY_ROOM, height: ROOM_HEIGHT };
  } else {
    const B = (model = union(ids.map((id) => boxes.get(id)!)));
    const flush = flushSides(doc, B, boxes);
    planes = {
      left: m.left !== undefined ? B.min[0] - m.left : flush.has('left') ? B.min[0] : floorInch(B.min[0] - SIDE_MARGIN),
      right: m.right !== undefined ? B.max[0] + m.right : flush.has('right') ? B.max[0] : ceilInch(B.max[0] + SIDE_MARGIN),
      back: B.min[2] - (m.back ?? 0),
      front: m.front !== undefined ? B.max[2] + m.front : ceilInch(B.max[2] + FRONT_MARGIN),
      height: Math.max(ROOM_HEIGHT, ceilInch(B.max[1])),
    };
  }
  if (opts.height !== undefined) planes.height = opts.height;
  if (planes.right - planes.left < MIN_ROOM) planes.right = planes.left + MIN_ROOM;
  if (planes.front - planes.back < MIN_ROOM) planes.front = planes.back + MIN_ROOM;
  return {
    params: { ...planes, ...(opts.walls && { walls: [...opts.walls] }), ...(opts.ceiling !== undefined && { ceiling: opts.ceiling }) },
    model,
  };
}

/** Do two openings on one wall overlap? */
function overlap(a: RoomOpening, b: RoomOpening): boolean {
  if (a.wall !== b.wall) return false;
  const [a0, a1] = openingSpan(a);
  const [b0, b1] = openingSpan(b);
  const [ay, by] = [openingBottom(a), openingBottom(b)];
  return a0 < b1 && b0 < a1 && ay < by + b.height && by < ay + a.height;
}

/**
 * Refits a room to the model as it is now (`roomAround`), keeping its openings, walls, finishes and
 * height (raised if the model got taller). Openings slide along their wall to stay on it; ones that
 * no longer fit are dropped. `notes` says what moved or went.
 */
export function refitRoomOps(doc: Doc, roomId: string, opts: RoomFitOptions = {}): { ops: Op[]; notes: string[] } {
  const asm = doc.assemblies[roomId];
  if (asm?.generator?.type !== 'room') throw new Error(`no room "${roomId}"`);
  const p = roomParams(asm);
  const fit = roomAround(doc, opts);
  const height = opts.height ?? Math.max(p.height, fit.model ? ceilInch(fit.model.max[1]) : 0);
  const next: RoomParams = {
    ...p,
    left: fit.params.left,
    right: fit.params.right,
    back: fit.params.back,
    front: fit.params.front,
    height,
    walls: opts.walls ? [...opts.walls] : p.walls,
    ceiling: opts.ceiling ?? p.ceiling,
  };
  const notes: string[] = [];
  const kept: RoomOpening[] = [];
  for (const o of p.openings) {
    const name = cap(openingLabel(o));
    const [min, max] = insideSpan(next, o.wall);
    if (o.width > max - min) {
      notes.push(`${name} (${f(o.width)} wide) was removed: the ${o.wall} wall is only ${f(max - min)} inside now`);
      continue;
    }
    if (openingBottom(o) + o.height > height - HEADER) {
      notes.push(`${name} was removed: it's too tall for the ${f(height)} room`);
      continue;
    }
    const half = Math.floor(o.width / 2);
    const at = Math.min(Math.max(o.at, min + half), max - o.width + half);
    const moved = { ...o, at };
    const clash = kept.find((k) => overlap(k, moved));
    if (clash) {
      notes.push(`${name} was removed: on the refit wall it would overlap ${openingLabel(clash)}`);
      continue;
    }
    if (at !== o.at) notes.push(`${name} moved ${f(Math.abs(at - o.at))} to stay on the ${o.wall} wall`);
    kept.push(moved);
  }
  next.openings = kept;
  const patch: Record<string, unknown> = {};
  for (const key of ['left', 'right', 'back', 'front', 'height', 'walls', 'ceiling', 'openings'] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(p[key])) patch[key] = next[key];
  }
  return { ops: Object.keys(patch).length ? [{ op: 'update', id: roomId, patch: { params: patch } }] : [], notes };
}

// ── openings ─────────────────────────────────────────────────────────────────

/** Where along its wall an opening's center is, measured from the wall's left end as seen from inside. */
export function alongWall(p: RoomParams, wall: RoomSide, at: number): number {
  switch (wall) {
    case 'back':
      return at - p.left;
    case 'front':
      return p.right - at;
    case 'left':
      return p.front - at;
    case 'right':
      return at - p.back;
  }
}

/** The room coordinate (`at`) for a distance from the wall's left end (the inverse of `alongWall`). */
export function atAlongWall(p: RoomParams, wall: RoomSide, along: number): number {
  switch (wall) {
    case 'back':
      return p.left + along;
    case 'front':
      return p.right - along;
    case 'left':
      return p.front - along;
    case 'right':
      return p.back + along;
  }
}

/**
 * A new opening of a kind on a wall (default: the back wall, else the first one built), centered in
 * the widest stretch of that wall no other opening uses. null when there's no room for it.
 */
export function placeOpening(p: RoomParams, kind: OpeningKind, wall?: RoomSide): RoomOpening | null {
  // The back wall first; walls that are built before ones that aren't.
  const walls = wall ? [wall] : [...ROOM_SIDES].sort((a, b) => Number(built(p, b)) - Number(built(p, a)));
  for (const side of walls) {
    const [min, max] = insideSpan(p, side);
    const taken = p.openings
      .filter((o) => o.wall === side)
      .map((o) => openingSpan(o))
      .sort((a, b) => a[0] - b[0]);
    let best: [number, number] | null = null;
    let from = min;
    for (const [a, b] of [...taken, [max, max] as [number, number]]) {
      if (a - from > (best ? best[1] - best[0] : 0)) best = [from, a];
      from = Math.max(from, b);
    }
    if (!best) continue;
    const o = newOpening(p, kind, side, Math.round((best[0] + best[1]) / 64 / 2) * 64);
    const [a, b] = openingSpan(o);
    if (a >= best[0] && b <= best[1]) return o;
  }
  return null;
}

/** `window w1 (back wall, 36" × 48")`, for diffs and tool results. */
export function openingText(o: RoomOpening): string {
  return `${openingLabel(o)} (${o.wall} wall, ${f(o.width)} × ${f(o.height)})`;
}

// ── issues ───────────────────────────────────────────────────────────────────

/** How far in front of an opening must stay clear: a door's swing, else 2". */
const clearDepth = (o: RoomOpening) => (o.kind === 'door' && o.leaf !== 'none' && o.swing === 'in' ? o.width : inches(2));

/**
 * What's wrong with the rooms' openings: ones on walls that are off (kept, not built), and ones
 * something solid of the model stands in front of — "Window w1 (back wall) is covered by “Wall
 * cabinet 30″”". The AI fixes them; the snapshot lists them.
 */
export function roomIssues(doc: Doc): string[] {
  const all = rooms(doc);
  if (!all.length) return [];
  const out: string[] = [];
  const boxes = worldBoxes(doc);
  const hidden = hiddenNodes(doc);
  const solids = modelPartIds(doc).filter((id) => boxes.has(id) && !hidden.has(id) && isSolid(doc.parts[id]!));
  const named = (id: string) => generatedOwner(doc, id)?.name ?? doc.parts[id]!.name;
  for (const asm of all) {
    const p = roomParams(asm);
    const A = nodeAffine(doc, asm.id);
    for (const o of p.openings) {
      const name = `${cap(openingLabel(o))} (${o.wall} wall)`;
      if (!built(p, o.wall)) {
        out.push(`${name} isn't built: the ${o.wall} wall is turned off`);
        continue;
      }
      const w = wallOpening(p, o);
      const T = p.wallThickness;
      const a = wallToRoom(p, o.wall, [w.x, w.y, T]);
      const b = wallToRoom(p, o.wall, [w.x + w.w, w.y + w.h, T + clearDepth(o)]);
      const zone = transformBox(A, { min: [0, 1, 2].map((k) => Math.min(a[k]!, b[k]!)) as V3, max: [0, 1, 2].map((k) => Math.max(a[k]!, b[k]!)) as V3 });
      const hits = solids.filter((id) => {
        const box = boxes.get(id)!;
        return [0, 1, 2].every((k) => Math.min(box.max[k]!, zone.max[k]!) - Math.max(box.min[k]!, zone.min[k]!) > 1);
      });
      if (hits.length) out.push(`${name} is covered by ${[...new Set(hits.map(named))].map((n) => `“${n}”`).join(', ')}`);
    }
  }
  return out;
}

// ── the inside, and the shell ────────────────────────────────────────────────

export const EYE_HEIGHT = inches(62);

/** The first room's inside (floor to ceiling, wall face to wall face) and the walking eye height. */
export function roomInterior(doc: Doc): { min: V3; max: V3; eyeHeight: number } | null {
  const asm = roomOf(doc);
  if (!asm) return null;
  const p = roomParams(asm);
  const box = transformBox(nodeAffine(doc, asm.id), { min: [p.left, 0, p.back], max: [p.right, p.height, p.front] });
  return { ...box, eyeHeight: doc.presentation?.eyeHeight ?? EYE_HEIGHT };
}

/** A wall and what it hosts (its windows, casings, baseboards and door folders): hidden together. */
export interface ShellWall {
  /** A room's side; none for a wall piece. */
  side?: RoomSide;
  /** The room or wall piece it belongs to. */
  room: string;
  ids: string[];
  /** The middle of its inside face, and its way out of the room (world, model units). */
  point: V3;
  outward: V3;
}
export interface ShellCeiling {
  ids: string[];
  /** Its underside (world y). */
  height: number;
  /** The inside footprint, [x, z]. */
  min: [number, number];
  max: [number, number];
}
export interface ShellWindow {
  id: string;
  part: string;
  /** The middle of the opening, halfway through the wall. */
  center: V3;
  outward: V3;
  /** Width × height, model units². */
  area: number;
}
export interface RoomShell {
  walls: ShellWall[];
  ceilings: ShellCeiling[];
  floors: string[];
  windows: ShellWindow[];
  /** Everything the rooms made (parts and door folders). */
  shellIds: string[];
  /** Outside bounds of the rooms, slabs included. */
  bounds: Box3 | null;
}

const shells = new WeakMap<Doc, RoomShell>();

/**
 * The rooms as the renderer needs them (binding note 6): walls (with what they host) for the cutaway,
 * ceilings, floors, windows (for the sun), every shell id, and the bounds. Memoized per doc.
 */
export function roomShell(doc: Doc): RoomShell {
  const hit = shells.get(doc);
  if (hit) return hit;
  const shell: RoomShell = { walls: [], ceilings: [], floors: [], windows: [], shellIds: [], bounds: null };
  const exists = (id: string) => !!(doc.parts[id] ?? doc.assemblies[id]);
  const bounds: Box3[] = [];
  for (const asm of rooms(doc)) {
    const p = roomParams(asm);
    const A: Affine = doc.roots.includes(asm.id) && asm.transform.position.every((c) => c === 0) && asm.transform.rotation.every((c) => c === 0) ? IDENTITY : nodeAffine(doc, asm.id);
    const id = (role: string) => genPartId(asm.id, role);
    const world = (side: RoomSide, v: V3) => apply(A, wallToRoom(p, side, v));
    const T = p.wallThickness;
    // Its parts and folders: generated ones (a role), directly in it or in its folders.
    const folders = new Set(asm.children.filter((c) => doc.assemblies[c]?.role !== undefined));
    const generated = descendants(doc, asm.id).filter((c) => {
      const node = doc.parts[c] ?? doc.assemblies[c];
      return node?.role !== undefined && (asm.children.includes(c) || [...folders].some((fid) => doc.assemblies[fid]!.children.includes(c)));
    });
    shell.shellIds.push(...generated);
    for (const side of ROOM_SIDES) {
      if (!built(p, side)) continue;
      const mine = p.openings.filter((o) => o.wall === side);
      const hosted = [
        ...mine.flatMap((o) => [id(`window-${o.id}`), id(`casing-${o.id}`), id(`door-${o.id}`)]),
        ...generated.filter((c) => c.startsWith(id(`baseboard-${side}-`))),
      ];
      const ids = [id(`wall-${side}`), ...hosted].filter(exists);
      if (!ids.length) continue;
      const fr = wallFrame(p, side);
      shell.walls.push({ side, room: asm.id, ids, point: world(side, [fr.length / 2, p.height / 2, T]), outward: rotate(A.m, WALL_OUTWARD[side]) });
      for (const o of mine) {
        if (o.kind !== 'window' || !exists(id(`window-${o.id}`))) continue;
        const w = wallOpening(p, o);
        shell.windows.push({ id: o.id, part: id(`window-${o.id}`), center: world(side, [w.x + w.w / 2, w.y + w.h / 2, T / 2]), outward: rotate(A.m, WALL_OUTWARD[side]), area: w.w * w.h });
      }
    }
    if (p.ceiling && exists(id('ceiling'))) {
      const box = transformBox(A, { min: [p.left, p.height, p.back], max: [p.right, p.height, p.front] });
      // Its recessed cans go with it (cut away together).
      shell.ceilings.push({ ids: [id('ceiling'), ...generated.filter((c) => c.startsWith(id('can-')))], height: box.min[1], min: [box.min[0], box.min[2]], max: [box.max[0], box.max[2]] });
    }
    if (p.floor && exists(id('floor'))) shell.floors.push(id('floor'));
    bounds.push(
      transformBox(A, {
        min: [p.left - thick(p, 'left'), p.floor ? -SLAB : 0, p.back - thick(p, 'back')],
        max: [p.right + thick(p, 'right'), p.height + (p.ceiling ? SLAB : 0), p.front + thick(p, 'front')],
      }),
    );
  }
  // Wall pieces: each its own wall, its front face its room side; it goes when the eye is behind it.
  for (const asm of wallPieces(doc)) {
    const p = asm.generator!.params as unknown as WallPieceParams;
    const A = nodeAffine(doc, asm.id);
    const id = (role: string) => genPartId(asm.id, role);
    const T = p.thickness;
    const generated = descendants(doc, asm.id).filter((c) => (doc.parts[c] ?? doc.assemblies[c])?.role !== undefined);
    shell.shellIds.push(...generated);
    const hosted = p.openings.flatMap((o) => [id(`window-${o.id}`), id(`casing-${o.id}`), id(`casing-back-${o.id}`), id(`door-${o.id}`)]);
    const ids = [id('wall'), ...hosted].filter(exists);
    const outward = rotate(A.m, [0, 0, -1]);
    shell.walls.push({ room: asm.id, ids, point: apply(A, [p.length / 2, p.height / 2, T]), outward });
    for (const o of p.openings) {
      if (o.kind !== 'window' || !exists(id(`window-${o.id}`))) continue;
      const w = wallCut(o);
      shell.windows.push({ id: o.id, part: id(`window-${o.id}`), center: apply(A, [w.x + w.w / 2, w.y + w.h / 2, T / 2]), outward, area: w.w * w.h });
    }
    bounds.push(transformBox(A, { min: [0, 0, 0], max: [p.length, p.height, T] }));
  }
  shell.bounds = bounds.length ? union(bounds) : null;
  shells.set(doc, shell);
  return shell;
}
