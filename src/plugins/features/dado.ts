import { z } from 'zod';
import type { Handle, HandleDrive, V3 } from '../../geometry/types';
import { formatInches as f } from '../../model/units';
import { registerFeature } from '../registry';
import { BOX_FACE_IDS, BOX_FACES, type BoxFaceId } from '../shapes/box';

export interface DadoParams {
  face: BoxFaceId;
  /** Opposite corners of the footprint, [u, v] in the face's frame; may run past the face's edges. */
  from: [number, number];
  to: [number, number];
  depth: number;
}

registerFeature<DadoParams>({
  type: 'dado',
  version: 1,
  schema: z
    .object({
      face: z.enum(BOX_FACE_IDS as [BoxFaceId, ...BoxFaceId[]]),
      from: z.tuple([z.int(), z.int()]),
      to: z.tuple([z.int(), z.int()]),
      depth: z.int().positive(),
    })
    .refine((p) => p.from[0] !== p.to[0] && p.from[1] !== p.to[1], { message: 'from and to must differ on both axes', path: ['to'] }),
  describe:
    'Square-bottomed channel cut into a flat face of a box part, like a dado stack or straight router bit: a dado or groove across ' +
    'or along the face, or a rabbet along an edge. `face` = box face; `from` / `to` = opposite corners of its footprint as [u, v] ' +
    'in 1/64" in that face\'s frame (front/back [x, y], left/right [z, y], top/bottom [x, z], from the part min corner). The ' +
    'footprint may run past the face\'s edges (it is clipped): that is how a through dado or a rabbet is made. `depth` into the ' +
    'face. Dado and rabbet joints cut these automatically in their housing part — add one by hand only for a groove no joint ' +
    'describes (e.g. a drawer-bottom groove). Box parts only, and not together with edge profiles on the same part.',
  appliesTo: (shape) => (shape.type === 'box' ? null : `dados need a box part, not "${shape.type}"`),
  channel: (p, { featureId }) => ({
    featureId,
    face: p.face,
    from: p.from,
    to: p.to,
    depth: p.depth,
    label: `dado ${featureId} (${f(Math.abs(p.to[0] - p.from[0]))} × ${f(Math.abs(p.to[1] - p.from[1]))}, ${f(p.depth)} deep in ${p.face})`,
  }),
  handles(p, { featureId, geom, part }) {
    const floors = geom.faces.filter((x) => x.tag === `${featureId}:floor`);
    if (!floors.length) return [];
    const pts = floors.flatMap((x) => x.outer.map(([s, t]): V3 => [0, 1, 2].map((k) => x.origin[k]! + x.u[k]! * s + x.v[k]! * t) as V3));
    const c = [0, 1, 2].map((k) => pts.reduce((s, q) => s + q[k]!, 0) / pts.length) as V3;
    const face = BOX_FACES[p.face];
    const out: V3 = [0, 0, 0];
    out[face.axis] = face.max ? 1 : -1;
    // A joint's cut follows the joint: edit the joint, not the cut.
    const fromJoint = part.joinery?.some((j) => j.id === featureId);
    const into = out.map((n) => (n ? -n : 0)) as V3;
    const drives: HandleDrive[] = fromJoint ? [] : [{ target: featureId, param: 'depth', label: 'depth', axis: into }];
    const handles: Handle[] = [{ id: `${featureId}:floor`, kind: 'face', source: featureId, points: [c], normal: out, drives }];
    return handles;
  },
});
