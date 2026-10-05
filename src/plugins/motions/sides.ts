import { z } from 'zod';
import type { V3 } from '../../geometry/types';

/** The six sides of a motion's frame (the first node's local frame: front = +Z, up = +Y). */
export const Side = z.enum(['left', 'right', 'bottom', 'top', 'back', 'front']);
export type Side = z.infer<typeof Side>;

/** Each side's outward normal: axis (0 x, 1 y, 2 z) and sign. */
export const SIDES: Record<Side, { axis: 0 | 1 | 2; sign: 1 | -1 }> = {
  left: { axis: 0, sign: -1 },
  right: { axis: 0, sign: 1 },
  bottom: { axis: 1, sign: -1 },
  top: { axis: 1, sign: 1 },
  back: { axis: 2, sign: -1 },
  front: { axis: 2, sign: 1 },
};

export function normal(side: Side): V3 {
  const v: V3 = [0, 0, 0];
  v[SIDES[side].axis] = SIDES[side].sign;
  return v;
}

export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const Seconds = z.number().min(0.1).max(10);
