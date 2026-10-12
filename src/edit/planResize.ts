import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import type { Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { apply, nodeAffine, rotate, toFrame, transpose } from '../model/world';
import { buildPart } from '../plugins/pipeline';
import { dragChanges, driveOps, handleDrives } from './drives';
import type { Target } from './targets';

/**
 * Resizing a piece from above (the 2D plan): a grip on each side of its footprint — its left, right,
 * back and front, in its own frame — that pushes or pulls the face of it standing on that side, the
 * way Push / Pull does (edit/drives.ts): a block's side, a cabinet's side or back (the cabinet grows),
 * an appliance, a prop. A side whose outermost face drives nothing gets no grip. Pure.
 */

export type PlanSide = 'left' | 'right' | 'back' | 'front';

export interface PlanGrip {
  side: PlanSide;
  /** The face it pushes. */
  target: Target;
  /** The face's middle (world [x, z]) and its way out (a world unit vector, flat). */
  point: [number, number];
  normal: [number, number];
}

const SIDES: { side: PlanSide; axis: 0 | 2; sign: 1 | -1 }[] = [
  { side: 'left', axis: 0, sign: -1 },
  { side: 'right', axis: 0, sign: 1 },
  { side: 'back', axis: 2, sign: -1 },
  { side: 'front', axis: 2, sign: 1 },
];
/** Faces within this of a side's outermost plane stand on that side. */
const ON_SIDE = 8;
/** …or within this, when none of those drives anything. */
const NEAR_SIDE = 64 * 3;

const grips = new WeakMap<Doc, Map<string, PlanGrip[]>>();

/** The grips of a plan piece (a part, or an assembly and the parts in it). Memoized per doc. */
export function planGrips(doc: Doc, id: string): PlanGrip[] {
  let byId = grips.get(doc);
  if (!byId) grips.set(doc, (byId = new Map()));
  const hit = byId.get(id);
  if (hit) return hit;
  const out: PlanGrip[] = [];
  if (doc.parts[id] || doc.assemblies[id]) {
    const A = nodeAffine(doc, id);
    const parts = doc.parts[id] ? [id] : descendants(doc, id).filter((c) => doc.parts[c]);
    // Every flat face that looks along one of the piece's sides: where its plane is, along that side.
    const faces: { side: PlanSide; plane: number; target: Target; center: V3; normal: V3 }[] = [];
    for (const pid of parts) {
      let handles;
      try {
        handles = buildPart(doc.parts[pid]!).handles;
      } catch {
        continue;
      }
      const P = nodeAffine(doc, pid);
      for (const h of handles) {
        if (h.kind !== 'face' || !h.normal || !h.points[0]) continue;
        const n = rotate(P.m, h.normal);
        const local = rotate(transpose(A.m), n);
        const s = SIDES.find((q) => local[q.axis] * q.sign > 1 - 1e-6);
        if (!s) continue;
        const center = apply(P, h.points[0]);
        faces.push({ side: s.side, plane: toFrame(A, center)[s.axis] * s.sign, target: { node: pid, handle: h.id }, center, normal: n });
      }
    }
    for (const s of SIDES) {
      const mine = faces.filter((f) => f.side === s.side);
      if (!mine.length) continue;
      const outer = Math.max(...mine.map((f) => f.plane));
      const drives = (f: (typeof mine)[number]) => {
        const hd = handleDrives(doc, f.target);
        return !!hd && hd.constraint?.kind === 'line' && hd.drives.some((d) => d.axis);
      };
      // The outermost face that drives something; else one a little behind it (a cabinet's doors
      // stand proud of its case, which is what grows).
      const pick = mine.filter((f) => outer - f.plane <= ON_SIDE).find(drives) ?? mine.filter((f) => outer - f.plane <= NEAR_SIDE).sort((a, b) => b.plane - a.plane).find(drives);
      if (!pick) continue;
      const len = Math.hypot(pick.normal[0], pick.normal[2]) || 1;
      out.push({ side: s.side, target: pick.target, point: [pick.center[0], pick.center[2]], normal: [pick.normal[0] / len, pick.normal[2] / len] });
    }
  }
  byId.set(id, out);
  return out;
}

/** Ops that push a grip's face `s` model units out (negative: in), as Push / Pull would. */
export function planResizeOps(doc: Doc, grip: PlanGrip, s: number): Op[] {
  const hd = handleDrives(doc, grip.target);
  if (!hd || !s) return [];
  const P = nodeAffine(doc, grip.target.node);
  const disp = rotate(transpose(P.m), [grip.normal[0] * s, 0, grip.normal[1] * s]);
  return driveOps(doc, hd.part.id, dragChanges(hd, disp));
}
