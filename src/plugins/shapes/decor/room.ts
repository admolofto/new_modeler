import { z } from 'zod';
import { channeledBox, type Block } from '../../../geometry/orthogonal';
import { box, mergeGeoms, translateGeom } from '../../../geometry/solids';
import type { Geom, Handle, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { formatInches as f, inches } from '../../../model/units';
import { PluginError, registerShape, shapes, type SurfaceMap } from '../../registry';
import { boxFaceInfo } from '../box';

/**
 * The room generator's pieces (A7), all `internal` decor: walls with openings cut through them,
 * floor and ceiling slabs, trim (baseboard runs, casings with a stool and apron), windows and door
 * leaves. Origin at the min corner, front (+Z) toward the room. Geometry is exact integer boxes and
 * `channeledBox` solids (watertight), so the renderer and the cutaway can rely on it. Pure.
 */

const Length = z.int().positive();
const OpeningId = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** Box face handles of a part's bounds, for picking and snapping: nothing to push or pull. */
const boundsHandles = (x: number, y: number, z: number): Handle[] =>
  shapes.get('box').handles({ x, y, z }).filter((h) => h.kind === 'face').map((h) => ({ ...h, drives: [] }));

/** Every face of a channeled solid in one tag (`channeledBox` names its own and the cut's faces). */
const oneTag = (g: Geom, tag: string): Geom => {
  for (const face of g.faces) face.tag = tag;
  return g;
};

// ── wall ─────────────────────────────────────────────────────────────────────

/** An opening through a wall, wall-local: x along it from its start, y up from the floor. */
export interface WallOpening {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WallParams {
  /** Length (along local x), height, thickness (local z: the room side is +Z). */
  x: number;
  y: number;
  z: number;
  openings: WallOpening[];
  finish: Finish;
}

/** A reveal face of an opening, by which way it faces: the left jamb faces +X (toward the opening). */
function revealTag(n: V3): string {
  if (n[0] > 0.5) return 'jamb-left';
  if (n[0] < -0.5) return 'jamb-right';
  return n[1] < 0 ? 'head' : 'sill';
}

/**
 * A wall: a box with each opening cut through it (`channeledBox` through-blocks). Openings must lie
 * inside it, leave wall above them, and not overlap (channeledBox would merge them silently).
 * Reveals are tagged `<id>:jamb-left | jamb-right | head | sill` (no sill when it starts at the floor).
 */
export function wallGeom(p: WallParams): Geom {
  for (const o of p.openings) {
    const what = `opening ${o.id}`;
    if (o.x < 0 || o.x + o.w > p.x) throw new PluginError(`${what} (${f(o.w)} wide at ${f(o.x)}) runs past the ends of the ${f(p.x)} wall`);
    if (o.y < 0) throw new PluginError(`${what} starts below the floor`);
    if (o.y + o.h >= p.y) throw new PluginError(`${what} reaches ${f(o.y + o.h)}, so it leaves no wall above it under the ${f(p.y)} top`);
  }
  p.openings.forEach((a, i) => {
    for (const b of p.openings.slice(i + 1)) {
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) throw new PluginError(`openings ${a.id} and ${b.id} overlap`);
    }
  });
  const blocks = p.openings.map((o): Block => ({ featureId: o.id, min: [o.x, o.y, 0], max: [o.x + o.w, o.y + o.h, p.z], axis: 2, label: `opening ${o.id}` }));
  const g = channeledBox([p.x, p.y, p.z], blocks, boxFaceInfo, 'wall');
  for (const face of g.faces) {
    const m = /^(.+):wall$/.exec(face.tag);
    if (m) face.tag = `${m[1]}:${revealTag(face.normal)}`;
  }
  return g;
}

registerShape<WallParams>({
  type: 'wall',
  version: 1,
  schema: z.object({
    x: Length,
    y: Length,
    z: Length,
    openings: z.array(z.object({ id: OpeningId, x: z.int(), y: z.int(), w: Length, h: Length })).default(() => []),
    finish: Finish.default(() => ({ preset: 'paint', color: '#ece8df' })),
  }) as z.ZodType<WallParams>,
  describe: 'A room wall (made by the room generator).',
  decor: { category: 'room', label: 'Wall', internal: true },
  build: (p) => ({ geom: wallGeom(p) }),
  handles: (p) => shapes.get('box').handles({ x: p.x, y: p.y, z: p.z }).filter((h) => h.kind === 'face'),
  surfaces: (p) => ({ base: { finish: p.finish } }),
});

// ── slab (floor, ceiling) ───────────────────────────────────────────────────

export interface SlabParams {
  x: number;
  y: number;
  z: number;
  finish: Finish;
}

registerShape<SlabParams>({
  type: 'slab',
  version: 1,
  schema: z.object({ x: Length, y: Length, z: Length, finish: Finish.default(() => ({ preset: 'floor:oak-plank' })) }) as z.ZodType<SlabParams>,
  describe: 'A floor or ceiling slab (made by the room generator); its texture runs along the part grain.',
  decor: { category: 'room', label: 'Slab', internal: true },
  build: (p) => ({ geom: slabGeom(p) }),
  handles: (p) => shapes.get('box').handles({ x: p.x, y: p.y, z: p.z }).filter((h) => h.kind === 'face'),
  surfaces: (p) => ({ base: { finish: p.finish } }),
});

/** A box with its faces tagged like a box part's (face:top, face:front…). */
function slabGeom(p: { x: number; y: number; z: number }): Geom {
  return channeledBox([p.x, p.y, p.z], [], boxFaceInfo, 'slab');
}

// ── trim (baseboard runs, casings) ──────────────────────────────────────────

export interface TrimStool {
  /** How far it stands out from the wall. */
  depth: number;
  thickness: number;
  /** How far it runs past the casing at each end. */
  horn: number;
}

export type TrimParams =
  | { style: 'run'; x: number; y: number; z: number; finish: Finish }
  | {
      style: 'frame';
      /** The opening it surrounds. */
      w: number;
      h: number;
      /** Casing width (each leg) and thickness. */
      width: number;
      thickness: number;
      /** 3: legs and a head (doors, a stool under a window); 4: a picture frame. */
      sides: 3 | 4;
      /** A window stool under the opening (with sides 3), and an apron this tall under it. */
      stool: TrimStool | null;
      apron: number | null;
      finish: Finish;
    };

/** Where a frame's pieces go, from its min corner: the casing's box and the opening's corner in it. */
export function frameLayout(p: Extract<TrimParams, { style: 'frame' }>) {
  const horn = p.stool ? p.stool.horn : 0;
  const apron = p.stool && p.apron ? p.apron : 0;
  const base = apron + (p.stool ? p.stool.thickness : 0);
  const below = p.sides === 4 && !p.stool ? p.width : 0;
  const casing = { x: horn, y: base, w: p.w + 2 * p.width, h: below + p.h + p.width };
  const size: V3 = [casing.w + 2 * horn, base + casing.h, Math.max(p.thickness, p.stool?.depth ?? 0)];
  /** The opening's min corner, from the frame's. */
  const opening: [number, number] = [horn + p.width, base + below];
  return { horn, apron, base, below, casing, size, opening };
}

function trimGeom(p: TrimParams): Geom {
  if (p.style === 'run') return oneTag(slabGeom(p), 'trim');
  const l = frameLayout(p);
  const block: Block = { featureId: 'open', min: [p.width, l.below, 0], max: [p.width + p.w, l.below + p.h, p.thickness], axis: 2, label: 'its opening' };
  const casing = translateGeom(oneTag(channeledBox([l.casing.w, l.casing.h, p.thickness], [block], boxFaceInfo, 'casing'), 'casing'), [l.casing.x, l.casing.y, 0]);
  if (!p.stool) return casing;
  const pieces = [casing, box([0, l.apron, 0], [l.size[0], l.base, p.stool.depth], 'stool')];
  if (l.apron) pieces.push(box([l.horn, 0, 0], [l.horn + l.casing.w, l.apron, p.thickness], 'apron'));
  return mergeGeoms(...pieces);
}

const Stool = z.object({ depth: Length, thickness: Length, horn: z.int().nonnegative() });

registerShape<TrimParams>({
  type: 'trim',
  version: 1,
  schema: z.discriminatedUnion('style', [
    z.object({ style: z.literal('run'), x: Length, y: Length, z: Length, finish: Finish.default(() => ({ preset: 'paint', color: '#f4f2ec' })) }),
    z.object({
      style: z.literal('frame'),
      w: Length,
      h: Length,
      width: Length,
      thickness: Length,
      sides: z.union([z.literal(3), z.literal(4)]).default(3),
      stool: Stool.nullable().default(null),
      apron: Length.nullable().default(null),
      finish: Finish.default(() => ({ preset: 'paint', color: '#f4f2ec' })),
    }),
  ]) as z.ZodType<TrimParams>,
  describe: 'Room trim (made by the room generator): a baseboard run, or a casing around an opening.',
  decor: { category: 'room', label: 'Trim', internal: true, solid: false },
  build: (p) => ({ geom: trimGeom(p) }),
  handles: (p) => (p.style === 'run' ? boundsHandles(p.x, p.y, p.z) : boundsHandles(...frameLayout(p).size)),
  surfaces: (p) => ({ base: { finish: p.finish }, tags: { trim: { finish: p.finish }, casing: { finish: p.finish }, stool: { finish: p.finish }, apron: { finish: p.finish } } }),
});

// ── window ───────────────────────────────────────────────────────────────────

export const WINDOW_STYLES = ['double-hung', 'casement', 'picture', 'slider'] as const;
export type WindowStyle = (typeof WINDOW_STYLES)[number];

export interface WindowParams {
  /** The opening it fills (width, height) and its depth (front = the room side). */
  x: number;
  y: number;
  z: number;
  style: WindowStyle;
  /** Lites per sash: columns, rows. */
  grid?: [number, number] | undefined;
  finish: Finish;
  glass: Finish;
}

/** The frame's face width, a sash's stiles and rails, a picture window's stop, muntin bars, the pane. */
const FRAME = inches(1.5);
const STILE = inches(2);
const STOP = inches(1);
const MUNTIN = inches(5 / 8);
const PANE = inches(1 / 4);
/** Casements wider than this split into a pair. */
const CASEMENT_MAX = inches(36);

/** A sash: a frame of stiles and rails round a pane, with muntin bars over it; its box is min..max. */
function sash(min: V3, max: V3, stile: number, grid: [number, number] | undefined, what: string): Geom {
  const [w, h, t] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (w - 2 * stile < inches(1) || h - 2 * stile < inches(1)) throw new PluginError(`this window is too small for its ${what}`);
  const lite: Block = { featureId: 'lite', min: [stile, stile, 0], max: [w - stile, h - stile, t], axis: 2, label: 'its pane' };
  const frame = oneTag(channeledBox([w, h, t], [lite], boxFaceInfo, 'sash'), 'sash');
  const pz = Math.floor((t - PANE) / 2);
  const pieces = [frame, box([stile, stile, pz], [w - stile, h - stile, pz + PANE], 'glass')];
  if (grid) {
    const [cols, rows] = grid;
    const [iw, ih] = [w - 2 * stile, h - 2 * stile];
    for (let c = 1; c < cols; c++) {
      const x = stile + Math.round((iw * c) / cols) - MUNTIN / 2;
      pieces.push(box([x, stile, 0], [x + MUNTIN, h - stile, t], 'muntin'));
    }
    for (let r = 1; r < rows; r++) {
      const y = stile + Math.round((ih * r) / rows) - MUNTIN / 2;
      pieces.push(box([stile, y, 0], [w - stile, y + MUNTIN, t], 'muntin'));
    }
  }
  return translateGeom(mergeGeoms(...pieces), min);
}

/**
 * A window filling its opening: a frame (jambs, head, sill; a mullion between a casement pair) and
 * its sashes — two sliding past each other in two planes (double-hung, slider), one or a pair of
 * casements, or a fixed pane in a narrow stop (picture). Glass is a 1/4" pane in each sash.
 */
export function windowGeom(p: WindowParams): Geom {
  const { x: W, y: H, z: D } = p;
  if (W <= 2 * FRAME + inches(2) || H <= 2 * FRAME + inches(2)) throw new PluginError(`a ${f(W)} × ${f(H)} window is too small for its frame`);
  const gap = 4;
  // Sash thickness: two fit side by side in the depth with a little frame left at each face.
  const t = Math.max(8, Math.min(inches(1.25), Math.floor((D - 2 * gap - inches(1 / 2)) / 2)));
  const mid = Math.floor(D / 2);
  const outer: [number, number] = [mid - gap - t, mid - gap];
  const inner: [number, number] = [mid + gap, mid + gap + t];
  const single: [number, number] = [mid - Math.floor(t / 2), mid - Math.floor(t / 2) + t];
  const [x0, x1, y0, y1] = [FRAME, W - FRAME, FRAME, H - FRAME];
  const openings: Block[] = [];
  const sashes: Geom[] = [];
  if (p.style === 'casement' && x1 - x0 > CASEMENT_MAX) {
    // A pair, with a mullion as wide as the frame between them.
    const m0 = Math.floor((W - FRAME) / 2);
    openings.push({ featureId: 'left', min: [x0, y0, 0], max: [m0, y1, D], axis: 2, label: 'its left light' });
    openings.push({ featureId: 'right', min: [m0 + FRAME, y0, 0], max: [x1, y1, D], axis: 2, label: 'its right light' });
    sashes.push(sash([x0, y0, single[0]], [m0, y1, single[1]], STILE, p.grid, 'casements'));
    sashes.push(sash([m0 + FRAME, y0, single[0]], [x1, y1, single[1]], STILE, p.grid, 'casements'));
  } else {
    openings.push({ featureId: 'light', min: [x0, y0, 0], max: [x1, y1, D], axis: 2, label: 'its light' });
    if (p.style === 'double-hung') {
      // The upper sash outside, the lower one inside, their meeting rails side by side.
      const meet = Math.round((y0 + y1) / 2);
      const half = Math.round(STILE / 2);
      sashes.push(sash([x0, meet - half, outer[0]], [x1, y1, outer[1]], STILE, p.grid, 'sashes'));
      sashes.push(sash([x0, y0, inner[0]], [x1, meet + half, inner[1]], STILE, p.grid, 'sashes'));
    } else if (p.style === 'slider') {
      const meet = Math.round((x0 + x1) / 2);
      const half = Math.round(STILE / 2);
      sashes.push(sash([x0, y0, outer[0]], [meet + half, y1, outer[1]], STILE, p.grid, 'sashes'));
      sashes.push(sash([meet - half, y0, inner[0]], [x1, y1, inner[1]], STILE, p.grid, 'sashes'));
    } else {
      sashes.push(sash([x0, y0, single[0]], [x1, y1, single[1]], p.style === 'picture' ? STOP : STILE, p.grid, p.style === 'picture' ? 'pane' : 'casement'));
    }
  }
  const frame = oneTag(channeledBox([W, H, D], openings, boxFaceInfo, 'window frame'), 'frame');
  return mergeGeoms(frame, ...sashes);
}

/** The window tags: frame and sashes in its finish, glass in its glass. */
export const WINDOW_TAGS = ['frame', 'sash', 'muntin', 'glass'] as const;

registerShape<WindowParams>({
  type: 'window',
  version: 1,
  schema: z.object({
    x: Length,
    y: Length,
    z: Length,
    style: z.enum(WINDOW_STYLES).default('double-hung'),
    grid: z.tuple([z.int().min(1).max(8), z.int().min(1).max(8)]).optional(),
    finish: Finish.default(() => ({ preset: 'paint', color: '#f4f2ec' })),
    glass: Finish.default(() => ({ preset: 'glass:clear' })),
  }) as z.ZodType<WindowParams>,
  describe: 'A window in a room wall (made by the room generator).',
  decor: { category: 'room', label: 'Window', internal: true },
  build: (p) => ({ geom: windowGeom(p) }),
  handles: (p) => boundsHandles(p.x, p.y, p.z),
  surfaces: (p): SurfaceMap => {
    const look = { finish: p.finish };
    return { base: look, tags: { frame: look, sash: look, muntin: look, glass: { finish: p.glass } } };
  },
});

// ── door leaf ───────────────────────────────────────────────────────────────

export const LEAF_STYLES = ['panel', 'slab', 'glass'] as const;
export type LeafStyle = (typeof LEAF_STYLES)[number];

export interface DoorLeafParams {
  x: number;
  y: number;
  /** Thickness (1 3/8" for an interior door). */
  z: number;
  style: LeafStyle;
  finish: Finish;
  glass: Finish;
}

/** Panel recess depth on each face. */
const RECESS = inches(1 / 4);

/** Stiles and rails for a leaf this size: stile, top rail, bottom rail (narrow leaves scale down). */
function leafFrame(w: number, h: number): { stile: number; top: number; bottom: number } {
  const stile = Math.min(inches(4.5), Math.floor(w / 5));
  return { stile, top: stile, bottom: Math.min(inches(9), Math.max(stile, Math.floor(h / 9))) };
}

/**
 * A door leaf: a slab; two panels recessed 1/4" into both faces under and over a lock rail; or a
 * glass lite through it (a 1/4" pane in the middle of its thickness).
 */
export function leafGeom(p: DoorLeafParams): Geom {
  const { x: w, y: h, z: t } = p;
  if (p.style === 'slab') return slabGeom(p);
  const { stile, top, bottom } = leafFrame(w, h);
  if (w - 2 * stile < inches(1) || h - top - bottom < inches(4)) throw new PluginError(`a ${f(w)} × ${f(h)} leaf is too small for a ${p.style} door`);
  if (p.style === 'glass') {
    const lite: Block = { featureId: 'lite', min: [stile, bottom, 0], max: [w - stile, h - top, t], axis: 2, label: 'its lite' };
    const leaf = channeledBox([w, h, t], [lite], boxFaceInfo, 'door leaf');
    for (const face of leaf.faces) if (face.tag === 'lite:wall') face.tag = 'stile';
    const pz = Math.floor((t - PANE) / 2);
    return mergeGeoms(leaf, box([stile, bottom, pz], [w - stile, h - top, pz + PANE], 'glass'));
  }
  if (t <= 2 * RECESS + inches(1 / 4)) throw new PluginError('a panel door this thin has no room for its panels');
  // Two panels, under and over a lock rail about 3' up (or across the middle of a short leaf).
  const rail = 2 * stile;
  const lockMid = Math.min(inches(38), Math.round(h * 0.45));
  const panels: [number, number][] =
    lockMid - rail / 2 - bottom >= inches(4) && h - top - (lockMid + rail / 2) >= inches(4)
      ? [[bottom, lockMid - rail / 2], [lockMid + rail / 2, h - top]]
      : [[bottom, h - top]];
  const blocks = panels.flatMap(([a, b], i): Block[] => [
    { featureId: `panel-${i + 1}f`, min: [stile, a, t - RECESS], max: [w - stile, b, t], axis: 2, label: 'a panel' },
    { featureId: `panel-${i + 1}b`, min: [stile, a, 0], max: [w - stile, b, RECESS], axis: 2, label: 'a panel' },
  ]);
  const leaf = channeledBox([w, h, t], blocks, boxFaceInfo, 'door leaf');
  for (const face of leaf.faces) if (face.tag.startsWith('panel-')) face.tag = 'panel';
  return leaf;
}

registerShape<DoorLeafParams>({
  type: 'doorLeaf',
  version: 1,
  schema: z.object({
    x: Length,
    y: Length,
    z: Length,
    style: z.enum(LEAF_STYLES).default('panel'),
    finish: Finish.default(() => ({ preset: 'paint', color: '#f4f2ec' })),
    glass: Finish.default(() => ({ preset: 'glass:clear' })),
  }) as z.ZodType<DoorLeafParams>,
  describe: 'A room door leaf (made by the room generator).',
  decor: { category: 'room', label: 'Door', internal: true },
  build: (p) => ({ geom: leafGeom(p) }),
  handles: (p) => boundsHandles(p.x, p.y, p.z),
  surfaces: (p): SurfaceMap => ({ base: { finish: p.finish }, prefixes: [['face:', { finish: p.finish }]], tags: { panel: { finish: p.finish }, stile: { finish: p.finish }, glass: { finish: p.glass } } }),
});
