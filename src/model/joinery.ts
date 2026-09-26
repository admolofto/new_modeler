import type { Axis } from '../geometry/prism';
import type { V2, V3 } from '../geometry/types';
import { BOX_FACE_IDS, BOX_FACES, type BoxFaceId } from '../plugins/shapes/box';
import { ModelError } from './doc';
import type { Doc, Joint, JointCut, Part } from './schema';
import { inches } from './units';
import { apply, localBox, nodeAffine, rotate, transpose, type Box3 } from './world';

/**
 * Joints → cuts (ROADMAP rule 10). Parts are modeled at their visible size, touching face to face.
 * A dado or rabbet joint finds where its inserted part meets its housing part and cuts a channel
 * there (`part.joinery`, re-derived at the end of every `applyOps`); the cut list adds the depth
 * to the inserted part. Pure: no Three.js.
 */

/** Where an inserted part meets its housing, in the housing's frame. */
export interface Contact {
  housing: string;
  inserted: string;
  /** The housing face the inserted part touches. */
  face: BoxFaceId;
  /** Footprint on that face, [u, v] in its frame. */
  from: V2;
  to: V2;
  /** The inserted part's local axis pointing into the housing, and which of its faces touches. */
  axis: Axis;
  max: boolean;
}

/** In-plane (u, v) axes of the box faces across each axis. */
const BOX_FACES_BY_AXIS: Record<Axis, { u: Axis; v: Axis }> = { 0: BOX_FACES['face:left'], 1: BOX_FACES['face:bottom'], 2: BOX_FACES['face:back'] };

/** Joints that cut a channel into their housing part. */
export const CHANNEL_JOINTS = new Set<Joint['type']>(['dado', 'rabbet']);

/** Nominal part-local box: a box shape's params (joint cuts never change it), else the built bounds. */
function nominalBox(part: Part, doc: Doc): Box3 {
  if (part.shape.type === 'box') {
    const s = part.shape.params as { x: number; y: number; z: number };
    return { min: [0, 0, 0], max: [s.x, s.y, s.z] };
  }
  return localBox(doc, part.id);
}

/** `b` (part-local to `from`) re-expressed in the frame of part `to`. */
function boxInFrame(doc: Doc, from: string, b: Box3, to: string): Box3 {
  const A = nodeAffine(doc, from);
  const B = nodeAffine(doc, to);
  const Bt = transpose(B.m);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const w = apply(A, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
    const p = rotate(Bt, [w[0] - B.t[0], w[1] - B.t[1], w[2] - B.t[2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, Math.round(p[k]!));
      max[k] = Math.max(max[k]!, Math.round(p[k]!));
    }
  }
  return { min, max };
}

/** Where the joint's parts meet, or why they don't meet face to face. */
export function jointContact(doc: Doc, joint: Joint): Contact | string {
  const [hid, iid] = joint.parts;
  const housing = doc.parts[hid];
  const inserted = doc.parts[iid];
  if (!housing || !inserted) return 'a part is missing';
  let H: Box3;
  let I: Box3;
  try {
    H = nominalBox(housing, doc);
    I = boxInFrame(doc, iid, nominalBox(inserted, doc), hid);
  } catch {
    return 'a part does not build';
  }
  const overlap = [0, 1, 2].map((k) => Math.min(H.max[k]!, I.max[k]!) - Math.max(H.min[k]!, I.min[k]!));
  if (overlap.every((o) => o > 0)) return `"${inserted.name}" runs into "${housing.name}" — model it at its visible size, touching`;
  for (const k of [0, 1, 2] as Axis[]) {
    const onMax = I.min[k] === H.max[k];
    if (!onMax && I.max[k] !== H.min[k]) continue;
    const [u, v] = [BOX_FACES_BY_AXIS[k].u, BOX_FACES_BY_AXIS[k].v];
    if (overlap[u]! <= 0 || overlap[v]! <= 0) continue;
    const face = BOX_FACE_IDS.find((id) => BOX_FACES[id].axis === k && BOX_FACES[id].max === onMax)!;
    // Direction into the housing, in the inserted part's frame.
    const dirH: V3 = [0, 0, 0];
    dirH[k] = onMax ? -1 : 1;
    const dirI = rotate(transpose(nodeAffine(doc, iid).m), rotate(nodeAffine(doc, hid).m, dirH));
    const axis = ([0, 1, 2] as Axis[]).find((a) => Math.abs(dirI[a]!) > 0.5)!;
    return {
      housing: hid,
      inserted: iid,
      face,
      from: [Math.max(H.min[u]!, I.min[u]!), Math.max(H.min[v]!, I.min[v]!)],
      to: [Math.min(H.max[u]!, I.max[u]!), Math.min(H.max[v]!, I.max[v]!)],
      axis,
      max: dirI[axis]! > 0,
    };
  }
  return `"${inserted.name}" doesn't touch "${housing.name}" face to face`;
}

/** Default depth into a housing this thick: a third of it to the nearest 1/16" (at most 1/4") for a dado, half for a rabbet. */
export function defaultJointDepth(type: Joint['type'], thick: number): number {
  return type === 'rabbet' ? Math.round(thick / 2) : Math.min(inches(1 / 4), Math.max(4, Math.round(thick / 12) * 4));
}

/** How deep the joint cuts: its `depth`, else the default for its type. */
export function jointDepth(doc: Doc, joint: Joint, contact: Contact): number {
  if (joint.params.depth !== undefined) return joint.params.depth;
  const housing = doc.parts[contact.housing]!;
  return defaultJointDepth(joint.type, nominalBox(housing, doc).max[BOX_FACES[contact.face].axis]!);
}

/** Feature id for a joint's cut: the joint id with `.` → `_` (feature ids end up in `id:floor` tags). */
export const jointCutId = (jointId: string) => jointId.replace(/\./g, '_');

/** Re-derives every part's `joinery` from the current joints and positions. */
export function syncJoints(d: Doc): void {
  const cuts = new Map<string, JointCut[]>();
  for (const joint of Object.values(d.joints)) {
    if (!CHANNEL_JOINTS.has(joint.type)) continue;
    const c = jointContact(d, joint);
    if (typeof c === 'string' || d.parts[c.housing]!.shape.type !== 'box') continue;
    const cut: JointCut = {
      id: jointCutId(joint.id),
      type: 'dado',
      params: { face: c.face, from: c.from, to: c.to, depth: jointDepth(d, joint, c) },
      joint: joint.id,
    };
    const housing = d.parts[c.housing]!;
    if (housing.features.some((f) => f.id === cut.id)) {
      throw new ModelError(`"${housing.name}" has a feature ${cut.id}, which joint ${joint.id} needs for its cut — rename one`);
    }
    cuts.set(c.housing, [...(cuts.get(c.housing) ?? []), cut]);
  }
  for (const part of Object.values(d.parts)) {
    const next = cuts.get(part.id);
    if (next) part.joinery = next;
    else delete part.joinery;
  }
}
