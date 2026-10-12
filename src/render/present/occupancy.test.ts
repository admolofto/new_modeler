import { describe, expect, it } from 'vitest';
import { buildGrid, isFree, move, nearestWalkable, WALK_GRID, type Grid } from './occupancy';

type V3 = [number, number, number];

/** A box's 12 triangles, flat (inches). */
function box(min: V3, max: V3): number[] {
  const c = (i: number): V3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return quads.flatMap(([a, b, cc, d]) => [...c(a!), ...c(b!), ...c(cc!), ...c(a!), ...c(cc!), ...c(d!)]);
}
/** A floor rectangle at y = 0. */
const floor = (x0: number, z0: number, x1: number, z1: number) => [x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1];

/**
 * A 120" × 120" room (inside 0…120), 4" walls, a 36" doorway (z 40…76) in the right wall with its
 * header over 80"; the floor runs 24" past the walls all round.
 */
function room(extra: number[] = []): Grid {
  const walls = [
    ...box([-4, 0, -4], [124, 96, 0]), // back
    ...box([-4, 0, 120], [124, 96, 124]), // front
    ...box([-4, 0, 0], [0, 96, 120]), // left
    ...box([120, 0, 0], [124, 96, 40]), // right, behind the doorway
    ...box([120, 0, 76], [124, 96, 120]), // right, in front of it
    ...box([120, 80, 40], [124, 96, 76]), // the header
  ];
  return buildGrid([...walls, ...extra], { ...WALK_GRID, floorTris: floor(-24, -24, 144, 144) });
}

describe('walk-mode occupancy', () => {
  it('keeps the body radius off walls', () => {
    const g = room();
    expect(isFree(g, 60, 60)).toBe(true);
    expect(isFree(g, 60, 6)).toBe(false); // 6" from the back wall's face
    expect(isFree(g, 60, 12)).toBe(true);
    expect(isFree(g, 115, 20)).toBe(false);
    expect(isFree(g, 108, 20)).toBe(true);
  });

  it('stops at a wall', () => {
    const g = room();
    const [x, z] = move(g, [60, 60], [0, -200]);
    expect(x).toBe(60);
    expect(z).toBeGreaterThan(8);
    expect(z).toBeLessThan(14);
  });

  it('slides along a wall when walking into it at an angle', () => {
    const g = room();
    const [x, z] = move(g, [60, 30], [20, -60]);
    expect(z).toBeLessThan(14);
    expect(x).toBeCloseTo(80, 6);
  });

  it('passes through a doorway (its header is over the body)', () => {
    const g = room();
    const [x, z] = move(g, [100, 58], [40, 0]);
    expect(x).toBeCloseTo(140, 6);
    expect(z).toBe(58);
    // Beside the doorway the wall stops you.
    expect(move(g, [100, 20], [40, 0])[0]).toBeLessThan(112);
  });

  it('never leaves the floor', () => {
    const g = buildGrid([], { ...WALK_GRID, floorTris: floor(0, 0, 60, 60) });
    expect(isFree(g, 30, 30)).toBe(true);
    expect(isFree(g, 70, 30)).toBe(false);
    expect(move(g, [30, 30], [100, 0])[0]).toBeLessThan(61);
    expect(buildGrid([], { ...WALK_GRID, floorTris: [] }).nx).toBe(0);
  });

  it('is blocked by an open door standing in the room, not by low things like a toe kick', () => {
    // The door's leaf swung into the room, square to the wall, beside the doorway.
    const leaf = box([88, 0.75, 40], [120, 80, 41.375]);
    const open = room(leaf);
    expect(move(open, [104, 20], [0, 50])[1]).toBeLessThan(32);
    expect(move(room(), [104, 20], [0, 50])[1]).toBeCloseTo(70, 6);
    const kick = room(box([20, 0, 20], [80, 6, 40]));
    expect(isFree(kick, 50, 30)).toBe(true);
    const counter = room(box([20, 0, 20], [80, 36, 40]));
    expect(isFree(counter, 50, 30)).toBe(false);
  });

  it('finds the nearest free spot', () => {
    const g = room();
    expect(nearestWalkable(g, [60, 60])).toEqual([60, 60]);
    const p = nearestWalkable(g, [60, 1])!;
    expect(isFree(g, p[0], p[1])).toBe(true);
    expect(Math.abs(p[0] - 60)).toBeLessThan(2);
    expect(p[1]).toBeGreaterThan(8);
    expect(p[1]).toBeLessThan(14);
  });
});
