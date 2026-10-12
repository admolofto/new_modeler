import { z } from 'zod';
import { channeledBox } from '../../../geometry/orthogonal';
import { cylinder, lathe, mergeGeoms, sphere } from '../../../geometry/solids';
import type { Geom, V2, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { formatInches as f, inches } from '../../../model/units';
import { PluginError, registerShape, type LightSpec, type Surface, type SurfaceMap } from '../../registry';
import { boxFaceInfo } from '../box';
import { boundsHandles, Length } from './common';

/**
 * Light fixtures (A8, category `lighting`): a pendant hanging from the ceiling, a recessed can, an
 * LED strip. Each gives off a light (`lights`, read by model/look.ts `sceneLights`) and has a surface
 * that glows when the lights are on (presentation's evening and night). Origin at the min corner,
 * front +Z. Pure.
 */

const BLACK: Finish = { preset: 'metal:matte-black' };
const WHITE_TRIM: Finish = { preset: 'paint', color: '#f6f5f1' };
const glowing = (kelvin: number, strength = 1): Surface => ({ finish: { preset: 'light' }, glow: { kelvin, strength } });
const Kelvin = z.int().min(1800).max(6500);
const Lumens = z.int().min(50).max(5000);

// ── pendant ──────────────────────────────────────────────────────────────────

export const SHADES = ['dome', 'cylinder', 'globe', 'cone'] as const;
export type Shade = (typeof SHADES)[number];

export interface PendantParams {
  shade: Shade;
  diameter: number;
  /** Ceiling to the bottom of the shade: the whole fixture's height (its canopy is at the top). */
  drop: number;
  finish: Finish;
  lumens: number;
  kelvin: number;
}

const CANOPY = { r: inches(2.5), h: inches(1) };
const CORD_R = 6;
const SHADE_WALL = 6;
const SOCKET = { r: inches(5 / 8), h: inches(1.5) };
/** Shade height per diameter. */
const SHADE_HEIGHT: Record<Shade, number> = { dome: 0.55, cylinder: 0.8, globe: 1, cone: 0.7 };
/** Beam angle per shade (degrees): a dome spreads its light, a cylinder throws a pool. */
const SHADE_BEAM: Record<Shade, number> = { dome: 100, cylinder: 60, globe: 120, cone: 80 };

function pendantLayout(p: PendantParams) {
  const R = Math.round(p.diameter / 2);
  const W = Math.max(2 * R, 2 * CANOPY.r);
  const c = W / 2;
  const sh = Math.round(p.diameter * SHADE_HEIGHT[p.shade]);
  const bulb = Math.max(inches(0.75), Math.min(inches(1.5), Math.round(R * 0.25)));
  // The bulb hangs from its socket under the shade's crown (a globe's: in its middle).
  const bulbY = p.shade === 'globe' ? R : Math.max(bulb + 4, sh - SHADE_WALL - SOCKET.h - bulb);
  return { R, W, c, sh, bulb, bulbY };
}

function pendantGeom(p: PendantParams): Geom {
  const { R, c, sh, bulb, bulbY } = pendantLayout(p);
  if (p.drop < sh + CANOPY.h + inches(2)) throw new PluginError(`a ${f(p.diameter)} ${p.shade} pendant needs a drop of at least ${f(sh + CANOPY.h + inches(2))}`);
  const t = SHADE_WALL;
  const base: V3 = [c, 0, c];
  const N = 8;
  let shade: Geom;
  if (p.shade === 'globe') shade = sphere([c, R, c], R, 'shade', 32);
  else {
    let profile: V2[];
    if (p.shade === 'dome') {
      // An eased dome: the inside down from the crown to the rim, then the outside back up.
      const at = (k: number) => (k / N) * (Math.PI / 2);
      const inner = Array.from({ length: N + 1 }, (_, k): V2 => (k === 0 ? [0, sh - t] : k === N ? [R - t, 0] : [(R - t) * Math.cos(at(N - k)), (sh - t) * Math.sin(at(N - k))]));
      const outer = Array.from({ length: N + 1 }, (_, k): V2 => (k === 0 ? [R, 0] : k === N ? [0, sh] : [R * Math.cos(at(k)), sh * Math.sin(at(k))]));
      profile = [...inner, ...outer];
    } else if (p.shade === 'cylinder') {
      profile = [[0, sh - t], [R - t, sh - t], [R - t, 0], [R, 0], [R, sh], [0, sh]];
    } else {
      const top = Math.max(inches(1), Math.round(R * 0.2));
      profile = [[0, sh - t], [top - t, sh - t], [R - t, 0], [R, 0], [top, sh], [0, sh]];
    }
    shade = lathe(base, profile, 'shade', 32);
  }
  const crown = p.shade === 'globe' ? 2 * R : sh;
  const socketTop = p.shade === 'globe' ? bulbY + bulb + SOCKET.h : sh - t + 4;
  return mergeGeoms(
    shade,
    sphere([c, bulbY, c], bulb, 'bulb', 16),
    cylinder([c, bulbY + bulb - 8, c], 1, SOCKET.r, socketTop - (bulbY + bulb - 8), 'socket', undefined, 16),
    cylinder([c, crown - 4, c], 1, CORD_R, p.drop - CANOPY.h - (crown - 4) + 4, 'cord', undefined, 8),
    cylinder([c, p.drop - CANOPY.h, c], 1, CANOPY.r, CANOPY.h, 'canopy', undefined, 24),
  );
}

const pendantSize = (p: PendantParams): V3 => {
  const { W } = pendantLayout(p);
  return [W, p.drop, W];
};

registerShape<PendantParams>({
  type: 'pendant',
  version: 1,
  schema: z.object({
    shade: z.enum(SHADES).default('dome'),
    diameter: z.int().min(inches(4)).max(inches(48)).default(inches(12)),
    drop: z.int().min(inches(8)).max(inches(120)).default(inches(30)),
    finish: Finish.default(() => ({ ...BLACK })),
    lumens: Lumens.default(800),
    kelvin: Kelvin.default(2700),
  }) as z.ZodType<PendantParams>,
  describe:
    'Pendant light: shade "dome" | "cylinder" | "globe" | "cone", diameter (12"), drop = its height, ceiling to shade bottom (30"; y = ceiling − drop), finish, lumens (800), kelvin (2700).',
  decor: {
    category: 'lighting',
    label: 'Pendant',
    defaults: { shade: 'dome', diameter: inches(12), drop: inches(30) },
    fields: [
      { path: 'shade', label: 'Shade', kind: 'choice', options: [...SHADES] },
      { path: 'diameter', label: 'Diameter', kind: 'length' },
      { path: 'drop', label: 'Drop', kind: 'length' },
      { path: 'finish', label: 'Finish', kind: 'finish' },
      { path: 'lumens', label: 'Lumens', kind: 'count', min: 50, max: 5000 },
      { path: 'kelvin', label: 'Color (K)', kind: 'count', min: 1800, max: 6500 },
    ],
  },
  build: (p) => ({ geom: pendantGeom(p) }),
  handles: (p) => boundsHandles(pendantSize(p)),
  surfaces: (p): SurfaceMap => {
    const metal = { finish: p.finish };
    const shade = p.shade === 'globe' ? { finish: { preset: 'glass:frosted' }, glow: { kelvin: p.kelvin, strength: 0.35 } } : metal;
    return { base: metal, tags: { shade, canopy: metal, socket: metal, cord: { finish: { ...BLACK } }, bulb: glowing(p.kelvin) } };
  },
  lights: (p): LightSpec[] => {
    const { c, bulbY } = pendantLayout(p);
    return [{ kind: p.shade === 'globe' ? 'point' : 'spot', at: [c, bulbY, c], dir: [0, -1, 0], lumens: p.lumens, kelvin: p.kelvin, beam: SHADE_BEAM[p.shade], glow: 'bulb' }];
  },
});

// ── recessed can ─────────────────────────────────────────────────────────────

export interface RecessedParams {
  /** The aperture (4" or 6" cans). */
  diameter: number;
  trim: Finish;
  lumens: number;
  kelvin: number;
  beam: number;
}

/** The trim's flange past the aperture, its thickness, and how far the lens sits up in it. */
const FLANGE = inches(3 / 4);
const TRIM_T = 9;
const LENS_UP = 3;

function recessedLayout(p: RecessedParams) {
  const Ri = Math.round(p.diameter / 2);
  const Ro = Ri + FLANGE;
  return { Ri, Ro, c: Ro };
}

/**
 * A trim ring flush under the ceiling with the lens recessed in it: its top (y = 9/64") goes against
 * the ceiling, so a can sits at y = ceiling − 9/64".
 */
function recessedGeom(p: RecessedParams): Geom {
  const { Ri, Ro, c } = recessedLayout(p);
  const recess = LENS_UP + 1;
  const trim = lathe([c, 0, c], [[0, recess], [Ri, recess], [Ri, 0], [Ro, 0], [Ro, TRIM_T], [0, TRIM_T]], 'trim', 32);
  return mergeGeoms(trim, cylinder([c, LENS_UP, c], 1, Ri - 1, 3, 'lens', undefined, 32));
}

registerShape<RecessedParams>({
  type: 'recessedLight',
  version: 1,
  schema: z.object({
    diameter: z.int().min(inches(2)).max(inches(8)).default(inches(4)),
    trim: Finish.default(() => ({ ...WHITE_TRIM })),
    lumens: Lumens.default(650),
    kelvin: Kelvin.default(3000),
    beam: z.number().min(10).max(120).default(60),
  }) as z.ZodType<RecessedParams>,
  describe: 'Recessed ceiling can: diameter (4"), trim, lumens (650), kelvin (3000), beam (60°); 9/64" tall, top at the ceiling (a room has cans).',
  decor: {
    category: 'lighting',
    label: 'Recessed light',
    solid: false,
    defaults: { diameter: inches(4) },
    fields: [
      { path: 'diameter', label: 'Diameter', kind: 'length' },
      { path: 'trim', label: 'Trim', kind: 'finish' },
      { path: 'lumens', label: 'Lumens', kind: 'count', min: 50, max: 5000 },
      { path: 'kelvin', label: 'Color (K)', kind: 'count', min: 1800, max: 6500 },
      { path: 'beam', label: 'Beam (°)', kind: 'number', min: 10, max: 120 },
    ],
  },
  build: (p) => ({ geom: recessedGeom(p) }),
  handles: (p) => {
    const { Ro } = recessedLayout(p);
    return boundsHandles([2 * Ro, TRIM_T, 2 * Ro]);
  },
  surfaces: (p) => ({ base: { finish: p.trim }, tags: { trim: { finish: p.trim }, lens: glowing(p.kelvin, 1.2) } }),
  lights: (p) => {
    const { c } = recessedLayout(p);
    return [{ kind: 'spot', at: [c, LENS_UP, c], dir: [0, -1, 0], lumens: p.lumens, kelvin: p.kelvin, beam: p.beam, glow: 'lens' }];
  },
});

/** How tall a recessed can is: it goes this far under the ceiling. */
export const RECESSED_HEIGHT = TRIM_T;
/** A can's footprint (x = z) for an aperture. */
export const recessedWidth = (diameter: number) => 2 * (Math.round(diameter / 2) + FLANGE);

// ── LED strip ────────────────────────────────────────────────────────────────

export interface StripParams {
  length: number;
  width: number;
  lumensPerFoot: number;
  kelvin: number;
  finish: Finish;
}

const STRIP_T = inches(3 / 8);

registerShape<StripParams>({
  type: 'stripLight',
  version: 1,
  schema: z.object({
    length: z.int().min(inches(4)).max(inches(240)).default(inches(24)),
    width: Length.max(inches(4)).default(inches(1)),
    lumensPerFoot: z.int().min(50).max(2000).default(300),
    kelvin: Kelvin.default(3000),
    finish: Finish.default(() => ({ preset: 'metal:brushed-nickel' })),
  }) as z.ZodType<StripParams>,
  describe: 'LED strip under a cabinet or shelf: length (x), width (1"), lumensPerFoot (300), kelvin (3000); 3/8" thick, shines down.',
  decor: {
    category: 'lighting',
    label: 'Light strip',
    solid: false,
    defaults: { length: inches(24) },
    fields: [
      { path: 'length', label: 'Length', kind: 'length' },
      { path: 'width', label: 'Width', kind: 'length' },
      { path: 'lumensPerFoot', label: 'Lumens / ft', kind: 'count', min: 50, max: 2000 },
      { path: 'kelvin', label: 'Color (K)', kind: 'count', min: 1800, max: 6500 },
      { path: 'finish', label: 'Housing', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: channeledBox([p.length, STRIP_T, p.width], [], boxFaceInfo, 'light strip') }),
  handles: (p) => boundsHandles([p.length, STRIP_T, p.width]),
  surfaces: (p) => ({ base: { finish: p.finish }, prefixes: [['face:', { finish: p.finish }]], tags: { 'face:bottom': glowing(p.kelvin, 1.5) } }),
  lights: (p) => [
    { kind: 'area', at: [p.length / 2, 0, p.width / 2], dir: [0, -1, 0], along: [1, 0, 0], size: [p.length, p.width], lumens: Math.round((p.lumensPerFoot * p.length) / inches(12)), kelvin: p.kelvin, glow: 'face:bottom' },
  ],
});
