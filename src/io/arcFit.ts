import type { V2 } from '../geometry/types';

/**
 * Finds the arcs SketchUp flattened into facets. SketchUp stores a circle or arc as a run of equal
 * edges, each turning the same small angle, with every vertex on the true curve. Such a run comes
 * back as a curved side (`sag`), or as a rounded corner (`r`) when it's a fillet: tangent to the
 * straight sides on both ends (their turn there is half the facet angle).
 */

export interface FitPoint {
  at: V2;
  /** Arc bulge of the side to the next point, outward positive (for a counter-clockwise outline). */
  sag?: number;
  /** Corner radius at this point. */
  r?: number;
}

const DEG = Math.PI / 180;
/** Facet turns this small are noise; this large (an octagon or coarser) is drawn on purpose. */
const MIN_TURN = 0.5 * DEG;
const MAX_TURN = 30.5 * DEG;
/** Equal facets: lengths within 5% (or 1/64"), turns within 15% (or 0.3°). */
const sameLength = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 0.05 * Math.max(a, b));
const sameTurn = (a: number, b: number) => Math.sign(a) === Math.sign(b) && Math.abs(a - b) <= Math.max(0.3 * DEG, 0.15 * Math.max(Math.abs(a), Math.abs(b)));

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];

/** Drops repeated points and points in line with their neighbours (to 1/20 of a model unit). */
export function cleanLoop(pts: V2[]): V2[] {
  let out = pts.filter((p, i) => len(sub(p, pts[(i + pts.length - 1) % pts.length]!)) > 0.05);
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const [p, q, r] = [out[(i + out.length - 1) % out.length]!, out[i]!, out[(i + 1) % out.length]!];
      if (Math.abs(cross(sub(q, p), sub(r, q))) / (len(sub(r, p)) || 1) < 0.05) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Rebuilds a counter-clockwise faceted outline with true arcs, in float coordinates. Returns null
 * when it has no faceted arcs (at least three equal facets of 30° or less each).
 */
export function fitArcs(P: V2[]): FitPoint[] | null {
  const n = P.length;
  if (n < 4) return null;
  const at = (i: number) => P[((i % n) + n) % n]!;
  const segLen = P.map((p, j) => len(sub(at(j + 1), p)));
  const sl = (j: number) => segLen[((j % n) + n) % n]!;
  /** Turn at vertex i, from side i−1 to side i; positive turns left (a convex corner). */
  const turn = P.map((p, i) => {
    const a = sub(p, at(i - 1));
    const b = sub(at(i + 1), p);
    return Math.atan2(cross(a, b), dot(a, b));
  });
  const tn = (i: number) => turn[((i % n) + n) % n]!;
  const cand = turn.map((t, i) => Math.abs(t) >= MIN_TURN && Math.abs(t) <= MAX_TURN && sameLength(sl(i - 1), sl(i)));
  const consistent = (i: number, j: number) => sameTurn(tn(i), tn(j)) && sameLength(sl(i), sl(j));

  // A whole circle: four quarter arcs, starting at the vertex nearest an axis direction.
  if (cand.every(Boolean) && P.every((_, i) => consistent(i, i + 1))) {
    const c: V2 = [P.reduce((s, p) => s + p[0], 0) / n, P.reduce((s, p) => s + p[1], 0) / n];
    const squareness = (p: V2) => {
      const d = sub(p, c);
      return Math.max(Math.abs(d[0]), Math.abs(d[1])) / (len(d) || 1);
    };
    const s0 = P.reduce((best, p, i) => (squareness(p) > squareness(P[best]!) + 1e-9 ? i : best), 0);
    const R = radius(segLen.reduce((a, b) => a + b, 0) / n, turn.reduce((a, b) => a + Math.abs(b), 0) / n);
    const idx = [0, 1, 2, 3].map((k) => s0 + Math.round((k * n) / 4));
    return idx.map((i, k) => ({ at: at(i), sag: Math.sign(tn(i)) * sagOf(R, len(sub(at(idx[(k + 1) % 4]!), at(i)))) }));
  }

  // Runs of consistent facets; scan from a vertex no run can cross.
  let s = cand.findIndex((c) => !c);
  const allCand = s < 0;
  if (allCand) s = P.findIndex((_, i) => !consistent(i - 1, i));
  const limit = allCand ? n - 2 : n - 1;
  const runs: { first: number; last: number }[] = [];
  for (let k = 0; k <= limit; ) {
    if (!cand[(s + k) % n]) {
      k++;
      continue;
    }
    let m = k;
    while (m + 1 <= limit && cand[(s + m + 1) % n] && consistent(s + m, s + m + 1)) m++;
    if (m > k) {
      runs.push({ first: s + k, last: s + m });
      k = m + 2; // vertex m+1 ends this run; the next can start from it
    } else k++;
  }
  if (!runs.length) return null;

  const inRun = new Array<boolean>(n).fill(false); // sides that are facets of some run
  for (const r of runs) for (let j = r.first - 1; j <= r.last; j++) inRun[(j + n) % n] = true;
  const skip = new Array<boolean>(n).fill(false);
  const emit = new Map<number, FitPoint[]>();
  for (const { first, last } of runs) {
    const [a, b] = [first - 1, last + 1];
    const facets = last - first + 2;
    let mean = 0;
    let meanLen = 0;
    for (let i = first; i <= last; i++) mean += Math.abs(tn(i)) / (last - first + 1);
    for (let j = a; j <= last; j++) meanLen += sl(j) / facets;
    const R = radius(meanLen, mean);
    const sign = Math.sign(tn(first));
    const sweep = facets * mean;
    for (let i = first; i <= last; i++) skip[(i + n) % n] = true;

    // Fillet: straight sides on both ends, meeting the arc tangentially.
    const tangent = (i: number) => Math.sign(tn(i)) === sign && Math.abs(Math.abs(tn(i)) - mean / 2) <= Math.max(0.3 * DEG, 0.2 * mean);
    if (!inRun[(a - 1 + n) % n] && !inRun[(b + n) % n] && tangent(a) && tangent(b) && sweep < 175 * DEG) {
      const x = intersect(at(a - 1), at(a), at(b), at(b + 1));
      if (x) {
        skip[(a + n) % n] = skip[(b + n) % n] = true;
        emit.set((a + n) % n, [{ at: x, r: R }]);
        continue;
      }
    }

    // Curved sides of 90° or less each, split at facet vertices.
    const pieces = Math.ceil(sweep / (90 * DEG + 1e-6));
    const cuts = Array.from({ length: pieces + 1 }, (_, k) => a + Math.round((k * facets) / pieces));
    emit.set(
      (a + n) % n,
      cuts.slice(0, -1).map((u, k) => ({ at: at(u), sag: sign * sagOf(R, len(sub(at(cuts[k + 1]!), at(u)))) })),
    );
  }

  const out: FitPoint[] = [];
  for (let i = 0; i < n; i++) {
    const e = emit.get(i);
    if (e) out.push(...e);
    else if (!skip[i]) out.push({ at: P[i]! });
  }
  return out.length >= 3 ? out : null;
}

/** Circumradius of a regular polygon's edge `chord` turning `turn` at each vertex. */
const radius = (chord: number, turn: number) => chord / (2 * Math.sin(turn / 2));
/** Height of a circle of radius R above a chord. */
const sagOf = (R: number, chord: number) => R - Math.sqrt(Math.max(0, R * R - (chord * chord) / 4));

/** Where line p0→p1 meets line q0→q1, or null when they're parallel. */
function intersect(p0: V2, p1: V2, q0: V2, q1: V2): V2 | null {
  const d = sub(p1, p0);
  const e = sub(q1, q0);
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9 * len(d) * len(e)) return null;
  const t = cross(sub(q0, p0), e) / den;
  return [p0[0] + d[0] * t, p0[1] + d[1] * t];
}

/**
 * Rounds to whole model units (1/64"), dropping repeated points and straight in-line ones. Null if
 * fewer than three points survive.
 */
export function roundFit(pts: FitPoint[]): FitPoint[] | null {
  type Pt = { at: V2; sag?: number; r?: number };
  let out = pts.map((p): Pt => {
    const q: Pt = { at: [Math.round(p.at[0]), Math.round(p.at[1])] };
    if (p.sag !== undefined && Math.round(p.sag) !== 0) q.sag = Math.round(p.sag);
    if (p.r !== undefined) q.r = Math.max(1, Math.round(p.r));
    return q;
  });
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i + out.length - 1) % out.length]!;
      const q = out[i]!;
      const next = out[(i + 1) % out.length]!;
      const repeat = q.at[0] === prev.at[0] && q.at[1] === prev.at[1];
      const inLine = !prev.sag && !q.sag && !q.r && Math.abs(cross(sub(q.at, prev.at), sub(next.at, q.at))) / (len(sub(next.at, prev.at)) || 1) < 0.5;
      if (repeat || inLine) {
        // A repeated point takes over its twin's side (its own side has no length).
        if (repeat) {
          const merged: Pt = { at: prev.at };
          if (q.sag !== undefined) merged.sag = q.sag;
          if ((prev.r ?? q.r) !== undefined) merged.r = (prev.r ?? q.r)!;
          out[(i + out.length - 1) % out.length] = merged;
        }
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out.length >= 3 ? out : null;
}
