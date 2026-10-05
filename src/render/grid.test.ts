import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Box3 } from '../model/world';
import { createGrid, isolateGridRect } from './grid';

/** A floor footprint in inches, as world bounds (1/64"). */
const footprint = (x0: number, z0: number, x1: number, z1: number): Box3 => ({ min: [x0 * 64, 0, z0 * 64], max: [x1 * 64, 34.5 * 64, z1 * 64] });

describe('floor grid', () => {
  it('gives an isolated folder a floor of whole feet, at least 12 ft a side and 2 ft clear around it', () => {
    expect(isolateGridRect(footprint(0, 0, 36, 24))).toEqual({ minX: -60, minZ: -60, maxX: 96, maxZ: 84 });
    expect(isolateGridRect(footprint(10, 5, 250, 29))).toEqual({ minX: -24, minZ: -60, maxX: 276, maxZ: 96 });
    for (const [x0, z0, x1, z1] of [[-37.3, 12.1, -1.5, 40], [500, -800, 512, -780], [0, 0, 0.5, 0.5], [-200, -3, 200, 3]] as const) {
      const r = isolateGridRect(footprint(x0, z0, x1, z1));
      for (const v of [r.minX, r.minZ, r.maxX, r.maxZ]) expect(Number.isInteger(v / 12)).toBe(true);
      expect(r.maxX - r.minX).toBeGreaterThanOrEqual(144);
      expect(r.maxZ - r.minZ).toBeGreaterThanOrEqual(144);
      expect(r.minX).toBeLessThanOrEqual(x0 - 24);
      expect(r.maxX).toBeGreaterThanOrEqual(x1 + 24);
      expect(r.minZ).toBeLessThanOrEqual(z0 - 24);
      expect(r.maxZ).toBeGreaterThanOrEqual(z1 + 24);
    }
  });

  it('runs out as far as it fades, further when zoomed out; bounded, it stops at its edges', () => {
    const grid = createGrid();
    const camera = new PerspectiveCamera(45, 1, 0.5, 2000);
    const target = new Vector3(0, 0, 0);
    camera.position.set(0, 60, 100);
    grid.update(camera, target);
    expect(grid.contains(0, 0)).toBe(true);
    expect(grid.contains(0, 800)).toBe(false);
    expect(grid.mesh.position.toArray()).toEqual([0, 0, 100]);
    camera.position.set(0, 300, 500);
    grid.update(camera, target);
    expect(grid.contains(0, 800)).toBe(true);
    expect(grid.contains(0, 3000)).toBe(false);
    grid.setBounds({ minX: -72, minZ: -72, maxX: 72, maxZ: 72 });
    expect(grid.contains(70, -70)).toBe(true);
    expect(grid.contains(80, 0)).toBe(false);
    grid.setBounds(null);
    expect(grid.contains(80, 0)).toBe(true);
  });
});
