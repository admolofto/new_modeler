import { selfIntersects, signedArea } from './polygon';
import type { Geom, Patch, PlanarFace, V2, V3 } from './types';

/**
 * 2.5D solid: a closed outline in the (a, b) plane extruded `thickness` along `axis`,
 * with optional rounded / chamfered outline corners, arced sides, and edge profiles on
 * the perimeter of either cap. Box and outline shapes build one of these; edge-profile
 * features edit it; `realizePrism` facets it into tagged faces the cut features work on.
 *
 * Edge profiles are swept like a router with a bearing: at each depth the outline is
 * offset inward by the profile's inset, so profiles miter at sharp corners and follow
 * rounded ones. A rounded corner smaller than the inset collapses to a sharp miter.
 */

export class GeometryError extends Error {}

export type Axis = 0 | 1 | 2;

/** A profile cross-section, as inset from the edge vs. depth below the cap. */
export interface ProfileCurve {
  depth: number;
  /** Sample depths in (0, depth], ascending, ending exactly at `depth`. */
  levels: number[];
  /** Inset at depth `h` (0 at and beyond `depth`). */
  inset(h: number): number;
  /** Surface normal at depth `h` as [outward, up] components. */
  normal(h: number): [number, number];
}

/** Segments so a chord strays at most ~1/256" from a radius-`r` arc spanning `angle`. */
export function arcSegments(r: number, angle: number, min = 1): number {
  const step = Math.min(Math.PI / 12, 2 * Math.acos(Math.max(-1, 1 - 0.25 / Math.max(r, 1e-9))));
  return Math.max(min, Math.min(64, Math.ceil(Math.abs(angle) / step - 1e-9)));
}

export function roundoverCurve(r: number): ProfileCurve {
  const n = arcSegments(r, Math.PI / 2, 3);
  const levels: number[] = [];
  for (let k = 1; k < n; k++) levels.push(r - r * Math.cos((k / n) * (Math.PI / 2)));
  levels.push(r);
  return {
    depth: r,
    levels,
    inset: (h) => (h >= r ? 0 : r - Math.sqrt(r * r - (r - h) * (r - h))),
    normal: (h) => {
      if (h >= r) return [1, 0];
      const c = (r - h) / r;
      return [Math.sqrt(1 - c * c), c];
    },
  };
}

export function chamferCurve(r: number): ProfileCurve {
  return {
    depth: r,
    levels: [r],
    inset: (h) => Math.max(0, r - h),
    normal: (h) => (h >= r ? [1, 0] : [Math.SQRT1_2, Math.SQRT1_2]),
  };
}

export interface EdgeProfile {
  /** Tag for the profiled surface, e.g. `f1:edge:top-front`. */
  tag: string;
  /** Equal keys = same cut (profiles must match through rounded corners). */
  key: string;
  curve: ProfileCurve;
}

export interface PrismCorner {
  kind: 'round' | 'chamfer';
  r: number;
  /** Tag for the corner surface. */
  tag: string;
}

export interface PrismVertex {
  at: V2;
  corner?: PrismCorner;
  /** Semantic name of the edge along `axis` at this vertex. */
  edge: string;
}

export interface Frame {
  origin: V3;
  u: V3;
  v: V3;
}

export interface PrismSide {
  /** Face tag, e.g. `face:front`. */
  tag: string;
  /** Arc bulge: distance from the chord midpoint to the arc; positive bows outward. 0 = straight. */
  sag: number;
  /** Semantic names of this side's edges on the [min, max] caps. */
  capEdges: [string, string];
  /** Face frame override (box faces keep part axes so feature coords match the box convention). */
  frame?: Frame;
  /** Edge profiles on the [min, max] cap edges. */
  profiles: [EdgeProfile | null, EdgeProfile | null];
}

export interface Prism {
  axis: Axis;
  a: Axis;
  b: Axis;
  thickness: number;
  /** Side i runs from verts[i] to verts[i + 1]. Either winding. */
  verts: PrismVertex[];
  sides: PrismSide[];
  /** [min, max] cap face tags. */
  caps: [string, string];
}

// ── small vector helpers ─────────────────────────────────────────────────────

const sub = (p: V2, q: V2): V2 => [p[0] - q[0], p[1] - q[1]];
const add = (p: V2, q: V2, s = 1): V2 => [p[0] + q[0] * s, p[1] + q[1] * s];
const len = (p: V2) => Math.hypot(p[0], p[1]);
const unit2 = (p: V2): V2 => {
  const l = len(p);
  return [p[0] / l, p[1] / l];
};
const cross2 = (p: V2, q: V2) => p[0] * q[1] - p[1] * q[0];
const dot2 = (p: V2, q: V2) => p[0] * q[0] + p[1] * q[1];
/** Right-hand normal: outward for a CCW outline. */
const right = (d: V2): V2 => [d[1], -d[0]];
/** Left-hand normal: inward for a CCW outline. */
const left = (d: V2): V2 => [-d[1], d[0]];

export function unitAxis(axis: Axis, sign = 1): V3 {
  const v: V3 = [0, 0, 0];
  v[axis] = sign;
  return v;
}

// ── densified outline ────────────────────────────────────────────────────────

interface Point {
  p: V2;
  /** Points on an arc offset concentrically. */
  arc?: { c: V2; r: number; convex: boolean };
  /** Rounded-corner group (may collapse to a sharp miter). */
  group?: number;
}

interface Edge {
  tag: string;
  /** Human name for messages. */
  name: string;
  curved: boolean;
  profiles: [EdgeProfile | null, EdgeProfile | null];
  frame?: Frame;
  dir: V2;
  /** Outward normals at the start and end point. */
  n0: V2;
  n1: V2;
}

interface Group {
  first: number;
  last: number;
  c: V2;
  r: number;
  convex: boolean;
}

interface Outline {
  points: Point[];
  /** edges[i] runs from points[i] to points[i + 1]. */
  edges: Edge[];
  groups: Group[];
}

/** Returns the prism with CCW verts / sides (in the a-b plane). */
function ccw(prism: Prism): Prism {
  if (prism.verts.length < 3) throw new GeometryError('an outline needs at least 3 points');
  const area = signedArea(prism.verts.map((v) => v.at));
  if (Math.abs(area) < 1e-9) throw new GeometryError('outline has no area');
  if (area > 0) return prism;
  const n = prism.verts.length;
  return {
    ...prism,
    verts: [...prism.verts].reverse(),
    sides: prism.verts.map((_, k) => prism.sides[(2 * n - 2 - k) % n]!),
  };
}

function sameProfile(p: EdgeProfile | null, q: EdgeProfile | null): boolean {
  return (p?.key ?? null) === (q?.key ?? null);
}

function densify(prism: Prism): Outline {
  const { verts, sides } = prism;
  const n = verts.length;
  const at = (i: number) => verts[(i + n) % n]!.at;

  // Corner trims.
  const trims = verts.map((v, i) => {
    if (!v.corner) return { tin: v.at, tout: v.at, L: 0 };
    const name = v.edge;
    if (sides[(i - 1 + n) % n]!.sag !== 0 || sides[i]!.sag !== 0) {
      throw new GeometryError(`${name}: can't round or chamfer a corner next to a curved side`);
    }
    const din = unit2(sub(v.at, at(i - 1)));
    const dout = unit2(sub(at(i + 1), v.at));
    const phi = Math.atan2(cross2(din, dout), dot2(din, dout));
    if (Math.abs(phi) < 1e-9) throw new GeometryError(`${name}: can't round or chamfer a corner whose sides are in line`);
    const L = v.corner.kind === 'round' ? v.corner.r * Math.tan(Math.abs(phi) / 2) : v.corner.r;
    return { tin: add(v.at, din, -L), tout: add(v.at, dout, L), L, din, dout, phi };
  });
  for (let i = 0; i < n; i++) {
    const room = len(sub(at(i + 1), at(i)));
    if (trims[i]!.L + trims[(i + 1) % n]!.L > room - 1) {
      throw new GeometryError(`corners ${verts[i]!.edge} and ${verts[(i + 1) % n]!.edge} are too big for the side between them (leave at least 1/64" straight)`);
    }
  }

  const out: Outline = { points: [], edges: [], groups: [] };
  const straight = (from: V2, to: V2, tag: string, name: string, profiles: Edge['profiles'], frame?: Frame): Edge => {
    const dir = unit2(sub(to, from));
    return { tag, name, curved: false, profiles, dir, n0: right(dir), n1: right(dir), ...(frame && { frame }) };
  };
  /** Points along an arc from `p0` to `p1` (exact endpoints) and the curved edges between them. */
  const arc = (c: V2, r: number, p0: V2, sweep: number, p1: V2, tag: string, name: string, profiles: Edge['profiles']) => {
    const convex = sweep > 0;
    const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    const m = arcSegments(r, sweep, 2);
    const pts: V2[] = [];
    for (let j = 0; j <= m; j++) {
      const ang = a0 + (sweep * j) / m;
      pts.push(j === 0 ? p0 : j === m ? p1 : [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
    }
    const radial = (p: V2): V2 => (convex ? unit2(sub(p, c)) : unit2(sub(c, p)));
    const edges: Edge[] = [];
    for (let j = 0; j < m; j++) {
      const dir = unit2(sub(pts[j + 1]!, pts[j]!));
      edges.push({ tag, name, curved: true, profiles, dir, n0: radial(pts[j]!), n1: radial(pts[j + 1]!) });
    }
    return { pts, edges, convex };
  };

  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    const tr = trims[i]!;
    const side = sides[i]!;
    const prev = sides[(i - 1 + n) % n]!;

    // Corner at vertex i: its points, and the edges between them.
    if (!v.corner) {
      out.points.push({ p: v.at });
    } else {
      for (const c of [0, 1] as const) {
        if (!sameProfile(prev.profiles[c], side.profiles[c])) {
          throw new GeometryError(
            `${v.edge} is ${v.corner.kind === 'round' ? 'rounded' : 'chamfered'}, so ${prev.capEdges[c]} and ${side.capEdges[c]} need the same edge profile (or none)`,
          );
        }
      }
      const profiles: Edge['profiles'] = [prev.profiles[0], prev.profiles[1]];
      if (v.corner.kind === 'chamfer') {
        out.points.push({ p: tr.tin });
        out.edges.push(straight(tr.tin, tr.tout, v.corner.tag, v.edge, profiles));
        out.points.push({ p: tr.tout });
      } else {
        const r = v.corner.r;
        const c = add(tr.tin, tr.phi! > 0 ? left(tr.din!) : right(tr.din!), r);
        const { pts, edges, convex } = arc(c, r, tr.tin, tr.phi!, tr.tout, v.corner.tag, v.edge, profiles);
        const group = out.groups.length;
        out.groups.push({ first: out.points.length, last: out.points.length + pts.length - 1, c, r, convex });
        pts.forEach((p, j) => {
          out.points.push({ p, arc: { c, r, convex }, group });
          if (j < edges.length) out.edges.push(edges[j]!);
        });
      }
    }

    // Side i, from the corner's last point to the next vertex's first.
    const start = tr.tout;
    const end = trims[(i + 1) % n]!.tin;
    if (side.sag === 0) {
      out.edges.push(straight(start, end, side.tag, side.tag, side.profiles, side.frame));
      continue;
    }
    const chord = sub(end, start);
    const cl = len(chord);
    const s = side.sag;
    if (Math.abs(s) > cl / 2 + 1e-9) throw new GeometryError(`${side.tag}: an arc's sag can be at most half its chord`);
    const nout = right(unit2(chord));
    const R = (cl * cl) / (8 * Math.abs(s)) + Math.abs(s) / 2;
    const c = add(add(add(start, chord, 0.5), nout, s), nout, -Math.sign(s) * R);
    const sweep = Math.sign(s) * 2 * Math.asin(Math.min(1, cl / (2 * R)));
    const { pts, edges, convex } = arc(c, R, start, sweep, end, side.tag, side.tag, side.profiles);
    out.edges.push(edges[0]!);
    for (let j = 1; j < pts.length - 1; j++) {
      out.points.push({ p: pts[j]!, arc: { c, r: R, convex } });
      out.edges.push(edges[j]!);
    }
  }

  if (selfIntersects(out.points.map((p) => p.p))) throw new GeometryError('outline crosses itself');
  return out;
}

// ── offsetting ──────────────────────────────────────────────────────────────

interface Level {
  /** Coordinate along the axis. */
  w: number;
  /** Which cap's profiles apply: 0 = min, 1 = max. */
  cap: 0 | 1;
  /** Depth below that cap. */
  h: number;
}

function insetAt(e: Edge, l: Level): number {
  return e.profiles[l.cap]?.curve.inset(l.h) ?? 0;
}

/** Intersection of two edges' offset lines, each moved inward by its own inset. */
function miter(o: Outline, before: number, after: number, pointIndex: number, dBefore: number, dAfter: number): V2 {
  const eb = o.edges[before]!;
  const ea = o.edges[after]!;
  const pb = add(o.points[before]!.p, left(eb.dir), dBefore);
  const pa = add(o.points[after]!.p, left(ea.dir), dAfter);
  const denom = cross2(eb.dir, ea.dir);
  if (Math.abs(denom) < 1e-9) {
    if (Math.abs(dBefore - dAfter) > 1e-9) {
      throw new GeometryError(`${eb.name} and ${ea.name} are in line but have different edge profiles`);
    }
    return add(o.points[pointIndex]!.p, left(eb.dir), dBefore);
  }
  const t = cross2(sub(pa, pb), ea.dir) / denom;
  return add(pb, eb.dir, t);
}

function ring(o: Outline, l: Level): V2[] {
  const N = o.points.length;
  const d = o.edges.map((e) => insetAt(e, l));
  const out: V2[] = new Array(N);
  for (let k = 0; k < N; k++) {
    const pt = o.points[k]!;
    if (pt.group !== undefined) continue;
    const prev = (k - 1 + N) % N;
    if (pt.arc) {
      const { c, r, convex } = pt.arc;
      const r2 = convex ? r - d[k]! : r + d[k]!;
      if (r2 <= 1e-9) throw new GeometryError(`edge profile on ${o.edges[k]!.name} is deeper than its curve's radius`);
      out[k] = add(c, sub(pt.p, c), r2 / r);
    } else {
      out[k] = miter(o, prev, k, k, d[prev]!, d[k]!);
    }
  }
  for (const g of o.groups) {
    const dd = d[g.first]!;
    const r2 = g.convex ? g.r - dd : g.r + dd;
    if (r2 > 1e-6 * g.r) {
      for (let k = g.first; k <= g.last; k++) out[k % N] = add(g.c, sub(o.points[k % N]!.p, g.c), r2 / g.r);
    } else {
      const m = miter(o, (g.first - 1 + N) % N, g.last % N, g.first, d[(g.first - 1 + N) % N]!, d[g.last % N]!);
      for (let k = g.first; k <= g.last; k++) out[k % N] = m;
    }
  }
  // A straight edge that turned around means the profile is too big for the outline there.
  for (let k = 0; k < N; k++) {
    const e = o.edges[k]!;
    if (e.curved) continue;
    const v = sub(out[(k + 1) % N]!, out[k]!);
    if (dot2(v, e.dir) < -1e-6) throw new GeometryError(`edge profile is too big for the outline near ${e.name}`);
  }
  return out;
}

function levels(o: Outline, t: number): Level[] {
  const depths: [Set<number>, Set<number>] = [new Set([0]), new Set([0])];
  const maxDepth = [0, 0];
  for (const e of o.edges) {
    for (const c of [0, 1] as const) {
      const curve = e.profiles[c]?.curve;
      if (!curve) continue;
      curve.levels.forEach((h) => depths[c].add(h));
      maxDepth[c] = Math.max(maxDepth[c]!, curve.depth);
    }
  }
  if (maxDepth[0]! + maxDepth[1]! >= t) throw new GeometryError('edge profiles on both faces are deeper than the part is thick');
  const top = [...depths[1]].sort((x, y) => x - y).map((h): Level => ({ w: t - h, cap: 1, h }));
  const bottom = [...depths[0]].sort((x, y) => y - x).map((h): Level => ({ w: h, cap: 0, h }));
  return [...top, ...bottom];
}

// ── faceting ─────────────────────────────────────────────────────────────────

export function realizePrism(input: Prism): Geom {
  const prism = ccw(input);
  const { axis, a, b, thickness: t } = prism;
  const o = densify(prism);
  const N = o.points.length;
  const lv = levels(o, t);
  const rings = lv.map((l) => ring(o, l));
  const to3 = (p: V2, w: number): V3 => {
    const v: V3 = [0, 0, 0];
    v[a] = p[0];
    v[b] = p[1];
    v[axis] = w;
    return v;
  };
  const dir3 = (d: V2): V3 => {
    const v: V3 = [0, 0, 0];
    v[a] = d[0];
    v[b] = d[1];
    return v;
  };
  const pos = rings.map((r, k) => r.map((p) => to3(p, lv[k]!.w)));

  const faces: PlanarFace[] = [];
  const cap = (k: number, max: boolean): PlanarFace => ({
    tag: prism.caps[max ? 1 : 0],
    origin: unitAxis(axis, max ? t : 0),
    u: unitAxis(a),
    v: unitAxis(b),
    normal: unitAxis(axis, max ? 1 : -1),
    outer: rings[k]!.map((p): V2 => [p[0], p[1]]),
    outer3: pos[k]!,
    holes: [],
  });
  faces.push(cap(0, true), cap(lv.length - 1, false));

  const patches = new Map<string, Patch>();
  const patch = (tag: string) => {
    let p = patches.get(tag);
    if (!p) patches.set(tag, (p = { tag, positions: [], normals: [], indices: [] }));
    return p;
  };
  const same3 = (p: V3, q: V3) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];

  for (let e = 0; e < N; e++) {
    const edge = o.edges[e]!;
    const e1 = (e + 1) % N;
    const flat = (k: number) => !edge.curved && insetAt(edge, lv[k]!) === insetAt(edge, lv[k + 1]!);
    let k = 0;
    while (k < lv.length - 1) {
      if (flat(k)) {
        let k1 = k + 1;
        while (k1 < lv.length - 1 && flat(k1)) k1++;
        const poly: V3[] = [pos[k]![e]!];
        for (let j = k; j <= k1; j++) poly.push(pos[j]![e1]!);
        for (let j = k1; j > k; j--) poly.push(pos[j]![e]!);
        const frame = edge.frame ?? { origin: to3(o.points[e]!.p, 0), u: dir3(edge.dir), v: unitAxis(axis) };
        const rel = (p: V3, d: V3) => (p[0] - frame.origin[0]) * d[0] + (p[1] - frame.origin[1]) * d[1] + (p[2] - frame.origin[2]) * d[2];
        faces.push({
          tag: edge.tag,
          ...frame,
          normal: dir3(right(edge.dir)),
          outer: poly.map((p): V2 => [rel(p, frame.u), rel(p, frame.v)]),
          outer3: poly,
          holes: [],
        });
        k = k1;
        continue;
      }
      // Curved wall or profile surface: quads with smooth normals.
      const l0 = lv[k]!;
      const l1 = lv[k + 1]!;
      const tag = insetAt(edge, l0) === insetAt(edge, l1) ? edge.tag : (edge.profiles[l0.cap]?.tag ?? edge.tag);
      const nrm = (n2: V2, l: Level): V3 => {
        const [out, up] = edge.profiles[l.cap]?.curve.normal(l.h) ?? [1, 0];
        const v = dir3([n2[0] * out, n2[1] * out]);
        v[axis] = (l.cap === 1 ? 1 : -1) * up;
        const m = Math.hypot(v[0], v[1], v[2]);
        return [v[0] / m, v[1] / m, v[2] / m];
      };
      const quad: [V3, V3][] = [
        [pos[k]![e]!, nrm(edge.n0, l0)],
        [pos[k]![e1]!, nrm(edge.n1, l0)],
        [pos[k + 1]![e1]!, nrm(edge.n1, l1)],
        [pos[k + 1]![e]!, nrm(edge.n0, l1)],
      ];
      const p = patch(tag);
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ]) {
        const [x, y, z] = tri.map((i) => quad[i]!) as [[V3, V3], [V3, V3], [V3, V3]];
        if (same3(x[0], y[0]) || same3(y[0], z[0]) || same3(x[0], z[0])) continue;
        const base = p.positions.length / 3;
        for (const [q, nq] of [x, y, z]) {
          p.positions.push(...q);
          p.normals.push(...nq);
        }
        p.indices.push(base, base + 1, base + 2);
      }
      k++;
    }
  }
  return { faces, patches: [...patches.values()], cuts: [] };
}
