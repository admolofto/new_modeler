import { z } from 'zod';
import { channeledBox, type Block } from '../../../geometry/orthogonal';
import { box, cylinder, extrude, mergeGeoms } from '../../../geometry/solids';
import type { Geom, V2, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { formatInches as f, inches } from '../../../model/units';
import { PluginError, registerShape, type Surface, type SurfaceMap } from '../../registry';
import { boxFaceInfo } from '../box';
import { boundsHandles, Length } from './common';

/**
 * Appliances (A8, category `appliance`): the range hood (a prop the AI and the catalog add), and the
 * pieces the appliance generators build fridges, ranges, dishwashers and microwaves from — a body
 * (a box with cavities behind its doors, plus burners, grates, knobs and panels) and a door (a box
 * with an optional black-glass window). Origin at the min corner, front +Z. Pure.
 */

/** Dark, glossy, nearly opaque: an oven window, a control panel, a glass cooktop. */
export const BLACK_GLASS: Finish = { preset: 'lacquer', color: '#141517', roughness: 0.08 };
const CAST_IRON: Finish = { preset: 'metal:matte-black' };
const RACK: Finish = { preset: 'metal:chrome' };

const V3s = z.tuple([z.int(), z.int(), z.int()]);

// ── body ─────────────────────────────────────────────────────────────────────

/** What an appliance's details are made of, by tag. */
export const DETAIL_TAGS = ['grate', 'burner', 'cap', 'knob', 'panel', 'zone', 'rack', 'shelf', 'kick', 'vent', 'trim', 'guard'] as const;
export type DetailTag = (typeof DETAIL_TAGS)[number];

export type Detail =
  | { kind: 'box'; min: V3; max: V3; tag: DetailTag }
  | { kind: 'cylinder'; base: V3; axis: 0 | 1 | 2; r: number; h: number; tag: DetailTag };

export interface ApplianceBodyParams {
  x: number;
  y: number;
  z: number;
  /** Hollows behind its doors (open at the front, `axis` 2) or a bin's (open at the top, `axis` 1). */
  cavities: { id: string; min: V3; max: V3; axis: 1 | 2 }[];
  details: Detail[];
  finish: Finish;
  /** Inside the cavities. */
  inner: Finish;
}

function bodyGeom(p: ApplianceBodyParams): Geom {
  const blocks = p.cavities.map((c): Block => ({ featureId: c.id, min: c.min, max: c.max, axis: c.axis, label: `its ${c.id}` }));
  const shell = channeledBox([p.x, p.y, p.z], blocks, boxFaceInfo, 'appliance');
  return mergeGeoms(
    shell,
    ...p.details.map((d) => (d.kind === 'box' ? box(d.min, d.max, d.tag) : cylinder(d.base, d.axis, d.r, d.h, d.tag, undefined, d.r > inches(1) ? 24 : 16))),
  );
}

/** Each detail tag's look; `knob` and `guard` follow the appliance's finish. */
function detailSurface(tag: DetailTag, finish: Finish): Surface {
  switch (tag) {
    case 'grate':
    case 'cap':
    case 'kick':
    case 'vent':
      return { finish: CAST_IRON };
    case 'burner':
      return { finish: { preset: 'metal:brushed-nickel' } };
    case 'panel':
      return { finish: BLACK_GLASS };
    case 'zone':
      return { finish: { preset: 'paint', color: '#5b5e63', roughness: 0.3 } };
    case 'rack':
      return { finish: RACK };
    case 'shelf':
      return { finish: { preset: 'glass:frosted' } };
    default:
      return { finish };
  }
}

const Detail = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), min: V3s, max: V3s, tag: z.enum(DETAIL_TAGS) }),
  z.object({ kind: z.literal('cylinder'), base: V3s, axis: z.union([z.literal(0), z.literal(1), z.literal(2)]), r: Length, h: Length, tag: z.enum(DETAIL_TAGS) }),
]);

registerShape<ApplianceBodyParams>({
  type: 'applianceBody',
  version: 1,
  schema: z.object({
    x: Length,
    y: Length,
    z: Length,
    cavities: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), min: V3s, max: V3s, axis: z.union([z.literal(1), z.literal(2)]).default(2) })).default(() => []),
    details: z.array(Detail).default(() => []),
    finish: Finish.default(() => ({ preset: 'metal:stainless' })),
    inner: Finish.default(() => ({ preset: 'paint', color: '#eef0f1' })),
  }) as z.ZodType<ApplianceBodyParams>,
  describe: 'An appliance body (made by the appliance generators).',
  decor: { category: 'appliance', label: 'Appliance body', internal: true },
  build: (p) => ({ geom: bodyGeom(p) }),
  handles: (p) => boundsHandles([p.x, p.y, p.z]),
  surfaces: (p): SurfaceMap => ({
    base: { finish: p.finish },
    tags: Object.fromEntries(DETAIL_TAGS.map((t) => [t, detailSurface(t, p.finish)])),
    prefixes: [['face:', { finish: p.finish }], ...p.cavities.map((c): [string, Surface] => [`${c.id}:`, { finish: p.inner }])],
  }),
});

// ── door ─────────────────────────────────────────────────────────────────────

export interface ApplianceDoorParams {
  x: number;
  y: number;
  /** Thickness, the window included (it stands 1/32" proud of the face). */
  z: number;
  /** A window on the front face, door-local [x, y] corners. */
  window: { min: [number, number]; max: [number, number] } | null;
  finish: Finish;
  /** Its back (the liner a fridge door shows when open). */
  inner: Finish;
  glass: Finish;
}

const PROUD = 2;

function doorGeom(p: ApplianceDoorParams): Geom {
  if (p.z <= 2 * PROUD) throw new PluginError(`an appliance door ${f(p.z)} thick is too thin`);
  const slab = channeledBox([p.x, p.y, p.z - PROUD], [], boxFaceInfo, 'appliance door');
  if (!p.window) return mergeGeoms(slab, box([inches(1 / 4), inches(1 / 4), p.z - PROUD - 1], [p.x - inches(1 / 4), p.y - inches(1 / 4), p.z], 'face'));
  const [u0, v0] = p.window.min;
  const [u1, v1] = p.window.max;
  if (u0 < 0 || v0 < 0 || u1 > p.x || v1 > p.y || u1 <= u0 || v1 <= v0) throw new PluginError('the window lies outside its door');
  return mergeGeoms(slab, box([u0, v0, p.z - 2 * PROUD], [u1, v1, p.z], 'window'));
}

registerShape<ApplianceDoorParams>({
  type: 'applianceDoor',
  version: 1,
  schema: z.object({
    x: Length,
    y: Length,
    z: Length,
    window: z.object({ min: z.tuple([z.int(), z.int()]), max: z.tuple([z.int(), z.int()]) }).nullable().default(null),
    finish: Finish.default(() => ({ preset: 'metal:stainless' })),
    inner: Finish.default(() => ({ preset: 'paint', color: '#eef0f1' })),
    glass: Finish.default(() => ({ ...BLACK_GLASS })),
  }) as z.ZodType<ApplianceDoorParams>,
  describe: 'An appliance door or drawer front (made by the appliance generators).',
  decor: { category: 'appliance', label: 'Appliance door', internal: true },
  build: (p) => ({ geom: doorGeom(p) }),
  handles: (p) => boundsHandles([p.x, p.y, p.z]),
  surfaces: (p): SurfaceMap => ({
    base: { finish: p.finish },
    tags: { 'face:back': { finish: p.inner }, face: { finish: p.finish }, window: { finish: p.glass } },
    prefixes: [['face:', { finish: p.finish }]],
  }),
});

// ── range hood ───────────────────────────────────────────────────────────────

export const HOOD_STYLES = ['chimney', 'wall', 'island', 'insert'] as const;
export type HoodStyle = (typeof HOOD_STYLES)[number];

export interface RangeHoodParams {
  style: HoodStyle;
  width: number;
  /** The canopy: its front band and slope (an insert's liner). */
  hoodHeight: number;
  depth: number;
  /** The flue cover above the canopy (chimney and island hoods; 0 = none). */
  chimney: number;
  finish: Finish;
  lumens: number;
  kelvin: number;
}

/** The front band, the lamps' lift off the bottom, and the lamp radius. */
const BAND = inches(2.5);
const LIFT = 3;
const LAMP_R = inches(1);

function hoodLayout(p: RangeHoodParams) {
  const chimney = p.style === 'chimney' || p.style === 'island' ? p.chimney : 0;
  const flueW = Math.max(inches(8), Math.min(inches(12), Math.round(p.width * 0.4)));
  const flueD = Math.max(inches(6), Math.min(inches(10), Math.round(p.depth * 0.5)));
  return { chimney, flueW, flueD, height: p.hoodHeight + chimney };
}

function hoodGeom(p: RangeHoodParams): Geom {
  const { width: W, depth: D, hoodHeight: H } = p;
  const { chimney, flueW, flueD } = hoodLayout(p);
  if (H < BAND + inches(1)) throw new PluginError(`a hood needs at least ${f(BAND + inches(1))} of height`);
  if (W < 2 * flueW || D < flueD + inches(2)) throw new PluginError(`a ${f(W)} × ${f(D)} hood is too small for its flue`);
  const pieces: Geom[] = [];
  if (p.style === 'insert') {
    pieces.push(box([0, LIFT, 0], [W, H, D], 'hood'));
  } else {
    pieces.push(box([0, LIFT, 0], [W, BAND, D], 'hood'));
    // The canopy slopes from the band up to the flue (centered on an island hood), seen from the side (z, y).
    const [z0, z1] = p.style === 'island' ? [Math.round((D - flueD) / 2), Math.round((D + flueD) / 2)] : [0, flueD];
    // It starts a little inside the band (shared edges would leave the mesh open there).
    const b = BAND - 8;
    const side: V2[] = p.style === 'island' ? [[0, b], [D, b], [z1, H], [z0, H]] : [[0, b], [D, b], [flueD, H], [0, H]];
    pieces.push(extrude(side, 0, 0, W, 'hood'));
    if (chimney > 0) pieces.push(box([Math.round((W - flueW) / 2), H - 4, z0], [Math.round((W + flueW) / 2), H + chimney, z1], 'flue'));
  }
  // Baffle filters and two lamps underneath.
  const inset = inches(1);
  pieces.push(box([inset, 1, inset], [W - inset, LIFT + 2, Math.round(D * 0.75)], 'filter'));
  for (const x of lampXs(W)) pieces.push(cylinder([x, 0, lampZ(D)], 1, LAMP_R, LIFT + 2, 'lamp', undefined, 16));
  return mergeGeoms(...pieces);
}

const lampXs = (W: number) => [Math.round(W / 4), Math.round((3 * W) / 4)];
const lampZ = (D: number) => Math.round(D * 0.85);

registerShape<RangeHoodParams>({
  type: 'rangeHood',
  version: 1,
  schema: z.object({
    style: z.enum(HOOD_STYLES).default('chimney'),
    width: z.int().min(inches(18)).max(inches(72)).default(inches(30)),
    hoodHeight: z.int().min(inches(4)).max(inches(36)).default(inches(10)),
    depth: z.int().min(inches(10)).max(inches(36)).default(inches(20)),
    chimney: z.int().min(0).max(inches(72)).default(inches(24)),
    finish: Finish.default(() => ({ preset: 'metal:stainless' })),
    lumens: z.int().min(50).max(3000).default(300),
    kelvin: z.int().min(1800).max(6500).default(3000),
  }) as z.ZodType<RangeHoodParams>,
  describe:
    'Range hood: style "chimney" | "wall" | "island" | "insert", width (30"), hoodHeight (canopy, 10"), depth (20"), chimney (flue cover, 24"), ' +
    'finish (stainless). Back against the wall, bottom 30" over the cooktop.',
  decor: {
    category: 'appliance',
    label: 'Range hood',
    defaults: { style: 'chimney', width: inches(30) },
    fields: [
      { path: 'style', label: 'Style', kind: 'choice', options: [...HOOD_STYLES] },
      { path: 'width', label: 'Width', kind: 'length' },
      { path: 'hoodHeight', label: 'Hood height', kind: 'length' },
      { path: 'depth', label: 'Depth', kind: 'length' },
      { path: 'chimney', label: 'Chimney', kind: 'length' },
      { path: 'finish', label: 'Finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: hoodGeom(p) }),
  handles: (p) => boundsHandles([p.width, hoodLayout(p).height, p.depth]),
  surfaces: (p) => ({
    base: { finish: p.finish },
    tags: { hood: { finish: p.finish }, flue: { finish: p.finish }, filter: { finish: { preset: 'metal:brushed-nickel' } }, lamp: { finish: { preset: 'light' }, glow: { kelvin: p.kelvin, strength: 1.2 } } },
  }),
  lights: (p) => lampXs(p.width).map((x) => ({ kind: 'spot' as const, at: [x, 0, lampZ(p.depth)] as V3, dir: [0, -1, 0] as V3, lumens: p.lumens, kelvin: p.kelvin, beam: 70, glow: 'lamp' })),
});

