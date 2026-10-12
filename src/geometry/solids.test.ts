import { describe, expect, it } from 'vitest';
import { bounds, isWatertight, volume } from '../plugins/testMesh';
import { box, cylinder, extrude, lathe, mergeGeoms, mirrorGeom, rotateGeom, rotateGeomY, sphere, translateGeom, unitCircle } from './solids';
import { tessellate } from './tessellate';
import type { Geom, V3 } from './types';

const mesh = (g: Geom) => tessellate(g);
const near = (got: number, want: number, tolerance: number) => expect(Math.abs(got - want) / want).toBeLessThan(tolerance);
const expectBounds = (g: Geom, min: V3, max: V3) => {
  const b = bounds(mesh(g));
  b.min.forEach((v, k) => expect(v).toBeCloseTo(min[k]!, 4));
  b.max.forEach((v, k) => expect(v).toBeCloseTo(max[k]!, 4));
};

describe('solids', () => {
  it('lands round things exactly on their quarter points', () => {
    const c = unitCircle(8);
    expect([c[0], c[2], c[4], c[6]]).toEqual([[1, 0], [0, 1], [-1, 0], [0, -1]]);
    expect(() => unitCircle(6)).toThrow(/multiple of 4/);
  });

  it('makes a closed box', () => {
    const g = box([1, 2, 3], [11, 7, 5], 'b');
    const m = mesh(g);
    expect(isWatertight(m)).toBe(true);
    expect(volume(m)).toBeCloseTo(10 * 5 * 2);
    expectBounds(g, [1, 2, 3], [11, 7, 5]);
    expect(m.tags).toEqual(['b']);
  });

  it('makes a closed cylinder on any axis, with its own cap tag', () => {
    for (const axis of [0, 1, 2] as const) {
      const g = cylinder([10, 20, 30], axis, 8, 40, 'side', 'end');
      const m = mesh(g);
      expect(isWatertight(m)).toBe(true);
      near(volume(m), Math.PI * 64 * 40, 0.01);
      const min: V3 = [2, 12, 22];
      const max: V3 = [18, 28, 38];
      min[axis] = [10, 20, 30][axis]!;
      max[axis] = min[axis] + 40;
      expectBounds(g, min, max);
      expect(new Set(m.tags)).toEqual(new Set(['side', 'end']));
    }
  });

  it('extrudes a concave outline with sharp and smooth corners', () => {
    const l = extrude([[0, 0], [8, 0], [8, 64], [40, 64], [40, 72], [0, 72]], 0, 0, 100, 'lip');
    expect(isWatertight(mesh(l))).toBe(true);
    near(volume(mesh(l)), (8 * 72 + 32 * 8) * 100, 1e-9);
    // Clockwise outlines work too.
    const cw = extrude([[0, 0], [0, 10], [10, 10], [10, 0]], 1, 0, 5, 'x');
    expect(volume(mesh(cw))).toBeCloseTo(500);
  });

  it('turns a profile into a closed solid with pole fans', () => {
    const knob = lathe([0, 0, 0], [[0, 0], [10, 0], [10, 4], [20, 12], [20, 16], [0, 16]], 'knob');
    const m = mesh(knob);
    expect(isWatertight(m)).toBe(true);
    expectBounds(knob, [-20, 0, -20], [20, 16, 20]);
    // A cylinder from a lathe: r 10, h 30.
    const can = mesh(lathe([5, 5, 5], [[0, 0], [10, 0], [10, 30], [0, 30]], 'can'));
    expect(isWatertight(can)).toBe(true);
    near(volume(can), Math.PI * 100 * 30, 0.01);
    expect(() => lathe([0, 0, 0], [[5, 0], [5, 5], [0, 5]], 'x')).toThrow(/starts and ends on its axis/);
  });

  it('makes a closed sphere of about the right volume', () => {
    const g = sphere([0, 50, 0], 20, 'ball');
    const m = mesh(g);
    expect(isWatertight(m)).toBe(true);
    near(volume(m), (4 / 3) * Math.PI * 8000, 0.03);
    expectBounds(g, [-20, 30, -20], [20, 70, 20]);
  });

  it('moves, turns and mirrors solids, keeping them closed and outward', () => {
    const g = box([0, 0, 0], [10, 20, 30], 'b');
    expectBounds(translateGeom(g, [1, 2, 3]), [1, 2, 3], [11, 22, 33]);
    expectBounds(rotateGeomY(g, 1), [0, 0, -10], [30, 20, 0]);
    expectBounds(rotateGeom(g, 2, 1), [-20, 0, 0], [0, 10, 30]);
    expectBounds(rotateGeom(g, 0, 1), [0, -30, 0], [10, 0, 20]);
    expectBounds(rotateGeomY(g, 4), [0, 0, 0], [10, 20, 30]);
    const mirrored = mesh(mirrorGeom(cylinder([0, 0, 5], 2, 4, 10, 'c'), 2));
    expect(isWatertight(mirrored)).toBe(true);
    expect(volume(mirrored)).toBeGreaterThan(0);
    expect(bounds(mirrored).max[2]).toBeCloseTo(-5);
    const both = mesh(mergeGeoms(g, translateGeom(g, [100, 0, 0])));
    expect(isWatertight(both)).toBe(true);
    expect(volume(both)).toBeCloseTo(2 * 6000);
  });
});
