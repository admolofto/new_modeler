import { z } from 'zod';
import type { V3 } from '../../geometry/types';
import { Finish, type Rotation, type Vec3 } from '../../model/schema';
import { formatInches as f, inches } from '../../model/units';
import { registerGenerator, shapes, type GenAction, type GenFace, type GenFaceDrive, type GenGroup, type GenMotion, type GenOutput, type GenPart, type ParamField } from '../registry';
import { PULL_FINISH, pullBox, type PullParams } from '../shapes/decor/hardware';
import { RECESSED_HEIGHT, recessedWidth } from '../shapes/decor/lighting';
import { frameLayout, WINDOW_STYLES, type TrimParams, type WallOpening, type WindowStyle } from '../shapes/decor/room';

/**
 * The room around the model (A6): a rectangle of walls (any of the four can be off), a floor and a
 * ceiling, baseboards, and openings — windows, doors (in folders that swing) and cased openings — cut
 * through the walls. Params are room coordinates, which are world coordinates: the room assembly
 * sits at the origin. Its parts are decor (no cut list) and it's `surroundings`, so fits, dims and
 * placement ignore it. Each wall's frame turns by quarter turns; this file does that math itself
 * (model/world.ts would close an import cycle through the plugin pipeline).
 */

export const ROOM_SIDES = ['back', 'left', 'right', 'front'] as const;
export type RoomSide = (typeof ROOM_SIDES)[number];

interface OpeningBase {
  id: string;
  wall: RoomSide;
  /** Its center along the wall, in room coordinates: x on the back and front walls, z on the side walls. */
  at: number;
  width: number;
  height: number;
  casing: boolean;
}
export interface WindowOpening extends OpeningBase {
  kind: 'window';
  sill: number;
  style: WindowStyle;
  grid?: [number, number] | undefined;
  stool: boolean;
}
export interface DoorOpening extends OpeningBase {
  kind: 'door';
  leaf: 'panel' | 'slab' | 'glass' | 'none';
  /** Seen from inside the room. */
  hinge: 'left' | 'right';
  swing: 'in' | 'out';
  angle: number;
  handle: 'lever' | 'knob';
}
export interface PlainOpening extends OpeningBase {
  kind: 'opening';
  sill: number;
}
export type RoomOpening = WindowOpening | DoorOpening | PlainOpening;
export type OpeningKind = RoomOpening['kind'];

export interface RoomFinishes {
  walls: Finish;
  floor: Finish;
  ceiling: Finish;
  trim: Finish;
  doors: Finish;
  windows: Finish;
}

export interface RoomParams {
  /** Inside faces of the walls, room (= world) coordinates: x of the left and right, z of the back and front. */
  left: number;
  right: number;
  back: number;
  front: number;
  height: number;
  walls: RoomSide[];
  wallThickness: number;
  openings: RoomOpening[];
  floor: boolean;
  ceiling: boolean;
  floorGrain: 'x' | 'z';
  baseboard: { height: number; thickness: number } | null;
  /** Recessed ceiling lights in an even grid (null: none). */
  cans: RoomCans | null;
  finishes: RoomFinishes;
}

export interface RoomCans {
  rows: number;
  cols: number;
  /** The aperture (4" or 6" cans). */
  diameter: number;
}

const TRIM_PAINT: Finish = { preset: 'paint', color: '#f4f2ec', roughness: 0.35 };
export const ROOM_FINISHES: RoomFinishes = {
  walls: { preset: 'paint', color: '#ece8df' },
  floor: { preset: 'floor:oak-plank' },
  ceiling: { preset: 'paint', color: '#f6f5f1' },
  trim: TRIM_PAINT,
  doors: TRIM_PAINT,
  windows: TRIM_PAINT,
};
export const ROOM_HEIGHT = inches(96);
export const WALL_THICKNESS = inches(4.5);
export const BASEBOARD = { height: inches(4.5), thickness: inches(0.5) };

/** Floor and ceiling slab thickness. */
export const SLAB = inches(1.5);
/** Wall left above an opening, at least. */
export const HEADER = inches(1);
/** Casing legs and head, and the window stool and apron. */
export const CASING_WIDTH = inches(3);
export const CASING_THICKNESS = inches(3 / 4);
const STOOL = { depth: inches(1.75), thickness: inches(1), horn: inches(3 / 4) };
const APRON = inches(3);
/** A window's depth: the wall's, at most this (flush with the room side). */
export const WINDOW_DEPTH = inches(4 + 9 / 16);
/** Door leaves: 1 3/8" thick, 3/4" off the floor, 1/8" clear of the jambs and head. */
export const LEAF_THICKNESS = inches(1 + 3 / 8);
const UNDERCUT = inches(3 / 4);
const LEAF_GAP = inches(1 / 8);
/** The handle's center: this far in from the latch edge, this high. */
const BACKSET = inches(2 + 3 / 8);
const HANDLE_HEIGHT = inches(36);
/** The smallest room, either way. */
const MIN_ROOM = inches(36);
/** Recessed cans: 4" apertures. */
export const CAN_DIAMETER = inches(4);

/** New openings ("Add window here"): width, height and sill. */
export const OPENING_DEFAULTS: Record<OpeningKind, { width: number; height: number; sill: number }> = {
  window: { width: inches(36), height: inches(48), sill: inches(36) },
  door: { width: inches(32), height: inches(80), sill: 0 },
  opening: { width: inches(36), height: inches(80), sill: 0 },
};
const ID_PREFIX: Record<OpeningKind, string> = { window: 'w', door: 'd', opening: 'o' };

// ── wall frames ──────────────────────────────────────────────────────────────

const built = (p: Pick<RoomParams, 'walls'>, side: RoomSide) => p.walls.includes(side);
/** A wall's thickness where it's built, else 0 (Tl, Tr, Tb, Tf). */
const thick = (p: Pick<RoomParams, 'walls' | 'wallThickness'>, side: RoomSide) => (built(p, side) ? p.wallThickness : 0);

/** Each wall's way out of the room. */
export const WALL_OUTWARD: Record<RoomSide, V3> = { back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], front: [0, 0, 1] };
/** Quarter turns about +Y from the room's frame to each wall's. */
const TURNS: Record<RoomSide, number> = { back: 0, left: 1, right: -1, front: 2 };

export interface WallFrame {
  side: RoomSide;
  position: Vec3;
  rotation: Rotation;
  /** Along its local x; its height is the room's and its thickness the wall thickness. */
  length: number;
}

/**
 * Where a wall sits: local x runs along it (left → right as seen from inside), y up, and its local
 * +Z face (`face:front`) faces the room. The back and front walls run the full outside width
 * (covering the corners); the side walls span back → front.
 */
export function wallFrame(p: RoomParams, side: RoomSide): WallFrame {
  const T = p.wallThickness;
  const [Tl, Tr] = [thick(p, 'left'), thick(p, 'right')];
  const across = p.right + Tr - (p.left - Tl);
  const along = p.front - p.back;
  switch (side) {
    case 'back':
      return { side, position: [p.left - Tl, 0, p.back - T], rotation: [0, 0, 0], length: across };
    case 'left':
      return { side, position: [p.left - T, 0, p.front], rotation: [0, 90, 0], length: along };
    case 'right':
      return { side, position: [p.right + T, 0, p.back], rotation: [0, -90, 0], length: along };
    case 'front':
      return { side, position: [p.right + Tr, 0, p.front + T], rotation: [0, 180, 0], length: across };
  }
}

/** A wall-local x for a room coordinate along that wall (x on back / front, z on left / right). */
export function wallX(p: RoomParams, side: RoomSide, c: number): number {
  const [Tl, Tr] = [thick(p, 'left'), thick(p, 'right')];
  switch (side) {
    case 'back':
      return c - (p.left - Tl);
    case 'left':
      return p.front - c;
    case 'right':
      return c - p.back;
    case 'front':
      return p.right + Tr - c;
  }
}

/** The room coordinate along a wall at its local x (the inverse of `wallX`). */
export function roomCoordAt(p: RoomParams, side: RoomSide, x: number): number {
  const [Tl, Tr] = [thick(p, 'left'), thick(p, 'right')];
  switch (side) {
    case 'back':
      return x + (p.left - Tl);
    case 'left':
      return p.front - x;
    case 'right':
      return x + p.back;
    case 'front':
      return p.right + Tr - x;
  }
}

/** A quarter turn about +Y, right-handed: +X → −Z. */
function turnY(v: V3, quarters: number): V3 {
  let [x, y, z] = v;
  for (let q = ((quarters % 4) + 4) % 4; q > 0; q--) [x, z] = [z, -x];
  return [x, y, z];
}

/** A wall-local point in room coordinates. */
export function wallToRoom(p: RoomParams, side: RoomSide, v: V3): V3 {
  const fr = wallFrame(p, side);
  const r = turnY(v, TURNS[side]);
  return [fr.position[0] + r[0], fr.position[1] + r[1], fr.position[2] + r[2]];
}

/** The inside of a wall, end to end, in room coordinates along it. */
export function insideSpan(p: RoomParams, side: RoomSide): [number, number] {
  return side === 'back' || side === 'front' ? [p.left, p.right] : [p.back, p.front];
}

/** The walls at the low and high ends of a wall's span (`runs past the right wall`). */
export function spanEnds(side: RoomSide): [RoomSide, RoomSide] {
  return side === 'back' || side === 'front' ? ['left', 'right'] : ['back', 'front'];
}

/** An opening's extent along its wall, room coordinates. */
export function openingSpan(o: Pick<RoomOpening, 'at' | 'width'>): [number, number] {
  const lo = o.at - Math.floor(o.width / 2);
  return [lo, lo + o.width];
}

/** How high an opening starts: doors at the floor. */
export const openingBottom = (o: RoomOpening): number => (o.kind === 'door' ? 0 : o.sill);

/** An opening as a cut through its wall, in the wall's frame. */
export function wallOpening(p: RoomParams, o: RoomOpening): WallOpening {
  const [lo, hi] = openingSpan(o).map((c) => wallX(p, o.wall, c)) as [number, number];
  return { id: o.id, x: Math.min(lo, hi), y: openingBottom(o), w: o.width, h: o.height };
}

/** `window w1`, `door d1`, `opening o1`. */
export const openingLabel = (o: Pick<RoomOpening, 'kind' | 'id'>) => `${o.kind} ${o.id}`;

/** Each opening's id: its own, else the next free `w1`, `d1`, `o1` for its kind, in list order. */
export function openingIds(openings: readonly { id?: string | undefined; kind: OpeningKind }[]): string[] {
  const used = new Set(openings.flatMap((o) => (o.id ? [o.id] : [])));
  return openings.map((o) => {
    if (o.id) return o.id;
    let n = 1;
    while (used.has(`${ID_PREFIX[o.kind]}${n}`)) n++;
    const id = `${ID_PREFIX[o.kind]}${n}`;
    used.add(id);
    return id;
  });
}

/** The next free id for a new opening of this kind. */
export const nextOpeningId = (openings: readonly RoomOpening[], kind: OpeningKind) => openingIds([...openings, { kind }]).at(-1)!;

// ── params ───────────────────────────────────────────────────────────────────

const Side = z.enum(ROOM_SIDES);
const OpeningId = z.string().regex(/^[A-Za-z0-9_-]+$/, 'opening ids are letters, digits, _ and - (no ":" or ".")');
const base = {
  id: OpeningId.optional(),
  wall: Side,
  at: z.int(),
  width: z.int().min(inches(12)),
  height: z.int().min(inches(12)),
  casing: z.boolean().default(true),
};
const Opening = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('window'),
    sill: z.int().nonnegative().default(OPENING_DEFAULTS.window.sill),
    style: z.enum(WINDOW_STYLES).default('double-hung'),
    grid: z.tuple([z.int().min(1).max(8), z.int().min(1).max(8)]).optional(),
    stool: z.boolean().default(true),
  }),
  z.object({
    ...base,
    kind: z.literal('door'),
    leaf: z.enum(['panel', 'slab', 'glass', 'none']).default('panel'),
    hinge: z.enum(['left', 'right']).default('left'),
    swing: z.enum(['in', 'out']).default('in'),
    angle: z.number().gt(0).max(180).default(90),
    handle: z.enum(['lever', 'knob']).default('lever'),
  }),
  z.object({ ...base, kind: z.literal('opening'), sill: z.int().nonnegative().default(0) }),
]);

type ParsedRoom = Omit<RoomParams, 'openings'> & { openings: (Omit<RoomOpening, 'id'> & { id?: string | undefined })[] };

/** Readable checks (`openings[w1]: a 36" window centered at 160" runs 10" past the right wall`). */
function roomChecks(p: ParsedRoom, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (p.right - p.left < MIN_ROOM) issue(['right'], `the room is ${f(p.right - p.left)} wide inside (left ${f(p.left)} to right ${f(p.right)}); it needs at least ${f(MIN_ROOM)}`);
  if (p.front - p.back < MIN_ROOM) issue(['front'], `the room is ${f(p.front - p.back)} deep inside (back ${f(p.back)} to front ${f(p.front)}); it needs at least ${f(MIN_ROOM)}`);
  if (new Set(p.walls).size !== p.walls.length) issue(['walls'], 'list each wall once');
  const ids = openingIds(p.openings);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) issue(['openings', i, 'id'], `openings[${id}]: two openings are both ${id}`);
  });
  const all = p.openings as RoomOpening[];
  all.forEach((o, i) => {
    const name = `openings[${ids[i]}]`;
    const [lo, hi] = openingSpan(o);
    const [min, max] = insideSpan(p as RoomParams, o.wall);
    const [minWall, maxWall] = spanEnds(o.wall);
    const what = `a ${f(o.width)} ${o.kind} centered at ${f(o.at)}`;
    if (hi - lo > max - min) issue(['openings', i, 'width'], `${name}: ${what} is wider than the ${f(max - min)} ${o.wall} wall`);
    else if (lo < min) issue(['openings', i, 'at'], `${name}: ${what} runs ${f(min - lo)} past the ${minWall} wall`);
    else if (hi > max) issue(['openings', i, 'at'], `${name}: ${what} runs ${f(hi - max)} past the ${maxWall} wall`);
    const top = openingBottom(o) + o.height;
    if (top > p.height - HEADER) {
      issue(['openings', i, 'height'], `${name}: its top at ${f(top)} leaves less than ${f(HEADER)} of wall under the ${f(p.height)} ceiling`);
    }
    for (let j = 0; j < i; j++) {
      const q = all[j]!;
      if (q.wall !== o.wall) continue;
      const [a, b] = openingSpan(q);
      const [y0, y1] = [openingBottom(q), openingBottom(q) + q.height];
      if (lo < b && a < hi && openingBottom(o) < y1 && y0 < top) issue(['openings', i, 'at'], `${name}: it overlaps ${openingLabel({ kind: q.kind, id: ids[j]! })} on the ${o.wall} wall`);
    }
  });
}

/** Gives each opening without one an id (w1, d1, o1 by kind), so tags and edits can name it. */
function fillOpeningIds(p: ParsedRoom): RoomParams {
  const ids = openingIds(p.openings);
  return { ...p, openings: p.openings.map((o, i) => ({ id: ids[i]!, ...o, ...(o.id === undefined && { id: ids[i]! }) }) as RoomOpening) };
}

export const roomSchema = z
  .object({
    left: z.int(),
    right: z.int(),
    back: z.int(),
    front: z.int(),
    height: z.int().min(inches(72)).max(inches(240)).default(ROOM_HEIGHT),
    walls: z.array(Side).default(() => [...ROOM_SIDES]),
    wallThickness: z.int().min(inches(2)).max(inches(24)).default(WALL_THICKNESS),
    openings: z.array(Opening).default(() => []),
    floor: z.boolean().default(true),
    ceiling: z.boolean().default(true),
    floorGrain: z.enum(['x', 'z']).default('x'),
    baseboard: z
      .object({ height: z.int().positive().default(BASEBOARD.height), thickness: z.int().positive().default(BASEBOARD.thickness) })
      .nullable()
      .default(() => ({ ...BASEBOARD })),
    cans: z
      .object({ rows: z.int().min(1).max(8), cols: z.int().min(1).max(8), diameter: z.int().min(inches(2)).max(inches(8)).default(CAN_DIAMETER) })
      .nullable()
      .default(null),
    finishes: z
      .object({
        walls: Finish.default(() => ({ ...ROOM_FINISHES.walls })),
        floor: Finish.default(() => ({ ...ROOM_FINISHES.floor })),
        ceiling: Finish.default(() => ({ ...ROOM_FINISHES.ceiling })),
        trim: Finish.default(() => ({ ...ROOM_FINISHES.trim })),
        doors: Finish.default(() => ({ ...ROOM_FINISHES.doors })),
        windows: Finish.default(() => ({ ...ROOM_FINISHES.windows })),
      })
      .default(() => structuredClone(ROOM_FINISHES)),
  })
  .superRefine((p, ctx) => roomChecks(p as ParsedRoom, ctx))
  .transform((p) => fillOpeningIds(p as ParsedRoom));

// ── generate ─────────────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A window's (or cased opening's) trim, sized for where it sits: a stool and apron when there's room under it. */
function casingFor(o: RoomOpening, finish: Finish): Extract<TrimParams, { style: 'frame' }> {
  const y = openingBottom(o);
  const frame = { style: 'frame' as const, w: o.width, h: o.height, width: CASING_WIDTH, thickness: CASING_THICKNESS, finish: structuredClone(finish) };
  if (o.kind === 'window' && o.stool && y >= APRON + STOOL.thickness) return { ...frame, sides: 3, stool: { ...STOOL }, apron: APRON };
  return { ...frame, sides: y >= CASING_WIDTH ? 4 : 3, stool: null, apron: null };
}

function generate(p: RoomParams): GenOutput {
  const parts: GenPart[] = [];
  const groups: GenGroup[] = [];
  const motions: GenMotion[] = [];
  const T = p.wallThickness;
  const fin = p.finishes;
  const [x0, x1] = [p.left - thick(p, 'left'), p.right + thick(p, 'right')];
  const [z0, z1] = [p.back - thick(p, 'back'), p.front + thick(p, 'front')];

  if (p.floor) {
    parts.push({ role: 'floor', name: 'Floor', grain: p.floorGrain, unclickable: true, position: [x0, -SLAB, z0], shape: { type: 'slab', params: { x: x1 - x0, y: SLAB, z: z1 - z0, finish: structuredClone(fin.floor) } } });
  }
  if (p.ceiling && p.cans) {
    // Recessed cans in an even grid over the inside, flush under the ceiling.
    const { rows, cols, diameter } = p.cans;
    const w = recessedWidth(diameter);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = p.left + Math.round(((c + 0.5) * (p.right - p.left)) / cols) - Math.round(w / 2);
        const z = p.back + Math.round(((r + 0.5) * (p.front - p.back)) / rows) - Math.round(w / 2);
        parts.push({
          role: `can-${r + 1}-${c + 1}`,
          name: `Ceiling light ${r * cols + c + 1}`,
          grain: 'none',
          unclickable: true,
          position: [x, p.height - RECESSED_HEIGHT, z],
          // Full params: generated parts aren't parsed (defaults filled) on their way into the doc.
          shape: { type: 'recessedLight', params: shapes.parse('recessedLight', { diameter }) },
        });
      }
    }
  }
  if (p.ceiling) {
    parts.push({ role: 'ceiling', name: 'Ceiling', grain: 'none', unclickable: true, position: [x0, p.height, z0], shape: { type: 'slab', params: { x: x1 - x0, y: SLAB, z: z1 - z0, finish: structuredClone(fin.ceiling) } } });
  }

  for (const side of ROOM_SIDES) {
    if (!built(p, side)) continue;
    const fr = wallFrame(p, side);
    const mine = p.openings.filter((o) => o.wall === side);
    /** A part on this wall, placed by its min corner in the wall's frame. */
    const onWall = (part: Omit<GenPart, 'position' | 'rotation'>, at: V3): GenPart => ({ ...part, position: wallToRoom(p, side, at), rotation: [...fr.rotation] });
    parts.push({
      role: `wall-${side}`,
      name: `${cap(side)} wall`,
      grain: 'none',
      position: fr.position,
      rotation: fr.rotation,
      shape: { type: 'wall', params: { x: fr.length, y: p.height, z: T, openings: mine.map((o) => wallOpening(p, o)), finish: structuredClone(fin.walls) } },
    });

    // Baseboards along the inside, broken by doors and openings down at the floor (and their casings).
    if (p.baseboard) {
      const { height: bh, thickness: bt } = p.baseboard;
      let [lo, hi] = insideSpan(p, side);
      // The side runs butt into the back and front runs.
      if (side === 'left' || side === 'right') {
        if (built(p, 'back')) lo += bt;
        if (built(p, 'front')) hi -= bt;
      }
      const gaps = mine
        .filter((o) => openingBottom(o) < bh)
        .map((o) => {
          const [a, b] = openingSpan(o);
          const c = o.casing ? CASING_WIDTH : 0;
          return [a - c, b + c] as [number, number];
        })
        .sort((a, b) => a[0] - b[0]);
      const runs: [number, number][] = [];
      let from = lo;
      for (const [a, b] of gaps) {
        if (a > from) runs.push([from, Math.min(a, hi)]);
        from = Math.max(from, b);
      }
      if (hi > from) runs.push([from, hi]);
      const local = runs
        .filter(([a, b]) => b - a > 0)
        .map(([a, b]) => [wallX(p, side, a), wallX(p, side, b)].sort((m, n) => m - n) as [number, number])
        .sort((a, b) => a[0] - b[0]);
      local.forEach(([a, b], i) => {
        parts.push(
          onWall(
            { role: `baseboard-${side}-${i + 1}`, name: `${cap(side)} baseboard ${i + 1}`, grain: 'none', unclickable: true, shape: { type: 'trim', params: { style: 'run', x: b - a, y: bh, z: bt, finish: structuredClone(fin.trim) } } },
            [a, 0, T],
          ),
        );
      });
    }

    for (const o of mine) {
      const w = wallOpening(p, o);
      const label = `${cap(o.kind)} ${o.id}`;
      if (o.casing) {
        const trim = casingFor(o, fin.trim);
        const layout = frameLayout(trim);
        parts.push(
          onWall(
            { role: `casing-${o.id}`, name: `${label} casing`, grain: 'none', unclickable: true, shape: { type: 'trim', params: trim as unknown as Record<string, unknown> } },
            [w.x - layout.opening[0], w.y - layout.opening[1], T],
          ),
        );
      }
      if (o.kind === 'window') {
        const depth = Math.min(T, WINDOW_DEPTH);
        parts.push(
          onWall(
            {
              role: `window-${o.id}`,
              name: label,
              grain: 'none',
              shape: { type: 'window', params: { x: w.w, y: w.h, z: depth, style: o.style, ...(o.grid && { grid: [...o.grid] }), finish: structuredClone(fin.windows), glass: { preset: 'glass:clear' } } },
            },
            [w.x, w.y, T - depth],
          ),
        );
      }
      if (o.kind === 'door' && o.leaf !== 'none') {
        // In a folder in the wall's frame, which swings about the hinge edge.
        const folder = `door-${o.id}`;
        groups.push({ role: folder, name: label, position: fr.position, rotation: fr.rotation });
        const leafRole = `${folder}-leaf`;
        const lx = w.x + LEAF_GAP;
        const lw = w.w - 2 * LEAF_GAP;
        const lz = Math.floor((T - LEAF_THICKNESS) / 2);
        parts.push({
          role: leafRole,
          name: label,
          grain: 'y',
          group: folder,
          position: [lx, UNDERCUT, lz],
          shape: { type: 'doorLeaf', params: { x: lw, y: o.height - UNDERCUT - LEAF_GAP, z: LEAF_THICKNESS, style: o.leaf, finish: structuredClone(fin.doors), glass: { preset: 'glass:clear' } } },
        });
        // Handles on both faces at the latch edge; a lever points toward the hinge side.
        const handle: PullParams = { style: o.handle, orientation: 'h', finish: { ...PULL_FINISH }, through: LEAF_THICKNESS };
        const [, hy, hz] = pullBox(handle);
        const r = hy / 2;
        const projection = (hz - LEAF_THICKNESS) / 2;
        const latchLeft = o.hinge === 'right';
        const roseX = latchLeft ? lx + BACKSET : lx + lw - BACKSET;
        parts.push({
          role: `${folder}-handle`,
          name: `${label} handle`,
          grain: 'none',
          group: folder,
          mountedOn: leafRole,
          // Turned half round (levers reach −X) when the latch is on the right.
          ...(latchLeft
            ? { position: [Math.round(roseX - r), Math.round(HANDLE_HEIGHT - r), lz - projection] as Vec3 }
            : { position: [Math.round(roseX + r), Math.round(HANDLE_HEIGHT - r), lz + LEAF_THICKNESS + projection] as Vec3, rotation: [0, 180, 0] as Rotation }),
          shape: { type: 'pull', params: handle as unknown as Record<string, unknown> },
        });
        motions.push({
          role: folder,
          name: label,
          type: 'hinge',
          nodes: [folder],
          requires: [leafRole],
          params: { side: o.hinge, toward: o.swing === 'in' ? 'front' : 'back', angle: o.angle },
        });
      }
    }
  }
  return { parts, groups, joints: [], motions };
}

// ── editing ──────────────────────────────────────────────────────────────────

/**
 * Pushing and pulling: a wall's inside face moves that wall (a position), its top the height, its
 * outside face the wall thickness; the ceiling's underside the height. Nothing else moves.
 */
function faceDrive(_p: RoomParams, face: GenFace): GenFaceDrive | null {
  const side = /^wall-(back|left|right|front)$/.exec(face.role)?.[1] as RoomSide | undefined;
  if (side) {
    if (face.axis === 1) return face.max ? { param: 'height', label: 'room height', sign: 1 } : null;
    const out = WALL_OUTWARD[side];
    const axis = out[0] !== 0 ? 0 : 2;
    if (face.axis !== axis) return null;
    // The inside face looks into the room: against the way out.
    const inside = face.max === (out[axis]! < 0);
    if (!inside) return { param: 'wallThickness', label: 'wall thickness', sign: 1 };
    return { param: side, label: `${side} wall`, sign: out[axis]! < 0 ? 1 : -1, kind: 'position' };
  }
  if (face.role === 'ceiling' && face.axis === 1 && !face.max) return { param: 'height', label: 'room height', sign: -1 };
  return null;
}

/** Snaps to 1/2". */
const half = (u: number) => Math.round(u / 32) * 32;

/**
 * A new opening of this kind centered near `at` on a wall: the defaults (a 36" × 48" window on a 36"
 * sill, a 32" × 80" door, a 36" × 80" opening), shrunk to fit a low room or a short wall and slid
 * along the wall to lie inside it.
 */
export function newOpening(p: RoomParams, kind: OpeningKind, wall: RoomSide, at: number): RoomOpening {
  const d = OPENING_DEFAULTS[kind];
  const [min, max] = insideSpan(p, wall);
  const width = Math.max(inches(12), Math.min(d.width, max - min));
  const room = p.height - HEADER;
  let sill = d.sill;
  let height = Math.max(inches(12), Math.min(d.height, room - sill));
  if (sill + height > room) sill = Math.max(0, room - height);
  const centered = Math.min(Math.max(at, min + Math.floor(width / 2)), max - width + Math.floor(width / 2));
  const common = { id: nextOpeningId(p.openings, kind), wall, at: centered, width, height, casing: true };
  if (kind === 'window') return { ...common, kind, sill, style: 'double-hung', stool: true };
  if (kind === 'door') return { ...common, kind, leaf: 'panel', hinge: 'left', swing: 'in', angle: 90, handle: 'lever' };
  return { ...common, kind, sill };
}

/** The opening a clicked part or reveal belongs to (`w1:jamb-left` on a wall, `window-w1`, `door-d1-leaf`…). */
export function openingOf(p: RoomParams, role: string, handle?: string): RoomOpening | null {
  const tag = handle && /^([A-Za-z0-9_-]+):(jamb-left|jamb-right|head|sill)$/.exec(handle)?.[1];
  for (const o of p.openings) {
    if (tag === o.id && role === `wall-${o.wall}`) return o;
    if ([`window-${o.id}`, `casing-${o.id}`, `door-${o.id}`, `door-${o.id}-leaf`, `door-${o.id}-handle`].includes(role)) return o;
  }
  return null;
}

function actions(p: RoomParams, ctx: { role: string; handle?: string; at?: V3 }): GenAction<RoomParams>[] {
  const out: GenAction<RoomParams>[] = [];
  const wall = /^wall-(back|left|right|front)$/.exec(ctx.role)?.[1] as RoomSide | undefined;
  if (wall && ctx.at && (ctx.handle === 'face:front' || ctx.handle === 'face:back')) {
    const at = half(roomCoordAt(p, wall, ctx.at[0]));
    for (const kind of ['window', 'door', 'opening'] as const) {
      out.push({ label: `Add ${kind} here`, params: { ...p, openings: [...p.openings, newOpening(p, kind, wall, at)] } });
    }
  }
  const o = openingOf(p, ctx.role, ctx.handle);
  if (o) out.push({ label: `Remove ${openingLabel(o)}`, params: { ...p, openings: p.openings.filter((x) => x !== o) } });
  return out;
}

const FIELDS: ParamField[] = [
  { path: 'height', label: 'Height', kind: 'length' },
  { path: 'wallThickness', label: 'Wall thickness', kind: 'length' },
  { path: 'floor', label: 'Floor', kind: 'bool' },
  { path: 'ceiling', label: 'Ceiling', kind: 'bool' },
  { path: 'floorGrain', label: 'Floor runs', kind: 'choice', options: ['x', 'z'], when: 'floor' },
  { path: 'finishes.walls', label: 'Walls', kind: 'finish' },
  { path: 'finishes.floor', label: 'Floor', kind: 'finish' },
  { path: 'finishes.ceiling', label: 'Ceiling', kind: 'finish' },
  { path: 'finishes.trim', label: 'Trim', kind: 'finish' },
  { path: 'finishes.doors', label: 'Doors', kind: 'finish' },
  { path: 'finishes.windows', label: 'Windows', kind: 'finish' },
];

registerGenerator<RoomParams>({
  type: 'room',
  version: 1,
  schema: roomSchema as unknown as z.ZodType<RoomParams>,
  describe:
    'The room around the model: walls, floor, ceiling, baseboards, windows and doors (decor: never in the cut list). Make or refit it ' +
    'with the fit_room tool, then change it with update {id, patch: {params}}. One per model; never move it or put things in it. Params ' +
    'are room = world coordinates (1/64"): left, right = x of the inside faces of the left and right walls; back, front = z of the ' +
    'inside faces of the back and front walls. height (floor to ceiling, default 96"), walls (which are built: "back" | "left" | ' +
    '"right" | "front"; default all four), wallThickness (default 4 1/2"), floor, ceiling (bool), floorGrain ("x" | "z"), baseboard ' +
    '({height, thickness} or null), cans ({rows, cols, diameter?} recessed ceiling lights in a grid, or null), finishes {walls, floor, ceiling, trim, doors, windows}. openings — send the whole list to change ' +
    'one: {id? (w1, d1, o1 by kind), kind "window" | "door" | "opening" (a cased opening), wall, at = its CENTER along the wall (x on ' +
    'the back and front walls, z on the left and right), width, height, casing (default true); window: sill (default 36"), style ' +
    '("double-hung" | "casement" | "picture" | "slider"), grid? [columns, rows] of lites per sash, stool (default true); door: leaf ' +
    '("panel" | "slab" | "glass" | "none" = cased doorway), hinge ("left" | "right", seen from inside the room), swing ("in" | "out"), ' +
    'angle (default 90), handle ("lever" | "knob"); opening: sill (default 0)}. Openings stay inside their wall, leave 1" of wall above ' +
    'them and don\'t overlap. Roles: floor, ceiling, wall-<side>, baseboard-<side>-<n>, window-<id>, casing-<id>; a door is a folder ' +
    'door-<id> (door-<id>-leaf, door-<id>-handle) that swings open; can-<row>-<col>.',
  surroundings: true,
  collapse: true,
  lockedParts: true,
  fields: FIELDS,
  generate: (p) => generate(p),
  faceDrive,
  actions,
  materialRefs: () => [],
});
