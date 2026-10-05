import type { V3 } from '../geometry/types';
import { parentIndex } from './doc';
import type { Doc, Transform } from './schema';
import { buildPart } from '../plugins/pipeline';

/**
 * World-space bounds of parts and assemblies, in model units (1/64"), and the rotation math that
 * moving and turning nodes needs. Rotations may be any angle; quarter turns stay exact (no float
 * noise), so square layouts keep integer bounds. Pure: shared by the AI context, tool warnings,
 * snapping and evals.
 */

export interface Box3 {
  min: V3;
  max: V3;
}

export type Mat3 = [V3, V3, V3]; // rows

const DEG = Math.PI / 180;
const trig = (deg: number): [number, number] => {
  if (Number.isInteger(deg) && deg % 90 === 0) {
    const q = ((deg / 90) % 4 + 4) % 4;
    return [[1, 0, -1, 0][q]!, [0, 1, 0, -1][q]!];
  }
  return [Math.cos(deg * DEG), Math.sin(deg * DEG)];
};

export function mul(a: Mat3, b: Mat3): Mat3 {
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j]! + row[1] * b[1][j]! + row[2] * b[2][j]!)) as Mat3;
}

/** Same convention as three.js Euler 'XYZ': M = Rx · Ry · Rz. */
export function rotation([x, y, z]: V3): Mat3 {
  const [cx, sx] = trig(x);
  const [cy, sy] = trig(y);
  const [cz, sz] = trig(z);
  const rx: Mat3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry: Mat3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz: Mat3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return mul(mul(rx, ry), rz);
}

/** Rotation by `deg` about a unit axis (right-handed); exact for quarter turns about a coordinate axis. */
export function axisRotation([x, y, z]: V3, deg: number): Mat3 {
  const [c, s] = trig(deg);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** Degrees in (−180, 180], to 0.001°. */
export function normalizeAngle(deg: number): number {
  const a = ((deg % 360) + 360) % 360;
  const r = Math.round((a > 180 ? a - 360 : a) * 1000) / 1000;
  return r === -180 ? 180 : r || 0;
}

/**
 * XYZ Euler degrees for a rotation matrix (the inverse of `rotation`). Of the two solutions it
 * picks the one that tilts least (|x| + |z|), so a half turn reads [0, 180, 0], not [180, 0, 180].
 */
export function eulerXYZ(m: Mat3): V3 {
  const s = Math.max(-1, Math.min(1, m[0][2]));
  const y = Math.asin(s) / DEG;
  const a: V3 =
    Math.abs(s) < 0.9999999
      ? [Math.atan2(-m[1][2], m[2][2]) / DEG, y, Math.atan2(-m[0][1], m[0][0]) / DEG]
      : [Math.atan2(m[2][1], m[1][1]) / DEG, y, 0];
  const A = a.map(normalizeAngle) as V3;
  const B = [a[0] + 180, 180 - a[1], a[2] + 180].map(normalizeAngle) as V3;
  const tilt = (v: V3) => Math.abs(v[0]) + Math.abs(v[2]);
  return tilt(B) < tilt(A) - 1e-9 ? B : A;
}

/** True when `m` only permutes and flips the coordinate axes: quarter turns only. */
export function isSquare(m: Mat3, eps = 1e-6): boolean {
  return m.every((row) => row.every((v) => Math.abs(v) < eps || Math.abs(Math.abs(v) - 1) < eps));
}

/** Node-local → parent (or world) frame. */
export interface Affine {
  m: Mat3;
  t: V3;
}
export const apply = (a: Affine, p: V3): V3 => [0, 1, 2].map((i) => a.m[i]![0] * p[0] + a.m[i]![1] * p[1] + a.m[i]![2] * p[2] + a.t[i]!) as V3;
/** Rotates a direction (no translation). */
export const rotate = (m: Mat3, v: V3): V3 => [0, 1, 2].map((i) => m[i]![0] * v[0] + m[i]![1] * v[1] + m[i]![2] * v[2]) as V3;
export const transpose = (m: Mat3): Mat3 => [0, 1, 2].map((i) => [m[0][i]!, m[1][i]!, m[2][i]!]) as Mat3;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** World (or parent) point → the frame's own coordinates. */
export const toFrame = (f: Affine, p: V3): V3 => rotate(transpose(f.m), sub(p, f.t));
const compose = (parent: Affine, local: Transform): Affine => ({
  m: mul(parent.m, rotation(local.rotation)),
  t: apply(parent, local.position),
});
export const IDENTITY: Affine = { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
/** `a` after `b`: a point goes through `b`, then `a`. */
export const composeAffine = (a: Affine, b: Affine): Affine => ({ m: mul(a.m, b.m), t: apply(a, b.t) });
/** The reverse move (rotation + translation only). */
export function invertAffine(a: Affine): Affine {
  const m = transpose(a.m);
  return { m, t: rotate(m, a.t).map((v) => -v) as V3 };
}
/** A node's own transform as an affine (node-local → parent). */
export const affineOf = (t: Transform): Affine => ({ m: rotation(t.rotation), t: [...t.position] as V3 });

/** Local → world for a part or assembly (its own frame, composed through its parents). */
export function nodeAffine(doc: Doc, id: string): Affine {
  const parents = parentIndex(doc);
  const chain: Transform[] = [];
  for (let cur: string | null | undefined = id; cur; cur = parents.get(cur)) {
    const node = doc.parts[cur] ?? doc.assemblies[cur];
    if (!node) break;
    chain.unshift(node.transform);
  }
  return chain.reduce(compose, IDENTITY);
}

/** Local → world for every node in the tree, in one pass. */
export function allAffines(doc: Doc): Map<string, Affine> {
  const out = new Map<string, Affine>();
  const visit = (id: string, parent: Affine) => {
    const node = doc.parts[id] ?? doc.assemblies[id];
    if (!node) return;
    const here = compose(parent, node.transform);
    out.set(id, here);
    for (const c of doc.assemblies[id]?.children ?? []) visit(c, here);
  };
  for (const id of doc.roots) visit(id, IDENTITY);
  return out;
}

/**
 * A node's transform after turning it `deg` about a world axis (unit) through a world pivot (model
 * units): the new local rotation and position, parent-aware. The position rounds to 1/64".
 */
export function rotateAbout(doc: Doc, id: string, pivot: V3, axis: V3, deg: number): Transform {
  const node = doc.parts[id] ?? doc.assemblies[id];
  if (!node) throw new Error(`no part or assembly "${id}"`);
  const parent = parentIndex(doc).get(id);
  const P = parent ? nodeAffine(doc, parent) : IDENTITY;
  const Pt = transpose(P.m);
  const Q = axisRotation(axis, deg);
  const origin = apply(P, node.transform.position);
  const moved = add(rotate(Q, sub(origin, pivot)), pivot);
  return {
    position: rotate(Pt, sub(moved, P.t)).map(Math.round) as V3,
    rotation: eulerXYZ(mul(mul(mul(Pt, Q), P.m), rotation(node.transform.rotation))),
  };
}

/** Part-local bounds of the built part (a hole doesn't change them; a profile can't grow them). */
export function localBox(doc: Doc, partId: string): Box3 {
  const part = doc.parts[partId]!;
  const pos = buildPart(part).mesh.positions;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, pos[i + k]!);
      max[k] = Math.max(max[k]!, pos[i + k]!);
    }
  }
  return { min, max };
}

export function transformBox(a: Affine, b: Box3): Box3 {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = apply(a, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  }
  return { min: min.map(Math.round) as V3, max: max.map(Math.round) as V3 };
}

/** World bounds of every part and (non-empty) assembly, keyed by id. Axis-aligned: bigger than a node turned off the axes. */
export function worldBoxes(doc: Doc): Map<string, Box3> {
  const out = new Map<string, Box3>();
  const visit = (id: string, parent: Affine): Box3 | null => {
    const part = doc.parts[id];
    if (part) {
      const box = transformBox(compose(parent, part.transform), localBox(doc, id));
      out.set(id, box);
      return box;
    }
    const asm = doc.assemblies[id];
    if (!asm) return null;
    const here = compose(parent, asm.transform);
    const boxes = asm.children.map((c) => visit(c, here)).filter((b): b is Box3 => b !== null);
    if (!boxes.length) return null;
    const box = union(boxes);
    out.set(id, box);
    return box;
  };
  for (const id of doc.roots) visit(id, IDENTITY);
  return out;
}

/**
 * Bounds of every part that sits square to a frame (turned from it by quarter turns only), in the
 * frame's coordinates — e.g. a part's own frame, so snapping works along its axes at any angle.
 * Parts at other angles are left out. Rounded to 1/64".
 */
export function frameBoxes(doc: Doc, frame: Affine): Map<string, Box3> {
  const out = new Map<string, Box3>();
  const Ft = transpose(frame.m);
  for (const [id, A] of allAffines(doc)) {
    if (!doc.parts[id]) continue;
    const m = mul(Ft, A.m);
    if (!isSquare(m)) continue;
    let local: Box3;
    try {
      local = localBox(doc, id);
    } catch {
      continue;
    }
    out.set(id, transformBox({ m, t: rotate(Ft, sub(A.t, frame.t)) }, local));
  }
  return out;
}

export function union(boxes: Box3[]): Box3 {
  return {
    min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]!))) as V3,
    max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]!))) as V3,
  };
}

export const boxSize = (b: Box3): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const column = (m: Mat3, j: number): V3 => [m[0][j]!, m[1][j]!, m[2][j]!];

/** How far two oriented boxes interpenetrate along their least-overlapping axis (separating-axis test); ≤ 0 = apart. */
export function penetration(a: Affine, ab: Box3, b: Affine, bb: Box3): number {
  const obb = (f: Affine, box: Box3) => ({
    c: apply(f, [0, 1, 2].map((k) => (box.min[k]! + box.max[k]!) / 2) as V3),
    axes: [0, 1, 2].map((j) => column(f.m, j)) as V3[],
    h: [0, 1, 2].map((k) => (box.max[k]! - box.min[k]!) / 2),
  });
  const A = obb(a, ab);
  const B = obb(b, bb);
  const T = sub(B.c, A.c);
  const axes = [...A.axes, ...B.axes];
  for (const u of A.axes) for (const v of B.axes) axes.push(cross(u, v));
  let least = Infinity;
  for (const L of axes) {
    const len = Math.hypot(...L);
    if (len < 1e-6) continue;
    const n = L.map((c) => c / len) as V3;
    const r = (o: typeof A) => o.axes.reduce((s, ax, i) => s + o.h[i]! * Math.abs(dot(ax, n)), 0);
    least = Math.min(least, r(A) + r(B) - Math.abs(dot(T, n)));
  }
  return least;
}

/**
 * Pairs of parts that interpenetrate (touching is fine), involving at least one of `ids`. `depth` is
 * the overlap along each axis: world axes, or the first part's own axes when both are turned off the
 * world axes but square to each other; for parts at odd angles to each other it's their bounds' overlap.
 */
export function overlaps(doc: Doc, ids: Iterable<string>, boxes = worldBoxes(doc)): { a: string; b: string; depth: V3 }[] {
  const parents = parentIndex(doc);
  /** A part's parent, skipping a generated folder it's in. */
  const genParent = (id: string) => {
    const p = parents.get(id);
    return p && doc.assemblies[p]?.role !== undefined ? parents.get(p) : p;
  };
  const focus = new Set(ids);
  const partIds = Object.keys(doc.parts).filter((id) => boxes.has(id));
  let affines: Map<string, Affine> | undefined;
  const affine = (id: string) => (affines ??= allAffines(doc)).get(id)!;
  const out: { a: string; b: string; depth: V3 }[] = [];
  for (let i = 0; i < partIds.length; i++) {
    for (let j = i + 1; j < partIds.length; j++) {
      const [a, b] = [partIds[i]!, partIds[j]!];
      if (!focus.has(a) && !focus.has(b)) continue;
      // Parts of the same generated assembly (or its generated folders) are laid out by the generator.
      const pa = genParent(a);
      if (pa && pa === genParent(b) && doc.assemblies[pa]?.generator && doc.parts[a]!.role && doc.parts[b]!.role) continue;
      const A = boxes.get(a)!;
      const B = boxes.get(b)!;
      const depth = [0, 1, 2].map((k) => Math.min(A.max[k]!, B.max[k]!) - Math.max(A.min[k]!, B.min[k]!)) as V3;
      if (!depth.every((d) => d > 1)) continue;
      const [fa, fb] = [affine(a), affine(b)];
      // Square to the world: the bounds are the parts.
      if (isSquare(fa.m) && isSquare(fb.m)) {
        out.push({ a, b, depth });
        continue;
      }
      const [la, lb] = [localBox(doc, a), localBox(doc, b)];
      const rel = mul(transpose(fa.m), fb.m);
      if (isSquare(rel)) {
        const inA = transformBox({ m: rel, t: toFrame(fa, fb.t) }, lb);
        const d = [0, 1, 2].map((k) => Math.min(la.max[k]!, inA.max[k]!) - Math.max(la.min[k]!, inA.min[k]!)) as V3;
        if (d.every((x) => x > 1)) out.push({ a, b, depth: d });
      } else if (penetration(fa, la, fb, lb) > 1) {
        out.push({ a, b, depth });
      }
    }
  }
  return out;
}
