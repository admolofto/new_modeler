import { z } from 'zod';
import { formatInches as f } from '../../model/units';
import { registerMotion, type MotionBasis } from '../registry';
import { normal, Seconds, Side, SIDES } from './sides';

export interface SlideParams {
  toward: Side;
  distance?: number | undefined;
  seconds: number;
}

const schema = z.object({
  toward: Side.default('front'),
  distance: z.int().positive().optional(),
  seconds: Seconds.default(0.6),
});

/** How far it travels: as given, else 90% of the parts' size that way (a drawer comes most of the way out). */
export function slideDistance(p: SlideParams, basis: MotionBasis): number {
  if (p.distance) return p.distance;
  const axis = SIDES[p.toward].axis;
  return Math.round(0.9 * (basis.box.max[axis] - basis.box.min[axis]));
}

const WAY: Record<Side, string> = { front: 'out', back: 'in', left: 'left', right: 'right', top: 'up', bottom: 'down' };

registerMotion<SlideParams>({
  type: 'slide',
  version: 1,
  schema: schema as z.ZodType<SlideParams>,
  describe:
    'Slides straight, like a drawer, pull-out, sliding door or lift-up. toward = the direction it moves, seen from the front of the ' +
    'first node (default "front": out of the cabinet). distance = how far (1/64"; default 90% of the parts\' size that way, so a ' +
    'drawer comes most of the way out). seconds = time to open (default 0.6).',
  presets: [
    { label: 'Drawer / pull-out', params: { toward: 'front' } },
    { label: 'Slides left', params: { toward: 'left' } },
    { label: 'Slides right', params: { toward: 'right' } },
    { label: 'Lifts up', params: { toward: 'top' } },
  ],
  summary: (p) => `slides ${WAY[p.toward]}${p.distance ? ` ${f(p.distance)}` : ''}`,
  seconds: (p) => p.seconds,
  reach: (p, basis) => ({ value: slideDistance(p, basis), unit: 'length' }),
  pose(p, basis, t) {
    const d = slideDistance(p, basis) * t;
    return { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: normal(p.toward).map((c) => c * d) as [number, number, number] };
  },
});
