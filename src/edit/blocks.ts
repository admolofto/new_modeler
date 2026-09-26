import type { V3 } from '../geometry/types';
import { descendants, parentIndex } from '../model/doc';
import type { Op } from '../model/ops';
import type { Doc, Part, Transform } from '../model/schema';
import { apply, axisRotation, eulerXYZ, frameBoxes, localBox, mul, nodeAffine, normalizeAngle, rotate, rotateAbout, rotation, transpose, union, type Affine, type Box3 } from '../model/world';

/**
 * Blocks (blockout placeholders): where a drawn block goes, and the ops that move, turn and split
 * nodes. A block's frame is the frame of what it stands for — local +Z is its front — so the AI can
 * build a cabinet in exactly its space with the same position, rotation and size. Pure.
 */

/** Grid for drawing, moving and resizing blocks: 1/2" (rough layouts don't need 1/16"). */
export const BLOCK_STEP = 32;

/** Front directions for 0–3 quarter turns about a frame's y axis: +Z, +X, −Z, −X. */
const FRONTS: V3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 0, -1],
  [-1, 0, 0],
];

/** Quarter turns (about the frame's y axis) that face a block toward a world direction. */
export function facingToward(frame: Affine, dir: V3): number {
  const d = rotate(transpose(frame.m), dir);
  let best = 0;
  FRONTS.forEach((f, i) => {
    if (d[0] * f[0] + d[2] * f[2] > d[0] * FRONTS[best]![0] + d[2] * FRONTS[best]![2]) best = i;
  });
  return best;
}

/** Quarter turns that face a block out of a vertical face whose normal is `sign` along frame axis `k` (0 or 2). */
export function facingOut(k: 0 | 2, sign: 1 | -1): number {
  return FRONTS.findIndex((f) => f[k] === sign);
}

/**
 * The block filling `box` (frame coordinates) with its front turned `turns` quarter turns about the
 * frame's y axis from the frame's +Z. The frame is the floor's (world) or a part's, when drawing on
 * one of its faces. Top-level transform (blocks are drawn at the top of the tree).
 */
export function blockPlacement(frame: Affine, box: Box3, turns: number): { transform: Transform; size: V3 } {
  const turn = axisRotation([0, 1, 0], 90 * (((turns % 4) + 4) % 4));
  const size: V3 = [0, 0, 0];
  const origin: V3 = [0, 0, 0];
  for (const j of [0, 1, 2] as const) {
    // Local axis j in frame coordinates: a signed frame axis.
    const col: V3 = [turn[0][j]!, turn[1][j]!, turn[2][j]!];
    const k = ([0, 1, 2] as const).find((i) => Math.abs(col[i]) > 0.5)!;
    size[j] = box.max[k] - box.min[k];
    origin[k] = col[k] > 0 ? box.min[k] : box.max[k];
  }
  return {
    transform: { position: apply(frame, origin).map(Math.round) as V3, rotation: eulerXYZ(mul(frame.m, turn)) },
    size,
  };
}

/** World direction a node's front (local +Z) faces. */
export const frontOf = (doc: Doc, id: string): V3 => rotate(nodeAffine(doc, id).m, [0, 0, 1]);

/** `+x`, `-z`… for a direction along a world axis, else the rounded vector. */
export function directionText(d: V3): string | V3 {
  const k = [0, 1, 2].find((i) => Math.abs(d[i]!) > 1 - 1e-6);
  if (k !== undefined) return `${d[k]! > 0 ? '+' : '-'}${'xyz'[k]}`;
  return d.map((c) => Math.round(c * 1000) / 1000) as V3;
}

/** The world offset of a node's parent frame: world deltas → parent-local ones. */
function parentFrame(doc: Doc, id: string): Affine | null {
  const p = parentIndex(doc).get(id);
  return p ? nodeAffine(doc, p) : null;
}

/** Moves nodes by a world displacement (model units). */
export function moveOps(doc: Doc, ids: readonly string[], delta: V3): Op[] {
  return ids.flatMap((id): Op[] => {
    const node = doc.parts[id] ?? doc.assemblies[id];
    if (!node) return [];
    const P = parentFrame(doc, id);
    const d = P ? rotate(transpose(P.m), delta) : delta;
    const to = node.transform.position.map((c, i) => Math.round(c + d[i]!)) as V3;
    return to.some((c, i) => c !== node.transform.position[i]) ? [{ op: 'move', id, to }] : [];
  });
}

/** A node's center in its own frame: a part's bounds, or those of an assembly's parts (the ones square to it). */
export function localCenter(doc: Doc, id: string): V3 | null {
  let box: Box3;
  if (doc.parts[id]) {
    try {
      box = localBox(doc, id);
    } catch {
      return null;
    }
  } else {
    if (!doc.assemblies[id]) return null;
    const boxes = frameBoxes(doc, nodeAffine(doc, id));
    const mine = descendants(doc, id).flatMap((c) => boxes.get(c) ?? []);
    if (!mine.length) return null;
    box = union(mine);
  }
  return [0, 1, 2].map((k) => (box.min[k]! + box.max[k]!) / 2) as V3;
}

/** A node's center in world coordinates (the gizmo's pivot). */
export function worldCenter(doc: Doc, id: string): V3 | null {
  const c = localCenter(doc, id);
  return c && apply(nodeAffine(doc, id), c);
}

/** Sets a node's rotation (degrees, XYZ), turning it about its center so it stays where it is. */
export function setRotationOps(doc: Doc, id: string, rot: V3): Op[] {
  const node = doc.parts[id] ?? doc.assemblies[id];
  if (!node) return [];
  const next = rot.map(normalizeAngle) as V3;
  const c = localCenter(doc, id);
  if (!c) return [{ op: 'move', id, rotation: next }];
  const [a, b] = [rotate(rotation(node.transform.rotation), c), rotate(rotation(next), c)];
  const to = node.transform.position.map((v, i) => Math.round(v + a[i]! - b[i]!)) as V3;
  return [{ op: 'move', id, to, rotation: next }];
}

/** Turns nodes `deg` about a world axis through a world pivot. */
export function turnOps(doc: Doc, ids: readonly string[], pivot: V3, axis: V3, deg: number): Op[] {
  return ids.flatMap((id): Op[] => {
    if (!doc.parts[id] && !doc.assemblies[id]) return [];
    const t = rotateAbout(doc, id, pivot, axis, deg);
    return [{ op: 'move', id, to: t.position, rotation: t.rotation }];
  });
}

/** A block's size along its own axes. */
export const blockSize = (part: Part): V3 => {
  const p = part.shape.params as { x: number; y: number; z: number };
  return [p.x, p.y, p.z];
};

const PARAM = ['x', 'y', 'z'] as const;

/**
 * Cuts a block across its axis `k` at `at` (from its min face) into two blocks: it keeps the first
 * piece and its name; the rest becomes a new block beside it, with the next default name.
 */
export function splitOps(doc: Doc, id: string, k: 0 | 1 | 2, at: number): Op[] {
  return splitManyOps(doc, id, k, [at]);
}

/** Cuts a block into `n` equal pieces along its axis `k` (sizes differ by at most 1/64"). */
export function splitEvenOps(doc: Doc, id: string, k: 0 | 1 | 2, n: number): Op[] {
  const part = doc.parts[id];
  if (!part?.block || n < 2) return [];
  const size = blockSize(part)[k];
  const cuts = Array.from({ length: n - 1 }, (_, i) => Math.round((size * (i + 1)) / n));
  return splitManyOps(doc, id, k, cuts);
}

function splitManyOps(doc: Doc, id: string, k: 0 | 1 | 2, cuts: number[]): Op[] {
  const part = doc.parts[id];
  if (!part?.block) return [];
  const size = blockSize(part);
  const at = [...new Set(cuts)].filter((c) => c > 0 && c < size[k]).sort((a, b) => a - b);
  if (!at.length) return [];
  const R = rotation(part.transform.rotation);
  const parent = parentIndex(doc).get(id) ?? null;
  const index = (parent ? doc.assemblies[parent]!.children : doc.roots).indexOf(id);
  const ops: Op[] = [{ op: 'update', id, patch: { shape: { params: { [PARAM[k]]: at[0]! } } } }];
  at.forEach((from, i) => {
    const to = at[i + 1] ?? size[k];
    const shift: V3 = [0, 0, 0];
    shift[k] = from;
    const piece: V3 = [...size];
    piece[k] = to - from;
    ops.push({
      op: 'add',
      entity: {
        kind: 'block',
        transform: { position: part.transform.position.map((c, j) => Math.round(c + rotate(R, shift)[j]!)) as V3, rotation: [...part.transform.rotation] },
        size: piece,
      },
      parent,
      index: index + 1 + i,
    });
  });
  return ops;
}
