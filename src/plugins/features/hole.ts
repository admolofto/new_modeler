import { z } from 'zod';
import { cutFace } from '../../geometry/cut';
import type { V2 } from '../../geometry/types';
import { formatInches as f } from '../../model/units';
import { registerFeature } from '../registry';
import { cutHandles, FACE_DOCS, FaceRef } from './cuts';

export interface HoleParams {
  face: string;
  at: [number, number];
  d: number;
  /** Omitted = through. */
  depth?: number | undefined;
}

/** Polygon segment count: roughly one per 1/2" of circumference, multiple of 4, 16–64. */
export function holeSegments(d: number): number {
  return Math.min(64, Math.max(16, 4 * Math.ceil((Math.PI * d) / 128)));
}

registerFeature<HoleParams>({
  type: 'hole',
  version: 1,
  schema: z.object({
    face: FaceRef,
    at: z.tuple([z.int(), z.int()]),
    d: z.int().positive(),
    depth: z.int().positive().optional(),
  }),
  describe:
    'Round hole drilled perpendicular to a flat face: through (e.g. a 1" grommet) or blind (e.g. a 5mm shelf-pin hole 3/8" deep, ' +
    'a 35mm hinge-cup bore 1/2" deep). `d` = diameter in 1/64". ' +
    FACE_DOCS +
    ' Must sit fully inside the face, leave material under a blind hole, and not touch other cuts.',
  appliesTo: (shape) => (shape.type === 'box' || shape.type === 'outline' ? null : `holes need a box or outline part, not "${shape.type}"`),
  cut(geom, p, { part, featureId }) {
    const n = holeSegments(p.d);
    const r = p.d / 2;
    const loop: V2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      loop.push([p.at[0] + r * Math.cos(a), p.at[1] + r * Math.sin(a)]);
    }
    cutFace(geom, {
      featureId,
      noun: 'hole',
      label: `hole ${featureId} (Ø${f(p.d)} at ${f(p.at[0])}, ${f(p.at[1])})`,
      partName: part.name,
      face: p.face,
      loop,
      smooth: loop.map(() => true),
      depth: p.depth ?? null,
    });
  },
  handles: (p, { featureId, geom }) => cutHandles(featureId, geom, p.depth !== undefined, [{ target: featureId, param: 'd', label: 'diameter' }]),
});
