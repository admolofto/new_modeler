import type { V3 } from '../geometry/types';
import { roomInterior } from '../model/room';
import type { Doc, Transform } from '../model/schema';
import { inches } from '../model/units';
import { IDENTITY, type Box3 } from '../model/world';
import { blockPlacement, facingToward } from './blocks';

/**
 * Where a prop or appliance lands when it's dropped from the catalog (ui/placeTool.ts): resting on
 * the floor, a counter or a cabinet top under the cursor; hanging from the ceiling (pendants, cans);
 * stuck under a cabinet (a light strip); or at its usual height on the wall (a hood, an over-range
 * microwave). Its front faces the camera, in quarter turns, like a drawn block. Pure.
 */

export type Mount = 'floor' | 'ceiling' | 'under' | { raised: number };

/** The ceiling without a room. */
export const DEFAULT_CEILING = inches(96);
/** A range hood's bottom (30" over a 36" cooktop), an over-range microwave's. */
export const HOOD_BOTTOM = inches(66);
export const MICROWAVE_BOTTOM = inches(54);
/** Drops snap to 1/8". */
const STEP = 8;

/** How a catalog item goes where it's dropped. */
export function mountOf(type: string, params: Record<string, unknown> = {}): Mount {
  if (type === 'pendant' || type === 'recessedLight') return 'ceiling';
  if (type === 'stripLight') return 'under';
  if (type === 'rangeHood') return { raised: HOOD_BOTTOM };
  if (type === 'microwave' && (params.mount ?? 'over-range') === 'over-range') return { raised: MICROWAVE_BOTTOM };
  return 'floor';
}

/** What the cursor is over: a point and its face's outward normal (world, model units). */
export interface SurfaceHit {
  point: V3;
  normal: V3;
}

/**
 * The point a drop goes from: the face under the cursor when it can hold the item (facing up to rest
 * on; facing down for something stuck under it), else where the cursor meets the floor (y = 0).
 */
export function dropPoint(hit: SurfaceHit | null, floor: V3 | null, mount: Mount): V3 | null {
  if (hit) {
    const up = hit.normal[1];
    if (mount === 'under' ? up < -0.7 : up > 0.7 || mount === 'ceiling') return hit.point;
  }
  return floor;
}

/** The ceiling over a point: the room's inside height when the point is in it, else 96". */
export function ceilingAt(doc: Doc, x: number, z: number): number {
  const inside = roomInterior(doc);
  if (inside && x >= inside.min[0] && x <= inside.max[0] && z >= inside.min[2] && z <= inside.max[2]) return inside.max[1];
  return DEFAULT_CEILING;
}

/**
 * The transform that drops an item of `size` (its own x / y / z) at `at`: centered on it in plan,
 * front turned toward the camera (`toCamera`, any direction: only its plan part counts), at the height
 * its mount says. Returns the world box it fills too.
 */
export function dropTransform(size: V3, at: V3, toCamera: V3, mount: Mount, ceiling: number): { transform: Transform; box: Box3 } {
  const turns = facingToward(IDENTITY, toCamera);
  const [wx, wz] = turns % 2 ? [size[2], size[0]] : [size[0], size[2]];
  const snap = (v: number) => Math.round(v / STEP) * STEP;
  const y =
    mount === 'floor' ? at[1] :
    mount === 'ceiling' ? ceiling - size[1] :
    mount === 'under' ? at[1] - size[1] :
    Math.min(mount.raised, ceiling - size[1]);
  const min: V3 = [snap(at[0] - wx / 2), Math.round(y), snap(at[2] - wz / 2)];
  const box: Box3 = { min, max: [min[0] + wx, min[1] + size[1], min[2] + wz] };
  return { transform: blockPlacement(IDENTITY, box, turns).transform, box };
}
