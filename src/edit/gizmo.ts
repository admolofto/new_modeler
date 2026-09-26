import type { V3 } from '../geometry/types';
import { descendants, parentIndex } from '../model/doc';
import { generatedOwner } from '../model/generate';
import type { Doc } from '../model/schema';
import { apply, frameBoxes, nodeAffine, union, worldBoxes, type Affine, type Box3 } from '../model/world';
import type { Target } from './targets';

/**
 * What the move / turn gizmo acts on, and where it sits. Pure. The gizmo moves whole pieces: a
 * selection that is all of an assembly's parts moves the assembly, a generated part moves its
 * cabinet (moving one side on its own is never what's meant), and anything else moves as picked.
 */

/** Nodes the gizmo moves for a selection of whole parts, or null (faces, edges… or nothing). */
export function gizmoNodes(doc: Doc, targets: readonly Target[]): string[] | null {
  if (!targets.length || targets.some((t) => t.handle || !doc.parts[t.node])) return null;
  const parents = parentIndex(doc);
  const picked = new Set(targets.map((t) => t.node));
  // The biggest assembly the selection is exactly all the parts of (a cabinet or a piece picked whole).
  let whole: string | null = null;
  for (let p = parents.get(targets[0]!.node); p; p = parents.get(p)) {
    const parts = descendants(doc, p).filter((id) => doc.parts[id]);
    if (parts.length === picked.size && parts.every((id) => picked.has(id))) whole = p;
    else if (parts.length > picked.size) break;
  }
  if (whole) return [whole];
  const ids = [...new Set(targets.map((t) => generatedOwner(doc, t.node)?.id ?? t.node))];
  // Leave out what moves with an ancestor already in the list.
  const inList = new Set(ids);
  return ids.filter((id) => {
    for (let p = parents.get(id); p; p = parents.get(p)) if (inList.has(p)) return false;
    return true;
  });
}

/** Selection targets for nodes: a part itself, or all of an assembly's parts (so it's picked whole). */
export function targetsOf(doc: Doc, ids: readonly string[]): Target[] {
  return ids.flatMap((id) => (doc.parts[id] ? [{ node: id }] : descendants(doc, id).filter((c) => doc.parts[c]).map((node) => ({ node }))));
}

/** Every part that moves with these nodes. */
export function movingParts(doc: Doc, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (doc.parts[id]) out.add(id);
    for (const c of descendants(doc, id)) if (doc.parts[c]) out.add(c);
  }
  return out;
}

export interface GizmoPlace {
  /** The first node's orientation (the gizmo's axes), with no offset: frame coordinates = its rotation's inverse applied to world ones. */
  frame: Affine;
  /** World center of what moves (the turning pivot). */
  pivot: V3;
  /** What moves, in the frame; null when some of it isn't square to the frame (then nothing snaps). */
  box: Box3 | null;
  /** The other parts square to the frame, in its coordinates (what moves snaps to them). */
  others: Map<string, Box3>;
  /** Every part square to the frame, what moves included (a copy snaps to its original too). */
  all: Map<string, Box3>;
  /** Whether the frame's y axis points straight up (the floor is then y = 0 in it). */
  upright: boolean;
}

/** Where the gizmo goes for these nodes and what their moves can snap to. */
export function gizmoPlace(doc: Doc, ids: readonly string[]): GizmoPlace | null {
  if (!ids.length) return null;
  const frame: Affine = { m: nodeAffine(doc, ids[0]!).m, t: [0, 0, 0] };
  const moving = movingParts(doc, ids);
  if (!moving.size) return null;
  const all = frameBoxes(doc, frame);
  const mine = [...moving].map((id) => all.get(id));
  const box = mine.every((b): b is Box3 => !!b) ? union(mine) : null;
  let pivot: V3;
  if (box) {
    pivot = apply(frame, [0, 1, 2].map((k) => (box.min[k]! + box.max[k]!) / 2) as V3);
  } else {
    const w = worldBoxes(doc);
    const u = union([...moving].flatMap((id) => w.get(id) ?? []));
    pivot = [0, 1, 2].map((k) => (u.min[k]! + u.max[k]!) / 2) as V3;
  }
  const others = new Map([...all].filter(([id]) => !moving.has(id)));
  return { frame, pivot, box, others, all, upright: Math.abs(frame.m[1][1] - 1) < 1e-9 };
}
