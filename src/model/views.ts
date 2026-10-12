import type { V3 } from '../geometry/types';
import { isSolid, modelPartIds } from './decor';
import { descendants, movingParts } from './doc';
import { EYE_HEIGHT, roomShell } from './room';
import type { Doc, View, ViewCamera, ViewFrom } from './schema';
import { hiddenNodes } from './visibility';
import { union, worldBoxes, type Box3 } from './world';

/**
 * Presentation views, worked out from the doc (A9; pure, model units): what a view opens, and where
 * its camera goes — a saved `camera` as is, a semantic `frame` fit to what it frames (or the whole
 * model, never the room) from a direction, kept inside the room's walls and out of cabinets.
 */

/** Field of view for a framed shot, and for a walk-mode one (degrees). */
export const FRAME_FOV = 50;
export const WALK_FOV = 60;
/** Directions per `from` (degrees): azimuth from the front (+Z), negative to the left; elevation up. */
export const FROM: Record<ViewFrom, { azimuth: number; elevation: number }> = {
  front: { azimuth: 0, elevation: 15 },
  'front-left': { azimuth: -35, elevation: 15 },
  'front-right': { azimuth: 35, elevation: 15 },
  left: { azimuth: -90, elevation: 15 },
  right: { azimuth: 90, elevation: 15 },
  above: { azimuth: 0, elevation: 70 },
  eye: { azimuth: -35, elevation: 0 },
};
/** A framed camera stays this far inside the room's walls and ceiling, and off cabinets (1/64"). */
export const WALL_MARGIN = 12 * 64;
/** The nearest a framed camera comes to the middle of what it frames (2'). */
const MIN_DISTANCE = 24 * 64;

/** The motions a view opens, in doc order: its motion ids, and every motion moving parts inside its node ids. */
export function viewMotions(doc: Doc, view: View): string[] {
  const want = new Set<string>();
  const inside = new Set<string>();
  for (const id of view.open ?? []) {
    if (doc.motions[id]) want.add(id);
    else if (doc.parts[id] || doc.assemblies[id]) for (const n of [id, ...(doc.assemblies[id] ? descendants(doc, id) : [])]) inside.add(n);
  }
  return Object.values(doc.motions)
    .filter((m) => want.has(m.id) || (inside.size > 0 && (m.nodes.some((n) => inside.has(n)) || [...movingParts(doc, m.nodes)].some((p) => inside.has(p)))))
    .map((m) => m.id);
}

/** Going to a view: what closes as the flight starts (open now, not in the view) and what opens halfway. */
export function motionPlan(openNow: readonly string[], target: readonly string[]): { close: string[]; open: string[] } {
  const keep = new Set(target);
  const now = new Set(openNow);
  return { close: openNow.filter((id) => !keep.has(id)), open: target.filter((id) => !now.has(id)) };
}

/** The walk-mode eye height (model units): the presentation's, else 62". */
export const eyeHeightOf = (doc: Doc): number => doc.presentation?.eyeHeight ?? EYE_HEIGHT;

const rad = (deg: number) => (deg * Math.PI) / 180;
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const inBox = (p: V3, b: Box3, pad: number) => [0, 1, 2].every((i) => p[i]! > b.min[i]! - pad && p[i]! < b.max[i]! + pad);

/** What a frame fits: its nodes, else the whole visible model (not the room), less the view's hidden ids. */
function framedBox(doc: Doc, view: View): Box3 | null {
  const boxes = worldBoxes(doc);
  const hide = new Set(view.hide ?? []);
  const ids = view.frame?.nodes.length ? view.frame.nodes : modelPartIds(doc);
  const hidden = hiddenNodes(doc);
  const shown = view.frame?.nodes.length ? ids : ids.filter((id) => !hidden.has(id) && !hide.has(id));
  const all = shown.map((id) => boxes.get(id)).filter((b): b is Box3 => !!b);
  return all.length ? union(all) : null;
}

/**
 * Pulls a camera at `p` looking at `t` inside the room: back along the line to `t` until it's
 * `WALL_MARGIN` inside every built wall (and under the ceiling). Walls `t` is already outside of don't count.
 */
export function insideRoom(doc: Doc, p: V3, t: V3): V3 {
  const shell = roomShell(doc);
  let s = 1;
  const d = sub(p, t);
  const limit = (point: V3, outward: V3) => {
    // dot(t + s d − point, outward) ≤ −margin
    const at = dot(sub(t, point), outward) + WALL_MARGIN;
    const rate = dot(d, outward);
    if (at > 0 || rate <= 1e-9) return;
    s = Math.min(s, -at / rate);
  };
  for (const w of shell.walls) limit(w.point, w.outward);
  for (const c of shell.ceilings) {
    if (t[0] >= c.min[0] && t[0] <= c.max[0] && t[2] >= c.min[1] && t[2] <= c.max[1]) limit([t[0], c.height, t[2]], [0, 1, 0]);
  }
  return add(t, d, Math.max(0, s));
}

/** Keeps a camera out of the model's solid parts: raised over one it's in, or, at eye height, slid toward `t`. */
function outOfParts(doc: Doc, p: V3, t: V3, eye: boolean): V3 {
  const boxes = worldBoxes(doc);
  const hidden = hiddenNodes(doc);
  const solid = modelPartIds(doc)
    .filter((id) => !hidden.has(id) && isSolid(doc.parts[id]!))
    .map((id) => boxes.get(id))
    .filter((b): b is Box3 => !!b);
  const pad = 6 * 64;
  let q = p;
  if (eye) {
    const d = sub(t, p);
    const len = Math.hypot(d[0], d[2]);
    for (let k = 0; k < 400 && solid.some((b) => inBox(q, b, pad)); k++) {
      if (len < 1) break;
      q = [q[0] + (d[0] / len) * 128, q[1], q[2] + (d[2] / len) * 128];
    }
    return q;
  }
  for (let k = 0; k < 8; k++) {
    const hit = solid.find((b) => inBox(q, b, pad));
    if (!hit) break;
    q = [q[0], hit.max[1] + WALL_MARGIN, q[2]];
  }
  return q;
}

/**
 * Where a view's camera goes (model units). A camera is returned as is. A frame is fit by the
 * bounding sphere of what it frames, from its direction (`from`, or its own azimuth / elevation),
 * at its distance or one that fits the sphere in the view; `eye` stands at the eye height. Inside a
 * room the camera stays inside its built walls, and never inside a cabinet.
 */
export function viewCamera(doc: Doc, view: View, aspect: number): ViewCamera {
  if (view.camera) return view.camera;
  const frame = view.frame ?? { nodes: [], from: 'front-left' as const };
  const fov = view.mode === 'walk' ? WALK_FOV : FRAME_FOV;
  const box = framedBox(doc, view) ?? { min: [0, 0, 0], max: [36 * 64, 36 * 64, 24 * 64] };
  const center: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(64, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
  const vertical = rad(fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(0.1, aspect));
  const distance = frame.distance ?? Math.max(MIN_DISTANCE, (radius * 1.15) / Math.sin(Math.min(vertical, horizontal)));
  const dir = FROM[frame.from];
  const az = rad(frame.azimuth ?? dir.azimuth);
  const eye = frame.from === 'eye';
  const el = eye ? 0 : rad(frame.elevation ?? dir.elevation);
  let position: V3 = [center[0] + distance * Math.cos(el) * Math.sin(az), center[1] + distance * Math.sin(el), center[2] + distance * Math.cos(el) * Math.cos(az)];
  if (eye) position[1] = eyeHeightOf(doc);
  // At eye height it pulls in level (it stays at the eye height).
  position = insideRoom(doc, position, eye ? [center[0], position[1], center[2]] : center);
  position = outOfParts(doc, position, center, eye);
  return { position, target: center, fov };
}
