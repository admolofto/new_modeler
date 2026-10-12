import { z } from 'zod';
import { channeledBox } from '../../../geometry/orthogonal';
import { cylinder, extrude, lathe, mergeGeoms, mulRotations, rotateGeom, rotationX, rotationY, sphere, transformGeom, translateGeom } from '../../../geometry/solids';
import type { Geom, V2, V3 } from '../../../geometry/types';
import { Finish } from '../../../model/schema';
import { inches } from '../../../model/units';
import { registerShape, type Surface, type SurfaceMap } from '../../registry';
import { boxFaceInfo } from '../box';
import { boundsHandles, measured, random, Seed, tinted } from './common';

/**
 * Accessories (A8, category `accessory`): a potted plant, a bowl of fruit, a row of books, a vase of
 * stems. Organic props built from closed primitives, varied by a `seed` (the same seed gives the same
 * prop), sized from their geometry, origin at the min corner. Pure.
 */

const SOIL: Finish = { preset: 'paint', color: '#3b2b21', roughness: 0.95 };
const LEAF: Finish = { preset: 'plant' };
const STEM: Finish = { preset: 'paint', color: '#5d6b3c', roughness: 0.7 };

/** A thin lance-shaped leaf along +Y from the origin, `length` long and `width` wide, lying in the XY plane. */
function leafBlade(length: number, width: number, thick = 3): Geom {
  const n = 7;
  const side = (t: number) => (width / 2) * Math.pow(Math.sin(Math.PI * t), 0.75) * (1 - 0.25 * t);
  const right = Array.from({ length: n }, (_, k): V2 => {
    const t = (k + 1) / (n + 1);
    return [side(t), length * t];
  });
  const outline: V2[] = [[0, 0], ...right, [0, length], ...right.map(([x, y]): V2 => [-x, y]).reverse()];
  const smooth = outline.map((_, i) => i !== 0 && i !== n + 1);
  return extrude(outline, 2, -thick / 2, thick / 2, 'leaf', { smooth });
}

/** A part placed by a lean (degrees off vertical, toward +Z) then a turn about Y, at `at`. */
const leaned = (g: Geom, lean: number, turn: number, at: V3): Geom => transformGeom(g, mulRotations(rotationY(turn), rotationX(lean)), at);

// ── plant ────────────────────────────────────────────────────────────────────

export interface PlantParams {
  style: 'leafy' | 'bush';
  height: number;
  potDiameter: number;
  potHeight: number;
  potFinish: Finish;
  seed: number;
}

/** A tapered pot with a rolled lip, hollow down to its soil, `R` across the top. */
function pot(c: V3, R: number, H: number, soil: number): Geom {
  const Rb = Math.round(R * 0.78);
  const wall = Math.max(6, Math.round(R * 0.07));
  const lip = Math.min(inches(0.75), Math.round(H * 0.12));
  const profile: V2[] = [[0, 0], [Rb, 0], [R - 6, H - lip], [R, H - lip], [R, H], [R - wall, H], [R - wall, H - lip], [Math.round(Rb + (R - Rb) * (soil / H)) - wall, soil], [0, soil]];
  return lathe(c, profile, 'pot', 32);
}

function plantGeom(p: PlantParams): Geom {
  const rnd = random(p.seed);
  const R = p.potDiameter / 2;
  const H = p.potHeight;
  const soil = H - Math.min(inches(1), Math.round(H * 0.12));
  const c: V3 = [0, 0, 0];
  const soilR = Math.round((R * 0.78 + (R - R * 0.78) * (soil / H)) * 0.97);
  const pieces: Geom[] = [pot(c, R, H, soil), cylinder([0, soil - inches(0.25), 0], 1, soilR, inches(0.25) + 2, 'soil', undefined, 24)];
  const grow = Math.max(inches(4), p.height - H);
  if (p.style === 'leafy') {
    // A rosette of long leaves: upright in the middle, leaning out round the edge.
    const count = 9 + Math.floor(rnd() * 6);
    for (let i = 0; i < count; i++) {
      const outer = i / count;
      const lean = 6 + outer * 34 + rnd() * 8;
      const turn = i * 137.5 + rnd() * 20;
      const length = (grow * (1 - outer * 0.3) * (0.92 + rnd() * 0.08) + inches(0.5)) / Math.cos((lean * Math.PI) / 180);
      const width = Math.max(inches(1), Math.min(inches(3), length * 0.17));
      const from = R * 0.3 * Math.min(1, outer * 1.5);
      const a = (turn * Math.PI) / 180;
      pieces.push(leaned(leafBlade(length, width), lean, turn, [from * Math.sin(a), soil - inches(0.5), from * Math.cos(a)]));
    }
  } else {
    // A clipped shrub: overlapping rounded clumps on a short trunk.
    const r = Math.max(inches(2), Math.min(grow / 2, R * 1.4));
    pieces.push(cylinder([0, soil - 8, 0], 1, Math.max(8, Math.round(r * 0.08)), Math.round(grow * 0.4), 'stem', undefined, 8));
    const clumps = 5 + Math.floor(rnd() * 3);
    const top = soil + grow;
    pieces.push(spheroid([0, top - r, 0], r * 0.85, r * 0.85, 'leaf'));
    for (let i = 0; i < clumps; i++) {
      const a = ((i * 360) / clumps + rnd() * 30) * (Math.PI / 180);
      const rr = r * (0.42 + rnd() * 0.15);
      const d = r - rr * 0.9;
      pieces.push(spheroid([d * Math.sin(a), top - r + (rnd() - 0.4) * r * 0.6, d * Math.cos(a)], rr, rr * 0.9, 'leaf'));
    }
  }
  return mergeGeoms(...pieces);
}

/** An ellipsoid of revolution about Y: `r` across, `h` half its height. */
function spheroid(center: V3, r: number, h: number, tag: string, segments = 16): Geom {
  const profile = Array.from({ length: segments / 2 + 1 }, (_, k): V2 => {
    const a = -Math.PI / 2 + (Math.PI * k) / (segments / 2);
    return [k === 0 || k === segments / 2 ? 0 : r * Math.cos(a), h + h * Math.sin(a)];
  });
  return lathe([center[0], center[1] - h, center[2]], profile, tag, segments);
}

const plantShape = measured(plantGeom);

registerShape<PlantParams>({
  type: 'plant',
  version: 1,
  schema: z.object({
    style: z.enum(['leafy', 'bush']).default('leafy'),
    height: z.int().min(inches(8)).max(inches(96)).default(inches(24)),
    potDiameter: z.int().min(inches(3)).max(inches(30)).default(inches(8)),
    potHeight: z.int().min(inches(2)).max(inches(30)).default(inches(7)),
    potFinish: Finish.default(() => tinted('ceramic', '#e9e4da')),
    seed: Seed.default(1),
  }) as z.ZodType<PlantParams>,
  describe: 'Potted plant: style "leafy" | "bush", height (24"), potDiameter (8"), potHeight (7"), potFinish, seed (variation).',
  decor: {
    category: 'accessory',
    label: 'Plant',
    defaults: { style: 'leafy', height: inches(24) },
    fields: [
      { path: 'style', label: 'Style', kind: 'choice', options: ['leafy', 'bush'] },
      { path: 'height', label: 'Height', kind: 'length' },
      { path: 'potDiameter', label: 'Pot diameter', kind: 'length' },
      { path: 'potHeight', label: 'Pot height', kind: 'length' },
      { path: 'potFinish', label: 'Pot', kind: 'finish' },
      { path: 'seed', label: 'Variation', kind: 'count', min: 0, max: 9999 },
    ],
  },
  build: (p) => ({ geom: plantShape(p).geom }),
  handles: (p) => boundsHandles(plantShape(p).size),
  surfaces: (p) => ({ base: { finish: p.potFinish }, tags: { pot: { finish: p.potFinish }, soil: { finish: SOIL }, leaf: { finish: LEAF }, stem: { finish: STEM } } }),
});

// ── bowl (of fruit) ──────────────────────────────────────────────────────────

export interface BowlParams {
  diameter: number;
  height: number;
  finish: Finish;
  fruit: number;
  seed: number;
}

const FRUIT: Record<string, Surface> = {
  'fruit-red': { finish: tinted('ceramic', '#a3242b', 0.35) },
  'fruit-green': { finish: tinted('ceramic', '#8fae3c', 0.4) },
  'fruit-orange': { finish: tinted('paint', '#e5821b', 0.55) },
  'fruit-lemon': { finish: tinted('paint', '#e8c83f', 0.45) },
  stem: { finish: tinted('paint', '#4e3a26', 0.8) },
};

function bowlGeom(p: BowlParams): Geom {
  const R = p.diameter / 2;
  const H = p.height;
  const Rf = R * 0.42;
  const footH = Math.max(4, Math.round(H * 0.07));
  const wall = Math.max(6, Math.round(R * 0.05));
  const N = 6;
  const outer = Array.from({ length: N }, (_, k): V2 => {
    const a = ((k + 1) / N) * (Math.PI / 2);
    return [Rf + (R - Rf) * Math.sin(a), footH + (H - footH) * (1 - Math.cos(a))];
  });
  outer[N - 1] = [R, H];
  const inner = outer
    .slice(0, -1)
    .map(([r, y]): V2 => [r - wall, Math.min(H - wall, y + wall)])
    .reverse();
  const floor = footH + wall;
  const profile: V2[] = [[0, 0], [Rf, 0], [Rf, footH], ...outer, [R - wall, H], ...inner, [0, floor]];
  const pieces: Geom[] = [lathe([0, 0, 0], profile, 'bowl', 32)];
  // Fruit: a ring of up to five resting in it, the rest on top.
  const rnd = random(p.seed);
  const s = Math.max(0.55, Math.min(1.3, p.diameter / inches(10)));
  for (let i = 0; i < p.fruit; i++) {
    const kind = rnd();
    const r = Math.round((kind < 0.5 ? inches(1.4) : kind < 0.8 ? inches(1.5) : inches(1.25)) * s);
    const ring = i < 5;
    const k = ring ? i : i - 5;
    const n = ring ? Math.min(5, p.fruit) : p.fruit - 5;
    const a = ((k * 360) / Math.max(1, n) + (ring ? 0 : 36) + rnd() * 18) * (Math.PI / 180);
    const d = n === 1 && ring ? 0 : ring ? Math.min(R * 0.42, R - wall - r * 1.15) : R * 0.16;
    const y = floor + r * 0.85 + (ring ? (d / R) * H * 0.35 : r * 1.35);
    const at: V3 = [d * Math.sin(a), y, d * Math.cos(a)];
    if (kind < 0.5) {
      pieces.push(sphere(at, r, kind < 0.32 ? 'fruit-red' : 'fruit-green', 16));
      pieces.push(cylinder([at[0], at[1] + r - 8, at[2]], 1, 3, inches(0.5), 'stem', undefined, 4));
    } else if (kind < 0.8) pieces.push(sphere(at, r, 'fruit-orange', 16));
    else pieces.push(translateGeom(rotateGeom(spheroid([0, 0, 0], r * 0.8, r * 1.15, 'fruit-lemon'), 0, 1), at));
  }
  return mergeGeoms(...pieces);
}

const bowlShape = measured(bowlGeom);

registerShape<BowlParams>({
  type: 'bowl',
  version: 1,
  schema: z.object({
    diameter: z.int().min(inches(4)).max(inches(24)).default(inches(10)),
    height: z.int().min(inches(1.5)).max(inches(12)).default(inches(4)),
    finish: Finish.default(() => tinted('ceramic', '#f1eee8')),
    fruit: z.int().min(0).max(8).default(3),
    seed: Seed.default(1),
  }) as z.ZodType<BowlParams>,
  describe: 'Bowl: diameter (10"), height (4"), finish, fruit (0–8), seed.',
  decor: {
    category: 'accessory',
    label: 'Bowl',
    defaults: { diameter: inches(10), fruit: 3 },
    fields: [
      { path: 'diameter', label: 'Diameter', kind: 'length' },
      { path: 'height', label: 'Height', kind: 'length' },
      { path: 'finish', label: 'Finish', kind: 'finish' },
      { path: 'fruit', label: 'Fruit', kind: 'count', min: 0, max: 8 },
      { path: 'seed', label: 'Variation', kind: 'count', min: 0, max: 9999 },
    ],
  },
  build: (p) => ({ geom: bowlShape(p).geom }),
  handles: (p) => boundsHandles(bowlShape(p).size),
  surfaces: (p) => ({ base: { finish: p.finish }, tags: { bowl: { finish: p.finish }, ...FRUIT } }),
});

// ── books ────────────────────────────────────────────────────────────────────

export interface BooksParams {
  count: number;
  height: number;
  depth: number;
  seed: number;
}

/** Cloth bindings: muted reds, blues, greens, ochre, charcoal, tan, cream, plum. */
export const BOOK_COLORS = ['#7a2e2e', '#2f4a5f', '#55653a', '#b8995a', '#36383b', '#8a5a3c', '#d9d2c2', '#4b3b5c'] as const;
const PAGES: Finish = { preset: 'paint', color: '#eee6d3', roughness: 0.85 };

/** A row of books standing along X, spines to the front (+Z), pages up and at the back. */
function booksGeom(p: BooksParams): Geom {
  const rnd = random(p.seed);
  const pieces: Geom[] = [];
  let x = 0;
  for (let i = 0; i < p.count; i++) {
    const t = Math.round(inches(0.6) + rnd() * inches(1));
    const h = Math.round(p.height * (0.8 + rnd() * 0.3));
    const d = Math.round(p.depth * (0.85 + rnd() * 0.2));
    const color = Math.floor(rnd() * BOOK_COLORS.length);
    const book = channeledBox([t, h, d], [], (axis, max) => ({ ...boxFaceInfo(axis, max), tag: (axis === 1 && max) || (axis === 2 && !max) ? 'pages' : `cover-${color}` }), 'book');
    pieces.push(translateGeom(book, [x, 0, -d]));
    // 1/64" apart: books that touch face to face would share edges.
    x += t + 1;
  }
  return mergeGeoms(...pieces);
}

const booksShape = measured(booksGeom);

registerShape<BooksParams>({
  type: 'books',
  version: 1,
  schema: z.object({
    count: z.int().min(1).max(24).default(5),
    height: z.int().min(inches(4)).max(inches(16)).default(inches(9)),
    depth: z.int().min(inches(3)).max(inches(14)).default(inches(6)),
    seed: Seed.default(1),
  }) as z.ZodType<BooksParams>,
  describe: 'Books standing in a row along x, spines front: count (5), height (9"), depth (6"), seed.',
  decor: {
    category: 'accessory',
    label: 'Books',
    defaults: { count: 5 },
    fields: [
      { path: 'count', label: 'Count', kind: 'count', min: 1, max: 24 },
      { path: 'height', label: 'Height', kind: 'length' },
      { path: 'depth', label: 'Depth', kind: 'length' },
      { path: 'seed', label: 'Variation', kind: 'count', min: 0, max: 9999 },
    ],
  },
  build: (p) => ({ geom: booksShape(p).geom }),
  handles: (p) => boundsHandles(booksShape(p).size),
  surfaces: (): SurfaceMap => ({
    base: { finish: PAGES },
    tags: { pages: { finish: PAGES }, ...Object.fromEntries(BOOK_COLORS.map((c, i) => [`cover-${i}`, { finish: tinted('paint', c, 0.7) }])) },
  }),
});

// ── vase ─────────────────────────────────────────────────────────────────────

export interface VaseParams {
  height: number;
  diameter: number;
  finish: Finish;
  stems: number;
  seed: number;
}

function vaseGeom(p: VaseParams): Geom {
  const R = p.diameter / 2;
  const H = p.height;
  const wall = Math.max(6, Math.round(R * 0.08));
  const neck = R * 0.42;
  const lip = R * 0.52;
  const profile: V2[] = [
    [0, 0], [R * 0.62, 0], [R * 0.9, H * 0.14], [R, H * 0.36], [R * 0.86, H * 0.6], [neck, H * 0.84], [lip, H],
    [lip - wall, H], [neck - wall, H * 0.84], [R * 0.86 - wall, H * 0.6], [R - wall, H * 0.36], [R * 0.9 - wall, H * 0.14 + wall], [0, wall],
  ];
  const pieces: Geom[] = [lathe([0, 0, 0], profile, 'vase', 32)];
  const rnd = random(p.seed);
  for (let i = 0; i < p.stems; i++) {
    const lean = 4 + rnd() * 16 + (p.stems > 1 ? 6 : 0);
    const turn = i * 137.5 + rnd() * 40;
    const length = H * (0.75 + rnd() * 0.45);
    const base: V3 = [0, H * 0.45, 0];
    // A stem with leaves up it and a bud at its tip, leaning out of the neck.
    const parts: Geom[] = [cylinder([0, 0, 0], 1, 5, length, 'stem', undefined, 8)];
    for (let k = 0; k < 3; k++) {
      const y = length * (0.55 + k * 0.14);
      const leaf = leafBlade(inches(1.6) * (1 - k * 0.15), inches(0.7));
      parts.push(translateGeom(transformGeom(leaf, mulRotations(rotationY(k * 120 + rnd() * 40), rotationX(55))), [0, y, 0]));
    }
    parts.push(spheroid([0, length + inches(0.4), 0], inches(0.45), inches(0.6), 'bud', 12));
    pieces.push(leaned(mergeGeoms(...parts), lean, turn, base));
  }
  return mergeGeoms(...pieces);
}

const vaseShape = measured(vaseGeom);

registerShape<VaseParams>({
  type: 'vase',
  version: 1,
  schema: z.object({
    height: z.int().min(inches(3)).max(inches(36)).default(inches(12)),
    diameter: z.int().min(inches(2)).max(inches(16)).default(inches(5)),
    finish: Finish.default(() => tinted('ceramic', '#3d5a5b')),
    stems: z.int().min(0).max(9).default(3),
    seed: Seed.default(1),
  }) as z.ZodType<VaseParams>,
  describe: 'Vase: height (12"), diameter (5"), finish, stems (0–9), seed.',
  decor: {
    category: 'accessory',
    label: 'Vase',
    defaults: { height: inches(12), stems: 3 },
    fields: [
      { path: 'height', label: 'Height', kind: 'length' },
      { path: 'diameter', label: 'Diameter', kind: 'length' },
      { path: 'finish', label: 'Finish', kind: 'finish' },
      { path: 'stems', label: 'Stems', kind: 'count', min: 0, max: 9 },
      { path: 'seed', label: 'Variation', kind: 'count', min: 0, max: 9999 },
    ],
  },
  build: (p) => ({ geom: vaseShape(p).geom }),
  handles: (p) => boundsHandles(vaseShape(p).size),
  surfaces: (p) => ({ base: { finish: p.finish }, tags: { vase: { finish: p.finish }, stem: { finish: STEM }, leaf: { finish: LEAF }, bud: { finish: tinted('paint', '#f3ede2', 0.6) } } }),
});
