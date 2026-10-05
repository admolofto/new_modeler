import { motions, type MotionBasis } from '../plugins';
import { ModelError, movingParts, parentIndex } from './doc';
import type { Doc, Motion } from './schema';
import { affineOf, allAffines, composeAffine, IDENTITY, invertAffine, localBox, transformBox, union, type Affine, type Box3 } from './world';

/**
 * Motions (how doors, drawers and lids open), worked out from the doc: which one moves a node,
 * where its parts sit in its frame, and the move at any open amount. Pure, and memoized per doc
 * (docs never change once made). How far each one is open is a view, kept by ui/motionPlayer.ts.
 */

function memo<T>(cache: WeakMap<Doc, T>, doc: Doc, make: () => T): T {
  let hit = cache.get(doc);
  if (hit === undefined) cache.set(doc, (hit = make()));
  return hit;
}

const indexes = new WeakMap<Doc, Map<string, Motion>>();
const worlds = new WeakMap<Doc, Map<string, Affine>>();
const bases = new WeakMap<Doc, Map<string, MotionBasis>>();

/** Node id → the motion that moves it (each node is in at most one). */
export function motionIndex(doc: Doc): Map<string, Motion> {
  return memo(indexes, doc, () => {
    const out = new Map<string, Motion>();
    for (const m of Object.values(doc.motions)) for (const id of m.nodes) out.set(id, m);
    return out;
  });
}

/** The motion that moves this node, or else the nearest one moving a folder it's in (it rides along). */
export function motionOf(doc: Doc, nodeId: string): Motion | null {
  const index = motionIndex(doc);
  const parents = parentIndex(doc);
  for (let cur: string | null | undefined = nodeId; cur; cur = parents.get(cur)) {
    const m = index.get(cur);
    if (m) return m;
  }
  return null;
}

/** What it's called in lists: its name, else its first node's. */
export function motionName(doc: Doc, m: Motion): string {
  const first = m.nodes[0]!;
  return m.name ?? (doc.parts[first] ?? doc.assemblies[first])?.name ?? first;
}

/** "hinges left, opens 105°". */
export function motionSummary(m: Motion): string {
  return motions.has(m.type) ? motions.get(m.type).summary(m.params) : m.type;
}

/** How far open over time: eases in and out (cubic), 0 … 1 → 0 … 1. */
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Seconds a full open takes. */
export function motionSeconds(m: Motion): number {
  return motions.has(m.type) ? motions.get(m.type).seconds(m.params) : 0.8;
}

/** Where a motion's parts sit in its frame (its first node's local frame): each part's box and their union. */
export function motionBasis(doc: Doc, m: Motion): MotionBasis {
  const byId = memo(bases, doc, () => new Map<string, MotionBasis>());
  const hit = byId.get(m.id);
  if (hit) return hit;
  const world = memo(worlds, doc, () => allAffines(doc));
  const frame = world.get(m.nodes[0]!);
  if (!frame) throw new ModelError(`motion ${m.id}: "${m.nodes[0]}" isn't in the model`);
  const toFrame = invertAffine(frame);
  const parts: Box3[] = [];
  for (const id of movingParts(doc, m.nodes)) {
    const placed = world.get(id);
    if (placed) parts.push(transformBox(composeAffine(toFrame, placed), localBox(doc, id)));
  }
  if (!parts.length) throw new ModelError(`motion ${m.id} has no parts to move`);
  const basis = { box: union(parts), parts };
  byId.set(m.id, basis);
  return basis;
}

/**
 * The move at `t` (0 closed … 1 open), in the frame of the motion's nodes' parent: each node's drawn
 * transform is this after its own. Throws PluginError when the parts can't move that way.
 */
export function motionDelta(doc: Doc, m: Motion, t: number): Affine {
  if (t <= 0) return IDENTITY;
  const first = doc.parts[m.nodes[0]!] ?? doc.assemblies[m.nodes[0]!];
  if (!first) throw new ModelError(`motion ${m.id}: "${m.nodes[0]}" isn't in the model`);
  const own = affineOf(first.transform);
  const pose = motions.get(m.type).pose(m.params, motionBasis(doc, m), Math.min(1, t));
  return composeAffine(composeAffine(own, pose), invertAffine(own));
}

/** World frames of a motion's parts at `t` (everything else stays where it is). */
export function movedAffines(doc: Doc, m: Motion, t: number): Map<string, Affine> {
  const world = memo(worlds, doc, () => allAffines(doc));
  const parent = parentIndex(doc).get(m.nodes[0]!);
  const P = parent ? world.get(parent)! : IDENTITY;
  const move = composeAffine(composeAffine(P, motionDelta(doc, m, t)), invertAffine(P));
  const out = new Map<string, Affine>();
  for (const id of movingParts(doc, m.nodes)) out.set(id, composeAffine(move, world.get(id)!));
  return out;
}

/**
 * Keeps motions in step with the tree after a change: deleted nodes drop out of user motions (an
 * emptied one goes), and a generated one missing any of its parts goes (regenerating rebuilds it).
 */
export function pruneMotions(d: Doc): void {
  for (const m of Object.values(d.motions)) {
    const nodes = m.nodes.filter((id) => d.parts[id] || d.assemblies[id]);
    if (nodes.length === m.nodes.length) continue;
    if (m.role !== undefined || !nodes.length) delete d.motions[m.id];
    else m.nodes = nodes;
  }
}
