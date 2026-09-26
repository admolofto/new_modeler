import type { PlanarFace, V2, V3 } from '../geometry/types';
import { defaultJointDepth, jointContact } from '../model/joinery';
import type { Op } from '../model/ops';
import type { Doc, Part } from '../model/schema';
import { formatInches, inches } from '../model/units';
import type { EdgeProfileParams } from '../plugins/features/edgeProfile';
import { BOX_FACES, boxCornerEdge, type BoxParams } from '../plugins/shapes/box';
import type { OutlineParams } from '../plugins/shapes/outline';
import { resolveTarget, type Target } from './targets';

/**
 * What the user can do to the current selection, as data: a label, a few fields with defaults,
 * and a `run` that turns the field values into ops. The inspector renders these generically.
 */

export interface Field {
  key: string;
  label: string;
  /** Model units. null = blank (e.g. depth blank = through). */
  value: number | null;
  optional?: boolean;
  placeholder?: string;
}

export interface Action {
  id: string;
  label: string;
  fields: Field[];
  run(values: Record<string, number | null>): Op[];
}

const SNAP = 4; // 1/16"
const snap = (n: number) => Math.round(n / SNAP) * SNAP;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A point on a flat face in that face's (u, v) frame — the `at` of a hole or pocket. */
export function faceCoords(faces: PlanarFace[], point: V3 | undefined): V2 | null {
  if (!faces.length) return null;
  const onPlane = point && faces.find((f) => Math.abs(dot(sub(point, f.origin), f.normal)) < 0.5);
  const face = onPlane || faces[0]!;
  if (point && onPlane) {
    const d = sub(point, face.origin);
    return [snap(dot(d, face.u)), snap(dot(d, face.v))];
  }
  const us = faces.flatMap((f) => f.outer.map((q) => q[0]));
  const vs = faces.flatMap((f) => f.outer.map((q) => q[1]));
  return [snap((Math.min(...us) + Math.max(...us)) / 2), snap((Math.min(...vs) + Math.max(...vs)) / 2)];
}

/** Edge-profile features that already route any of these edges. */
function profiling(part: Part, edges: string[]) {
  return part.features.filter((f) => f.type === 'edgeProfile' && (f.params as unknown as EdgeProfileParams).edges.some((e) => edges.includes(e)));
}

/** Takes the edges out of whatever profiles them now (dropping emptied features). */
function unprofileOps(part: Part, edges: string[]): Op[] {
  return profiling(part, edges).map((f): Op => {
    const rest = (f.params as unknown as EdgeProfileParams).edges.filter((e) => !edges.includes(e));
    return rest.length
      ? { op: 'updateFeature', part: part.id, feature: f.id, params: { edges: rest } }
      : { op: 'removeFeature', part: part.id, feature: f.id };
  });
}

function profileAction(part: Part, edges: string[], profile: 'roundover' | 'chamfer', id: string, label: string, r: number): Action {
  return {
    id,
    label,
    fields: [{ key: 'r', label: profile === 'roundover' ? 'Radius' : 'Size', value: r }],
    run: (v) => [
      ...unprofileOps(part, edges),
      { op: 'addFeature', part: part.id, feature: { type: 'edgeProfile', params: { edges, profile, r: v.r! } } },
    ],
  };
}

function outlinePointIndex(part: Part, vertexId: string): number {
  const id = /^vertex:[a-z]+-(.+)$/.exec(vertexId)?.[1];
  return (part.shape.params as unknown as OutlineParams).points.findIndex((p) => p.id === id);
}

/**
 * Two touching parts: join them with a dado or rabbet (the housing is the one whose face the other
 * only partly covers), or take off the joint between them.
 */
function jointActions(doc: Doc, a: Part, b: Part): Action[] {
  const existing = Object.values(doc.joints).filter((j) => j.parts.includes(a.id) && j.parts.includes(b.id));
  if (existing.length) {
    return existing
      .filter((j) => j.role === undefined)
      .map((j): Action => ({ id: `unjoin-${j.id}`, label: `Remove ${j.type} joint`, fields: [], run: () => [{ op: 'delete', id: j.id }] }));
  }
  const coverage = (housing: Part, inserted: Part) => {
    const c = jointContact(doc, { id: 'probe', type: 'dado', parts: [housing.id, inserted.id], params: {} });
    if (typeof c === 'string' || housing.shape.type !== 'box') return null;
    const f = BOX_FACES[c.face];
    const s = housing.shape.params as unknown as BoxParams;
    const size = [s.x, s.y, s.z];
    const area = (c.to[0] - c.from[0]) * (c.to[1] - c.from[1]);
    const cover = area / (size[f.u]! * size[f.v]!);
    // A channel needs housing face left around it.
    return cover < 1 ? { c, cover, thick: size[f.axis]! } : null;
  };
  const ab = coverage(a, b);
  const ba = coverage(b, a);
  const pick = ab && (!ba || ab.cover <= ba.cover) ? { housing: a, inserted: b, ...ab } : ba ? { housing: b, inserted: a, ...ba } : null;
  if (!pick) return [];
  const join = (type: 'dado' | 'rabbet', depth: number): Action => ({
    id: type,
    label: `${type === 'dado' ? 'Dado' : 'Rabbet'} ${pick.inserted.name} into ${pick.housing.name}`,
    fields: [{ key: 'depth', label: 'Depth', value: depth }],
    run: (v) => [{ op: 'add', entity: { kind: 'joint', type, parts: [pick.housing.id, pick.inserted.id], params: { depth: v.depth! } } }],
  });
  return [join('dado', defaultJointDepth('dado', pick.thick)), join('rabbet', defaultJointDepth('rabbet', pick.thick))];
}

/** `fmt` formats lengths in labels (the UI passes its display units). */
export function actionsFor(doc: Doc, targets: Target[], fmt: (u: number) => string = formatInches): Action[] {
  if (!targets.length) return [];
  const actions: Action[] = [];
  const parts = targets.map((t) => doc.parts[t.node]);

  // Whole parts.
  if (targets.every((t, i) => !t.handle && parts[i])) {
    const n = targets.length;
    if (n === 2 && !parts[0]!.block && !parts[1]!.block) actions.push(...jointActions(doc, parts[0]!, parts[1]!));
    actions.push({ id: 'delete', label: n === 1 ? 'Delete part' : `Delete ${n} parts`, fields: [], run: () => targets.map((t): Op => ({ op: 'delete', id: t.node })) });
    const bound = parts.filter((p): p is Part => !!p?.bind);
    if (bound.length) {
      actions.push({
        id: 'unlink',
        label: 'Unlink from variables',
        fields: [],
        run: () => bound.flatMap((p) => Object.keys(p.bind!).map((path): Op => ({ op: 'bind', node: p.id, path, expr: null }))),
      });
    }
    return actions;
  }

  // Edges on one part: route a profile along them.
  const part = parts[0];
  // Blocks are placeholders: nothing to machine on them.
  if (part?.block) return actions;
  const sameIds = targets.every((t) => t.node === targets[0]!.node);
  if (part && sameIds && targets.every((t) => t.handle?.startsWith('edge:'))) {
    const edges = targets.map((t) => t.handle!);
    actions.push(profileAction(part, edges, 'roundover', 'roundover', 'Roundover', inches(1 / 4)));
    actions.push(profileAction(part, edges, 'chamfer', 'chamfer', 'Chamfer', inches(1 / 8)));
    if (profiling(part, edges).length) actions.push({ id: 'unprofile', label: 'Remove profile', fields: [], run: () => unprofileOps(part, edges) });
    return actions;
  }

  if (targets.length !== 1 || !part) return actions;
  const t = targets[0]!;
  const r = resolveTarget(doc, t);
  if (!r || !t.handle) return actions;
  const tag = t.handle;

  // Flat faces: drill or pocket where the user clicked.
  const flat = r.built.geom.faces.filter((f) => f.tag === tag);
  const at = faceCoords(flat, t.at);
  if (at && (tag.startsWith('face:') || tag.endsWith(':floor'))) {
    const where = `${fmt(at[0])}, ${fmt(at[1])}`;
    actions.push({
      id: 'hole',
      label: `Drill hole at ${where}`,
      fields: [
        { key: 'd', label: 'Diameter', value: inches(1 / 2) },
        { key: 'depth', label: 'Depth', value: null, optional: true, placeholder: 'through' },
      ],
      run: (v) => [{ op: 'addFeature', part: part.id, feature: { type: 'hole', params: { face: tag, at, d: v.d!, ...(v.depth !== null && { depth: v.depth }) } } }],
    });
    actions.push({
      id: 'pocket',
      label: `Pocket at ${where}`,
      fields: [
        { key: 'w', label: 'Width', value: inches(2) },
        { key: 'h', label: 'Height', value: inches(1) },
        { key: 'r', label: 'Corner r', value: 0 },
        { key: 'depth', label: 'Depth', value: inches(1 / 4), optional: true, placeholder: 'through' },
      ],
      run: (v) => [
        {
          op: 'addFeature',
          part: part.id,
          feature: { type: 'pocket', params: { face: tag, at, size: [v.w!, v.h!], r: v.r ?? 0, ...(v.depth !== null && { depth: v.depth }) } },
        },
      ],
    });
  }

  // Corners: round or clip them.
  if (tag.startsWith('vertex:') && part.shape.type === 'box') {
    const edge = boxCornerEdge(part.shape.params as unknown as BoxParams, tag);
    if (edge) {
      actions.push(profileAction(part, [edge], 'roundover', 'round-corner', 'Round corner', inches(1 / 2)));
      actions.push(profileAction(part, [edge], 'chamfer', 'clip-corner', 'Clip corner', inches(1 / 2)));
      if (profiling(part, [edge]).length) actions.push({ id: 'sharp-corner', label: 'Sharp corner', fields: [], run: () => unprofileOps(part, [edge]) });
    }
  }
  if (tag.startsWith('vertex:') && part.shape.type === 'outline') {
    const i = outlinePointIndex(part, tag);
    const p = part.shape.params as unknown as OutlineParams;
    const pt = p.points[i];
    if (pt) {
      const edge = `edge:corner-${pt.id}`;
      const setR = (rr: number | undefined): Op => ({
        op: 'update',
        id: part.id,
        patch: { shape: { params: { points: p.points.map((q, k) => (k === i ? { ...q, r: rr } : q)) } } },
      });
      actions.push({
        id: 'corner-radius',
        label: pt.r ? 'Corner radius' : 'Round corner',
        fields: [{ key: 'r', label: 'Radius', value: pt.r ?? inches(1) }],
        run: (v) => [...unprofileOps(part, [edge]), setR(v.r!)],
      });
      actions.push({
        id: 'clip-corner',
        label: 'Clip corner',
        fields: [{ key: 'r', label: 'Size', value: inches(1 / 2) }],
        run: (v) => [...(pt.r ? [setR(undefined)] : []), ...unprofileOps(part, [edge]), { op: 'addFeature', part: part.id, feature: { type: 'edgeProfile', params: { edges: [edge], profile: 'chamfer', r: v.r! } } }],
      });
      if (pt.r || profiling(part, [edge]).length) {
        actions.push({ id: 'sharp-corner', label: 'Sharp corner', fields: [], run: () => [...(pt.r ? [setR(undefined)] : []), ...unprofileOps(part, [edge])] });
      }
    }
  }

  // Anything a feature made: take the feature off.
  const source = r.handle?.source ?? tag.split(':')[0];
  const feature = part.features.find((f) => f.id === source);
  if (feature) {
    const noun = feature.type === 'edgeProfile' ? String(feature.params.profile) : feature.type === 'pocket' && feature.params.depth === undefined ? 'cutout' : feature.type;
    actions.push({ id: 'remove-feature', label: `Remove this ${noun}`, fields: [], run: () => [{ op: 'removeFeature', part: part.id, feature: feature.id }] });
  }
  return actions;
}
