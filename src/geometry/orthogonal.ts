import { pointInPolygon, signedArea } from './polygon';
import { GeometryError, unitAxis, type Axis } from './prism';
import type { Geom, PlanarFace, V2, V3 } from './types';

/**
 * A box with axis-aligned blocks of material removed: dados, grooves and rabbets, which (unlike
 * pockets) may run off the box's edges. Solved exactly on the grid of every box and block
 * boundary: each grid cell is solid or cut away, and the faces are the cell faces between solid
 * and empty, merged per plane and tag. Loops keep every grid vertex they pass, so faces that meet
 * share identical edges (watertight, no T-junctions). Coordinates are integers, so it's exact.
 */

export interface Block {
  featureId: string;
  /** Part-local corners; clipped to the box. */
  min: V3;
  max: V3;
  /** Depth axis: faces across it are the floor, the rest are walls. */
  axis: Axis;
  /** For messages, e.g. `dado f1`. */
  label: string;
}

/** The box's own face on an axis side: its tag and in-plane (u, v) axes. */
export type BoxFaceInfo = (axis: Axis, max: boolean) => { tag: string; u: Axis; v: Axis };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function channeledBox(size: V3, input: Block[], faceInfo: BoxFaceInfo, partName: string): Geom {
  const blocks = input.map((b) => {
    const min = b.min.map((v, k) => clamp(v, 0, size[k]!)) as V3;
    const max = b.max.map((v, k) => clamp(v, 0, size[k]!)) as V3;
    if ([0, 1, 2].some((k) => max[k]! - min[k]! <= 0)) throw new GeometryError(`${b.label} misses "${partName}"`);
    return { ...b, min, max };
  });

  const grid = [0, 1, 2].map((k) => [...new Set([0, size[k]!, ...blocks.flatMap((b) => [b.min[k]!, b.max[k]!])])].sort((a, b) => a - b));
  const n = grid.map((g) => g.length - 1) as V3;
  const index = (c: V3) => (c[0] * n[1] + c[1]) * n[2] + c[2];
  const inside = (c: V3) => c.every((v, k) => v >= 0 && v < n[k]!);

  // Which block (if any) removes each cell.
  const owner = new Int32Array(n[0] * n[1] * n[2]).fill(-1);
  let solidCount = 0;
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let l = 0; l < n[2]; l++) {
        const c: V3 = [i, j, l];
        const mid = c.map((v, k) => (grid[k]![v]! + grid[k]![v + 1]!) / 2);
        const o = blocks.findIndex((b) => mid.every((m, k) => m > b.min[k]! && m < b.max[k]!));
        owner[index(c)] = o;
        if (o < 0) solidCount++;
      }
    }
  }
  const solid = (c: V3) => inside(c) && owner[index(c)]! < 0;

  // What's left must be one piece.
  const start = owner.findIndex((o) => o < 0);
  if (start < 0) throw new GeometryError(`${blocks.map((b) => b.label).join(', ')} remove all of "${partName}"`);
  const seen = new Uint8Array(owner.length);
  const queue: V3[] = [[Math.floor(start / (n[1] * n[2])), Math.floor(start / n[2]) % n[1], start % n[2]]];
  seen[start] = 1;
  let reached = 0;
  while (queue.length) {
    const c = queue.pop()!;
    reached++;
    for (let k = 0; k < 3; k++) {
      for (const s of [-1, 1]) {
        const q = [...c] as V3;
        q[k] = c[k]! + s;
        if (solid(q) && !seen[index(q)]) {
          seen[index(q)] = 1;
          queue.push(q);
        }
      }
    }
  }
  if (reached !== solidCount) throw new GeometryError(`${blocks.map((b) => b.label).join(', ')} cut "${partName}" into separate pieces`);

  // Boundary cell faces, grouped by plane, facing and tag.
  interface Group {
    axis: Axis;
    plane: number;
    sign: 1 | -1;
    tag: string;
    u: Axis;
    v: Axis;
    cells: [number, number][];
  }
  const groups = new Map<string, Group>();
  for (const k of [0, 1, 2] as Axis[]) {
    const { u, v } = faceInfo(k, true);
    for (let p = 0; p <= n[k]; p++) {
      for (let a = 0; a < n[u]; a++) {
        for (let b = 0; b < n[v]; b++) {
          const below = [0, 0, 0] as V3;
          below[k] = p - 1;
          below[u] = a;
          below[v] = b;
          const above = [...below] as V3;
          above[k] = p;
          const sb = solid(below);
          if (sb === solid(above)) continue;
          const empty = sb ? above : below;
          let tag: string;
          if (!inside(empty)) {
            tag = faceInfo(k, sb).tag;
          } else {
            const blk = blocks[owner[index(empty)]!]!;
            tag = `${blk.featureId}:${blk.axis === k ? 'floor' : 'wall'}`;
          }
          const key = `${k}|${p}|${sb}|${tag}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { axis: k, plane: grid[k]![p]!, sign: sb ? 1 : -1, tag, u, v, cells: [] }));
          g.cells.push([a, b]);
        }
      }
    }
  }

  const faces: PlanarFace[] = [];
  for (const g of groups.values()) {
    const at = ([a, b]: [number, number]): V2 => [grid[g.u]![a]!, grid[g.v]![b]!];
    const loops = cellLoops(g.cells).map((loop) => loop.map(at));
    const outers = loops.filter((l) => signedArea(l) > 0);
    const holes = loops.filter((l) => signedArea(l) < 0);
    const faceOf = new Map<V2[], PlanarFace>();
    for (const outer of outers) {
      const face: PlanarFace = {
        tag: g.tag,
        origin: unitAxis(g.axis, g.plane),
        u: unitAxis(g.u),
        v: unitAxis(g.v),
        normal: unitAxis(g.axis, g.sign),
        outer,
        holes: [],
      };
      faceOf.set(outer, face);
      faces.push(face);
    }
    for (const hole of holes) {
      const [p, q] = [hole[0]!, hole[1]!];
      const probe: V2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const host = outers.filter((o) => pointInPolygon(probe, o)).sort((x, y) => signedArea(x) - signedArea(y))[0];
      if (host) faceOf.get(host)!.holes.push(hole);
    }
  }
  return { faces, patches: [], cuts: [] };
}

/**
 * Boundary loops of a set of unit grid cells, in grid indexes: outer loops counter-clockwise,
 * holes clockwise, every grid vertex along the way kept. Where two cells touch only at a corner,
 * the walk turns as far left as it can, so each loop stays simple.
 */
function cellLoops(cells: [number, number][]): [number, number][][] {
  const edges = new Map<string, [number, number, number, number]>();
  const add = (a0: number, b0: number, a1: number, b1: number) => {
    const rev = `${a1},${b1}>${a0},${b0}`;
    if (edges.has(rev)) edges.delete(rev);
    else edges.set(`${a0},${b0}>${a1},${b1}`, [a0, b0, a1, b1]);
  };
  for (const [a, b] of cells) {
    add(a, b, a + 1, b);
    add(a + 1, b, a + 1, b + 1);
    add(a + 1, b + 1, a, b + 1);
    add(a, b + 1, a, b);
  }
  const out = new Map<string, [number, number, number, number][]>();
  for (const e of edges.values()) {
    const k = `${e[0]},${e[1]}`;
    out.set(k, [...(out.get(k) ?? []), e]);
  }
  const used = new Set<[number, number, number, number]>();
  const loops: [number, number][][] = [];
  for (const first of edges.values()) {
    if (used.has(first)) continue;
    const loop: [number, number][] = [];
    let e = first;
    for (;;) {
      used.add(e);
      loop.push([e[0], e[1]]);
      if (e[2] === first[0] && e[3] === first[1]) break;
      const [dx, dy] = [e[2] - e[0], e[3] - e[1]];
      const next = out
        .get(`${e[2]},${e[3]}`)!
        .filter((x) => !used.has(x))
        .map((x) => ({ x, turn: Math.atan2(dx * (x[3] - x[1]) - dy * (x[2] - x[0]), dx * (x[2] - x[0]) + dy * (x[3] - x[1])) }))
        .sort((p, q) => q.turn - p.turn)[0];
      if (!next) throw new GeometryError('channel faces did not close (internal error)');
      e = next.x;
    }
    loops.push(loop);
  }
  return loops;
}
