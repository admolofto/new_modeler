import type { V3 } from '../../geometry/types';

/**
 * Double-click focus in presentation (B5, pure, inches): orbit around the point clicked, from the same
 * side, closer — 55% of the way, kept between 2′ and 10′. Phase 8's flights replace the animation.
 */

export const FOCUS_MIN = 24;
export const FOCUS_MAX = 120;
export const FOCUS_SECONDS = 0.6;

/** How far from the point clicked the camera ends up, given how far it is now. */
export const focusDistance = (d: number): number => Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, d * 0.55));

/** The camera pose that focuses `hit`, seen from where the camera is (`eye`). */
export function focusPose(eye: V3, hit: V3): { position: V3; target: V3 } {
  const v: V3 = [eye[0] - hit[0], eye[1] - hit[1], eye[2] - hit[2]];
  const d = Math.hypot(v[0], v[1], v[2]);
  if (d < 1e-6) return { position: [...eye], target: [...hit] };
  const k = focusDistance(d) / d;
  return { position: [hit[0] + v[0] * k, hit[1] + v[1] * k, hit[2] + v[2] * k], target: [...hit] };
}
