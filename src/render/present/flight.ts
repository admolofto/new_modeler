import type { V3 } from '../../geometry/types';
import { easeInOut } from '../../model/motion';
import type { ViewCamera } from '../../model/schema';

/**
 * Camera flights in presentation (B6; pure, inches). Orbit poses fly around their targets: the
 * target slides, the offset turns on a sphere — the radius log-lerped (so zooming feels even), the
 * shortest way round, the polar angle kept off the poles. Walk flights (either end walking) slide
 * the eye and turn the gaze (yaw the short way round, pitch). Eased in and out; the duration grows
 * with the distance and the turn, and is 0 under reduced motion.
 */

export interface Pose {
  position: V3;
  target: V3;
  /** Vertical field of view (degrees). */
  fov: number;
}

export interface Flight {
  seconds: number;
  /** The pose at `u` of the way through (0 … 1, linear time; the easing is inside). */
  at(u: number): Pose;
}

export const MIN_SECONDS = 0.6;
export const MAX_SECONDS = 2.5;
/** The polar angle's limits (radians from straight up). */
const POLE = 0.02;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp3 = (a: V3, b: V3, k: number): V3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** An angle difference taken the short way round, in (−π, π]. */
export const shortest = (d: number) => {
  const w = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return w === -Math.PI ? Math.PI : w;
};
const copy = (p: Pose): Pose => ({ position: [...p.position], target: [...p.target], fov: p.fov });

/** Yaw (about +Y; 0 looks toward −Z, positive turns left) and pitch (up) of a direction. */
export function yawPitch(d: V3): { yaw: number; pitch: number } {
  const l = len(d) || 1;
  return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(clamp(d[1] / l, -1, 1)) };
}

/** The unit direction for a yaw and pitch. */
export const direction = (yaw: number, pitch: number): V3 => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];

/** The angle between two poses' view directions (radians). */
function turn(a: Pose, b: Pose): number {
  const da = sub(a.target, a.position);
  const db = sub(b.target, b.position);
  const l = len(da) * len(db);
  if (l < 1e-9) return 0;
  return Math.acos(clamp((da[0] * db[0] + da[1] * db[1] + da[2] * db[2]) / l, -1, 1));
}

/** How long a flight takes: `clamp(0.6 + 0.25·log2(1 + d/24) + 0.4·Δangle/π, 0.6, 2.5)` s (0 when there's nowhere to go). */
export function flightSeconds(a: Pose, b: Pose): number {
  const d = Math.max(len(sub(a.position, b.position)), len(sub(a.target, b.target)));
  const angle = turn(a, b);
  if (d < 1e-6 && angle < 1e-6 && Math.abs(a.fov - b.fov) < 1e-6) return 0;
  return clamp(MIN_SECONDS + 0.25 * Math.log2(1 + d / 24) + (0.4 * angle) / Math.PI, MIN_SECONDS, MAX_SECONDS);
}

/** Spherical offset of a pose's camera from its target: radius, azimuth (atan2(x, z)) and polar angle (from +Y). */
function spherical(p: Pose) {
  const o = sub(p.position, p.target);
  const r = Math.max(1e-6, len(o));
  return { r, theta: Math.atan2(o[0], o[2]), phi: Math.acos(clamp(o[1] / r, -1, 1)) };
}

/** A flight from `a` to `b`. `walk`: slide the eye and turn the gaze (else orbit). `reduced`: no flight (0 s). */
export function flight(a: Pose, b: Pose, o: { walk?: boolean; reduced?: boolean } = {}): Flight {
  const seconds = o.reduced ? 0 : flightSeconds(a, b);
  const ends = (u: number) => (u <= 0 && seconds > 0 ? copy(a) : u >= 1 || seconds === 0 ? copy(b) : null);
  if (o.walk) {
    const ga = yawPitch(sub(a.target, a.position));
    const gb = yawPitch(sub(b.target, b.position));
    const dYaw = shortest(gb.yaw - ga.yaw);
    const la = len(sub(a.target, a.position));
    const lb = len(sub(b.target, b.position));
    return {
      seconds,
      at(u) {
        const end = ends(u);
        if (end) return end;
        const e = easeInOut(u);
        const position = lerp3(a.position, b.position, e);
        const d = direction(ga.yaw + dYaw * e, lerp(ga.pitch, gb.pitch, e));
        const l = lerp(la, lb, e);
        return { position, target: [position[0] + d[0] * l, position[1] + d[1] * l, position[2] + d[2] * l], fov: lerp(a.fov, b.fov, e) };
      },
    };
  }
  const sa = spherical(a);
  const sb = spherical(b);
  const dTheta = shortest(sb.theta - sa.theta);
  return {
    seconds,
    at(u) {
      const end = ends(u);
      if (end) return end;
      const e = easeInOut(u);
      const target = lerp3(a.target, b.target, e);
      const r = sa.r * (sb.r / sa.r) ** e;
      const theta = sa.theta + dTheta * e;
      const phi = clamp(lerp(sa.phi, sb.phi, e), POLE, Math.PI - POLE);
      return {
        position: [target[0] + r * Math.sin(phi) * Math.sin(theta), target[1] + r * Math.cos(phi), target[2] + r * Math.sin(phi) * Math.cos(theta)],
        target,
        fov: lerp(a.fov, b.fov, e),
      };
    },
  };
}

/** A pose saved as a view camera: model units, whole 1/64ths; the fov to a tenth of a degree. */
export function poseToCamera(p: Pose): ViewCamera {
  const units = (v: V3) => v.map((c) => Math.round(c * 64)) as V3;
  return { position: units(p.position), target: units(p.target), fov: clamp(Math.round(p.fov * 10) / 10, 10, 120) };
}

/** A view camera as a pose (inches). */
export const cameraToPose = (c: ViewCamera): Pose => ({
  position: c.position.map((v) => v / 64) as V3,
  target: c.target.map((v) => v / 64) as V3,
  fov: c.fov,
});
