import { z } from 'zod';
import { box, cylinder, extrude, lathe, mergeGeoms, mirrorGeom, rotateGeom, translateGeom, unitCircle } from '../../../geometry/solids';
import type { Geom, Handle, V2, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { formatInches as f, inches } from '../../../model/units';
import { PluginError, registerShape, shapes, type SurfaceMap } from '../../registry';

/**
 * Cabinet and door hardware (decor): a pull in one of a few styles. Origin at the min corner; it
 * mounts on its back (local z = 0) and projects toward +Z, so it sits on a door or drawer front at
 * the front's face. `h` runs its length along X, `v` along Y. `through` adds a mirrored twin on the
 * far face of a leaf that thick (a room door's handles): the leaf then sits between z = projection
 * and z = projection + through.
 */

export const PULL_STYLES = ['bar', 'arch', 'cup', 'edge', 'knob', 'tab', 'lever'] as const;
export type PullStyle = (typeof PULL_STYLES)[number];

export interface PullParams {
  style: PullStyle;
  /** Center to center (bar, arch, cup); overall (edge, tab); from the rose's center (lever). Knobs have none. */
  length?: number | undefined;
  /** Across the grip: bar or band thickness, cup / edge / tab height; knob or rose diameter. */
  size?: number | undefined;
  /** How far it stands off the face. */
  projection?: number | undefined;
  orientation: 'h' | 'v';
  finish: Finish;
  through?: number | undefined;
}

export const PULL_FINISH: Finish = { preset: 'metal:brushed-nickel' };

/** Per style: length, size, projection when not given. */
export const PULL_DEFAULTS: Record<PullStyle, [number, number, number]> = {
  bar: [inches(5), 28, inches(1 + 3 / 8)],
  arch: [inches(5), inches(1 / 2), inches(1 + 1 / 8)],
  cup: [inches(3), inches(1 + 1 / 4), inches(3 / 4)],
  edge: [inches(6), inches(1 + 1 / 2), inches(5 / 8)],
  knob: [0, inches(1 + 1 / 4), inches(1 + 1 / 8)],
  tab: [inches(1 + 1 / 2), inches(3 / 4), inches(1)],
  lever: [inches(5), inches(2 + 1 / 4), inches(2 + 1 / 2)],
};

const ARCH_BAND = inches(3 / 16);
const CUP_SHELL = inches(3 / 32);
const EDGE_SHELL = inches(1 / 8);
const TAB_PLATE = inches(3 / 16);
const LEVER_ROSE = inches(3 / 8);
const LEVER_NECK = inches(1 / 4); // radius
const LEVER_BAR = inches(5 / 16); // radius

/** Every mesh tag a pull makes, one per piece. */
export const PULL_TAGS = ['bar', 'post', 'arch', 'plate', 'hood', 'lip', 'knob', 'tab', 'rose', 'neck', 'lever'] as const;

interface Dims {
  length: number;
  size: number;
  projection: number;
  /** Along its length (X before it's turned for `v`). */
  overall: number;
}

function dims(p: PullParams): Dims {
  const [l, s, d] = PULL_DEFAULTS[p.style];
  const length = p.length ?? l;
  const size = p.size ?? s;
  const projection = p.projection ?? d;
  const overall =
    p.style === 'bar' ? length + inches(2) :
    p.style === 'arch' ? length + inches(1 / 2) :
    p.style === 'cup' ? length + inches(3 / 4) :
    p.style === 'knob' ? size :
    p.style === 'lever' ? Math.max(size, Math.round(size / 2) + length) :
    length;
  return { length, size, projection, overall };
}

/** Its size, [x, y, z]: what a generator centers on a front (the box from its origin). */
export function pullBox(p: PullParams): V3 {
  const d = dims(p);
  const [x, y] = p.orientation === 'v' && p.style !== 'knob' ? [d.size, d.overall] : [d.overall, d.size];
  return [x, y, p.through ? 2 * d.projection + p.through : d.projection];
}

const smoothInside = (n: number, sharp: number[]) => Array.from({ length: n }, (_, i) => !sharp.includes(i));

/** A round bar on two posts. */
function bar({ length, size, projection: P, overall }: Dims): Geom {
  if (P <= size) throw new PluginError(`a bar pull has to stand off more than its ${f(size)} bar`);
  const r = size / 2;
  const x0 = (overall - length) / 2;
  const post = Math.max(2, size * 0.35);
  return mergeGeoms(
    cylinder([0, r, P - r], 0, r, overall, 'bar'),
    cylinder([x0, r, 0], 2, post, P - r, 'post'),
    cylinder([x0 + length, r, 0], 2, post, P - r, 'post'),
  );
}

/** A flat band bowed out from two feet: the arc's chord on the face, its crown at the projection. */
function arch({ size, projection: s, overall: c }: Dims): Geom {
  if (2 * s > c) throw new PluginError(`an arch pull stands off at most half its length (${f(Math.floor(c / 2))})`);
  const radius = ((c * c) / 4 + s * s) / (2 * s);
  const cz = s - radius; // the circle's center, at or behind the face
  const inner = radius - ARCH_BAND;
  if (inner <= Math.abs(cz) || inner <= 0) throw new PluginError('an arch pull this flat needs a thinner band');
  const hw = Math.sqrt(inner * inner - cz * cz);
  if (c / 2 - hw < 1) throw new PluginError('an arch pull this flat needs a thinner band');
  const N = 16;
  const arc = (r: number, from: number, to: number, ends: [V2, V2, V2]): V2[] =>
    Array.from({ length: N + 1 }, (_, k): V2 => {
      if (k === 0) return ends[0];
      if (k === N / 2) return ends[1];
      if (k === N) return ends[2];
      const t = from + ((to - from) * k) / N;
      return [c / 2 + r * Math.cos(t), cz + r * Math.sin(t)];
    });
  const right = Math.atan2(-cz, c / 2);
  const innerRight = Math.atan2(-cz, hw);
  const outline = [
    ...arc(radius, Math.PI - right, right, [[0, 0], [c / 2, s], [c, 0]]),
    ...arc(inner, innerRight, Math.PI - innerRight, [[c / 2 + hw, 0], [c / 2, s - ARCH_BAND], [c / 2 - hw, 0]]),
  ];
  return extrude(outline, 1, 0, size, 'arch', { smooth: smoothInside(outline.length, [0, N, N + 1, 2 * N + 1]) });
}

/** A hood over a finger opening at its bottom, on a back plate. */
function cup({ size: H, projection: P, overall }: Dims): Geom {
  const depth = P - CUP_SHELL;
  if (depth <= 2 * CUP_SHELL || H <= 2 * CUP_SHELL) throw new PluginError('a cup pull this small has no room for fingers');
  const M = 8;
  const quarter = unitCircle(4 * M).slice(0, M + 1);
  const outer = quarter.map(([c, s]): V2 => [CUP_SHELL + depth * s, H * c]);
  const inside = quarter.map(([c, s]): V2 => [CUP_SHELL + (depth - CUP_SHELL) * s, (H - CUP_SHELL) * c]).reverse();
  const outline = [...outer, ...inside];
  const inset = Math.min(inches(1 / 16), overall / 8);
  return mergeGeoms(
    box([0, 0, 0], [overall, H, CUP_SHELL], 'plate'),
    extrude(outline, 0, inset, overall - inset, 'hood', { smooth: smoothInside(outline.length, [0, M, M + 1, 2 * M + 1]) }),
  );
}

/** An L: a strip on the face with a lip along its top. */
function edge({ size: H, projection: P, overall }: Dims): Geom {
  if (P <= EDGE_SHELL || H <= 2 * EDGE_SHELL) throw new PluginError('an edge pull this small has no lip');
  const t = EDGE_SHELL;
  return extrude([[0, 0], [t, 0], [t, H - t], [P, H - t], [P, H], [0, H]], 0, 0, overall, 'lip');
}

/** A turned mushroom knob. */
function knob({ size, projection: P }: Dims): Geom {
  const R = size / 2;
  const profile: V2[] = [[0, 0], [0.45 * R, 0], [0.32 * R, 0.3 * P], [0.6 * R, 0.55 * P], [R, 0.75 * P], [R, 0.85 * P], [0.75 * R, P], [0, P]];
  return translateGeom(rotateGeom(lathe([0, 0, 0], profile, 'knob'), 0, 1), [R, R, 0]);
}

/** A flat rounded tab on a short post. */
function tab({ size: H, projection: P, overall: W }: Dims): Geom {
  if (W < H) throw new PluginError(`a tab pull is at least as long as it's tall (${f(H)})`);
  if (P <= TAB_PLATE) throw new PluginError(`a tab pull stands off more than its ${f(TAB_PLATE)} plate`);
  const r = H / 2;
  const circle = unitCircle(32);
  // Round ends: the right one from straight down (270°) up to straight up, the left one back down.
  const end = (cx: number, from: number): V2[] => Array.from({ length: 17 }, (_, k) => circle[(from + k) % 32]!).map(([c, s]): V2 => [cx + r * c, r + r * s]);
  const outline = W === H ? circle.map(([c, s]): V2 => [r + r * c, r + r * s]) : [...end(W - r, 24), ...end(r, 8)];
  const post = Math.max(2, Math.min(W, H) / 4);
  return mergeGeoms(
    cylinder([W / 2, r, 0], 2, post, P - TAB_PLATE / 2, 'post'),
    extrude(outline, 2, P - TAB_PLATE, P, 'tab', { smooth: true }),
  );
}

/** A door lever: a rose on the face, a neck, and the lever reaching out along +X. */
function lever({ size, projection: P, overall }: Dims): Geom {
  const R = size / 2;
  if (R <= LEVER_NECK) throw new PluginError(`a lever's rose is wider than its neck (${f(2 * LEVER_NECK)})`);
  if (P <= LEVER_ROSE + 2 * LEVER_BAR) throw new PluginError(`a lever stands off more than ${f(LEVER_ROSE + 2 * LEVER_BAR)}`);
  return mergeGeoms(
    cylinder([R, R, 0], 2, R, LEVER_ROSE, 'rose'),
    cylinder([R, R, LEVER_ROSE / 2], 2, LEVER_NECK, P - LEVER_BAR - LEVER_ROSE / 2, 'neck'),
    cylinder([R - LEVER_NECK, R, P - LEVER_BAR], 0, LEVER_BAR, overall - (R - LEVER_NECK), 'lever'),
  );
}

const BUILD: Record<PullStyle, (d: Dims) => Geom> = { bar, arch, cup, edge, knob, tab, lever };

export function pullGeom(p: PullParams): Geom {
  const d = dims(p);
  let g = BUILD[p.style](d);
  if (p.orientation === 'v' && p.style !== 'knob') g = translateGeom(rotateGeom(g, 2, 1), [d.size, 0, 0]);
  if (p.through) {
    const twin = translateGeom(mirrorGeom(g, 2), [0, 0, d.projection]);
    g = mergeGeoms(twin, translateGeom(g, [0, 0, d.projection + p.through]));
  }
  return g;
}

/** Box face handles of its bounds, for picking and snapping: hardware isn't pushed or pulled. */
function pullHandles(p: PullParams): Handle[] {
  const [x, y, z] = pullBox(p);
  return shapes.get('box').handles({ x, y, z }).map((h) => ({ ...h, drives: [] }));
}

function pullSurfaces(p: PullParams): SurfaceMap {
  const look = { finish: p.finish };
  return { base: look, tags: Object.fromEntries(PULL_TAGS.map((t) => [t, look])) };
}

const Length = z.int().positive();

registerShape<PullParams>({
  type: 'pull',
  version: 1,
  schema: z.object({
    style: z.enum(PULL_STYLES).default('bar'),
    length: Length.optional(),
    size: Length.optional(),
    projection: Length.optional(),
    orientation: z.enum(['h', 'v']).default('h'),
    finish: Finish.default(() => ({ ...PULL_FINISH })),
    through: Length.optional(),
  }) as z.ZodType<PullParams>,
  describe:
    'A cabinet or door pull (hardware). Its origin is its min corner; it mounts on its back (z = 0) and stands off toward +Z, so set ' +
    'its z to the face it goes on and center it with x / y. style: bar (round bar on two posts), arch, cup (bin pull), edge (an L strip ' +
    'with a lip), knob, tab, lever (door lever). length = center to center (bar, arch, cup; default 5", cup 3"), overall (edge 6", tab ' +
    '1 1/2"), or a lever\'s reach; knobs ignore it. size = the grip across (knob / lever rose diameter), projection = stand-off; both ' +
    'default per style. orientation "h" (length along X) or "v" (along Y: doors). finish default {"preset": "metal:brushed-nickel"}. ' +
    'through = a leaf thickness: adds the same pull on the far face (a room door). Its size: bar overall = length + 2", arch + 1/2", cup + 3/4".',
  decor: {
    category: 'hardware',
    label: 'Pull',
    defaults: { style: 'bar', orientation: 'h', finish: PULL_FINISH },
    fields: [
      { path: 'style', label: 'Style', kind: 'choice', options: [...PULL_STYLES] },
      { path: 'length', label: 'Length', kind: 'length' },
      { path: 'size', label: 'Size', kind: 'length' },
      { path: 'projection', label: 'Projection', kind: 'length' },
      { path: 'orientation', label: 'Orientation', kind: 'choice', options: ['h', 'v'] },
      { path: 'finish', label: 'Finish', kind: 'finish' },
    ],
  },
  build: (p) => ({ geom: pullGeom(p) }),
  handles: pullHandles,
  surfaces: pullSurfaces,
});
