import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import type { Doc } from '../model/schema';
import { hiddenNodes } from '../model/visibility';
import { apply, boxSize, frameBoxes, isSquare, nodeAffine, rotate, union, worldBoxes, type Affine, type Box3 } from '../model/world';
import type { Target } from './targets';

/**
 * Overall dimensions drawn in the viewport: width along the top front edge, height up the front
 * left edge, depth along the top right edge, each pushed out from the box by an offset that grows
 * with its size. A footprint that steps (an L, a U, a deeper cabinet in a run) also gets its legs'
 * sizes, in a row between the model and the overall size. World model units (1/64"). Pure: the
 * renderer draws what this returns.
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

const offsetFor = (box: Box3) => Math.round(96 + 0.04 * Math.max(...boxSize(box)));

export function boxDimensions(box: Box3): DimLine[] {
  const { min, max } = box;
  const size = boxSize(box);
  const offset = offsetFor(box);
  const lines: DimLine[] = [
    { a: [min[0], max[1], max[2]], b: [max[0], max[1], max[2]], out: [0, 1, 0], offset, value: size[0] },
    { a: [min[0], min[1], max[2]], b: [min[0], max[1], max[2]], out: [-1, 0, 0], offset, value: size[1] },
    { a: [max[0], max[1], min[2]], b: [max[0], max[1], max[2]], out: [1, 0, 0], offset, value: size[2] },
  ];
  return lines.filter((l) => l.value > 0);
}

/** Steps and slivers in a footprint smaller than this (an overhang, a door's thickness, a reveal) aren't legs: 1 1/2". */
const STEP = 96;

/**
 * A stretch of one side of a footprint, seen from outside, along the measured axis: how far out the
 * footprint reaches there (signed, so further out is bigger on either side), or null across a gap.
 */
interface Run {
  from: number;
  to: number;
  reach: number | null;
}

const reachOf = (b: Box3, j: number, s: 1 | -1) => (s > 0 ? b.max[j]! : -b.min[j]!);
const spans = (b: Box3, k: number, from: number, to: number) => b.min[k]! < to && b.max[k]! > from;

/** The side of a footprint facing `s` along axis `j`, as runs along axis `k`, with steps and slivers under STEP merged away. */
function sideRuns(boxes: Box3[], k: number, j: number, s: 1 | -1): Run[] {
  const cuts = [...new Set(boxes.flatMap((b) => [b.min[k]!, b.max[k]!]))].sort((p, q) => p - q);
  let runs: Run[] = cuts.slice(1).map((to, i) => {
    const from = cuts[i]!;
    const over = boxes.filter((b) => spans(b, k, from, to));
    return { from, to, reach: over.length ? Math.max(...over.map((b) => reachOf(b, j, s))) : null };
  });
  const near = (p: number | null, q: number | null) => (p === null || q === null ? (p === q ? 0 : Infinity) : Math.abs(p - q));
  const merge = () => {
    const out: Run[] = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (!last || near(last.reach, r.reach) >= STEP) out.push({ ...r });
      else {
        last.to = r.to;
        if (last.reach !== null) last.reach = Math.max(last.reach, r.reach!);
      }
    }
    runs = out;
  };
  merge();
  // A sliver (a reveal, a panel seen edge on) joins the neighbor nearest its reach.
  for (;;) {
    const thin = runs.filter((r) => r.to - r.from < STEP);
    if (runs.length < 2 || !thin.length) return runs;
    const r = thin.reduce((p, q) => (q.to - q.from < p.to - p.from ? q : p));
    const i = runs.indexOf(r);
    const [prev, next] = [runs[i - 1], runs[i + 1]];
    const into = !prev ? next! : !next ? prev : near(prev.reach, r.reach) <= near(next.reach, r.reach) ? prev : next;
    into.from = Math.min(into.from, r.from);
    into.to = Math.max(into.to, r.to);
    runs.splice(i, 1);
    merge();
  }
}

/** One leg's size along a side of a footprint: the span on axis `k`, the side's coordinate on axis `j`, and the leg's top. */
interface Leg {
  from: number;
  to: number;
  at: number;
  top: number;
}

/**
 * One side of a footprint: its legs — each stretch reaching the side's outer edge (a leg's end), and
 * each gap or recess between two of them (an opening); none when the side is straight — and whether
 * it starts and ends on the model, so a line along it has real corners to measure from.
 */
interface Side {
  s: 1 | -1;
  legs: Leg[];
  anchored: boolean;
}

function side(boxes: Box3[], k: number, j: number, s: 1 | -1): Side {
  const runs = sideRuns(boxes, k, j, s);
  const edge = Math.max(...runs.map((r) => r.reach ?? -Infinity));
  const outer = (r: Run | undefined) => !!r && r.reach !== null && r.reach > edge - STEP;
  // The top of what reaches the edge there, so a base cabinet's leg isn't measured up at a tall one's top.
  const top = (r: Run) => Math.max(...boxes.filter((b) => spans(b, k, r.from, r.to) && reachOf(b, j, s) > edge - STEP).map((b) => b.max[1]!));
  // A gap with something set back beyond it: separate pieces (a door leaning nearby), not legs of one footprint.
  const apart = runs.some((r, i) => r.reach === null && !(outer(runs[i - 1]) && outer(runs[i + 1])));
  const legs = runs.length < 2 || apart ? [] : runs.flatMap((r, i): Leg[] => {
    const [prev, next] = [runs[i - 1], runs[i + 1]];
    if (outer(r)) return [{ from: r.from, to: r.to, at: s * edge, top: top(r) }];
    if (outer(prev) && outer(next)) return [{ from: r.from, to: r.to, at: s * edge, top: Math.min(top(prev!), top(next!)) }];
    return [];
  });
  return { s, legs, anchored: outer(runs[0]) && outer(runs[runs.length - 1]) };
}

/**
 * Dimensions of a footprint made of boxes (one frame's coordinates): width, height and depth, and the
 * legs along a side that steps — an L shows each leg's depth across its end. Legs go along the front
 * or right first; the overall size then moves to the opposite side when that one starts and ends on
 * the model (the wall side of an L or a U), else out past the legs.
 */
export function footprintDimensions(boxes: Box3[]): DimLine[] {
  if (!boxes.length) return [];
  const env = union(boxes);
  const { min, max } = env;
  const size = boxSize(env);
  const offset = offsetFor(env);
  // A point `t` along axis k, at `c` on the other horizontal axis, `y` up; lines across x sit above, along z beside.
  const point = (k: number, t: number, c: number, y: number): V3 => (k === 0 ? [t, y, c] : [c, y, t]);
  const out = (k: number, s: 1 | -1): V3 => (k === 0 ? [0, 1, 0] : [s, 0, 0]);
  const plan = (k: 0 | 2): DimLine[] => {
    const j = 2 - k;
    const [near, far] = [side(boxes, k, j, 1), side(boxes, k, j, -1)];
    const legs = near.legs.length ? near : far.legs.length ? far : null;
    const total = legs === near && far.anchored ? far : near;
    const at = total.s > 0 ? max[j]! : min[j]!;
    return [
      { a: point(k, min[k], at, max[1]), b: point(k, max[k], at, max[1]), out: out(k, total.s), offset: legs === total ? 2 * offset : offset, value: size[k] },
      ...(legs?.legs ?? []).map((l): DimLine => ({ a: point(k, l.from, l.at, l.top), b: point(k, l.to, l.at, l.top), out: out(k, legs!.s), offset, value: l.to - l.from })),
    ];
  };
  // Up the front-left corner of what stands full height: not the missing corner of an L, nor a base cabinet beside a tall one.
  const full = boxes.filter((b) => b.min[1]! < min[1] + STEP && b.max[1]! > max[1] - STEP);
  const tall = full.length ? full : boxes;
  const x = Math.min(...tall.map((b) => b.min[0]!));
  const z = Math.max(...tall.filter((b) => b.min[0]! < x + STEP).map((b) => b.max[2]!));
  const lines = [...plan(0), { a: [x, min[1], z], b: [x, max[1], z], out: [-1, 0, 0], offset, value: size[1] } satisfies DimLine, ...plan(2)];
  return lines.filter((l) => l.value > 0);
}

/** The parts to dimension, as world boxes: the selected parts and assemblies' parts, else every part. Hidden ones are left out. */
function dimensionParts(doc: Doc, selected: readonly Target[], boxes = worldBoxes(doc)): Box3[] {
  const hidden = hiddenNodes(doc);
  const parts = selected.flatMap((t) => doc.parts[t.node] ? [t.node] : descendants(doc, t.node));
  const picked = [...new Set(parts)].filter((id) => doc.parts[id] && !hidden.has(id)).map((id) => boxes.get(id)).filter((b): b is Box3 => !!b);
  if (picked.length) return picked;
  return Object.keys(doc.parts).filter((id) => !hidden.has(id)).map((id) => boxes.get(id)).filter((b): b is Box3 => !!b);
}

/** What to dimension: the selected parts / assemblies together, else the whole model's envelope. */
export function dimensionBoxes(doc: Doc, selected: readonly Target[], boxes = worldBoxes(doc)): Box3[] {
  const parts = dimensionParts(doc, selected, boxes);
  return parts.length ? [union(parts)] : [];
}

/**
 * The lines to draw: the selection's size, else the whole model's. A selection turned off the world
 * axes is measured along its own axes (an angled cabinet shows its real width, not its bounding
 * box), as long as its parts sit square to each other; otherwise along the world axes.
 */
export function dimensionLines(doc: Doc, selected: readonly Target[]): DimLine[] {
  const hidden = hiddenNodes(doc);
  const ids = [...new Set(selected.map((t) => t.node))].filter((id) => !hidden.has(id) && (doc.parts[id] || doc.assemblies[id]));
  if (ids.length) {
    const own = nodeAffine(doc, ids[0]!);
    if (!isSquare(own.m)) {
      const frame: Affine = { m: own.m, t: [0, 0, 0] };
      const boxes = frameBoxes(doc, frame);
      const parts = ids.flatMap((id) => (doc.parts[id] ? [id] : descendants(doc, id).filter((c) => doc.parts[c])));
      const picked = parts.filter((id) => !hidden.has(id)).map((id) => boxes.get(id));
      if (picked.length && picked.every((b): b is Box3 => !!b)) return footprintDimensions(picked).map((l) => placed(frame, l));
    }
  }
  return footprintDimensions(dimensionParts(doc, selected));
}

/** A line measured in a frame's coordinates, placed in the world. */
const placed = (frame: Affine, l: DimLine): DimLine => ({ ...l, a: apply(frame, l.a), b: apply(frame, l.b), out: rotate(frame.m, l.out) });

/** Dimensions of a box given in a frame's coordinates, placed in the world. */
export function frameBoxDimensions(frame: Affine, box: Box3): DimLine[] {
  return boxDimensions(box).map((l) => placed(frame, l));
}
