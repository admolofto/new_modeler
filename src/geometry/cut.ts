import { formatInches as f } from '../model/units';
import { polygonDistance, polygonInside, signedArea } from './polygon';
import { GeometryError } from './prism';
import { facePoint } from './tessellate';
import type { Cut, Geom, PlanarFace, V2, V3 } from './types';

/**
 * Cuts a straight-walled recess (blind) or opening (through) perpendicular to a flat face:
 * holes, pockets, cutouts. Refuses cuts that break out of the face, leave no floor, or
 * collide with earlier cuts. Walls and rims share vertices with the faces, so the mesh
 * stays closed.
 */
export interface CutSpec {
  featureId: string;
  /** `hole`, `pocket`… used in messages. */
  noun: string;
  /** e.g. `hole f1 (Ø1" at 6", 10")`. */
  label: string;
  partName: string;
  face: string;
  /** Opening outline in the face's (u, v) frame. */
  loop: V2[];
  /** Per loop point: shade the wall smoothly through it (curves) or crease (sharp corners). */
  smooth: boolean[];
  /** null = through. */
  depth: number | null;
}

/** Minimum material left between a cut and an edge, another cut, or the far face: 1/64". */
const MARGIN = 1;

const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const addS = (p: V3, q: V3, s: number): V3 => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];

function bounds(c: { rim: V3[]; dir: V3; depth: number }): [V3, V3] {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of c.rim) {
    for (const q of [p, addS(p, c.dir, c.depth)]) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, q[i]!);
        max[i] = Math.max(max[i]!, q[i]!);
      }
    }
  }
  return [min, max];
}

function collides(a: Cut, b: Cut): boolean {
  if (Math.abs(dot(a.dir, b.dir)) > 1 - 1e-9) {
    // Parallel: footprints closer than MARGIN and depth ranges overlapping.
    const proj = (p: V3): V2 => [dot(p, a.u), dot(p, a.v)];
    if (polygonDistance(a.rim.map(proj), b.rim.map(proj)) >= MARGIN) return false;
    const sa = dot(a.rim[0]!, a.dir);
    const sb = dot(b.rim[0]!, a.dir);
    const [b0, b1] = dot(b.dir, a.dir) > 0 ? [sb, sb + b.depth] : [sb - b.depth, sb];
    return Math.min(sa + a.depth, b1) - Math.max(sa, b0) > 1e-9;
  }
  // Not parallel: conservative bounding-box test.
  const [amin, amax] = bounds(a);
  const [bmin, bmax] = bounds(b);
  return [0, 1, 2].every((i) => Math.min(amax[i]!, bmax[i]!) - Math.max(amin[i]!, bmin[i]!) > 0);
}

export function cutFace(geom: Geom, spec: CutSpec): Cut {
  const { label, loop } = spec;
  const candidates = geom.faces.filter((x) => x.tag === spec.face);
  if (!candidates.length) {
    const flat = [...new Set(geom.faces.map((x) => x.tag))].filter((t) => t.startsWith('face:'));
    throw new GeometryError(`${label}: "${spec.partName}" has no flat face ${spec.face} (flat faces: ${flat.join(', ')})`);
  }
  const entry = candidates.find((x) => polygonInside(loop, x.outer, MARGIN));
  if (!entry) throw new GeometryError(`${label} doesn't fit inside ${spec.face} of "${spec.partName}"`);

  const dir: V3 = [-entry.normal[0], -entry.normal[1], -entry.normal[2]];
  const rim = loop.map(([s, t]) => facePoint(entry, s, t));

  // Far side: the nearest opposite-facing flat face the whole footprint lands inside.
  let exit: { face: PlanarFace; dist: number; loop: V2[] } | null = null;
  for (const face of geom.faces) {
    if (dot(face.normal, entry.normal) > -1 + 1e-9) continue;
    const dist = dot(sub(face.origin, rim[0]!), face.normal);
    if (dist <= 0 || (exit && dist >= exit.dist)) continue;
    const proj = rim.map((p): V2 => {
      const q = sub(addS(p, dir, dist), face.origin);
      return [dot(q, face.u), dot(q, face.v)];
    });
    if (polygonInside(proj, face.outer, MARGIN)) exit = { face, dist, loop: proj };
  }
  if (!exit) {
    throw new GeometryError(
      spec.depth === null
        ? `${label} doesn't come out cleanly through the far side of "${spec.partName}"`
        : `${label} has no solid material behind it on "${spec.partName}" (too close to a shaped edge on the far side)`,
    );
  }
  if (spec.depth !== null && spec.depth > exit.dist - MARGIN) {
    throw new GeometryError(
      `${label} is ${f(spec.depth)} deep but "${spec.partName}" is only ${f(exit.dist)} thick there — leave depth out for a through ${spec.noun}`,
    );
  }

  const depth = spec.depth ?? exit.dist;
  const centroid: V2 = [loop.reduce((s, p) => s + p[0], 0) / loop.length, loop.reduce((s, p) => s + p[1], 0) / loop.length];
  const cut: Cut = {
    featureId: spec.featureId,
    noun: spec.noun,
    rim,
    dir,
    depth,
    entryFace: spec.face,
    u: entry.u,
    v: entry.v,
    center: facePoint(entry, centroid[0], centroid[1]),
  };
  for (const other of geom.cuts) {
    if (collides(cut, other)) throw new GeometryError(`${label} overlaps ${other.noun} ${other.featureId} on "${spec.partName}"`);
  }

  // Opening, far face or floor.
  entry.holes.push(loop.map((p): V2 => [p[0], p[1]]));
  let bottom: V3[];
  if (spec.depth === null) {
    exit.face.holes.push(exit.loop);
    bottom = exit.loop.map(([s, t]) => facePoint(exit.face, s, t));
  } else {
    const floor: PlanarFace = {
      tag: `${spec.featureId}:floor`,
      origin: addS(entry.origin, dir, depth),
      u: entry.u,
      v: entry.v,
      normal: entry.normal,
      outer: loop.map((p): V2 => [p[0], p[1]]),
      holes: [],
    };
    geom.faces.push(floor);
    bottom = loop.map(([s, t]) => facePoint(floor, s, t));
  }

  // Wall: normals face into the opening (away from the material).
  const n = loop.length;
  const ccw = signedArea(loop) > 0;
  const edgeNormal = (i: number): V2 => {
    const [a, b] = [loop[i]!, loop[(i + 1) % n]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(dx, dy);
    return ccw ? [-dy / l, dx / l] : [dy / l, -dx / l];
  };
  const to3 = ([x, y]: V2): V3 => {
    const v: V3 = [entry.u[0] * x + entry.v[0] * y, entry.u[1] * x + entry.v[1] * y, entry.u[2] * x + entry.v[2] * y];
    const m = Math.hypot(...v);
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  const pointNormal = (i: number, edge: number): V3 => {
    if (!spec.smooth[i]) return to3(edgeNormal(edge));
    const [p, q] = [edgeNormal((i - 1 + n) % n), edgeNormal(i)];
    return to3([p[0] + q[0], p[1] + q[1]]);
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const base = positions.length / 3;
    positions.push(...rim[i]!, ...rim[j]!, ...bottom[j]!, ...bottom[i]!);
    const [ni, nj] = [pointNormal(i, i), pointNormal(j, i)];
    normals.push(...ni, ...nj, ...nj, ...ni);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  geom.patches.push({ tag: `${spec.featureId}:wall`, positions, normals, indices });
  geom.cuts.push(cut);
  return cut;
}
