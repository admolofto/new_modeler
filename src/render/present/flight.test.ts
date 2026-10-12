import { describe, expect, it } from 'vitest';
import type { V3 } from '../../geometry/types';
import { cameraToPose, direction, flight, flightSeconds, MAX_SECONDS, MIN_SECONDS, poseToCamera, shortest, yawPitch, type Pose } from './flight';

const pose = (position: V3, target: V3 = [0, 0, 0], fov = 50): Pose => ({ position, target, fov });
const azimuth = (p: Pose) => Math.atan2(p.position[0] - p.target[0], p.position[2] - p.target[2]);

describe('flight', () => {
  it('starts and ends exactly on its poses', () => {
    const a = pose([10, 20, 100], [1, 2, 3], 50);
    const b = pose([-80, 40, -20], [5, 0, -5], 60);
    for (const walk of [false, true]) {
      const f = flight(a, b, { walk });
      expect(f.at(0)).toEqual(a);
      expect(f.at(1)).toEqual(b);
      expect(f.at(1.5)).toEqual(b);
    }
  });

  it('orbits the short way round, the radius log-lerped', () => {
    // From azimuth +170° to −170°: through 180°, not back through 0°.
    const r = 100;
    const at = (deg: number) => pose([r * Math.sin((deg * Math.PI) / 180), 0, r * Math.cos((deg * Math.PI) / 180)]);
    const f = flight(at(170), at(-170));
    const mid = f.at(0.5);
    expect(Math.abs(azimuth(mid))).toBeCloseTo(Math.PI, 6);
    // Radius 100 → 400: halfway (eased 0.5) is the geometric mean, 200.
    const g = flight(pose([0, 0, 100]), pose([0, 0, 400]));
    expect(Math.hypot(...g.at(0.5).position)).toBeCloseTo(200, 6);
  });

  it('keeps the polar angle off the poles', () => {
    // Straight above to straight below: the camera never sits exactly on the axis.
    const f = flight(pose([0, 100, 0]), pose([0, -100, 0.0001]));
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const p = f.at(u).position;
      expect(Math.hypot(p[0], p[2])).toBeGreaterThan(1);
    }
  });

  it('walks in a straight line and turns the short way', () => {
    const a = pose([0, 62, 0], [0, 62, -60]); // looking −z (yaw 0)
    const b = pose([100, 62, 0], [160, 62, 0]); // looking +x (yaw −90°)
    const f = flight(a, b, { walk: true });
    const mid = f.at(0.5);
    expect(mid.position).toEqual([50, 62, 0]);
    const g = yawPitch([mid.target[0] - mid.position[0], mid.target[1] - mid.position[1], mid.target[2] - mid.position[2]]);
    const ya = yawPitch([0, 0, -1]).yaw;
    const yb = yawPitch([b.target[0] - 100, 0, b.target[2]]).yaw;
    expect(g.yaw).toBeCloseTo(ya + shortest(yb - ya) / 2, 6);
  });

  it('takes longer the further it goes and the more it turns, within 0.6 – 2.5 s', () => {
    const a = pose([0, 0, 100]);
    let last = 0;
    for (const d of [1, 10, 50, 200, 1000, 10_000, 1e6]) {
      const s = flightSeconds(a, pose([d, 0, 100], [d, 0, 0]));
      expect(s).toBeGreaterThanOrEqual(last);
      expect(s).toBeGreaterThanOrEqual(MIN_SECONDS);
      expect(s).toBeLessThanOrEqual(MAX_SECONDS);
      last = s;
    }
    expect(last).toBe(MAX_SECONDS);
    // The formula: 48" over, no turn → 0.6 + 0.25·log2(3).
    expect(flightSeconds(a, pose([48, 0, 100], [48, 0, 0]))).toBeCloseTo(0.6 + 0.25 * Math.log2(3), 9);
    // Turning around in place adds 0.4 s (on top of the target moving 20").
    expect(flightSeconds(pose([0, 0, 0], [0, 0, -10]), pose([0, 0, 0], [0, 0, 10]))).toBeCloseTo(1.0 + 0.25 * Math.log2(1 + 20 / 24), 9);
    expect(flightSeconds(a, a)).toBe(0);
  });

  it('takes no time under reduced motion', () => {
    const f = flight(pose([0, 0, 100]), pose([300, 0, 100]), { reduced: true });
    expect(f.seconds).toBe(0);
    expect(f.at(0)).toEqual(pose([300, 0, 100]));
  });
});

describe('poses and saved cameras', () => {
  it('round-trip to the 1/64"', () => {
    const p = pose([12.3456, 61.99, -40.001], [0.017, 30.5, 2], 47.33);
    const cam = poseToCamera(p);
    expect(cam.position.every(Number.isInteger) && cam.target.every(Number.isInteger)).toBe(true);
    const back = cameraToPose(cam);
    back.position.forEach((c, i) => expect(Math.abs(c - p.position[i]!)).toBeLessThanOrEqual(1 / 128));
    back.target.forEach((c, i) => expect(Math.abs(c - p.target[i]!)).toBeLessThanOrEqual(1 / 128));
    expect(back.fov).toBeCloseTo(47.3);
    expect(poseToCamera(back)).toEqual(cam);
  });

  it('turns yaw and pitch into a direction and back', () => {
    for (const [yaw, pitch] of [[0, 0], [1, 0.3], [-2.5, -0.9]] as const) {
      const g = yawPitch(direction(yaw, pitch));
      expect(g.yaw).toBeCloseTo(yaw, 9);
      expect(g.pitch).toBeCloseTo(pitch, 9);
    }
    expect(direction(0, 0)).toEqual([-0, 0, -1]);
  });
});
