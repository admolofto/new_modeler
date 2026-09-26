import { z } from 'zod';
import { chamferCurve, GeometryError, roundoverCurve } from '../../geometry/prism';
import type { Handle, V3 } from '../../geometry/types';
import { registerFeature } from '../registry';

export interface EdgeProfileParams {
  edges: string[];
  profile: 'roundover' | 'chamfer';
  r: number;
}

const PROFILES = ['roundover', 'chamfer'] as const;

registerFeature<EdgeProfileParams>({
  type: 'edgeProfile',
  version: 1,
  schema: z.object({
    edges: z
      .array(z.string().regex(/^edge:[A-Za-z0-9_\-]+$/, 'an edge id like edge:top-front'))
      .min(1)
      .refine((e) => new Set(e).size === e.length, 'edges must be unique'),
    profile: z.enum(PROFILES),
    r: z.int().positive(),
  }),
  describe:
    'Routes a profile along edges, like a router with a bearing: `roundover` (radius `r`) or `chamfer` (`r` = leg length, 45°), in 1/64". ' +
    'Profiles miter where two profiled edges meet at a sharp corner and follow rounded corners. ' +
    'Box edges are named from face words (edge:top-front, edge:front-left…); for a panel, the edges around its big faces are ' +
    'the ones usually profiled, and the short edges through its thickness round its corners. Outline edges: edge:top-<pointId> ' +
    '(the cap edge of the side starting at that point; use the outline\'s cap words, e.g. edge:front-<id> for axis z) and edge:corner-<pointId>. ' +
    'Where a corner is rounded, both edges meeting there need the same profile.',
  appliesTo: (shape) =>
    shape.type === 'box' || shape.type === 'outline' ? null : `edge profiles need a box or outline part, not "${shape.type}"`,
  profile(prism, p, { featureId }) {
    const curve = p.profile === 'roundover' ? roundoverCurve(p.r) : chamferCurve(p.r);
    const key = `${p.profile}:${p.r}`;
    for (const name of p.edges) {
      const tag = `${featureId}:${name}`;
      let found = false;
      for (const side of prism.sides) {
        for (const c of [0, 1] as const) {
          if (side.capEdges[c] !== name) continue;
          const existing = side.profiles[c];
          if (existing) throw new GeometryError(`${name} is already profiled by ${existing.tag.split(':')[0]}`);
          side.profiles[c] = { tag, key, curve };
          found = true;
        }
      }
      for (const v of prism.verts) {
        if (v.edge !== name) continue;
        if (v.corner) throw new GeometryError(`${name} is already rounded`);
        v.corner = { kind: p.profile === 'roundover' ? 'round' : 'chamfer', r: p.r, tag };
        found = true;
      }
      if (!found) {
        const known = [...prism.sides.flatMap((s) => s.capEdges), ...prism.verts.map((v) => v.edge)];
        throw new GeometryError(`edgeProfile ${featureId}: no edge ${name} (edges: ${known.join(', ')})`);
      }
    }
  },
  handles(p, { featureId, geom }) {
    const handles: Handle[] = [];
    for (const name of p.edges) {
      const tag = `${featureId}:${name}`;
      const pts: number[] = [];
      for (const patch of geom.patches) if (patch.tag === tag) pts.push(...patch.positions);
      for (const face of geom.faces) if (face.tag === tag && face.outer3) face.outer3.forEach((q) => pts.push(...q));
      if (!pts.length) continue;
      const c = [0, 1, 2].map((k) => {
        let sum = 0;
        for (let i = k; i < pts.length; i += 3) sum += pts[i]!;
        return (sum * 3) / pts.length;
      }) as V3;
      handles.push({ id: tag, kind: 'face', source: featureId, points: [c], drives: [{ target: featureId, param: 'r', label: p.profile === 'roundover' ? 'radius' : 'chamfer' }] });
    }
    return handles;
  },
});
