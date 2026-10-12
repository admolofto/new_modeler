import { signedArea } from './polygon';
import { GeometryError, unitAxis, type Axis } from './prism';
import type { Cut, Geom, Patch, PlanarFace, V2, V3 } from './types';

/**
 * Small closed solids for decor (pulls, props, appliance details): boxes, extruded outlines,
 * cylinders, lathed profiles and spheres, plus quarter-turn, mirror and translate helpers. Flat
 * ends are planar faces; curved sides are patches with smooth normals. Shared boundaries are
 * computed once, so the tessellated mesh is closed (every edge a→b has its b→a). Round things use
 * segment counts that are multiples of 4, so their bounds land exactly on center ± r. Pure.
 */

/** Outline-plane axes [a, b] for an extrusion along each axis (box face frames use the same). */
const PLANE: Record<Axis, [Axis, Axis]> = { 0: [2, 1], 1: [0, 2], 2: [0, 1] };

export const SEGMENTS = 32;

const empty = (): Geom => ({ faces: [], patches: [], cuts: [] });

/** [cos, sin] at n even steps round a circle, exact at the quarter points. */
export function unitCircle(n = SEGMENTS): V2[] {
  if (n < 4 || n % 4 !== 0) throw new GeometryError(`round solids need a multiple of 4 segments (got ${n})`);
  const exact: V2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  return Array.from({ length: n }, (_, i) => (i % (n / 4) === 0 ? exact[i / (n / 4)]! : [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]));
}

const norm2 = (p: V2): V2 => {
  const l = Math.hypot(p[0], p[1]);
  return [p[0] / l, p[1] / l];
};

/**
 * An outline in the plane across `axis` (coordinates along `PLANE[axis]`), extruded from `from` to
 * `to` along it. `smooth` marks outline vertices whose side normal blends both neighbouring edges
 * (true: all of them, a round outline); the rest stay sharp. Ends are tagged `capTag` (default `tag`).
 */
export function extrude(outline: V2[], axis: Axis, from: number, to: number, tag: string, o: { smooth?: boolean | boolean[]; capTag?: string } = {}): Geom {
  const n = outline.length;
  if (n < 3) throw new GeometryError('an extruded outline needs at least 3 points');
  if (to <= from) throw new GeometryError('an extrusion needs a positive length');
  const area = signedArea(outline);
  if (area === 0) throw new GeometryError('an extruded outline needs an area');
  const [A, B] = PLANE[axis];
  const point = (p: V2, c: number): V3 => {
    const v: V3 = [0, 0, 0];
    v[A] = p[0];
    v[B] = p[1];
    v[axis] = c;
    return v;
  };
  const smooth = (i: number) => (Array.isArray(o.smooth) ? !!o.smooth[i] : !!o.smooth);
  // Outward edge normals: right-hand for a counter-clockwise outline.
  const edgeN = outline.map((p, i): V2 => {
    const q = outline[(i + 1) % n]!;
    const d = norm2([q[0] - p[0], q[1] - p[1]]);
    return area > 0 ? [d[1], -d[0]] : [-d[1], d[0]];
  });
  const vertexN = (i: number, edge: number): V2 => {
    if (!smooth(i)) return edgeN[edge]!;
    const a = edgeN[(i - 1 + n) % n]!;
    const b = edgeN[i]!;
    return norm2([a[0] + b[0], a[1] + b[1]]);
  };
  const side: Patch = { tag, positions: [], normals: [], indices: [] };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const base = side.positions.length / 3;
    const [ni, nj] = [vertexN(i, i), vertexN(j, i)];
    for (const [p, nn, c] of [[outline[i]!, ni, from], [outline[j]!, nj, from], [outline[j]!, nj, to], [outline[i]!, ni, to]] as [V2, V2, number][]) {
      side.positions.push(...point(p, c));
      side.normals.push(...point(nn, 0));
    }
    side.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const cap = (c: number, sign: number): PlanarFace => ({
    tag: o.capTag ?? tag,
    origin: point([0, 0], c),
    u: unitAxis(A),
    v: unitAxis(B),
    normal: unitAxis(axis, sign),
    outer: outline.map((p): V2 => [p[0], p[1]]),
    outer3: outline.map((p) => point(p, c)),
    holes: [],
  });
  return { faces: [cap(from, -1), cap(to, 1)], patches: [side], cuts: [] };
}

/** An axis-aligned box between two corners. */
export function box(min: V3, max: V3, tag: string): Geom {
  if (![0, 1, 2].every((k) => max[k]! > min[k]!)) throw new GeometryError('a box needs a positive size on every axis');
  const rect: V2[] = [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]];
  return extrude(rect, 2, min[2], max[2], tag);
}

/** A round rod along +`axis` from the center of its `base` end, `h` long, with flat ends (tagged `capTag`). */
export function cylinder(base: V3, axis: Axis, r: number, h: number, tag: string, capTag?: string, segments = SEGMENTS): Geom {
  if (r <= 0 || h <= 0) throw new GeometryError('a cylinder needs a positive radius and length');
  const [A, B] = PLANE[axis];
  const ring = unitCircle(segments).map(([c, s]): V2 => [base[A] + r * c, base[B] + r * s]);
  return extrude(ring, axis, base[axis], base[axis] + h, tag, { smooth: true, ...(capTag !== undefined && { capTag }) });
}

/**
 * A profile of [r, y] points (y up from `base`, r out from the vertical axis through it) turned
 * about that axis. It starts and ends on the axis (r = 0), which close as pole fans. Joints
 * sharper than 40° keep a crease; gentler ones shade smooth.
 */
export function lathe(base: V3, profile: V2[], tag: string, segments = SEGMENTS): Geom {
  if (profile.length < 3) throw new GeometryError('a lathe profile needs at least 3 points');
  if (profile[0]![0] !== 0 || profile.at(-1)![0] !== 0) throw new GeometryError('a lathe profile starts and ends on its axis (r = 0)');
  if (profile.some(([r]) => r < 0)) throw new GeometryError('a lathe profile stays on one side of its axis (r ≥ 0)');
  const circle = unitCircle(segments);
  const at = ([r, y]: V2, i: number): V3 => {
    const [c, s] = circle[i % segments]!;
    return r === 0 ? [base[0], base[1] + y, base[2]] : [base[0] + r * c, base[1] + y, base[2] + r * s];
  };
  // Outward normal of each profile segment in (r, y): the profile runs up the outside.
  const segN = profile.slice(0, -1).map((p, k): V2 | null => {
    const q = profile[k + 1]!;
    if (p[0] === q[0] && p[1] === q[1]) return null;
    const d = norm2([q[0] - p[0], q[1] - p[1]]);
    return [d[1], -d[0]];
  });
  const CREASE = Math.cos((40 * Math.PI) / 180);
  /** The normal at profile point k on segment `seg`: blended with the neighbour unless it creases; ±y on the axis. */
  const nAt = (k: number, seg: number): V2 => {
    const own = segN[seg]!;
    if (profile[k]![0] === 0) return [0, own[1] >= 0 ? 1 : -1];
    const other = segN[k === seg ? seg - 1 : seg + 1];
    if (!other || own[0] * other[0] + own[1] * other[1] < CREASE) return own;
    return norm2([own[0] + other[0], own[1] + other[1]]);
  };
  const patch: Patch = { tag, positions: [], normals: [], indices: [] };
  const vertex = (p: V2, nn: V2, i: number) => {
    const [c, s] = circle[i % segments]!;
    patch.positions.push(...at(p, i));
    patch.normals.push(nn[0] * c, nn[1], nn[0] * s);
    return patch.positions.length / 3 - 1;
  };
  for (let k = 0; k < profile.length - 1; k++) {
    if (!segN[k]) continue;
    const [p, q] = [profile[k]!, profile[k + 1]!];
    if (p[0] === 0 && q[0] === 0) continue; // along the axis: no surface
    const [np, nq] = [nAt(k, k), nAt(k + 1, k)];
    for (let i = 0; i < segments; i++) {
      const a = vertex(p, np, i);
      const b = vertex(p, np, i + 1);
      const c = vertex(q, nq, i + 1);
      const d = vertex(q, nq, i);
      // A pole end collapses its two ring vertices into one point: one triangle, not two.
      if (p[0] !== 0) patch.indices.push(a, b, c);
      if (q[0] !== 0) patch.indices.push(p[0] !== 0 ? a : b, c, d);
    }
  }
  return { faces: [], patches: [patch], cuts: [] };
}

/** A ball of radius `r` about `center`. */
export function sphere(center: V3, r: number, tag: string, segments = SEGMENTS): Geom {
  if (r <= 0) throw new GeometryError('a sphere needs a positive radius');
  const circle = unitCircle(segments);
  // From the south pole (−90°) up to the north pole (+90°) in the same steps as round it.
  const profile = Array.from({ length: segments / 2 + 1 }, (_, k): V2 => {
    const [c, s] = circle[((3 * segments) / 4 + k) % segments]!;
    return [k === 0 || k === segments / 2 ? 0 : r * c, r + r * s];
  });
  return lathe([center[0], center[1] - r, center[2]], profile, tag, segments);
}

// ── moving solids ────────────────────────────────────────────────────────────

/** Applies a rigid or mirroring map to everything: `pt` to positions, `vec` to directions. */
function mapGeom(g: Geom, pt: (p: V3) => V3, vec: (v: V3) => V3): Geom {
  return {
    faces: g.faces.map((f) => ({
      ...f,
      origin: pt(f.origin),
      u: vec(f.u),
      v: vec(f.v),
      normal: vec(f.normal),
      outer: f.outer.map((p): V2 => [p[0], p[1]]),
      ...(f.outer3 && { outer3: f.outer3.map(pt) }),
      holes: f.holes.map((h) => h.map((p): V2 => [p[0], p[1]])),
    })),
    patches: g.patches.map((p) => ({ tag: p.tag, positions: mapFlat(p.positions, pt), normals: mapFlat(p.normals, vec), indices: [...p.indices] })),
    cuts: g.cuts.map((c): Cut => ({ ...c, rim: c.rim.map(pt), dir: vec(c.dir), u: vec(c.u), v: vec(c.v), center: pt(c.center) })),
  };
}

function mapFlat(xs: number[], f: (p: V3) => V3): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i += 3) out.push(...f([xs[i]!, xs[i + 1]!, xs[i + 2]!]));
  return out;
}

export function translateGeom(g: Geom, d: V3): Geom {
  return mapGeom(g, (p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]], (v) => [...v]);
}

/** Quarter turns about an axis through the origin (right-handed: +1 about Y takes +X to −Z). Exact. */
export function rotateGeom(g: Geom, axis: Axis, quarters: number): Geom {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return mapGeom(g, (p) => [...p], (v) => [...v]);
  const [A, B]: [Axis, Axis] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
  const turn = (p: V3): V3 => {
    let out: V3 = [...p];
    for (let i = 0; i < q; i++) {
      const next: V3 = [...out];
      next[A] = -out[B];
      next[B] = out[A];
      out = next;
    }
    return out;
  };
  return mapGeom(g, turn, turn);
}

export const rotateGeomY = (g: Geom, quarters: number): Geom => rotateGeom(g, 1, quarters);

/** Mirrors across the plane through the origin perpendicular to `axis` (normals stay outward). */
export function mirrorGeom(g: Geom, axis: Axis): Geom {
  const flip = (p: V3): V3 => {
    const out: V3 = [...p];
    out[axis] = -out[axis];
    return out;
  };
  return mapGeom(g, flip, flip);
}

export function mergeGeoms(...gs: Geom[]): Geom {
  const out = empty();
  for (const g of gs) {
    out.faces.push(...g.faces);
    out.patches.push(...g.patches);
    out.cuts.push(...g.cuts);
  }
  return out;
}

/** A rigid map (rows of a rotation matrix, then a translation): props lean and turn at any angle. */
export function transformGeom(g: Geom, m: [V3, V3, V3], t: V3 = [0, 0, 0]): Geom {
  const rot = (v: V3): V3 => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
  return mapGeom(g, (p) => {
    const r = rot(p);
    return [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
  }, rot);
}

/** Rotation matrices (degrees, right-handed) and their product, for `transformGeom`. */
export function rotationX(deg: number): [V3, V3, V3] {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
export function rotationY(deg: number): [V3, V3, V3] {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
export function rotationZ(deg: number): [V3, V3, V3] {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export function mulRotations(a: [V3, V3, V3], b: [V3, V3, V3]): [V3, V3, V3] {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as [V3, V3, V3];
}

/** The axis-aligned bounds of everything in it (faces' outlines and patches' vertices). */
export function geomBounds(g: Geom): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const add = (p: readonly number[]) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  };
  for (const f of g.faces) {
    if (f.outer3) for (const p of f.outer3) add(p);
    else for (const [a, b] of f.outer) add([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * a + f.v[k]! * b));
  }
  for (const p of g.patches) for (let i = 0; i < p.positions.length; i += 3) add([p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!]);
  return { min, max };
}

/** Moves it so its bounds start at the origin (a part's min corner); returns it with its size. */
export function atMinCorner(g: Geom): { geom: Geom; size: V3 } {
  const { min, max } = geomBounds(g);
  return { geom: translateGeom(g, [-min[0], -min[1], -min[2]]), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
