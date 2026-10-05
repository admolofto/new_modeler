import * as THREE from 'three';
import { BLOCK_STEP, moveOps, turnOps } from '../edit/blocks';
import { duplicateOps } from '../edit/duplicate';
import { gizmoNodes, gizmoPlace, targetsOf, type GizmoPlace } from '../edit/gizmo';
import { inferMove, type Snap } from '../edit/snap';
import type { V3 } from '../geometry/types';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { boxSize, rotate, transpose, worldBoxes } from '../model/world';
import type { Gizmo, GizmoHandle } from '../render/gizmo';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { SNAP_PX } from './interaction';
import type { Selection } from './selection';
import { fmt, shop } from './units';

/**
 * Drives the move / turn gizmo (render/gizmo.ts) on the selection: drag an arrow to move along
 * that axis, the square to slide along the floor plane, a ring to turn — each snapping to what's
 * nearby (against a neighbor, in line with it, centered on it, the floor; edit/snap.ts) or the grid
 * (1/2" for blocks, else 1/16"; turns in 15° steps). Alt = 1/64" or 1°, no snapping. Hold Ctrl as
 * the drag starts to move a copy instead. Previews live; release commits one undo step. R / Shift+R
 * turns a quarter turn about the vertical; Ctrl+D drops a copy alongside (repeat for a row).
 */

export interface GizmoControlOptions {
  viewport: Viewport;
  gizmo: Gizmo;
  store: Store;
  selection: Selection;
  /** The doc on screen (a drag preview while dragging). */
  shown(): Doc;
  /** The doc as drawn (an isolated folder only): what moves snap to. */
  view?(doc: Doc): Doc;
  editBlocked(): string | null;
  /** A drawing tool has the pointer: no gizmo. */
  toolActive(): boolean;
  setDragPreview(doc: Doc | null): void;
  setSnapNode(id: string | null): void;
  onStatus(msg: string, error?: boolean): void;
}

export interface GizmoControl {
  /** Places the gizmo on the selection, in the doc on screen (after every render or selection change). */
  sync(): void;
  /** Hover feedback: true while the pointer is over a handle. */
  hover(e: PointerEvent): boolean;
  /** Starts a drag when the pointer is on a handle (true: it took the gesture). */
  down(e: PointerEvent): boolean;
  readonly dragging: boolean;
  move(e: PointerEvent): void;
  /** Ends the drag: commit = one undo step, else nothing changes. */
  end(commit: boolean): void;
  /** Turns the selection `deg` about its vertical axis, around its center. */
  turn(deg: number): void;
  /** Copies the selection and puts the copy flush beside it, to its right (along its own x). */
  duplicate(): void;
}

interface Drag {
  h: GizmoHandle;
  ids: string[];
  base: Doc;
  place: GizmoPlace;
  pointerId: number;
  /** Where the drag started on its constraint (axis param, or plane point; model units). */
  t0: number;
  p0: V3;
  /** Rings: the angle turned so far (degrees, unwrapped) and the last screen angle. */
  angle: number;
  last: number;
  ops: Op[];
  error: string | null;
  /** Ctrl-drag: the copies being moved (they start where the originals are). */
  copy: { ops: Op[]; copies: string[]; doc: Doc } | null;
}

const U = UNITS_PER_INCH;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const column = (m: V3[], k: number): V3 => [m[0]![k]!, m[1]![k]!, m[2]![k]!];
const signed = (u: number) => `${u >= 0 ? '+' : '−'}${fmt(Math.abs(u))}`;

export function attachGizmo(o: GizmoControlOptions): GizmoControl {
  const { viewport, gizmo, store, selection } = o;
  const { camera, controls, renderer } = viewport;
  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const label = el('div', { class: 'drag-label len' });
  label.style.display = 'none';
  document.body.append(label);
  let drag: Drag | null = null;

  const setRay = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  };
  const ray = () => ({ o: raycaster.ray.origin.toArray().map((c) => c * U) as V3, d: raycaster.ray.direction.toArray() as V3 });
  const inches = (p: V3) => new THREE.Vector3(p[0] / U, p[1] / U, p[2] / U);
  /** Where the pivot is on screen (client pixels). */
  const screenOf = (p: V3) => {
    const r = canvas.getBoundingClientRect();
    const q = inches(p).project(camera);
    return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height };
  };

  /** The nodes the gizmo acts on now, or null (hidden). */
  const nodes = (doc: Doc) => (o.toolActive() || o.editBlocked() ? null : gizmoNodes(doc, selection.targets));

  function sync() {
    const doc = o.shown();
    const ids = drag ? drag.ids : nodes(doc);
    const place = ids && gizmoPlace(doc, ids);
    gizmo.place(place ? { pivot: place.pivot, m: place.frame.m } : null);
  }

  /** Parameter along a world line through `p` with direction `d` of the point nearest the ray. */
  function alongLine(p: V3, d: V3): number | null {
    const { o: ro, d: rd } = ray();
    const w0: V3 = [p[0] - ro[0], p[1] - ro[1], p[2] - ro[2]];
    const b = dot(d, rd);
    const denom = 1 - b * b;
    if (denom < 1e-4) return null;
    return (b * dot(rd, w0) - dot(d, w0)) / denom;
  }
  /** Where the ray meets the plane through `p` across `n`. */
  function onPlane(p: V3, n: V3): V3 | null {
    const { o: ro, d: rd } = ray();
    const den = dot(n, rd);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot(n, [p[0] - ro[0], p[1] - ro[1], p[2] - ro[2]]) / den;
    return t > 0 ? [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t] : null;
  }
  const screenAngle = (e: PointerEvent, pivot: V3) => {
    const c = screenOf(pivot);
    return Math.atan2(-(e.clientY - c.y), e.clientX - c.x);
  };

  // ── Drag ──────────────────────────────────────────────────────────────────────
  function down(e: PointerEvent): boolean {
    if (drag || !gizmo.visible) return false;
    setRay(e);
    const h = gizmo.pick(raycaster);
    if (!h) return false;
    const blocked = o.editBlocked();
    if (blocked) {
      o.onStatus(blocked, true);
      return true;
    }
    const base = store.doc;
    const ids = nodes(base);
    const place = ids && gizmoPlace(base, ids);
    if (!ids || !place) return false;
    const F = place.frame.m;
    let t0 = 0;
    let p0: V3 = place.pivot;
    if (h.kind === 'axis') t0 = alongLine(place.pivot, column(F, h.k)) ?? 0;
    if (h.kind === 'plane') p0 = onPlane(place.pivot, column(F, 1)) ?? place.pivot;
    const a0 = screenAngle(e, place.pivot);
    let copy: Drag['copy'] = null;
    if (e.ctrlKey || e.metaKey) {
      try {
        copy = duplicateOps(base, ids);
      } catch (err) {
        o.onStatus(`Can't copy that: ${(err as Error).message}`, true);
        return true;
      }
    }
    drag = { h, ids, base, place, pointerId: e.pointerId, t0, p0, angle: 0, last: a0, ops: [], error: null, copy };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    gizmo.highlight(h);
    return true;
  }

  function move(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    setRay(e);
    const { place } = d;
    const F = place.frame.m;
    const allBlocks = d.ids.every((id) => d.base.parts[id]?.block);
    const step = e.altKey ? 1 : allBlocks ? BLOCK_STEP : 4;
    const tol = e.altKey ? 0 : SNAP_PX * viewport.unitsPerPx(inches(place.pivot));
    const snapAxis = (k: 0 | 1 | 2, raw: number): Snap => {
      const s = tol && place.box ? inferMove(o.view?.(d.base) ?? d.base, k, place.box, raw, tol, d.copy ? place.all : place.others, place.upright ? 0 : undefined) : null;
      return s ?? { s: Math.round(raw / step) * step, label: '', node: '' };
    };
    // A copy: add it where the original is, then move / turn the copy.
    const [from, ids] = d.copy ? [d.copy.doc, d.copy.copies] : [d.base, d.ids];
    const withCopy = (ops: Op[]) => (d.copy ? [...d.copy.ops, ...ops] : ops);
    let ops: Op[];
    let text: string;
    let why: Snap[] = [];
    if (d.h.kind === 'ring') {
      const a = screenAngle(e, place.pivot);
      let delta = a - d.last;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      d.last = a;
      const A = column(F, d.h.k);
      // Counterclockwise on screen is a positive turn when the axis points at the viewer.
      const toCamera = camera.position.clone().multiplyScalar(U).sub(inches(place.pivot).multiplyScalar(U)).toArray() as V3;
      d.angle += (dot(A, toCamera) >= 0 ? 1 : -1) * (delta * 180) / Math.PI;
      const snapDeg = e.altKey ? 1 : 15;
      const deg = Math.round(d.angle / snapDeg) * snapDeg;
      ops = withCopy(deg ? turnOps(from, ids, place.pivot, A, deg) : []);
      text = `${d.copy ? 'copy ' : ''}turned ${deg}°`;
    } else if (d.h.kind === 'axis') {
      const t = alongLine(place.pivot, column(F, d.h.k));
      if (t === null) return;
      const s = snapAxis(d.h.k, t - d.t0);
      why = [s];
      const D = column(F, d.h.k);
      ops = withCopy(moveOps(from, ids, [D[0] * s.s, D[1] * s.s, D[2] * s.s]));
      text = `${d.copy ? 'copy ' : ''}moved ${signed(s.s)}`;
    } else {
      const p = onPlane(place.pivot, column(F, 1));
      if (!p) return;
      const v = rotate(transpose(F), [p[0] - d.p0[0], p[1] - d.p0[1], p[2] - d.p0[2]]);
      const [sx, sz] = [snapAxis(0, v[0]), snapAxis(2, v[2])];
      why = [sx, sz];
      ops = withCopy(moveOps(from, ids, rotate(F, [sx.s, 0, sz.s])));
      text = `${d.copy ? 'copy ' : ''}moved ${signed(sx.s)}, ${signed(sz.s)}`;
    }
    const r = ops.length ? applyOps(d.base, ops) : ({ ok: true, doc: d.base } as const);
    const labels = why.filter((w) => w.label).map((w) => w.label);
    o.setSnapNode(why.find((w) => w.node)?.node ?? null);
    const line = [text, ...labels].join(' · ');
    if (r.ok) {
      d.ops = ops;
      d.error = null;
      o.setDragPreview(r.doc);
      label.replaceChildren(...shop(line));
    } else {
      d.error = r.error;
      label.replaceChildren(...shop(`${line} — ${r.error.split('\n')[0]}`));
    }
    label.classList.toggle('bad', !r.ok);
    label.style.display = '';
    label.style.left = `${e.clientX + 16}px`;
    label.style.top = `${e.clientY + 12}px`;
  }

  function end(commit: boolean) {
    const d = drag;
    if (!d) return;
    drag = null;
    label.style.display = 'none';
    controls.enabled = true;
    if (canvas.hasPointerCapture(d.pointerId)) canvas.releasePointerCapture(d.pointerId);
    canvas.style.cursor = '';
    gizmo.highlight(null);
    o.setSnapNode(null);
    o.setDragPreview(null);
    if (!commit) return o.onStatus('Move cancelled.');
    if (d.ops.length) {
      const r = store.dispatch(d.ops);
      if (!r.ok) return o.onStatus(r.error, true);
      if (d.copy) selection.set(targetsOf(store.doc, d.copy.copies));
    }
    o.onStatus(d.error ? `Stopped at the last spot that works: ${d.error.split('\n')[0]}` : '', !!d.error);
    sync();
  }

  function duplicate() {
    const blocked = o.editBlocked();
    if (blocked) return o.onStatus(blocked, true);
    const doc = store.doc;
    const ids = nodes(doc);
    const place = ids && gizmoPlace(doc, ids);
    if (!ids || !place) return o.onStatus('Select whole parts, blocks or cabinets to copy them.', true);
    // Flush beside it along its own x; its bounding box's width if it isn't square to itself.
    const w = place.box ? boxSize(place.box)[0] : boxSize(worldBoxes(doc).get(ids[0]!) ?? { min: [0, 0, 0], max: [0, 0, 0] })[0];
    const x = column(place.frame.m, 0);
    try {
      const dup = duplicateOps(doc, ids);
      const r = store.dispatch([...dup.ops, ...moveOps(dup.doc, dup.copies, [x[0] * w, x[1] * w, x[2] * w])]);
      if (!r.ok) return o.onStatus(r.error, true);
      selection.set(targetsOf(store.doc, dup.copies));
    } catch (err) {
      o.onStatus(`Can't copy that: ${(err as Error).message}`, true);
    }
  }

  function turn(deg: number) {
    const blocked = o.editBlocked();
    if (blocked) return o.onStatus(blocked, true);
    const doc = store.doc;
    const ids = nodes(doc);
    const place = ids && gizmoPlace(doc, ids);
    if (!ids || !place) return;
    const r = store.dispatch(turnOps(doc, ids, place.pivot, column(place.frame.m, 1), deg));
    if (!r.ok) o.onStatus(r.error, true);
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.('input, select, textarea') || e.altKey || e.defaultPrevented || !gizmo.visible || drag) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'd') {
      e.preventDefault();
      duplicate();
    } else if (!e.ctrlKey && !e.metaKey && k === 'r') {
      e.preventDefault();
      turn(e.shiftKey ? -90 : 90);
    }
  });

  return {
    sync,
    hover(e) {
      if (drag || !gizmo.visible) return false;
      setRay(e);
      const h = gizmo.pick(raycaster);
      gizmo.highlight(h);
      return !!h;
    },
    down,
    get dragging() {
      return !!drag;
    },
    move,
    end,
    turn,
    duplicate,
  };
}
