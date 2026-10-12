import { describe, expect, it } from 'vitest';
import '../plugins';
import { buildPart } from '../plugins/pipeline';
import { cylinder } from './solids';
import { tessellate } from './tessellate';
import type { PlanarFace, TaggedMesh, V2, V3 } from './types';
import { boxUVs, uvOffset } from './uv';

const IN = 64;
/** A box part's mesh (tags face:front, face:top, …), sizes in inches. */
const boxMesh = (x: number, y: number, z: number): TaggedMesh =>
  buildPart({ id: 'p', name: 'P', grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type: 'box', params: { x: x * IN, y: y * IN, z: z * IN } }, features: [] }).mesh;

/** One tag's UVs: min and max of u and v, and the vertices' positions with their UVs. */
function tagUVs(m: TaggedMesh, uv: Float32Array, tag: string) {
  const k = m.tags.indexOf(tag);
  const vs = new Set<number>();
  for (let t = 0; t < m.triTags.length; t++) if (m.triTags[t] === k) for (let j = 0; j < 3; j++) vs.add(m.indices[t * 3 + j]!);
  const pts = [...vs].map((v) => ({ p: [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!] as V3, uv: [uv[v * 2]!, uv[v * 2 + 1]!] as V2 }));
  const span = (i: 0 | 1) => Math.max(...pts.map((q) => q.uv[i])) - Math.min(...pts.map((q) => q.uv[i]));
  return { pts, u: span(0), v: span(1) };
}

/** v grows along this part-local axis on a tag (and u doesn't). */
function vAlong(m: TaggedMesh, uv: Float32Array, tag: string, axis: 0 | 1 | 2) {
  const { pts } = tagUVs(m, uv, tag);
  const [a, b] = [pts[0]!, pts.find((q) => q.p[axis] !== pts[0]!.p[axis] && [0, 1, 2].every((k) => k === axis || q.p[k] === pts[0]!.p[k]))!];
  expect(b).toBeDefined();
  expect(Math.abs(b.uv[1] - a.uv[1])).toBeCloseTo(Math.abs(b.p[axis] - a.p[axis]) / IN, 4);
  expect(b.uv[0]).toBeCloseTo(a.uv[0], 4);
}

describe('boxUVs', () => {
  it('gives every vertex a UV, in inches', () => {
    const m = boxMesh(18, 30, 0.75);
    const uv = boxUVs(m, { grain: 'y' });
    expect(uv.length).toBe((m.positions.length / 3) * 2);
    // A door: 18" wide, 30" tall: its face spans 18 × 30 inches.
    const front = tagUVs(m, uv, 'face:front');
    expect([front.u, front.v].map((x) => +x.toFixed(4))).toEqual([18, 30]);
  });

  it('runs v along the grain on faces: up a door, across a drawer front', () => {
    const door = boxMesh(18, 30, 0.75);
    const duv = boxUVs(door, { grain: 'y' });
    for (const tag of ['face:front', 'face:back', 'face:left', 'face:right']) vAlong(door, duv, tag, 1);
    const front = boxMesh(18, 6, 0.75);
    const fuv = boxUVs(front, { grain: 'x' });
    for (const tag of ['face:front', 'face:back', 'face:top', 'face:bottom']) vAlong(front, fuv, tag, 0);
  });

  it('runs end grain and grainless faces along their longer side, like edge banding', () => {
    const door = boxMesh(18, 30, 0.75);
    const uv = boxUVs(door, { grain: 'y' });
    // The top and bottom edges are end grain: along the door's width (x), not its thickness.
    vAlong(door, uv, 'face:top', 0);
    vAlong(door, uv, 'face:bottom', 0);
    const plain = boxMesh(10, 4, 30);
    const puv = boxUVs(plain, { grain: 'none' });
    vAlong(plain, puv, 'face:front', 0);
    vAlong(plain, puv, 'face:top', 2);
    vAlong(plain, puv, 'face:left', 2);
  });

  it("doesn't stretch a 45° face", () => {
    // A ramp face rising 10" over 10" of depth, 20" wide, grain up (y).
    const c: V3[] = [
      [0, 0, 10 * IN],
      [20 * IN, 0, 10 * IN],
      [20 * IN, 10 * IN, 0],
      [0, 10 * IN, 0],
    ];
    const s = Math.SQRT1_2;
    const face: PlanarFace = {
      tag: 'ramp',
      origin: c[0]!,
      u: [1, 0, 0],
      v: [0, s, -s],
      normal: [0, s, s],
      outer: [
        [0, 0],
        [20 * IN, 0],
        [20 * IN, 10 * IN * Math.SQRT2],
        [0, 10 * IN * Math.SQRT2],
      ],
      outer3: c,
      holes: [],
    };
    const m = tessellate({ faces: [face], patches: [], cuts: [] });
    const r = tagUVs(m, boxUVs(m, { grain: 'y' }), 'ramp');
    // Up the slope (along the grain as it lies in the face) is its true length, 10√2".
    expect(r.v).toBeCloseTo(10 * Math.SQRT2, 4);
    expect(r.u).toBeCloseTo(20, 4);
  });

  it('maps a curved patch along its long axis, smoothly along it', () => {
    // A 5" bar pull along x, 3/8" across.
    const m = tessellate(cylinder([0, 12, 12], 0, 12, 5 * IN, 'bar', 'end', 16));
    const uv = boxUVs(m, { grain: 'none' });
    const bar = tagUVs(m, uv, 'bar');
    expect(bar.v).toBeCloseTo(5, 4);
    // Every vertex's v is its x: the bar's length.
    for (const q of bar.pts) expect(q.uv[1]).toBeCloseTo(q.p[0] / IN, 4);
    expect(uv.every(Number.isFinite)).toBe(true);
  });

  it('shifts the whole mapping by the offset', () => {
    const m = boxMesh(18, 30, 0.75);
    const a = boxUVs(m, { grain: 'y' });
    const b = boxUVs(m, { grain: 'y', offset: [3, 40] });
    for (let i = 0; i < a.length; i += 2) {
      expect(b[i]! - a[i]!).toBeCloseTo(3, 4);
      expect(b[i + 1]! - a[i + 1]!).toBeCloseTo(40, 4);
    }
  });
});

describe('uvOffset', () => {
  it('is deterministic, in [0, 96) inches, and differs between neighbours', () => {
    expect(uvOffset('a1.door-left')).toEqual(uvOffset('a1.door-left'));
    const ids = ['a1.door-left', 'a1.door-right', 'a1.drawer-1-front', 'a1.drawer-2-front', 'p1', 'p2'];
    const offs = ids.map(uvOffset);
    for (const o of offs) for (const x of o) expect(x >= 0 && x < 96).toBe(true);
    expect(new Set(offs.map((o) => o.join())).size).toBe(ids.length);
  });
});
