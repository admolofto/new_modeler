import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import type { Doc } from '../model/schema';
import { apply, frameBoxes, isSquare, nodeAffine, rotate, union, worldBoxes, type Affine, type Box3 } from '../model/world';
import type { Target } from './targets';

/**
 * Overall dimensions drawn in the viewport: width along the top front edge, height up the front
 * left edge, depth along the top right edge, each pushed out from the box by an offset that grows
 * with its size. World model units (1/64"). Pure: the renderer draws what this returns.
 */
export interface DimLine {
  /** Measured edge. */
  a: V3;
  b: V3;
  /** Unit direction the dimension line sits out from the edge. */
  out: V3;
  offset: number;
  value: number;
}

export function boxDimensions(box: Box3): DimLine[] {
  const { min, max } = box;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const offset = Math.round(96 + 0.04 * Math.max(...size));
  const lines: DimLine[] = [
    { a: [min[0], max[1], max[2]], b: [max[0], max[1], max[2]], out: [0, 1, 0], offset, value: size[0]! },
    { a: [min[0], min[1], max[2]], b: [min[0], max[1], max[2]], out: [-1, 0, 0], offset, value: size[1]! },
    { a: [max[0], max[1], min[2]], b: [max[0], max[1], max[2]], out: [1, 0, 0], offset, value: size[2]! },
  ];
  return lines.filter((l) => l.value > 0);
}

/** What to dimension: the selected parts / assemblies together, else the whole model's envelope. */
export function dimensionBoxes(doc: Doc, selected: readonly Target[], boxes = worldBoxes(doc)): Box3[] {
  const picked = [...new Set(selected.map((t) => t.node))].map((id) => boxes.get(id)).filter((b): b is Box3 => !!b);
  if (picked.length) return [union(picked)];
  const all = doc.roots.map((id) => boxes.get(id)).filter((b): b is Box3 => !!b);
  return all.length ? [union(all)] : [];
}

/**
 * The lines to draw: the selection's overall size, else the whole model's. A selection turned off
 * the world axes is measured along its own axes (an angled cabinet shows its real width, not its
 * bounding box), as long as its parts sit square to each other; otherwise along the world axes.
 */
export function dimensionLines(doc: Doc, selected: readonly Target[]): DimLine[] {
  const ids = [...new Set(selected.map((t) => t.node))].filter((id) => doc.parts[id] || doc.assemblies[id]);
  if (ids.length) {
    const own = nodeAffine(doc, ids[0]!);
    if (!isSquare(own.m)) {
      const frame: Affine = { m: own.m, t: [0, 0, 0] };
      const boxes = frameBoxes(doc, frame);
      const parts = ids.flatMap((id) => (doc.parts[id] ? [id] : descendants(doc, id).filter((c) => doc.parts[c])));
      const picked = parts.map((id) => boxes.get(id));
      if (picked.length && picked.every((b): b is Box3 => !!b)) return frameBoxDimensions(frame, union(picked));
    }
  }
  return dimensionBoxes(doc, selected).flatMap(boxDimensions);
}

/** Dimensions of a box given in a frame's coordinates, placed in the world. */
export function frameBoxDimensions(frame: Affine, box: Box3): DimLine[] {
  return boxDimensions(box).map((l) => ({ ...l, a: apply(frame, l.a), b: apply(frame, l.b), out: rotate(frame.m, l.out) }));
}
