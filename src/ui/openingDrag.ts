import * as THREE from 'three';
import type { DimLine } from '../edit/dimensions';
import {
  openingDims,
  openingEdges,
  openingGrips,
  openingReadout,
  openingUnder,
  readoutText,
  resizeOpening,
  slideOpening,
  wallPoint,
  wallUnder,
  withOpening,
  type OpeningGrip,
} from '../edit/openings';
import type { Ray } from '../edit/rays';
import type { V3 } from '../geometry/types';
import { applyOps, type Op } from '../model/ops';
import { roomOf, roomParams, type RoomOpening, type RoomParams } from '../model/room';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { hiddenNodes } from '../model/visibility';
import { apply, nodeAffine, rotate, toFrame, transpose, type Affine } from '../model/world';
import { openingBottom, openingLabel } from '../plugins/generators/room';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { fmt, shop } from './units';

/**
 * Windows, doors and cased openings, dragged in the viewport (part of the Select tool): press on
 * one and drag to slide it along its wall and round the corner onto the next; pull a grip on one
 * of its edges to resize it. While it moves, dimension lines on the wall and the cursor's label say
 * how far it is from each corner and from its nearest neighbor. Snaps to 1/2" (and to the middle
 * of the wall); hold Alt for 1/64". One undo step on release; Esc cancels. The math is in
 * edit/openings.ts.
 */

export interface OpeningDragOptions {
  viewport: Viewport;
  store: Store;
  /** The doc on screen. */
  shown(): Doc;
  editBlocked(): string | null;
  /** Doors drawn open: drags wait. */
  posed?(): boolean;
  setDragPreview(doc: Doc | null): void;
  /** Dimension lines for what's being dragged (null: back to the selection's). */
  setDims(lines: DimLine[] | null): void;
  onStatus(msg: string, error?: boolean): void;
}

export interface OpeningDrag {
  readonly dragging: boolean;
  /** The cursor for what's under the pointer (an opening, or a grip of the one last pointed at), or null. `clear`: how far the ray goes before it hits the model. */
  hover(e: MouseEvent, ray: THREE.Ray, clear: number): string | null;
  /** Starts a drag when the press is on an opening or a grip. */
  down(e: PointerEvent, ray: THREE.Ray, clear: number): boolean;
  move(e: PointerEvent, ray: THREE.Ray): void;
  /** Ends the drag; true when it was one (not just a click). */
  end(commit: boolean): boolean;
  /** Nothing pointed at any more (the pointer left, a tool took over). */
  clear(): void;
}

interface Dragging {
  room: string;
  id: string;
  grip: OpeningGrip;
  base: Doc;
  p: RoomParams;
  A: Affine;
  /** From the grabbed point to the edge being placed (along the wall, or up). */
  off: number;
  /** Where it is now (what release commits). */
  now: RoomOpening;
  x: number;
  y: number;
  pointerId: number;
  moved: boolean;
  ops: Op[];
  error: string | null;
}

const STYLE = `
.opening-grip { position: fixed; z-index: 54; width: 11px; height: 11px; margin: -6px 0 0 -6px; pointer-events: none; box-sizing: border-box;
  background: #fff; border: 2px solid var(--sel); border-radius: 3px; box-shadow: 0 1px 4px #0009; }
.opening-grip.on { background: var(--sel); }
`;

/** How near (screen pixels) the cursor must be to a grip, or to the edge it's on, to pull it. */
const GRIP_PX = 10;
const EDGE_PX = 5;
const CLICK_PX = 5;
const SNAP_PX = 9;
/** Sizes and distances land on 1/2"; Alt: 1/64". */
const STEP = 32;
/** A window's frame, a door's leaf and handle count as the opening: this far into the room off the wall's middle. */
const PROUD = 6 * UNITS_PER_INCH;

const CURSOR: Record<OpeningGrip, string> = { move: 'grab', left: 'ew-resize', right: 'ew-resize', top: 'ns-resize', bottom: 'ns-resize' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function createOpeningDrag(o: OpeningDragOptions): OpeningDrag {
  const { viewport, store } = o;
  const { camera, controls, renderer } = viewport;
  const canvas = renderer.domElement;
  const label = el('div', { class: 'drag-label len' });
  label.style.display = 'none';
  const dots = (['left', 'right', 'top', 'bottom'] as const).map((grip) => {
    const dot = el('div', { class: 'opening-grip' });
    dot.style.display = 'none';
    return { grip, dot };
  });
  document.body.append(el('style', {}, STYLE), label, ...dots.map((d) => d.dot));

  /** The opening whose grips show: the one pointed at last (or being dragged), and the grip under the cursor. */
  let active: { id: string; grip: OpeningGrip | null } | null = null;
  let drag: Dragging | null = null;

  /** The room on screen, when its walls are showing. */
  function room(doc: Doc): { id: string; p: RoomParams; A: Affine } | null {
    const asm = roomOf(doc);
    if (!asm || hiddenNodes(doc).has(asm.id)) return null;
    return { id: asm.id, p: roomParams(asm), A: nodeAffine(doc, asm.id) };
  }
  /** The pointer's ray in a room's coordinates (model units). */
  const inRoom = (A: Affine, ray: THREE.Ray): Ray => ({
    o: toFrame(A, [ray.origin.x * UNITS_PER_INCH, ray.origin.y * UNITS_PER_INCH, ray.origin.z * UNITS_PER_INCH]),
    d: rotate(transpose(A.m), [ray.direction.x, ray.direction.y, ray.direction.z]),
  });
  const scenePoint = (A: Affine, p: V3) => new THREE.Vector3(...apply(A, p)).divideScalar(UNITS_PER_INCH);
  const toClient = (A: Affine, p: V3) => {
    const r = canvas.getBoundingClientRect();
    const q = scenePoint(A, p).project(camera);
    return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height, behind: q.z > 1 };
  };

  /** The grip of an opening the cursor is on: its dot first, else the edge it's on. */
  function gripAt(A: Affine, p: RoomParams, op: RoomOpening, e: MouseEvent): OpeningGrip | null {
    let best: { grip: OpeningGrip; d: number } | null = null;
    for (const g of openingGrips(p, op)) {
      const [c, a, b] = [g.at, ...g.ends].map((pt) => toClient(A, pt));
      if (c!.behind || a!.behind || b!.behind) continue;
      const dot = Math.hypot(c!.x - e.clientX, c!.y - e.clientY);
      const len2 = (b!.x - a!.x) ** 2 + (b!.y - a!.y) ** 2;
      const s = len2 ? Math.max(0, Math.min(1, ((e.clientX - a!.x) * (b!.x - a!.x) + (e.clientY - a!.y) * (b!.y - a!.y)) / len2)) : 0;
      const edge = Math.hypot(a!.x + (b!.x - a!.x) * s - e.clientX, a!.y + (b!.y - a!.y) * s - e.clientY);
      // A dot beats any edge; among edges, the nearer.
      const d = dot <= GRIP_PX ? dot - GRIP_PX : edge <= EDGE_PX ? edge : Infinity;
      if (d < (best?.d ?? Infinity)) best = { grip: g.grip, d };
    }
    return best?.grip ?? null;
  }

  function place() {
    const r = active && room(o.shown());
    const op = r?.p.openings.find((q) => q.id === active!.id);
    // Seen from inside only: from outside the cutaway has the wall away.
    const eye = r && toFrame(r.A, [camera.position.x * UNITS_PER_INCH, camera.position.y * UNITS_PER_INCH, camera.position.z * UNITS_PER_INCH]);
    const facing = r && op && r.p.walls.includes(op.wall) && seenFromInside(r.p, op, eye!);
    const grips = facing ? openingGrips(r.p, op) : [];
    for (const { grip, dot } of dots) {
      const g = grips.find((x) => x.grip === grip);
      const s = g && toClient(r!.A, g.at);
      const show = !!s && !s.behind && (!drag || drag.grip === grip || drag.grip === 'move');
      dot.style.display = show ? '' : 'none';
      if (!show) continue;
      dot.style.left = `${s.x}px`;
      dot.style.top = `${s.y}px`;
      dot.classList.toggle('on', (drag?.grip ?? active!.grip) === grip);
    }
  }
  viewport.onFrame(() => {
    if (active) place();
  });

  /** What the pointer is on: an opening it goes through with nothing in front, or a grip of the active one. */
  function aim(e: MouseEvent, ray: THREE.Ray, clear: number): { id: string; grip: OpeningGrip; r: NonNullable<ReturnType<typeof room>> } | null {
    const r = room(o.shown());
    if (!r) return null;
    const rr = inRoom(r.A, ray);
    const mine = active && r.p.openings.find((q) => q.id === active!.id);
    const through = openingUnder(r.p, rr);
    const under = through && clear * UNITS_PER_INCH >= through.t - Math.floor(r.p.wallThickness / 2) - PROUD ? through.opening : null;
    // The active one's grips reach a little outside it.
    const grip = mine && seenFromInside(r.p, mine, rr.o) ? gripAt(r.A, r.p, mine, e) : null;
    if (mine && grip) return { id: mine.id, grip, r };
    if (!under) return null;
    return { id: under.id, grip: gripAt(r.A, r.p, under, e) ?? 'move', r };
  }
  /** Whether the eye is on the room side of an opening's wall. */
  function seenFromInside(p: RoomParams, op: RoomOpening, eye: V3): boolean {
    switch (op.wall) {
      case 'back':
        return eye[2] > p.back;
      case 'front':
        return eye[2] < p.front;
      case 'left':
        return eye[0] > p.left;
      case 'right':
        return eye[0] < p.right;
    }
  }

  function update(e: PointerEvent, ray: THREE.Ray) {
    const d = drag!;
    const rr = inRoom(d.A, ray);
    const step = e.altKey ? 1 : STEP;
    const was = d.p.openings.find((q) => q.id === d.id)!;
    let next: RoomOpening | null = null;
    let note = '';
    if (d.grip === 'move') {
      const w = wallUnder(d.p, rr, d.now.wall);
      if (!w) return;
      const at = scenePoint(d.A, openingGrips(d.p, d.now)[0]!.at);
      const slid = slideOpening(d.p, d.id, w.wall, w.along + d.off, step, e.altKey ? 0 : SNAP_PX * viewport.unitsPerPx(at));
      if (!slid) note = `no room on the ${w.wall} wall`;
      next = slid?.opening ?? d.now;
      if (slid?.note) note = slid.note;
    } else {
      const w = wallPoint(d.p, was.wall, rr);
      if (!w) return;
      const side = d.grip === 'left' || d.grip === 'right';
      next = resizeOpening(d.p, d.id, d.grip, (side ? w.along : w.y) + d.off, step);
    }
    if (!next) return;
    const params = withOpening(d.p, next);
    const changed = JSON.stringify(next) !== JSON.stringify(was);
    const ops: Op[] = changed ? [{ op: 'update', id: d.room, patch: { params: { openings: params.openings } } }] : [];
    const r = ops.length ? applyOps(d.base, ops) : ({ ok: true, doc: d.base } as const);
    const name = cap(openingLabel(next));
    const top = openingBottom(next) + next.height;
    const what =
      d.grip === 'move'
        ? [`${name} · ${next.wall} wall`, readoutText(openingReadout(params, next), fmt)]
        : d.grip === 'left' || d.grip === 'right'
          ? [`${name} · ${fmt(next.width)} wide`, readoutText(openingReadout(params, next), fmt)]
          : [`${name} · ${fmt(next.height)} high`, ...(next.kind === 'door' ? [] : [`sill ${fmt(openingBottom(next))}`]), `${fmt(params.height - top)} below ceiling`];
    const text = [...what, ...(note ? [note] : [])].join(' · ');
    if (r.ok) {
      d.now = next;
      d.ops = ops;
      d.error = null;
      o.setDragPreview(ops.length ? r.doc : null);
      o.setDims(openingDims(params, next, d.grip).map((l) => ({ ...l, a: apply(d.A, l.a), b: apply(d.A, l.b), out: rotate(d.A.m, l.out) })));
      label.replaceChildren(...shop(text));
    } else {
      d.error = r.error;
      label.replaceChildren(...shop(`${text} — ${r.error.split('\n')[0]}`));
    }
    label.classList.toggle('bad', !r.ok || (!!note && note !== 'centered'));
    label.style.display = '';
    label.style.left = `${e.clientX + 16}px`;
    label.style.top = `${e.clientY + 12}px`;
    place();
  }

  return {
    get dragging() {
      return !!drag;
    },
    hover(e, ray, clear) {
      if (drag) return CURSOR[drag.grip];
      const hit = o.posed?.() ? null : aim(e, ray, clear);
      active = hit && { id: hit.id, grip: hit.grip === 'move' ? null : hit.grip };
      place();
      return hit ? CURSOR[hit.grip] : null;
    },
    down(e, ray, clear) {
      if (drag || o.posed?.()) return false;
      const hit = aim(e, ray, clear);
      if (!hit) return false;
      const blocked = o.editBlocked();
      if (blocked) {
        o.onStatus(blocked, true);
        return false;
      }
      const { r } = hit;
      const base = store.doc;
      // What's on screen (an AI proposal is blocked above) is the store's doc.
      const asm = base.assemblies[r.id];
      const p = asm?.generator?.type === 'room' ? roomParams(asm) : null;
      const op = p?.openings.find((q) => q.id === hit.id);
      const w = p && op && wallPoint(p, op.wall, inRoom(r.A, ray));
      if (!p || !op || !w) return false;
      const [left, right] = openingEdges(p, op);
      const edge = { move: left, left, right, top: openingBottom(op) + op.height, bottom: openingBottom(op) }[hit.grip];
      const off = edge - (hit.grip === 'top' || hit.grip === 'bottom' ? w.y : w.along);
      drag = { room: r.id, id: op.id, grip: hit.grip, base, p, A: r.A, off, now: op, x: e.clientX, y: e.clientY, pointerId: e.pointerId, moved: false, ops: [], error: null };
      active = { id: op.id, grip: hit.grip === 'move' ? null : hit.grip };
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = hit.grip === 'move' ? 'grabbing' : CURSOR[hit.grip];
      place();
      return true;
    },
    move(e, ray) {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= CLICK_PX) return;
      drag.moved = true;
      update(e, ray);
    },
    end(commit) {
      const d = drag;
      if (!d) return false;
      drag = null;
      label.style.display = 'none';
      controls.enabled = true;
      if (canvas.hasPointerCapture(d.pointerId)) canvas.releasePointerCapture(d.pointerId);
      canvas.style.cursor = '';
      o.setDims(null);
      o.setDragPreview(null);
      if (!d.moved) return false; // a click: it selects
      if (!commit) o.onStatus('Edit cancelled.');
      else if (d.ops.length) {
        const r = store.dispatch(d.ops);
        if (!r.ok) o.onStatus(r.error, true);
        else o.onStatus(d.error ? `Stopped at the last spot that works: ${d.error.split('\n')[0]}` : '', !!d.error);
      }
      place();
      return true;
    },
    clear() {
      if (drag || !active) return;
      active = null;
      place();
    },
  };
}
