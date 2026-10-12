import type { MapKind, Procedural } from './textureSets';

/**
 * Texture maps drawn in code (B3; pure): subway tile (3" × 6" in running bond, long side along u),
 * large-format floor tile (24" squares), and paint's orange-peel micro-normal. RGBA bytes, row 0 at
 * v = 0 (a DataTexture's layout), every map tiling seamlessly. Tile color maps are a light mask (white
 * tile, gray grout) the finish's color multiplies; roughness is in green, OpenGL-convention normals.
 */

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

interface TileSpec {
  /** Pixels per inch. */
  ppi: number;
  /** The repeat, inches [u, v]. */
  size: [number, number];
  /** Tile size, inches [u, v]; rows alternate by `bond` × the tile's width. */
  tile: [number, number];
  bond: number;
  /** Grout width and the tile's rounded edge, inches. */
  grout: number;
  bevel: number;
  /** Mask brightness of the grout; tile-to-tile brightness variation. */
  groutTone: number;
  vary: number;
  /** Roughness of the tile's face and of the grout. */
  roughness: [number, number];
  /** How much the bevel tilts the normal. */
  relief: number;
}

const SPECS: Record<'tile-subway' | 'tile-floor', TileSpec> = {
  'tile-subway': { ppi: 512 / 12, size: [12, 12], tile: [6, 3], bond: 0.5, grout: 1 / 16, bevel: 0.14, groutTone: 0.74, vary: 0.012, roughness: [0.12, 0.85], relief: 2.2 },
  'tile-floor': { ppi: 512 / 48, size: [48, 48], tile: [24, 24], bond: 0, grout: 1 / 8, bevel: 0.08, groutTone: 0.7, vary: 0.035, roughness: [0.36, 0.9], relief: 1.2 },
};

/** A small seeded PRNG (mulberry32): the same textures every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);
const byte = (x: number) => Math.round(clamp01(x) * 255);

/** Normals from a height field (wrapping at the edges), `k` = slope per unit height step. */
function normalsOf(w: number, h: number, height: Float32Array, k: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out[i] = byte((-dx / l) * 0.5 + 0.5);
      out[i + 1] = byte((-dy / l) * 0.5 + 0.5);
      out[i + 2] = byte((1 / l) * 0.5 + 0.5);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** One tile layout's maps: per pixel, distance to the nearest tile edge and which tile it's in. */
function tiles(s: TileSpec, map: MapKind): Pixels {
  const w = Math.round(s.size[0] * s.ppi);
  const h = Math.round(s.size[1] * s.ppi);
  const cols = s.size[0] / s.tile[0];
  const rows = s.size[1] / s.tile[1];
  const random = rng(7);
  const tone = Array.from({ length: Math.ceil(cols + 1) * rows }, () => 1 - s.vary + random() * 2 * s.vary);
  const height = new Float32Array(w * h);
  const color = new Uint8Array(w * h * 4);
  const rough = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / s.ppi;
    const row = Math.floor(v / s.tile[1]);
    const shift = (row % 2) * s.bond * s.tile[0];
    const dv = Math.min(v - row * s.tile[1], (row + 1) * s.tile[1] - v);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / s.ppi - shift;
      const col = Math.floor(u / s.tile[0]);
      const du = Math.min(u - col * s.tile[0], (col + 1) * s.tile[0] - u);
      // Distance into the tile from its grout line.
      const d = Math.min(du, dv) - s.grout / 2;
      const face = d <= 0 ? 0 : smooth(clamp01(d / s.bevel));
      height[y * w + x] = face;
      const t = tone[(((col % cols) + cols) % cols) + row * Math.ceil(cols + 1)] ?? 1;
      const c = d <= 0 ? s.groutTone : t;
      const i = (y * w + x) * 4;
      color[i] = color[i + 1] = color[i + 2] = byte(c);
      color[i + 3] = 255;
      rough[i] = rough[i + 2] = 0;
      rough[i + 1] = byte(d <= 0 ? s.roughness[1] : s.roughness[0] + (s.roughness[1] - s.roughness[0]) * 0.25 * (1 - face));
      rough[i + 3] = 255;
    }
  }
  if (map === 'color') return { width: w, height: h, data: color };
  if (map === 'roughness') return { width: w, height: h, data: rough };
  // Bevel slope: full height over `bevel` inches, in pixels.
  return { width: w, height: h, data: normalsOf(w, h, height, (s.relief * 1) / Math.max(1, s.bevel * s.ppi)) };
}

/** Periodic value noise, three octaves: a fine, even orange peel. */
function paintMicro(): Pixels {
  const n = 256;
  const random = rng(11);
  const height = new Float32Array(n * n);
  for (const [cells, amp] of [
    [32, 0.5],
    [64, 0.3],
    [128, 0.2],
  ] as const) {
    const lattice = Array.from({ length: cells * cells }, random);
    const at = (i: number, j: number) => lattice[(j % cells) * cells + (i % cells)]!;
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * cells;
      const j = Math.floor(fy);
      const ty = smooth(fy - j);
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * cells;
        const i = Math.floor(fx);
        const tx = smooth(fx - i);
        const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
        const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
        height[y * n + x] = height[y * n + x]! + (a + (b - a) * ty) * amp;
      }
    }
  }
  return { width: n, height: n, data: normalsOf(n, n, height, 1.5) };
}

/** A procedural set's map, or null when it doesn't make that one. */
export function proceduralMap(kind: Procedural, map: MapKind): Pixels | null {
  if (kind === 'paint-micro') return map === 'normal' ? paintMicro() : null;
  return tiles(SPECS[kind], map);
}
