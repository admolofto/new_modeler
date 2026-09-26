import { z } from 'zod';
import { cutFace } from '../../geometry/cut';
import { arcSegments } from '../../geometry/prism';
import type { V2 } from '../../geometry/types';
import { formatInches as f } from '../../model/units';
import { registerFeature } from '../registry';
import { cutHandles, FACE_DOCS, FaceRef } from './cuts';

export interface PocketParams {
  face: string;
  at: [number, number];
  size: [number, number];
  /** Corner radius (a router bit leaves at least its own radius). */
  r: number;
  /** Omitted = through (a cutout). */
  depth?: number | undefined;
}

/** Rounded rectangle centered on `at`, counter-clockwise. */
export function roundedRect(at: [number, number], size: [number, number], r: number): V2[] {
  const [hw, hh] = [size[0] / 2, size[1] / 2];
  if (r === 0) {
    return [
      [at[0] - hw, at[1] - hh],
      [at[0] + hw, at[1] - hh],
      [at[0] + hw, at[1] + hh],
      [at[0] - hw, at[1] + hh],
    ];
  }
  const m = arcSegments(r, Math.PI / 2, 2);
  const corners: [number, number, number][] = [
    [at[0] + hw - r, at[1] - hh + r, -Math.PI / 2],
    [at[0] + hw - r, at[1] + hh - r, 0],
    [at[0] - hw + r, at[1] + hh - r, Math.PI / 2],
    [at[0] - hw + r, at[1] - hh + r, Math.PI],
  ];
  const loop: V2[] = [];
  for (const [cx, cy, a0] of corners) {
    for (let j = 0; j <= m; j++) {
      const a = a0 + ((Math.PI / 2) * j) / m;
      loop.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  // Drop tangent points shared by two corners (a full-round end on a slot).
  return loop.filter((p, i) => {
    const q = loop[(i + 1) % loop.length]!;
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9;
  });
}

registerFeature<PocketParams>({
  type: 'pocket',
  version: 1,
  schema: z
    .object({
      face: FaceRef,
      at: z.tuple([z.int(), z.int()]),
      size: z.tuple([z.int().positive(), z.int().positive()]),
      r: z.int().nonnegative().default(0),
      depth: z.int().positive().optional(),
    })
    .refine((p) => 2 * p.r <= Math.min(...p.size), { message: 'corner radius can be at most half the smaller side', path: ['r'] }),
  describe:
    'Rectangular recess (blind, e.g. a hinge mortise or inlay pocket) or cutout (through, e.g. a sink or vent opening) perpendicular to a flat face, ' +
    'with optional corner radius `r`. `size` = [width along u, height along v] in 1/64". ' +
    FACE_DOCS,
  appliesTo: (shape) => (shape.type === 'box' || shape.type === 'outline' ? null : `pockets need a box or outline part, not "${shape.type}"`),
  cut(geom, p, { part, featureId }) {
    const loop = roundedRect(p.at, p.size, p.r);
    cutFace(geom, {
      featureId,
      noun: p.depth === undefined ? 'cutout' : 'pocket',
      label: `${p.depth === undefined ? 'cutout' : 'pocket'} ${featureId} (${f(p.size[0])} × ${f(p.size[1])} at ${f(p.at[0])}, ${f(p.at[1])})`,
      partName: part.name,
      face: p.face,
      loop,
      smooth: loop.map(() => p.r > 0),
      depth: p.depth ?? null,
    });
  },
  handles: (p, { featureId, geom }) =>
    cutHandles(featureId, geom, p.depth !== undefined, [
      { target: featureId, param: 'size.0', label: 'width' },
      { target: featureId, param: 'size.1', label: 'height' },
    ]),
});
