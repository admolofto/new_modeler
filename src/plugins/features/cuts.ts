import { z } from 'zod';
import type { Geom, Handle, HandleDrive, V3 } from '../../geometry/types';

/** Shared bits for features that cut into a flat face (hole, pocket). */

export const FaceRef = z.string().regex(/^[A-Za-z0-9_\-.:]+$/, 'a face id like face:top');

export const FACE_DOCS =
  '`face` = flat face to cut into (box: face:left/right/bottom/top/back/front; outline: its caps like face:top, or a straight side like face:side-v1; ' +
  'or another cut\'s floor like f1:floor); `at` = [u, v] center in 1/64" in that face\'s frame (box faces measure from the part min corner: ' +
  'front/back [x, y], left/right [z, y], top/bottom [x, z]; outline caps use the outline\'s own coords; outline sides measure along the side from its start point, and up from the min cap); ' +
  '`depth` in 1/64" (omit to cut all the way through).';

const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];

/** Wall (sized by `wallDrives`), center (drives `at`) and — for blind cuts — floor (drives `depth`). */
export function cutHandles(featureId: string, geom: Geom, blind: boolean, wallDrives: HandleDrive[]): Handle[] {
  const cut = geom.cuts.find((c) => c.featureId === featureId);
  if (!cut) return [];
  const at = (depth: number): V3 => [0, 1, 2].map((i) => cut.center[i]! + cut.dir[i]! * depth) as V3;
  const handles: Handle[] = [
    { id: `${featureId}:wall`, kind: 'face', source: featureId, points: [at(cut.depth / 2)], drives: wallDrives },
    {
      id: `${featureId}:center`,
      kind: 'vertex',
      source: featureId,
      points: [cut.center],
      drives: [
        { target: featureId, param: 'at.0', label: 'position u', axis: cut.u },
        { target: featureId, param: 'at.1', label: 'position v', axis: cut.v },
      ],
    },
  ];
  if (blind) {
    handles.push({
      id: `${featureId}:floor`,
      kind: 'face',
      source: featureId,
      points: [at(cut.depth)],
      normal: scale(cut.dir, -1),
      drives: [{ target: featureId, param: 'depth', label: 'depth', axis: cut.dir }],
    });
  }
  return handles;
}
