/**
 * Where you can walk in walk mode (B6; pure, inches, world space). A grid over the floor, seen from
 * above: a cell is free when it's on the floor and no solid triangle passes through the body's height
 * band (8" … 70": a toe kick or a door's header doesn't stop you, a counter or a wall does) within the
 * body's radius of it. Doorways are free because their headers sit above the band; an open door's leaf
 * stands in it, so the grid is rebuilt once doors stop moving.
 */

export type V2 = [number, number];

export interface Grid {
  /** The min corner of cell (0, 0), the cell size, and the cell counts along x and z. */
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** 1 = free to stand in, by `i + j * nx`. */
  free: Uint8Array;
}

export interface GridOptions {
  /** The body's height band [low, high] (inches above the floor, y = 0). */
  band: [number, number];
  cell: number;
  /** The body's radius: free cells keep this far from anything solid. */
  radius: number;
  /** The floor's triangles (flat, 9 numbers each): their outline from above is where you can stand. */
  floorTris: ArrayLike<number>;
}

export const WALK_GRID: Omit<GridOptions, 'floorTris'> = { band: [8, 70], cell: 2, radius: 9 };
/** The most cells a grid may have (a bigger area gets bigger cells). */
const MAX_CELLS = 2_000_000;

type P3 = [number, number, number];

/** A triangle clipped to y ∈ [lo, hi] (Sutherland–Hodgman against two planes). */
function clipBand(tri: P3[], lo: number, hi: number): P3[] {
  const clip = (poly: P3[], keep: (p: P3) => number): P3[] => {
    const out: P3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const da = keep(a);
      const db = keep(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    return out;
  };
  return clip(clip(tri, (p) => p[1] - lo), (p) => hi - p[1]);
}

const cross2 = (a: V2, b: V2, p: V2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

/** Whether `p` is inside a convex polygon (either winding; edges count). */
function inConvex(poly: V2[], p: V2): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const c = cross2(poly[i]!, poly[(i + 1) % poly.length]!, p);
    if (c > 1e-9) pos = true;
    else if (c < -1e-9) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

export function buildGrid(tris: ArrayLike<number>, o: GridOptions): Grid {
  const f = o.floorTris;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 8 < f.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      minX = Math.min(minX, f[i + k * 3]!);
      maxX = Math.max(maxX, f[i + k * 3]!);
      minZ = Math.min(minZ, f[i + k * 3 + 2]!);
      maxZ = Math.max(maxZ, f[i + k * 3 + 2]!);
    }
  }
  if (!Number.isFinite(minX)) return { x0: 0, z0: 0, cell: o.cell, nx: 0, nz: 0, free: new Uint8Array(0) };
  let cell = o.cell;
  while (((maxX - minX) / cell) * ((maxZ - minZ) / cell) > MAX_CELLS) cell *= 2;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const x0 = minX;
  const z0 = minZ;
  const walk = new Uint8Array(nx * nz);
  const blocked = new Uint8Array(nx * nz);
  const ci = (x: number) => Math.floor((x - x0) / cell);
  const cj = (z: number) => Math.floor((z - z0) / cell);
  const center = (i: number, j: number): V2 => [x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell];

  /** Marks the cells whose centers lie in a convex polygon (from above). */
  const fill = (poly: V2[], into: Uint8Array) => {
    let lx = Infinity;
    let hx = -Infinity;
    let lz = Infinity;
    let hz = -Infinity;
    for (const p of poly) {
      lx = Math.min(lx, p[0]);
      hx = Math.max(hx, p[0]);
      lz = Math.min(lz, p[1]);
      hz = Math.max(hz, p[1]);
    }
    for (let j = Math.max(0, cj(lz)); j <= Math.min(nz - 1, cj(hz)); j++) {
      for (let i = Math.max(0, ci(lx)); i <= Math.min(nx - 1, ci(hx)); i++) if (inConvex(poly, center(i, j))) into[i + j * nx] = 1;
    }
  };
  /** Marks every cell a segment passes over (sampled finer than a cell). */
  const line = (a: V2, b: V2) => {
    const n = Math.max(1, Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) / cell) * 4));
    for (let k = 0; k <= n; k++) {
      const i = ci(a[0] + ((b[0] - a[0]) * k) / n);
      const j = cj(a[1] + ((b[1] - a[1]) * k) / n);
      if (i >= 0 && j >= 0 && i < nx && j < nz) blocked[i + j * nx] = 1;
    }
  };

  for (let i = 0; i + 8 < f.length; i += 9) fill([[f[i]!, f[i + 2]!], [f[i + 3]!, f[i + 5]!], [f[i + 6]!, f[i + 8]!]], walk);
  const [lo, hi] = o.band;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ys = [tris[i + 1]!, tris[i + 4]!, tris[i + 7]!];
    if (Math.max(...ys) < lo || Math.min(...ys) > hi) continue;
    const poly = clipBand(
      [
        [tris[i]!, ys[0]!, tris[i + 2]!],
        [tris[i + 3]!, ys[1]!, tris[i + 5]!],
        [tris[i + 6]!, ys[2]!, tris[i + 8]!],
      ],
      lo,
      hi,
    ).map((p): V2 => [p[0], p[2]]);
    if (!poly.length) continue;
    for (let k = 0; k < poly.length; k++) line(poly[k]!, poly[(k + 1) % poly.length]!);
    if (poly.length >= 3) fill(poly, blocked);
  }

  // Keep the body's radius from anything blocked.
  const reach = Math.ceil(o.radius / cell);
  const disk: number[][] = [];
  for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) if (Math.hypot(di, dj) * cell <= o.radius) disk.push([di, dj]);
  const near = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!blocked[i + j * nx]) continue;
      for (const [di, dj] of disk) {
        const a = i + di!;
        const b = j + dj!;
        if (a >= 0 && b >= 0 && a < nx && b < nz) near[a + b * nx] = 1;
      }
    }
  }
  const free = new Uint8Array(nx * nz);
  for (let k = 0; k < free.length; k++) free[k] = walk[k] && !near[k] ? 1 : 0;
  return { x0, z0, cell, nx, nz, free };
}

/** Whether a point (x, z) is free to stand on. */
export function isFree(g: Grid, x: number, z: number): boolean {
  const i = Math.floor((x - g.x0) / g.cell);
  const j = Math.floor((z - g.z0) / g.cell);
  return i >= 0 && j >= 0 && i < g.nx && j < g.nz && g.free[i + j * g.nx] === 1;
}

/**
 * Walks from `from` by `delta` (x, z), in steps under half a cell: a blocked step slides along
 * whichever axis is still free, and stops when neither is. Standing somewhere blocked (a door just
 * swung into you), it moves freely, so you can step out.
 */
export function move(g: Grid, from: V2, delta: V2): V2 {
  const dist = Math.hypot(delta[0], delta[1]);
  if (dist < 1e-9) return [from[0], from[1]];
  if (!isFree(g, from[0], from[1])) return [from[0] + delta[0], from[1] + delta[1]];
  const n = Math.max(1, Math.ceil(dist / (g.cell / 2)));
  const dx = delta[0] / n;
  const dz = delta[1] / n;
  let [x, z] = from;
  for (let k = 0; k < n; k++) {
    if (isFree(g, x + dx, z + dz)) {
      x += dx;
      z += dz;
    } else if (dx && isFree(g, x + dx, z)) x += dx;
    else if (dz && isFree(g, x, z + dz)) z += dz;
    else break;
  }
  return [x, z];
}

/** The free spot nearest `p` (itself when it's free; a free cell's center otherwise), or null when there's none. */
export function nearestWalkable(g: Grid, p: V2): V2 | null {
  if (isFree(g, p[0], p[1])) return [p[0], p[1]];
  if (!g.nx || !g.nz) return null;
  const pi = Math.min(g.nx - 1, Math.max(0, Math.floor((p[0] - g.x0) / g.cell)));
  const pj = Math.min(g.nz - 1, Math.max(0, Math.floor((p[1] - g.z0) / g.cell)));
  let best: V2 | null = null;
  let bestD = Infinity;
  const far = Math.max(g.nx, g.nz);
  for (let r = 0; r <= far; r++) {
    // A ring at r can't hold anything nearer than (r − 1) cells once something is found.
    if (best && (r - 1) * g.cell > bestD) break;
    for (let j = pj - r; j <= pj + r; j++) {
      for (let i = pi - r; i <= pi + r; i++) {
        if (Math.max(Math.abs(i - pi), Math.abs(j - pj)) !== r) continue;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz || !g.free[i + j * g.nx]) continue;
        const c: V2 = [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell];
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
  }
  return best;
}
