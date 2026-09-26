import type { V2 } from './types';

/** 2D polygon helpers. Polygons are closed implicitly (last point connects to the first). */

export function signedArea(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function pointInPolygon(p: V2, poly: readonly V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cross(o: V2, a: V2, b: V2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Whether segments ab and cd share any point (touching counts). */
export function segmentsIntersect(a: V2, b: V2, c: V2, d: V2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (p: V2, q: V2, r: V2) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && onSeg(c, d, a)) || (d2 === 0 && onSeg(c, d, b)) || (d3 === 0 && onSeg(a, b, c)) || (d4 === 0 && onSeg(a, b, d));
}

export function pointSegmentDistance(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Smallest distance between two polygon boundaries (0 if they cross or touch). */
export function boundaryDistance(a: readonly V2[], b: readonly V2[]): number {
  let min = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!;
    const a1 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j]!;
      const b1 = b[(j + 1) % b.length]!;
      if (segmentsIntersect(a0, a1, b0, b1)) return 0;
      min = Math.min(min, pointSegmentDistance(a0, b0, b1), pointSegmentDistance(b0, a0, a1));
    }
  }
  return min;
}

/** `inner` lies inside `outer` with at least `margin` between their boundaries. */
export function polygonInside(inner: readonly V2[], outer: readonly V2[], margin: number): boolean {
  return pointInPolygon(inner[0]!, outer) && boundaryDistance(inner, outer) >= margin;
}

/** Distance between two polygon regions (0 if they overlap or one contains the other). */
export function polygonDistance(a: readonly V2[], b: readonly V2[]): number {
  if (pointInPolygon(a[0]!, b) || pointInPolygon(b[0]!, a)) return 0;
  return boundaryDistance(a, b);
}

/** Whether any two non-adjacent edges cross (adjacent edges may only share their vertex). */
export function selfIntersects(poly: readonly V2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return true;
    }
  }
  return false;
}
