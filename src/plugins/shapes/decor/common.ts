import { z } from 'zod';
import { atMinCorner, extrude, unitCircle } from '../../../geometry/solids';
import type { Geom, Handle, V2, V3 } from '../../../geometry/types';
import type { Finish } from '../../../model/schema';
import { shapes } from '../../registry';

/**
 * Helpers the prop shapes share (A8): handles of a prop's bounds, sizes measured from the geometry
 * (organic props: a plant, a bowl of fruit), a seeded random stream (books, leaves), and outlines
 * with rounded corners. Pure.
 */

export const Length = z.int().positive();
export const Seed = z.int().min(0).max(9999);

/** Box face handles of a prop's bounds, for picking and snapping: props aren't pushed or pulled. */
export function boundsHandles(size: V3): Handle[] {
  return shapes
    .get('box')
    .handles({ x: size[0], y: size[1], z: size[2] })
    .filter((h) => h.kind === 'face')
    .map((h) => ({ ...h, drives: [] }));
}

/**
 * A shape whose size comes from its geometry: built once per params (a few kept), moved to its min
 * corner. `build` and `handles` share it.
 */
export function measured<P>(make: (p: P) => Geom, keep = 32): (p: P) => { geom: Geom; size: V3 } {
  const cache = new Map<string, { geom: Geom; size: V3 }>();
  return (p) => {
    const key = JSON.stringify(p);
    let hit = cache.get(key);
    if (!hit) {
      hit = atMinCorner(make(p));
      cache.set(key, hit);
      if (cache.size > keep) cache.delete(cache.keys().next().value!);
    }
    return hit;
  };
}

/** A deterministic random stream in [0, 1) from a seed (mulberry32). */
export function random(seed: number): () => number {
  let a = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rectangle [0, w] × [0, h] with corners rounded at radius r (quarter arcs of `n` steps), counter-clockwise; smooth flags for `extrude`. */
export function roundedRect(w: number, h: number, r: number, n = 4): { outline: V2[]; smooth: boolean[] } {
  const rr = Math.max(0, Math.min(r, w / 2 - 1, h / 2 - 1));
  if (rr <= 0) return { outline: [[0, 0], [w, 0], [w, h], [0, h]], smooth: [false, false, false, false] };
  const circle = unitCircle(4 * n);
  const corner = (cx: number, cy: number, quarter: number): V2[] =>
    Array.from({ length: n + 1 }, (_, k) => circle[(quarter * n + k) % (4 * n)]!).map(([c, s]): V2 => [cx + rr * c, cy + rr * s]);
  const outline = [...corner(w - rr, rr, 3), ...corner(w - rr, h - rr, 0), ...corner(rr, h - rr, 1), ...corner(rr, rr, 2)];
  // Arc ends meet the straight sides: those stay sharp-free too (the side is tangent), so all smooth but the seams.
  const smooth = outline.map((_, i) => i % (n + 1) !== 0 && i % (n + 1) !== n);
  return { outline, smooth };
}

/** A rounded-corner slab, extruded up (Y) from y0 to y1 over [x0, x0 + w] × [z0, z0 + d]. */
export function roundedSlab(x0: number, z0: number, w: number, d: number, y0: number, y1: number, r: number, tag: string, capTag?: string): Geom {
  const { outline, smooth } = roundedRect(w, d, r);
  // Extruding along Y lays the outline in (x, z).
  return extrude(outline.map(([a, b]): V2 => [x0 + a, z0 + b]), 1, y0, y1, tag, { smooth, ...(capTag && { capTag }) });
}

/** A finish with a color. */
export const tinted = (preset: string, color: string, roughness?: number): Finish => ({ preset, color, ...(roughness !== undefined && { roughness }) });
