import { z } from 'zod';
import type { V3 } from '../../geometry/types';
import { axisRotation, rotate, type Box3 } from '../../model/world';
import { registerMotion, type MotionBasis } from '../registry';
import { cross, normal, Seconds, Side, SIDES } from './sides';

export interface HingeParams {
  side: Side;
  toward?: Side | undefined;
  angle: number;
  seconds: number;
}

/** The face that swings out: as given, else the front (the top when the hinges are at the front or back: a lid). */
export const towardOf = (p: { side: Side; toward?: Side | undefined }): Side => p.toward ?? (SIDES[p.side].axis === 2 ? 'top' : 'front');

const schema = z
  .object({
    side: Side,
    toward: Side.optional(),
    angle: z.number().gt(0).max(180).default(105),
    seconds: Seconds.default(0.8),
  })
  .refine((p) => SIDES[p.side].axis !== SIDES[towardOf(p)].axis, {
    message: "side and toward can't be the same or opposite sides (e.g. side left, toward front)",
    path: ['toward'],
  });

/** Parts this much smaller than the whole face (pulls, knobs, hinge leaves) don't set where it hinges. */
const HARDWARE = 0.05;
/** How close a part must come to the hinge side to reach it: 1/16". */
const REACH = 4;

/**
 * A point on the hinge line, in the motion's frame: the outer edge on the hinge side, at the face that
 * swings out — the door's front corner, so it swings clear of the cabinet it covers. Only the panel
 * counts (a pull sticking out doesn't move the line); on a frame-and-panel door, the stile does.
 */
export function hingePoint(basis: MotionBasis, side: Side, toward: Side): V3 {
  const s = SIDES[side];
  const w = SIDES[toward];
  const along = (3 - s.axis - w.axis) as 0 | 1 | 2;
  const area = (b: Box3) => (b.max[s.axis] - b.min[s.axis]) * (b.max[along] - b.min[along]);
  const whole = area(basis.box);
  const body = basis.parts.filter((b) => area(b) >= HARDWARE * whole);
  const parts = body.length ? body : basis.parts;
  const at = (b: Box3, f: { axis: number; sign: number }) => (f.sign > 0 ? b.max[f.axis]! : b.min[f.axis]!);
  const extreme = (values: number[], sign: number) => (sign > 0 ? Math.max(...values) : Math.min(...values));
  const sidePlane = extreme(parts.map((b) => at(b, s)), s.sign);
  const reaching = parts.filter((b) => Math.abs(at(b, s) - sidePlane) <= REACH);
  const p: V3 = [0, 0, 0];
  p[s.axis] = sidePlane;
  p[w.axis] = extreme(reaching.map((b) => at(b, w)), w.sign);
  p[along] = basis.box.min[along]!;
  return p;
}

const WHERE: Record<Side, string> = {
  left: 'hinges left',
  right: 'hinges right',
  top: 'hinges at the top',
  bottom: 'hinges at the bottom',
  back: 'hinges at the back',
  front: 'hinges at the front',
};

registerMotion<HingeParams>({
  type: 'hinge',
  version: 1,
  schema: schema as z.ZodType<HingeParams>,
  describe:
    'Swings about one edge, like a door on hinges. side = where the hinges are, seen from the front of the first node ' +
    '("left" / "right": a door; "top": a flip-up; "bottom": a drop-front; "back": a lid, which swings its top up). toward = the ' +
    'face that swings out (default "front"; "top" when side is "back" or "front"). angle = how far it opens in degrees (default 105). ' +
    'The hinge line is worked out from the parts — the outer edge on the hinge side, at the face that swings out; pulls and hinge ' +
    'hardware are ignored — so resizing keeps it right. seconds = time to open (default 0.8).',
  presets: [
    { label: 'Door — hinges left', params: { side: 'left' } },
    { label: 'Door — hinges right', params: { side: 'right' } },
    { label: 'Flip-up — hinges at the top', params: { side: 'top' } },
    { label: 'Drop-front — hinges at the bottom', params: { side: 'bottom', angle: 90 } },
    { label: 'Lid — hinges at the back', params: { side: 'back' } },
  ],
  summary: (p) => {
    const toward = p.toward && p.toward !== towardOf({ side: p.side }) ? `, ${p.toward} swings out` : '';
    return `${WHERE[p.side]}${toward}, opens ${Math.round(p.angle * 10) / 10}°`;
  },
  seconds: (p) => p.seconds,
  reach: (p) => ({ value: p.angle, unit: 'deg' }),
  pose(p, basis, t) {
    const toward = towardOf(p);
    const pivot = hingePoint(basis, p.side, toward);
    // Turning about toward × side swings the face that opens toward the hinge side.
    const m = axisRotation(cross(normal(toward), normal(p.side)), p.angle * t);
    const turned = rotate(m, pivot);
    return { m, t: [pivot[0] - turned[0], pivot[1] - turned[1], pivot[2] - turned[2]] };
  },
});
