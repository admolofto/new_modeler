import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import type { Doc } from '../model/schema';
import { frameBoxes, nodeAffine, type Box3 } from '../model/world';
import { buildPart } from '../plugins/pipeline';
import { WORDS } from '../plugins/shapes/box';
import type { HandleDrives } from './drives';
import { GROUND } from './targets';

/**
 * Snapping (inference) for every gesture: pushing a face, dragging a point, moving something,
 * drawing or splitting a block. Candidates near the raw value win over the grid — flush with another
 * part's face ("align to edge"), a size equal to another part's ("match length"), in line with a
 * corner. Everything works in one frame: the edited part's own axes (or the drawing plane's), so it
 * snaps at any angle to the parts square to it — `frameBoxes` gives their bounds in that frame.
 * Candidates within `tol` (model units, from a few screen pixels) of the raw value win; the closest
 * one wins, lower rank first on ties. Pure.
 */

export interface Snap {
  /** Snapped value (model units). */
  s: number;
  label: string;
  /** The part or assembly it snapped to (highlighted while dragging); GROUND for the floor. */
  node: string;
}

interface Cand extends Snap {
  rank: number;
}

const DIM = ['width', 'height', 'depth'];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nameOf = (doc: Doc, id: string) => doc.parts[id]?.name ?? doc.assemblies[id]?.name ?? id;

/** The candidate nearest `raw` within `tol`; ties go to `prefer`'s node, then the lower rank. */
function closest(cands: readonly Cand[], raw: number, tol: number, prefer?: string): Snap | null {
  let best: (Cand & { d: number }) | null = null;
  const favored = (c: Cand) => (prefer !== undefined && c.node === prefer ? 0 : 1);
  for (const c of cands) {
    const d = Math.abs(c.s - raw);
    if (!Number.isFinite(c.s) || d > tol) continue;
    const tie = best && Math.abs(d - best.d) < 1e-9;
    if (!best || (!tie && d < best.d) || (tie && (favored(c) - favored(best) || c.rank - best.rank) < 0)) best = { ...c, d };
  }
  return best && { s: Math.round(best.s), label: best.label, node: best.node };
}

/** The frame axis a direction runs along, if it runs along one. */
function axisOf(dir: V3): { k: 0 | 1 | 2; sign: 1 | -1 } | null {
  const k = ([0, 1, 2] as const).find((i) => Math.abs(dir[i]) > 1 - 1e-9);
  return k === undefined ? null : { k, sign: dir[k] > 0 ? 1 : -1 };
}

/** Bounds of the parts square to a part, in its own frame (what its drags snap to). */
export const partFrameBoxes = (doc: Doc, partId: string): Map<string, Box3> => frameBoxes(doc, nodeAffine(doc, partId));

/** Nodes that move with the drag (the part; for a generator drive, its whole assembly). */
function moving(doc: Doc, hd: HandleDrives): Set<string> {
  const out = new Set([hd.part.id]);
  for (const d of hd.drives) {
    if (d.owner.kind !== 'generator') continue;
    out.add(d.owner.asm);
    for (const id of descendants(doc, d.owner.asm)) out.add(id);
  }
  return out;
}

function others(doc: Doc, hd: HandleDrives, boxes: Map<string, Box3>): [string, Box3][] {
  const skip = moving(doc, hd);
  return [...boxes].filter(([id]) => doc.parts[id] && !skip.has(id));
}

/**
 * Inference for a drag along a part-local line (a face push / pull); `raw` is the unsnapped
 * displacement, `boxes` the other parts in the part's frame (`partFrameBoxes`).
 */
export function inferLine(doc: Doc, hd: HandleDrives, dir: V3, raw: number, tol: number, boxes = partFrameBoxes(doc, hd.part.id)): Snap | null {
  const axis = axisOf(dir);
  if (!axis) return null;
  const { k, sign } = axis;
  const p0 = hd.handle.points[0]![k];
  const linear = hd.drives.filter((d) => d.axis && Math.abs(dot(d.axis, dir)) > 1e-9);
  const drive = linear.length === 1 ? linear[0]! : null;
  const g = drive ? dot(drive.axis!, dir) : 0;
  const cands: Cand[] = [];
  for (const [id, b] of others(doc, hd, boxes)) {
    const name = nameOf(doc, id);
    for (const [c, max] of [[b.min[k], false], [b.max[k], true]] as const) {
      cands.push({ s: sign * (c - p0), label: `flush with ${name} ${WORDS[k][max ? 1 : 0]}`, node: id, rank: 0 });
    }
    if (drive && drive.value > 0) cands.push({ s: (b.max[k] - b.min[k] - drive.value) / g, label: `${drive.label} = ${name} ${DIM[k]}`, node: id, rank: 1 });
  }
  return closest(cands, raw, tol);
}

/**
 * Inference for a drag in a part-local plane (an outline point, a hole center): each in-plane axis
 * snaps on its own — in line with the part's other corners, or flush with another part's face.
 */
export function inferPlane(
  doc: Doc,
  hd: HandleDrives,
  u: V3,
  v: V3,
  raw: [number, number],
  tol: number,
  boxes = partFrameBoxes(doc, hd.part.id),
): { s: [number, number]; labels: string[]; nodes: string[] } {
  const start = hd.handle.points[0]!;
  // The part's other corners in the dragged point's plane (not its twins on the far face).
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const corners = buildPart(hd.part).handles.filter((h) => {
    const p = h.points[0]!;
    return h.kind === 'vertex' && Math.abs(dot(p, n) - dot(start, n)) < 1e-6 && (dot(p, u) !== dot(start, u) || dot(p, v) !== dot(start, v));
  });
  const out: [number, number] = [raw[0], raw[1]];
  const labels: string[] = [];
  const nodes: string[] = [];
  ([u, v] as V3[]).forEach((dir, i) => {
    const cands: Cand[] = corners.map((h) => ({ s: dot(h.points[0]!, dir) - dot(start, dir), label: `in line with ${h.id.replace('vertex:', '')}`, node: hd.part.id, rank: 0 }));
    const axis = axisOf(dir);
    if (axis) {
      for (const [id, b] of others(doc, hd, boxes)) {
        for (const [c, max] of [[b.min[axis.k], false], [b.max[axis.k], true]] as const) {
          cands.push({ s: axis.sign * (c - start[axis.k]), label: `flush with ${nameOf(doc, id)} ${WORDS[axis.k][max ? 1 : 0]}`, node: id, rank: 0 });
        }
      }
    }
    const best = closest(cands, raw[i]!, tol);
    if (best) {
      out[i] = best.s;
      labels.push(best.label);
      nodes.push(best.node);
    }
  });
  return { s: out, labels, nodes };
}

/**
 * Inference for moving something along axis `k` of a frame (the moved node's own, so it works at
 * any angle): its bounds `box` go against other parts, in line with their faces or centered on them,
 * or onto the floor. `boxes` = the other parts in the frame (leave the moving ones out); `floor` =
 * the floor's coordinate along the frame's y axis, when that axis is straight up.
 */
export function inferMove(doc: Doc, k: 0 | 1 | 2, box: Box3, raw: number, tol: number, boxes: Map<string, Box3>, floor?: number): Snap | null {
  const cands: Cand[] = [];
  const mid = (b: Box3) => (b.min[k] + b.max[k]) / 2;
  for (const [id, b] of boxes) {
    const name = nameOf(doc, id);
    cands.push(
      { s: b.min[k] - box.max[k], label: `against ${name}`, node: id, rank: 0 },
      { s: b.max[k] - box.min[k], label: `against ${name}`, node: id, rank: 0 },
      { s: b.min[k] - box.min[k], label: `in line with ${name} ${WORDS[k][0]}`, node: id, rank: 1 },
      { s: b.max[k] - box.max[k], label: `in line with ${name} ${WORDS[k][1]}`, node: id, rank: 1 },
      { s: mid(b) - mid(box), label: `centered on ${name}`, node: id, rank: 2 },
    );
  }
  if (floor !== undefined && k === 1) cands.push({ s: floor - box.min[1], label: 'on the floor', node: GROUND, rank: 0 });
  return closest(cands, raw, tol);
}

/**
 * Inference for a point drawn on a plane of a frame (the floor, or a part's face): each in-plane axis
 * lines up on its own with other parts' faces (`in line with Block 2 right`); lining up both ways with
 * one part is its corner. With `from` (the first corner), a side may also match another part's size.
 * Else the grid (`step`, counted from the frame's origin). `plane` = the axis the plane is across;
 * that coordinate is kept.
 */
export function inferDraw(
  doc: Doc,
  plane: 0 | 1 | 2,
  raw: V3,
  tol: number,
  boxes: Map<string, Box3>,
  step: number,
  from?: V3,
): { p: V3; labels: string[]; nodes: string[]; axes: (0 | 1 | 2)[] } {
  const axes = ([0, 1, 2] as const).filter((k) => k !== plane);
  const cands = axes.map((k) => {
    const out: Cand[] = [];
    for (const [id, b] of boxes) {
      const name = nameOf(doc, id);
      out.push({ s: b.min[k], label: `in line with ${name} ${WORDS[k][0]}`, node: id, rank: 0 }, { s: b.max[k], label: `in line with ${name} ${WORDS[k][1]}`, node: id, rank: 0 });
      if (from) {
        const size = b.max[k] - b.min[k];
        for (const s of [from[k] + size, from[k] - size]) out.push({ s, label: `${DIM[k]} = ${name}`, node: id, rank: 1 });
      }
    }
    return out;
  });
  // Where both axes tie between parts, pick the same part for both: its corner.
  let a = closest(cands[0]!, raw[axes[0]!], tol);
  const b = closest(cands[1]!, raw[axes[1]!], tol, a?.node);
  if (a && b && a.node !== b.node) a = closest(cands[0]!, raw[axes[0]!], tol, b.node);
  const p: V3 = [...raw];
  [a, b].forEach((hit, i) => {
    const k = axes[i]!;
    p[k] = hit ? hit.s : Math.round(raw[k] / step) * step;
  });
  if (a && b && a.node === b.node && a.label.startsWith('in line') && b.label.startsWith('in line')) {
    return { p, labels: [`corner of ${nameOf(doc, a.node)}`], nodes: [a.node], axes: [] };
  }
  const hits = ([a, b] as const).flatMap((h, i) => (h ? [{ ...h, k: axes[i]! }] : []));
  return { p, labels: hits.map((h) => h.label), nodes: hits.map((h) => h.node), axes: hits.map((h) => h.k) };
}

/**
 * Inference for how far a drawn rectangle extrudes along axis `k` from its plane at `base` (`sign`:
 * which way is out): flush with another part's face, or the same size as it along `k`; else the grid.
 * Never less than one step.
 */
export function inferExtrude(doc: Doc, k: 0 | 1 | 2, base: number, sign: 1 | -1, raw: number, tol: number, boxes: Map<string, Box3>, step: number): Snap & { snapped: boolean } {
  const cands: Cand[] = [];
  for (const [id, b] of boxes) {
    const name = nameOf(doc, id);
    for (const [c, max] of [[b.min[k], false], [b.max[k], true]] as const) {
      const s = sign * (c - base);
      if (s > 0) cands.push({ s, label: `flush with ${name} ${WORDS[k][max ? 1 : 0]}`, node: id, rank: 0 });
    }
    cands.push({ s: b.max[k] - b.min[k], label: `${DIM[k]} = ${name}`, node: id, rank: 1 });
  }
  const best = closest(cands, raw, tol);
  if (best) return { ...best, snapped: true };
  return { s: Math.max(step, Math.round(raw / step) * step), label: '', node: '', snapped: false };
}

/** Standard cabinet widths come in 3" steps. */
export const CABINET_STEP = 3 * 64;

/**
 * Where to split a block along its own axis `k`: `raw` = the cut's distance from its min face, `size`
 * = its extent along `k`. Snaps to other parts' faces that cross it (the seams of the blocks above or
 * below), its middle, and 3" steps from either end (cabinet widths); else the grid. `boxes`: the other
 * parts in the block's frame.
 */
export function inferSplit(doc: Doc, k: 0 | 1 | 2, size: number, raw: number, tol: number, boxes: Map<string, Box3>, step: number): Snap | null {
  const cands: Cand[] = [];
  const inside = (s: number) => s > 0 && s < size;
  for (const [id, b] of boxes) {
    for (const [c, max] of [[b.min[k], false], [b.max[k], true]] as const) {
      if (inside(c)) cands.push({ s: c, label: `in line with ${nameOf(doc, id)} ${WORDS[k][max ? 1 : 0]}`, node: id, rank: 0 });
    }
  }
  cands.push({ s: size / 2, label: 'middle', node: '', rank: 1 });
  for (let s = CABINET_STEP; s < size; s += CABINET_STEP) cands.push({ s, label: '', node: '', rank: 2 }, { s: size - s, label: '', node: '', rank: 2 });
  const best = closest(cands.filter((c) => inside(Math.round(c.s))), raw, tol);
  if (best) return best;
  const s = Math.round(raw / step) * step;
  return inside(s) ? { s, label: '', node: '' } : null;
}
