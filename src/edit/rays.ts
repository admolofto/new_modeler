import type { V3 } from '../geometry/types';

/**
 * Where the pointer's ray meets the things tools constrain to: a line (an axis, a face's normal) or
 * a plane (the floor, a protractor). Any one unit system; directions are unit vectors. Pure.
 */
export interface Ray {
  o: V3;
  d: V3;
}

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 | null => {
  const l = length(a);
  return l < 1e-9 ? null : scale(a, 1 / l);
};

/** Parameter along the line through `p` with direction `d` of its point nearest the ray; null when they run parallel. */
export function alongLine(ray: Ray, p: V3, d: V3): number | null {
  const w0 = sub(p, ray.o);
  const b = dot(d, ray.d);
  const denom = 1 - b * b;
  if (denom < 1e-4) return null;
  return (b * dot(ray.d, w0) - dot(d, w0)) / denom;
}

/** Where the ray meets the plane through `p` across `n`; null when it runs along the plane or the plane is behind it. */
export function onPlane(ray: Ray, p: V3, n: V3): V3 | null {
  const den = dot(n, ray.d);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(n, sub(p, ray.o)) / den;
  return t > 0 ? add(ray.o, scale(ray.d, t)) : null;
}

/** The part of `v` in the plane across unit `n`. */
export const inPlane = (v: V3, n: V3): V3 => sub(v, scale(n, dot(v, n)));

/** Degrees from `a` round to `b` about unit `axis`, right-handed, in (−180, 180]; both are taken in the plane across the axis. */
export function angleAbout(a: V3, b: V3, axis: V3): number | null {
  const [p, q] = [unit(inPlane(a, axis)), unit(inPlane(b, axis))];
  if (!p || !q) return null;
  return (Math.atan2(dot(cross(p, q), axis), dot(p, q)) * 180) / Math.PI;
}
