import earcut from 'earcut';
import type { Geom, PlanarFace, TaggedMesh, V2, V3 } from './types';

/** Face-local (s, t) → part-local 3D. Shared by features so rim vertices match exactly. */
export function facePoint(face: PlanarFace, s: number, t: number): V3 {
  const { origin: o, u, v } = face;
  return [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t];
}

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  triTags: number[] = [];
  tags: string[] = [];
  private tagIndex = new Map<string, number>();

  tag(t: string): number {
    let i = this.tagIndex.get(t);
    if (i === undefined) {
      i = this.tags.length;
      this.tags.push(t);
      this.tagIndex.set(t, i);
    }
    return i;
  }

  vertex(p: V3, n: V3): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    return this.positions.length / 3 - 1;
  }

  /** Adds a triangle, flipping it if its winding disagrees with `facing`. */
  tri(a: number, b: number, c: number, tag: number, facing: V3): void {
    const p = this.positions;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const e1 = [p[b * 3]! - ax, p[b * 3 + 1]! - ay, p[b * 3 + 2]! - az];
    const e2 = [p[c * 3]! - ax, p[c * 3 + 1]! - ay, p[c * 3 + 2]! - az];
    const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const flip = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0;
    this.indices.push(a, flip ? c : b, flip ? b : c);
    this.triTags.push(tag);
  }

  build(): TaggedMesh {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
      triTags: new Uint16Array(this.triTags),
      tags: this.tags,
    };
  }
}

/** Indices of `pts` without consecutive duplicates (earcut would skip them, leaving cracks). */
function dedupe<T>(pts: T[], same: (a: T, b: T) => boolean): number[] {
  const keep: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = keep.length ? pts[keep[keep.length - 1]!]! : undefined;
    if (prev === undefined || !same(prev, pts[i]!)) keep.push(i);
  }
  while (keep.length > 1 && same(pts[keep[0]!]!, pts[keep[keep.length - 1]!]!)) keep.pop();
  return keep;
}

const same2 = (a: V2, b: V2) => a[0] === b[0] && a[1] === b[1];

/**
 * Earcut silently drops collinear points. Neighbouring faces still use them, so put each
 * one back by splitting the triangle that spans it — otherwise shared edges don't match.
 */
function reinsertDropped(tris: number[], loops: number[][]): void {
  const used = new Set(tris);
  for (const loop of loops) {
    const n = loop.length;
    for (let k = 0; k < n; k++) {
      const idx = loop[k]!;
      if (used.has(idx)) continue;
      let prev = -1;
      let next = -1;
      for (let s = 1; s < n && prev < 0; s++) if (used.has(loop[(k - s + n) % n]!)) prev = loop[(k - s + n) % n]!;
      for (let s = 1; s < n && next < 0; s++) if (used.has(loop[(k + s) % n]!)) next = loop[(k + s) % n]!;
      if (prev < 0 || next < 0) continue;
      for (let t = 0; t < tris.length; t += 3) {
        const tri = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
        const e = [0, 1, 2].find((i) => {
          const [x, y] = [tri[i]!, tri[(i + 1) % 3]!];
          return (x === prev && y === next) || (x === next && y === prev);
        });
        if (e === undefined) continue;
        const [x, y, z] = [tri[e]!, tri[(e + 1) % 3]!, tri[(e + 2) % 3]!];
        tris.splice(t, 3, x, idx, z);
        tris.push(idx, y, z);
        used.add(idx);
        break;
      }
    }
  }
}

function addFace(mb: MeshBuilder, face: PlanarFace): void {
  const flat: number[] = [];
  const pos: V3[] = [];
  const loops: number[][] = [];
  const addLoop = (pts: V2[], exact?: V3[]) => {
    const keep = dedupe(pts, same2);
    if (keep.length < 3) return false;
    const loop: number[] = [];
    for (const i of keep) {
      const [s, t] = pts[i]!;
      loop.push(flat.length / 2);
      flat.push(s, t);
      pos.push(exact ? exact[i]! : facePoint(face, s, t));
    }
    loops.push(loop);
    return true;
  };
  if (!addLoop(face.outer, face.outer3)) return;
  const holeStarts: number[] = [];
  for (const hole of face.holes) {
    const start = flat.length / 2;
    if (addLoop(hole)) holeStarts.push(start);
  }
  const tris = earcut(flat, holeStarts.length ? holeStarts : null, 2);
  reinsertDropped(tris, loops);
  const base = mb.positions.length / 3;
  for (const p of pos) mb.vertex(p, face.normal);
  const tag = mb.tag(face.tag);
  for (let i = 0; i < tris.length; i += 3) {
    mb.tri(base + tris[i]!, base + tris[i + 1]!, base + tris[i + 2]!, tag, face.normal);
  }
}

export function tessellate(geom: Geom): TaggedMesh {
  const mb = new MeshBuilder();
  for (const face of geom.faces) addFace(mb, face);
  for (const patch of geom.patches) {
    const base = mb.positions.length / 3;
    const pos = patch.positions;
    const nrm = patch.normals;
    for (let i = 0; i < pos.length; i += 3) {
      mb.vertex([pos[i]!, pos[i + 1]!, pos[i + 2]!], [nrm[i]!, nrm[i + 1]!, nrm[i + 2]!]);
    }
    const tag = mb.tag(patch.tag);
    for (let i = 0; i < patch.indices.length; i += 3) {
      const a = patch.indices[i]!;
      // Orient by the first vertex's normal; patch triangles are small relative to curvature.
      mb.tri(base + a, base + patch.indices[i + 1]!, base + patch.indices[i + 2]!, tag, [
        nrm[a * 3]!,
        nrm[a * 3 + 1]!,
        nrm[a * 3 + 2]!,
      ]);
    }
  }
  return mb.build();
}
