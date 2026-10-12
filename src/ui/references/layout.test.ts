import { describe, expect, it } from 'vitest';
import { fitView, focusView, GAP, hit, layoutWall, MAX_SCALE, MIN_SCALE, zoomAt } from './layout';

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('layoutWall', () => {
  it('is empty with no pictures', () => {
    expect(layoutWall([])).toEqual({ rects: [], w: 0, h: 0 });
  });

  it('keeps every picture’s shape and fills each full row edge to edge', () => {
    const sizes = [
      { w: 4000, h: 3000 },
      { w: 1080, h: 1920 },
      { w: 800, h: 800 },
      { w: 1920, h: 1080 },
      { w: 600, h: 900 },
      { w: 3000, h: 2000 },
      { w: 500, h: 500 },
    ];
    const wall = layoutWall(sizes, { width: 1200 });
    expect(wall.rects).toHaveLength(sizes.length);
    wall.rects.forEach((r, i) => close(r.w / r.h, sizes[i]!.w / sizes[i]!.h));
    const rows = new Map<number, typeof wall.rects>();
    for (const r of wall.rects) rows.set(r.y, [...(rows.get(r.y) ?? []), r]);
    const ys = [...rows.keys()].sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThan(1);
    for (const y of ys.slice(0, -1)) {
      const row = rows.get(y)!;
      const right = Math.max(...row.map((r) => r.x + r.w));
      close(right, 1200);
      expect(row[0]!.x).toBe(0);
    }
    // Nothing overlaps, and the rows stack with a gap.
    for (let i = 1; i < ys.length; i++) close(ys[i]!, ys[i - 1]! + rows.get(ys[i - 1]!)![0]!.h + GAP);
    close(wall.h, ys.at(-1)! + rows.get(ys.at(-1)!)![0]!.h);
  });

  it('comes out about the shape of the screen', () => {
    const sizes = Array.from({ length: 24 }, (_, i) => (i % 3 ? { w: 1600, h: 1200 } : { w: 900, h: 1200 }));
    const wall = layoutWall(sizes, { screenAspect: 16 / 9 });
    expect(wall.w / wall.h).toBeGreaterThan(1.1);
    expect(wall.w / wall.h).toBeLessThan(2.6);
  });

  it('treats a picture with no size yet as square', () => {
    const wall = layoutWall([{ w: 0, h: 0 }], { width: 1000 });
    close(wall.rects[0]!.w, wall.rects[0]!.h);
  });

  it('lets a lone panorama be the whole width', () => {
    const wall = layoutWall([{ w: 10000, h: 1000 }]);
    expect(wall.w).toBeGreaterThanOrEqual(wall.rects[0]!.w);
  });
});

describe('the view', () => {
  it('fits the wall centred in the screen', () => {
    const v = fitView({ w: 2000, h: 1000 }, { w: 1064, h: 800 }, 32);
    close(v.scale, 0.5);
    close(v.x, 32);
    close(v.y + 500 * 1, 800 - v.y); // centred vertically: equal space above and below
  });

  it('frames one picture', () => {
    const r = { x: 400, y: 300, w: 200, h: 100 };
    const v = focusView(r, { w: 1000, h: 1000 }, 0);
    close(r.x * v.scale + v.x, 0);
    close((r.x + r.w) * v.scale + v.x, 1000);
  });

  it('zooms about the cursor and stays within limits', () => {
    const v = { x: 10, y: 20, scale: 1 };
    const z = zoomAt(v, 2, 110, 120);
    // The world point under (110, 120) is still under it.
    close((110 - z.x) / z.scale, (110 - v.x) / v.scale);
    close((120 - z.y) / z.scale, (120 - v.y) / v.scale);
    expect(zoomAt(v, 1e6, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, 1e-6, 0, 0).scale).toBe(MIN_SCALE);
  });

  it('finds the picture under a point', () => {
    const rects = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 120, y: 0, w: 100, h: 100 },
    ];
    const v = { x: 50, y: 50, scale: 2 };
    expect(hit(rects, v, 60, 60)).toBe(0);
    expect(hit(rects, v, 50 + 150 * 2, 60)).toBe(1);
    expect(hit(rects, v, 50 + 110 * 2, 60)).toBe(-1);
  });
});
