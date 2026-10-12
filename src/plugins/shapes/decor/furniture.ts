import { z } from 'zod';
import { channeledBox } from '../../../geometry/orthogonal';
import { box, cylinder, extrude, lathe, mergeGeoms, unitCircle } from '../../../geometry/solids';
import type { Geom, V2, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { formatInches as f, inches } from '../../../model/units';
import { PluginError, registerShape, type SurfaceMap } from '../../registry';
import { boxFaceInfo } from '../box';
import { boundsHandles, Length, roundedSlab } from './common';

/**
 * Furniture props (A8, category `furniture`): a bar stool, a dining chair, a dining table and a rug.
 * Simple, clean silhouettes from closed primitives (they show up in client renders), origin at the
 * min corner, front +Z. Pure.
 */

// ── bar stool ────────────────────────────────────────────────────────────────

export interface BarStoolParams {
  seatHeight: number;
  seat: 'round' | 'square';
  /** Seat diameter or width. */
  size: number;
  back: boolean;
  frameFinish: Finish;
  seatFinish: Finish;
}

const SEAT_T = inches(1.5);
const STOOL_LEG_R = inches(5 / 16);
const RUNG_R = inches(3 / 16);
const STOOL_BACK = inches(12);

function stoolLayout(p: BarStoolParams) {
  const R = p.size / 2;
  const a = p.seat === 'round' ? Math.round(R * 0.55) : R - inches(1.25);
  return { R, a, c: R, height: p.seatHeight + (p.back ? STOOL_BACK : 0) };
}

function barStoolGeom(p: BarStoolParams): Geom {
  const { R, a, c } = stoolLayout(p);
  const sh = p.seatHeight;
  if (sh < inches(14) + SEAT_T) throw new PluginError(`a stool seat ${f(sh)} high is too low`);
  const y0 = sh - SEAT_T;
  const bevel = inches(1 / 4);
  const seat =
    p.seat === 'round'
      ? lathe([c, y0, c], [[0, 0], [R - bevel, 0], [R, bevel], [R, SEAT_T - bevel], [R - bevel, SEAT_T], [0, SEAT_T]], 'seat', 32)
      : roundedSlab(0, 0, p.size, p.size, y0, sh, inches(1), 'seat');
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    // The back legs carry on up as the back's posts.
    const top = p.back && sz! < 0 ? sh + STOOL_BACK - inches(1) : y0 + 8;
    return cylinder([c + sx! * a, 0, c + sz! * a], 1, STOOL_LEG_R, top, 'frame', undefined, 12);
  });
  // A footrest: rungs front and back, and a little higher at the sides.
  const foot = Math.max(inches(7), Math.round(sh * 0.36));
  const rungs = [
    cylinder([c - a, foot, c + a], 0, RUNG_R, 2 * a, 'frame', undefined, 8),
    cylinder([c - a, foot, c - a], 0, RUNG_R, 2 * a, 'frame', undefined, 8),
    cylinder([c - a, foot + inches(1.5), c - a], 2, RUNG_R, 2 * a, 'frame', undefined, 8),
    cylinder([c + a, foot + inches(1.5), c - a], 2, RUNG_R, 2 * a, 'frame', undefined, 8),
  ];
  const back = p.back ? [box([c - a - STOOL_LEG_R - inches(0.5), sh + STOOL_BACK - inches(3.5), c - a - inches(3 / 8)], [c + a + STOOL_LEG_R + inches(0.5), sh + STOOL_BACK, c - a + inches(3 / 8)], 'seat')] : [];
  return mergeGeoms(seat, ...legs, ...rungs, ...back);
}

const Height = z.int().min(inches(16)).max(inches(40));

registerShape<BarStoolParams>({
  type: 'barStool',
  version: 1,
  schema: z.object({
    seatHeight: Height.default(inches(24)),
    seat: z.enum(['round', 'square']).default('round'),
    size: z.int().min(inches(11)).max(inches(22)).default(inches(15)),
    back: z.boolean().default(false),
    frameFinish: Finish.default(() => ({ preset: 'metal:matte-black' })),
    seatFinish: Finish.default(() => ({ preset: 'wood:white-oak' })),
  }) as z.ZodType<BarStoolParams>,
  describe: 'Bar stool: seatHeight (24" at a 36" counter, 30" at a 42" bar), seat "round" | "square", size (15"), back, frameFinish, seatFinish. ~24" apart.',
  decor: {
    category: 'furniture',
    label: 'Bar stool',
    defaults: { seatHeight: inches(24), seat: 'round' },
    fields: [
      { path: 'seatHeight', label: 'Seat height', kind: 'length' },
      { path: 'seat', label: 'Seat', kind: 'choice', options: ['round', 'square'] },
      { path: 'size', label: 'Seat size', kind: 'length' },
      { path: 'back', label: 'Back', kind: 'bool' },
      { path: 'frameFinish', label: 'Frame', kind: 'finish' },
      { path: 'seatFinish', label: 'Seat finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: barStoolGeom(p) }),
  handles: (p) => boundsHandles([p.size, stoolLayout(p).height, p.size]),
  surfaces: (p) => ({ base: { finish: p.frameFinish }, tags: { frame: { finish: p.frameFinish }, seat: { finish: p.seatFinish } } }),
});

// ── chair ────────────────────────────────────────────────────────────────────

export interface ChairParams {
  seatHeight: number;
  width: number;
  depth: number;
  /** The top of its back, from the floor. */
  backHeight: number;
  frameFinish: Finish;
  seatFinish: Finish;
}

const LEG = inches(1.5);
const CUSHION = inches(2);
const APRON = inches(3);
const RAIL_T = inches(3 / 4);

function chairGeom(p: ChairParams): Geom {
  const { width: W, depth: D, seatHeight: sh, backHeight: bh } = p;
  if (bh < sh + inches(8)) throw new PluginError(`a chair's back reaches at least 8" over its seat (${f(sh + inches(8))})`);
  if (W < 4 * LEG || D < 4 * LEG) throw new PluginError('a chair this small has no room between its legs');
  const seatBottom = sh - CUSHION;
  const ay1 = seatBottom;
  const ay0 = ay1 - APRON;
  const sink = inches(1 / 8);
  const pieces: Geom[] = [
    // Legs: the back pair runs up into the back.
    box([0, 0, D - LEG], [LEG, seatBottom + sink, D], 'frame'),
    box([W - LEG, 0, D - LEG], [W, seatBottom + sink, D], 'frame'),
    box([0, 0, 0], [LEG, bh, LEG], 'frame'),
    box([W - LEG, 0, 0], [W, bh, LEG], 'frame'),
    // Aprons under the seat, set in 1/4" from the legs' faces and into them.
    box([LEG - 8, ay0, D - 16 - RAIL_T], [W - LEG + 8, ay1, D - 16], 'frame'),
    box([LEG - 8, ay0, 16], [W - LEG + 8, ay1, 16 + RAIL_T], 'frame'),
    box([16, ay0, LEG - 8], [16 + RAIL_T, ay1, D - LEG + 8], 'frame'),
    box([W - 16 - RAIL_T, ay0, LEG - 8], [W - 16, ay1, D - LEG + 8], 'frame'),
    // The back: a wide top rail and a slimmer one lower down.
    box([LEG - 8, bh - inches(4), 16], [W - LEG + 8, bh - inches(1 / 2), 16 + RAIL_T], 'frame'),
    box([LEG - 8, sh + inches(4), 16], [W - LEG + 8, sh + inches(5.5), 16 + RAIL_T], 'frame'),
    // The cushion, between the back legs and the front.
    roundedSlab(inches(1 / 4), LEG, W - inches(1 / 2), D - LEG, seatBottom, sh, inches(3 / 4), 'seat'),
  ];
  return mergeGeoms(...pieces);
}

registerShape<ChairParams>({
  type: 'chair',
  version: 1,
  schema: z.object({
    seatHeight: Height.default(inches(18)),
    width: z.int().min(inches(14)).max(inches(30)).default(inches(18)),
    depth: z.int().min(inches(14)).max(inches(30)).default(inches(20)),
    backHeight: z.int().min(inches(26)).max(inches(48)).default(inches(34)),
    frameFinish: Finish.default(() => ({ preset: 'wood:white-oak' })),
    seatFinish: Finish.default(() => ({ preset: 'fabric:linen', color: '#d9d2c5' })),
  }) as z.ZodType<ChairParams>,
  describe: 'Dining chair: seatHeight (18"), width (18"), depth (20"), backHeight (34"), frameFinish, seatFinish.',
  decor: {
    category: 'furniture',
    label: 'Chair',
    defaults: { seatHeight: inches(18) },
    fields: [
      { path: 'seatHeight', label: 'Seat height', kind: 'length' },
      { path: 'width', label: 'Width', kind: 'length' },
      { path: 'depth', label: 'Depth', kind: 'length' },
      { path: 'backHeight', label: 'Back height', kind: 'length' },
      { path: 'frameFinish', label: 'Frame', kind: 'finish' },
      { path: 'seatFinish', label: 'Seat finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: chairGeom(p) }),
  handles: (p) => boundsHandles([p.width, p.backHeight, p.depth]),
  surfaces: (p) => ({ base: { finish: p.frameFinish }, tags: { frame: { finish: p.frameFinish }, seat: { finish: p.seatFinish } } }),
});

// ── dining table ─────────────────────────────────────────────────────────────

export interface DiningTableParams {
  shape: 'rect' | 'round' | 'oval';
  /** Length (a round table's diameter). */
  width: number;
  depth: number;
  height: number;
  top: number;
  base: 'legs' | 'pedestal' | 'trestle';
  finish: Finish;
  /** The base's finish (default: the top's). */
  baseFinish?: Finish | undefined;
}

const tableDepth = (p: DiningTableParams) => (p.shape === 'round' ? p.width : p.depth);

function tableGeom(p: DiningTableParams): Geom {
  const { width: W, height: H, top: T } = p;
  const D = tableDepth(p);
  if (H < T + inches(12)) throw new PluginError(`a ${f(H)} table is too low for its ${f(T)} top`);
  const yt = H - T;
  const pieces: Geom[] = [];
  // The top.
  if (p.shape === 'rect') pieces.push(roundedSlab(0, 0, W, D, yt, H, inches(1 / 2), 'top'));
  else {
    const ring = unitCircle(48).map(([c, s]): V2 => [W / 2 + (W / 2) * c, D / 2 + (D / 2) * s]);
    pieces.push(extrude(ring, 1, yt, H, 'top', { smooth: true }));
  }
  const cx = W / 2;
  const cz = D / 2;
  const L = inches(2.5);
  if (p.base === 'legs') {
    // Four legs under the top's edge (inset more on a round or oval one), with aprons between them.
    const [ix, iz] = p.shape === 'rect' ? [inches(2), inches(2)] : [Math.round(W * 0.16), Math.round(D * 0.16)];
    const xs = [ix, W - ix - L];
    const zs = [iz, D - iz - L];
    for (const x of xs) for (const z of zs) pieces.push(box([x, 0, z], [x + L, yt + 8, z + L], 'base'));
    const a0 = yt - inches(4);
    const t = inches(3 / 4);
    pieces.push(box([xs[0]! + L - 8, a0, zs[0]! + 16], [xs[1]! + 8, yt + 8, zs[0]! + 16 + t], 'base'));
    pieces.push(box([xs[0]! + L - 8, a0, zs[1]! + L - 16 - t], [xs[1]! + 8, yt + 8, zs[1]! + L - 16], 'base'));
    pieces.push(box([xs[0]! + 16, a0, zs[0]! + L - 8], [xs[0]! + 16 + t, yt + 8, zs[1]! + 8], 'base'));
    pieces.push(box([xs[1]! + L - 16 - t, a0, zs[0]! + L - 8], [xs[1]! + L - 16, yt + 8, zs[1]! + 8], 'base'));
  } else if (p.base === 'pedestal') {
    // One turned pedestal (two on a long table).
    const foot = Math.round(Math.min(inches(14), Math.min(W, D) * 0.35));
    const col = inches(2.5);
    const centers = p.shape !== 'round' && W > inches(60) ? [Math.round(W * 0.28), Math.round(W * 0.72)] : [cx];
    const profile: V2[] = [[0, 0], [foot, 0], [foot, inches(1)], [Math.round(foot * 0.55), inches(3)], [col, inches(6)], [col, yt - inches(2)], [inches(6), yt - inches(1)], [inches(6), yt + 8], [0, yt + 8]];
    for (const x of centers) pieces.push(lathe([x, 0, cz], profile, 'base', 24));
  } else {
    // Trestle ends (a foot, a post, a cleat) joined by a stretcher.
    const inset = Math.max(inches(8), Math.round(W * 0.12));
    const post = inches(3);
    const footD = Math.max(inches(12), D - inches(6));
    const zf = Math.round((D - footD) / 2);
    const ends = [inset, W - inset - post];
    for (const x of ends) {
      pieces.push(box([x - inches(0.5), 0, zf], [x + post + inches(0.5), inches(2.5), zf + footD], 'base'));
      pieces.push(box([x, inches(2.5) - 8, Math.round(cz - inches(1.5))], [x + post, yt - inches(2) + 8, Math.round(cz + inches(1.5))], 'base'));
      pieces.push(box([x - inches(0.5), yt - inches(2), zf + inches(2)], [x + post + inches(0.5), yt + 8, zf + footD - inches(2)], 'base'));
    }
    pieces.push(box([ends[0]! + post - 8, inches(10), Math.round(cz - inches(0.75))], [ends[1]! + 8, inches(13), Math.round(cz + inches(0.75))], 'base'));
  }
  return mergeGeoms(...pieces);
}

registerShape<DiningTableParams>({
  type: 'diningTable',
  version: 1,
  schema: z.object({
    shape: z.enum(['rect', 'round', 'oval']).default('rect'),
    width: z.int().min(inches(24)).max(inches(144)).default(inches(72)),
    depth: z.int().min(inches(24)).max(inches(60)).default(inches(36)),
    height: z.int().min(inches(16)).max(inches(42)).default(inches(30)),
    top: z.int().min(inches(1 / 2)).max(inches(4)).default(inches(1.25)),
    base: z.enum(['legs', 'pedestal', 'trestle']).default('legs'),
    finish: Finish.default(() => ({ preset: 'wood:white-oak' })),
    baseFinish: Finish.optional(),
  }) as z.ZodType<DiningTableParams>,
  describe: 'Dining table: shape "rect" | "round" (diameter = width) | "oval", width (72"), depth (36"), height (30"), top (1 1/4"), base "legs" | "pedestal" | "trestle", finish, baseFinish?.',
  decor: {
    category: 'furniture',
    label: 'Dining table',
    defaults: { shape: 'rect', width: inches(72), depth: inches(36) },
    fields: [
      { path: 'shape', label: 'Shape', kind: 'choice', options: ['rect', 'round', 'oval'] },
      { path: 'width', label: 'Width', kind: 'length' },
      { path: 'depth', label: 'Depth', kind: 'length' },
      { path: 'height', label: 'Height', kind: 'length' },
      { path: 'top', label: 'Top', kind: 'length' },
      { path: 'base', label: 'Base', kind: 'choice', options: ['legs', 'pedestal', 'trestle'] },
      { path: 'finish', label: 'Finish', kind: 'finish' },
      { path: 'baseFinish', label: 'Base finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: tableGeom(p) }),
  handles: (p) => boundsHandles([p.width, p.height, tableDepth(p)]),
  surfaces: (p) => ({ base: { finish: p.finish }, tags: { top: { finish: p.finish }, base: { finish: p.baseFinish ?? p.finish } } }),
});

// ── rug ──────────────────────────────────────────────────────────────────────

export interface RugParams {
  shape: 'rect' | 'round';
  /** Length (a round rug's diameter). */
  width: number;
  depth: number;
  thickness: number;
  finish: Finish;
  /** A border band in another color. */
  border: { width: number; finish: Finish } | null;
}

const rugDepth = (p: RugParams) => (p.shape === 'round' ? p.width : p.depth);

function rugGeom(p: RugParams): Geom {
  const { width: W, thickness: T } = p;
  const D = rugDepth(p);
  const bw = p.border?.width ?? 0;
  if (p.border && 2 * bw >= Math.min(W, D) - inches(4)) throw new PluginError(`a ${f(bw)} border leaves no field on a ${f(Math.min(W, D))} rug`);
  if (p.shape === 'rect') {
    // The field sits 1/64" below the border band, cut into the top.
    const field = p.border ? [{ featureId: 'field', min: [bw, T - 1, bw] as V3, max: [W - bw, T, D - bw] as V3, axis: 1 as const, label: 'its field' }] : [];
    return channeledBox([W, T, D], field, boxFaceInfo, 'rug');
  }
  const R = W / 2;
  if (!p.border) return lathe([R, 0, R], [[0, 0], [R, 0], [R, T], [0, T]], 'field', 64);
  return mergeGeoms(lathe([R, 0, R], [[0, 0], [R, 0], [R, T - 1], [0, T - 1]], 'border', 64), lathe([R, 0, R], [[0, 0], [R - bw, 0], [R - bw, T], [0, T]], 'field', 64));
}

const RUG: Finish = { preset: 'fabric:wool', color: '#c9bfae' };

registerShape<RugParams>({
  type: 'rug',
  version: 1,
  schema: z.object({
    shape: z.enum(['rect', 'round']).default('rect'),
    width: z.int().min(inches(12)).max(inches(240)).default(inches(96)),
    depth: z.int().min(inches(12)).max(inches(240)).default(inches(60)),
    thickness: z.int().min(4).max(inches(1.5)).default(inches(3 / 8)),
    finish: Finish.default(() => ({ ...RUG })),
    border: z.object({ width: Length, finish: Finish }).nullable().default(null),
  }) as z.ZodType<RugParams>,
  describe: 'Rug: shape "rect" | "round" (diameter = width), width (96"), depth (60"), thickness, finish (wool + color), border {width, finish} | null.',
  decor: {
    category: 'furniture',
    label: 'Rug',
    solid: false,
    defaults: { shape: 'rect', width: inches(96), depth: inches(60) },
    fields: [
      { path: 'shape', label: 'Shape', kind: 'choice', options: ['rect', 'round'] },
      { path: 'width', label: 'Width', kind: 'length' },
      { path: 'depth', label: 'Depth', kind: 'length' },
      { path: 'finish', label: 'Finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: rugGeom(p) }),
  handles: (p) => boundsHandles([p.width, p.thickness, rugDepth(p)]),
  surfaces: (p): SurfaceMap => {
    const field = { finish: p.finish };
    const band = p.border ? { finish: p.border.finish } : field;
    return { base: band, tags: { field, border: band, 'field:floor': field, 'field:wall': field }, prefixes: [['face:', band]] };
  },
});
