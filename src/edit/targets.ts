import type { Handle, V3 } from '../geometry/types';
import type { AnnotationTarget, Doc, Part } from '../model/schema';
import { apply, localBox, nodeAffine, worldBoxes } from '../model/world';
import { buildPart, type BuiltPart } from '../plugins/pipeline';

/**
 * What the user points at: a node, optionally one of its semantic handles, optionally the
 * node-local point clicked. Selection, direct edits, notes and the AI all use this one shape
 * (ROADMAP rule 12). Pure: no Three.js.
 */
export type Target = AnnotationTarget;

/** Selection granularity. */
export type Mode = 'part' | 'face' | 'edge' | 'vertex';

export const targetKey = (t: Target): string => (t.handle ? `${t.node}/${t.handle}` : t.node);

/**
 * The floor, for notes about nothing on the model (or when there's no model yet). A pseudo-node:
 * its `at` is a world point (1/64") on Y = 0, and it's never selected or edited.
 */
export const GROUND = '_ground';
export const isGround = (t: Target) => t.node === GROUND;
/** Side of the square floor grid, in inches (centered on the origin). */
export const GROUND_INCHES = 144;

export interface ResolvedTarget {
  part: Part;
  built: BuiltPart;
  /** The part's declared handle for `target.handle`, if it has one. */
  handle?: Handle | undefined;
}

export function resolveTarget(doc: Doc, t: Target): ResolvedTarget | null {
  const part = doc.parts[t.node];
  if (!part) return null;
  let built: BuiltPart;
  try {
    built = buildPart(part);
  } catch {
    return null;
  }
  return { part, built, handle: t.handle ? built.handles.find((h) => h.id === t.handle) : undefined };
}

/** Face / edge / vertex, from the declared handle or else the id's prefix (`f1:wall` is a face). */
export function handleKind(id: string, handle?: Handle): Handle['kind'] {
  if (handle) return handle.kind;
  if (id.startsWith('edge:')) return 'edge';
  if (id.startsWith('vertex:')) return 'vertex';
  return 'face';
}

const centroid = (pts: V3[]): V3 => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k]!, 0) / pts.length) as V3;

/** Where a target sits in the world (1/64"): the clicked point, else the handle's center, else the node's center. */
export function targetPoint(doc: Doc, t: Target): V3 | null {
  if (isGround(t)) return t.at ? [...t.at] : [0, 0, 0];
  if (doc.assemblies[t.node]) {
    const b = worldBoxes(doc).get(t.node);
    return b ? centroid([b.min, b.max]) : null;
  }
  if (!doc.parts[t.node]) return null;
  const toWorld = (p: V3) => apply(nodeAffine(doc, t.node), p);
  if (t.at) return toWorld(t.at);
  const handle = resolveTarget(doc, t)?.handle;
  if (handle) return toWorld(centroid(handle.points));
  try {
    const b = localBox(doc, t.node);
    return toWorld(centroid([b.min, b.max]));
  } catch {
    return null;
  }
}

/** `Left side · face:left`, `Left side · dado for Bottom (floor)`, or `(missing p7)` for a stale target. */
export function describeTarget(doc: Doc, t: Target): string {
  if (isGround(t)) return 'Ground';
  const node = doc.parts[t.node] ?? doc.assemblies[t.node];
  if (!node) return `(missing ${t.node})`;
  if (!t.handle) return node.name;
  const [source, rest] = [t.handle.split(':')[0]!, t.handle.slice(t.handle.indexOf(':') + 1)];
  const cut = doc.parts[t.node]?.joinery?.find((c) => c.id === source);
  const joint = cut && doc.joints[cut.joint];
  if (joint) return `${node.name} · ${joint.type} for ${doc.parts[joint.parts[1]]?.name ?? joint.parts[1]} (${rest})`;
  return `${node.name} · ${t.handle}`;
}
