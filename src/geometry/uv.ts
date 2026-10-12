import type { Grain } from '../model/schema';
import type { TaggedMesh, V3 } from './types';

/**
 * Texture coordinates for presentation (B4; pure). UVs are in inches, so a texture's repeat is one
 * over its real-world size, and `v` runs along the part's grain: a door's face shows its grain up the
 * door, a drawer front's across it. Each mesh tag (a face of the part) is mapped flat in its own
 * plane, so a 45° side isn't stretched. Where the grain runs into a face (end grain, or a part with
 * no grain), `v` runs along the face's longer side instead — the look of edge banding: a door's top
 * edge reads along its width. Curved patches (no single plane) fall back to a per-vertex projection
 * along the tag's long axis.
 *
 * `tessellate()` never shares a vertex between faces, so each vertex's tag comes from its triangles.
 * Only the present look calls this; the editor's meshes and the build cache have no UVs.
 */

const UNITS_PER_INCH = 64;
/** A tag is flat when its area-weighted normal is this close to its area (a ~9° arc or less). */
const FLAT = 0.999;
/** The grain is "in" a face when at least this much of it lies in the face's plane. */
const IN_PLANE = 0.3;

const AXES: readonly V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const GRAIN_AXIS: Record<Grain, number> = { x: 0, y: 1, z: 2, none: -1 };

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * UVs (2 per vertex, inches) for a part's mesh. `grain` is the part's grain axis (part-local);
 * `offset` (inches) shifts the whole mapping, so parts cut from "different boards" differ.
 */
export function boxUVs(mesh: TaggedMesh, o: { grain: Grain; offset?: [number, number] }): Float32Array {
  const { positions: P, normals: N, indices: I, triTags, tags } = mesh;
  const nv = P.length / 3;
  const uv = new Float32Array(nv * 2);
  const [ou, ov] = o.offset ?? [0, 0];
  const g = GRAIN_AXIS[o.grain] ?? -1;
  const p = (i: number): V3 => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];

  // Per tag: the area-weighted normal (twice the area, summed), its total area, and its vertices.
  const sum = tags.map((): V3 => [0, 0, 0]);
  const area = new Float64Array(tags.length);
  const vtag = new Int32Array(nv).fill(-1);
  const verts = tags.map((): number[] => []);
  for (let t = 0; t < triTags.length; t++) {
    const k = triTags[t]!;
    const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    const pa = p(a);
    const pb = p(b);
    const pc = p(c);
    const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
    const s = sum[k]!;
    s[0] += n[0];
    s[1] += n[1];
    s[2] += n[2];
    area[k] = area[k]! + len(n);
    for (const v of [a, b, c]) {
      if (vtag[v] === k) continue;
      if (vtag[v] === -1) verts[k]!.push(v);
      vtag[v] = k;
    }
  }

  /** How far a tag's vertices reach along a direction. */
  const extent = (k: number, d: V3) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of verts[k]!) {
      const x = dot(p(v), d);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return hi - lo;
  };

  for (let k = 0; k < tags.length; k++) {
    if (!verts[k]!.length) continue;
    const s = sum[k]!;
    const l = len(s);
    if (l > 0 && l >= FLAT * area[k]!) {
      // Flat: v along the grain as it lies in this plane, else along the face's longer side.
      const n = scale(s, 1 / l);
      let t: V3 | null = null;
      if (g >= 0) {
        const ga = AXES[g]!;
        const inPlane: V3 = [ga[0] - n[0] * n[g]!, ga[1] - n[1] * n[g]!, ga[2] - n[2] * n[g]!];
        const m = len(inPlane);
        if (m > IN_PLANE) t = scale(inPlane, 1 / m);
      }
      if (!t) {
        let best = -1;
        for (const a of AXES) {
          const d: V3 = [a[0] - n[0] * dot(a, n), a[1] - n[1] * dot(a, n), a[2] - n[2] * dot(a, n)];
          const m = len(d);
          if (m <= IN_PLANE) continue;
          const dir = scale(d, 1 / m);
          const e = extent(k, dir);
          if (e > best * 1.0001 + 1e-9) [best, t] = [e, dir];
        }
      }
      const b = cross(n, t!);
      for (const v of verts[k]!) {
        const q = p(v);
        uv[v * 2] = dot(q, b) / UNITS_PER_INCH + ou;
        uv[v * 2 + 1] = dot(q, t!) / UNITS_PER_INCH + ov;
      }
      continue;
    }
    // Curved (a pull's bar, a hole's wall): v along the tag's long axis (its grain when that runs
    // a fair way along it); u across, projected along each vertex's dominant normal axis.
    const ext = AXES.map((a) => extent(k, a));
    const longest = ext.indexOf(Math.max(...ext));
    const along = g >= 0 && ext[g]! >= 0.5 * ext[longest]! ? g : longest;
    for (const v of verts[k]!) {
      const n: V3 = [N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!];
      const abs = n.map(Math.abs);
      const d = abs.indexOf(Math.max(...abs));
      // A vertex facing along the long axis (a dome's tip) takes the next-longest one instead.
      const ta = d !== along ? along : [0, 1, 2].filter((i) => i !== d).reduce((m, i) => (ext[i]! > ext[m]! ? i : m));
      const b = cross(scale(AXES[d]!, Math.sign(n[d]!) || 1), AXES[ta]!);
      const q = p(v);
      uv[v * 2] = dot(q, b) / UNITS_PER_INCH + ou;
      uv[v * 2 + 1] = q[ta]! / UNITS_PER_INCH + ov;
    }
  }
  return uv;
}

/**
 * Where a part's texture starts (inches, each in [0, 96)): a FNV-1a hash of its id, so neighbouring
 * doors and drawer fronts don't show the same stretch of grain. Deterministic.
 */
export function uvOffset(partId: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < partId.length; i++) {
    h ^= partId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [((h & 0xffff) / 0x10000) * 96, ((h >>> 16) / 0x10000) * 96];
}
