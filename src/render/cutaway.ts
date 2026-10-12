import type { V3 } from '../geometry/types';
import { inches } from '../model/units';

/**
 * The cutaway (binding note 10, B6): which room walls stand between the camera and the room, so
 * they're taken away — the editor hides them (and leaves them out of picking); presentation mode
 * will draw them shadow-only. One pure function for both. Model units, world coordinates.
 */

export interface CutWall {
  /** The wall first, then what it hosts (windows, casings, baseboards, door folders): they go together. */
  ids: string[];
  /** A point on its inside face, and its way out of the room. */
  point: V3;
  outward: V3;
}

export interface CutCeiling {
  ids: string[];
  /** Its underside (world y), and the inside footprint it covers, [x, z]. */
  height: number;
  min: [number, number];
  max: [number, number];
}

/** How far past a wall's inside face the eye must go to hide it, or come back to show it again (6"). */
export const CUT_MARGIN = inches(6);

/**
 * The ids to take away for an eye at `eye`. A wall goes when the eye is more than `margin` outside
 * its inside face, and comes back only when the eye is more than `margin` inside it; in between it
 * stays as it was in `prev` (no flicker as the camera crosses the plane). What a wall hosts follows
 * it. A ceiling goes when the eye is above it or outside its footprint. Walking never cuts.
 */
export function cutaway(walls: readonly CutWall[], ceilings: readonly CutCeiling[], eye: V3, mode: 'orbit' | 'walk', prev: ReadonlySet<string>, margin = CUT_MARGIN): Set<string> {
  const out = new Set<string>();
  if (mode === 'walk') return out;
  for (const w of walls) {
    if (!w.ids.length) continue;
    const d = (eye[0] - w.point[0]) * w.outward[0] + (eye[1] - w.point[1]) * w.outward[1] + (eye[2] - w.point[2]) * w.outward[2];
    const hide = d > margin || (d >= -margin && prev.has(w.ids[0]!));
    if (hide) for (const id of w.ids) out.add(id);
  }
  for (const c of ceilings) {
    const outside = eye[0] < c.min[0] || eye[0] > c.max[0] || eye[2] < c.min[1] || eye[2] > c.max[1];
    if (eye[1] > c.height || outside) for (const id of c.ids) out.add(id);
  }
  return out;
}

/** Whether two cutaways take away the same ids. */
export const sameCut = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));
