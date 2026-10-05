import * as THREE from 'three';
import { BLOCK_STEP } from '../edit/blocks';
import { dragChanges, driveOps, handleDrives, type HandleDrives } from '../edit/drives';
import { inferLine, inferPlane, partFrameBoxes } from '../edit/snap';
import { GROUND, type Target } from '../edit/targets';
import type { Handle, V3 } from '../geometry/types';
import { descendants, parentIndex } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { unclickableNodes } from '../model/visibility';
import type { Box3 } from '../model/world';
import type { Overlay } from '../render/overlay';
import { resolvePick } from '../render/pick';
import type { SceneSync } from '../render/sceneSync';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import type { GizmoControl } from './gizmoControl';
import type { Selection } from './selection';
import { fmt, shop } from './units';

/**
 * Viewport pointer handling. Hover highlights what a click would pick: the corner or edge right
 * under the cursor, else the face. Click selects it (shift / ctrl adds), double-click takes the
 * whole part, triple-click the whole piece (its top-level assembly). Dragging an already-selected
 * handle edits it: the drag is projected onto the handle's constraint (a face's normal, an outline
 * point's plane), snapped to other parts (flush faces, matching sizes — edit/snap.ts) or else to
 * 1/16" (hold Alt for 1/64" and no inference), previewed live, and committed on release as one
 * undo step. A selected block's faces push and pull like handles too (on a 1/2" grid), and the
 * move / turn gizmo takes drags that start on it. Any other left-drag draws a selection box,
 * SketchUp-style: left to right takes the parts wholly inside it, right to left the parts it touches
 * (shift / ctrl adds). The camera is on the other buttons (render/viewport.ts).
 */

export interface InteractionOptions {
  viewport: Viewport;
  sceneSync: SceneSync;
  overlay: Overlay;
  selection: Selection;
  store: Store;
  /** The doc on screen (an AI proposal while one is pending). */
  shown(): Doc;
  /** The doc as drawn (an isolated folder only): what drags snap to. */
  view?(doc: Doc): Doc;
  /** Why direct edits are off right now, or null. */
  editBlocked(): string | null;
  setDragPreview(doc: Doc | null): void;
  /** The part / assembly a drag snapped to (highlighted), or null. */
  setSnapNode(id: string | null): void;
  onPin(noteId: string): void;
  onStatus(msg: string, error?: boolean): void;
  /** Every hover change, including the point moved to within the same target (voice notes log these). */
  onHover?(t: Target | null): void;
  /** Look through note pins to the model (while dictating, pins mustn't hide what's pointed at). */
  ignorePins?(): boolean;
  /** A drawing tool has the pointer (the block tool): stay out of its way. */
  toolActive?(): boolean;
  /** Something is drawn open (doors, drawers): drags would edit the closed model, so they wait. */
  posed?(): boolean;
  /** The move / turn gizmo: gets first go at every press. */
  gizmo?: GizmoControl;
}

interface Picked {
  target: Target;
  mesh: THREE.Mesh;
  world: THREE.Vector3;
}

interface Drag {
  hd: HandleDrives;
  base: Doc;
  /** Part-local → world at drag start (the mesh may be rebuilt while previewing). */
  mw: THREE.Matrix4;
  inv: THREE.Matrix4;
  startWorld: THREE.Vector3;
  startLocal: THREE.Vector3;
  pointerId: number;
  /** Past the click threshold: until then a release is a click, not an edit. */
  moved: boolean;
  /** Last ops that applied cleanly (what release commits). */
  ops: Op[];
  /** Other parts' bounds in the dragged part's frame at drag start, for inference. */
  boxes: Map<string, Box3>;
  error: string | null;
}

const STYLE = `
.drag-label { position: fixed; z-index: 60; padding: 3px 8px; pointer-events: none; background: #141518f0; border: 1px solid var(--sel); border-radius: 6px;
  box-shadow: 0 4px 12px #0008; color: var(--fg); font: 500 var(--fs-sm)/1.4 var(--font); white-space: nowrap; }
.drag-label.bad { border-color: var(--bad); color: #f7b3ae; }
.select-box { position: fixed; z-index: 55; pointer-events: none; border: 1px solid var(--sel); background: color-mix(in srgb, var(--sel) 10%, transparent); }
.select-box.crossing { border-style: dashed; }
`;

/** How close (screen pixels) the cursor must be to a corner or an edge to pick it over the face. */
const VERTEX_PX = 8;
const EDGE_PX = 5;
/** A press that moves less than this is a click; more is an orbit or a drag. */
export const CLICK_PX = 5;
/** Inference reach, in screen pixels. */
export const SNAP_PX = 9;

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const round3 = (p: THREE.Vector3): V3 => [Math.round(p.x), Math.round(p.y), Math.round(p.z)];

export function attachInteraction(o: InteractionOptions): { cancelDrag(): boolean } {
  const { viewport, sceneSync, selection } = o;
  const { camera, controls, renderer } = viewport;
  const canvas = renderer.domElement;
  const container = canvas.parentElement!;
  const raycaster = new THREE.Raycaster();
  const occluder = new THREE.Raycaster();
  const label = el('div', { class: 'drag-label len' });
  label.style.display = 'none';
  const box = el('div', { class: 'select-box' });
  box.style.display = 'none';
  document.body.append(el('style', {}, STYLE), label, box);

  let mouse = { x: 0, y: 0 };
  const setRay = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    raycaster.setFromCamera(new THREE.Vector2((mouse.x / r.width) * 2 - 1, -(mouse.y / r.height) * 2 + 1), camera);
  };
  const toScreen = (p: THREE.Vector3) => {
    const r = canvas.getBoundingClientRect();
    const q = p.clone().project(camera);
    return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height, behind: q.z > 1 };
  };
  const local = (mesh: THREE.Mesh, world: THREE.Vector3): V3 => round3(mesh.worldToLocal(world.clone()));

  /** A point is visible if nothing sits in front of it along the line of sight. */
  const visible = (p: THREE.Vector3) => {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occluder.set(camera.position, dir.normalize());
    const hit = occluder.intersectObjects(sceneSync.pickable(), false)[0];
    return !hit || hit.distance >= dist - Math.max(0.05, dist * 0.002);
  };

  /**
   * The corner or edge handle right under the cursor, if there is one and nothing hides it. Corners
   * win over edges (they're the smaller target), then the nearer over the farther.
   */
  function nearestHandle(): Picked | null {
    const found: { rank: number; mesh: THREE.Mesh; h: Handle; world: THREE.Vector3 }[] = [];
    for (const mesh of sceneSync.pickable()) {
      for (const h of (mesh.userData.handles as Handle[] | undefined) ?? []) {
        if (h.kind === 'face') continue;
        const edge = h.kind === 'edge';
        const pts = h.points.map((p) => v3(p).applyMatrix4(mesh.matrixWorld));
        const scr = pts.map(toScreen);
        if (scr.some((s) => s.behind)) continue;
        let s = 0;
        if (edge) {
          const [a, b] = [scr[0]!, scr[1]!];
          const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
          s = len2 ? Math.max(0, Math.min(1, ((mouse.x - a.x) * (b.x - a.x) + (mouse.y - a.y) * (b.y - a.y)) / len2)) : 0;
        }
        const at = edge ? { x: scr[0]!.x + (scr[1]!.x - scr[0]!.x) * s, y: scr[0]!.y + (scr[1]!.y - scr[0]!.y) * s } : scr[0]!;
        const d = Math.hypot(at.x - mouse.x, at.y - mouse.y);
        if (d <= (edge ? EDGE_PX : VERTEX_PX)) found.push({ rank: d + (edge ? VERTEX_PX : 0), mesh, h, world: edge ? pts[0]!.clone().lerp(pts[1]!, s) : pts[0]! });
      }
    }
    found.sort((a, b) => a.rank - b.rank);
    for (const c of found.slice(0, 8)) {
      if (visible(c.world)) return { target: { node: c.mesh.userData.partId, handle: c.h.id, at: local(c.mesh, c.world) }, mesh: c.mesh, world: c.world };
    }
    return null;
  }

  /** A note pin, else the corner or edge right under the cursor, else the face. */
  function pick(e: MouseEvent): { pin: string } | Picked | null {
    setRay(e);
    const pin = o.ignorePins?.() ? null : o.overlay.pinAt(raycaster);
    if (pin) return { pin };
    const near = nearestHandle();
    if (near) return near;
    const hit = raycaster.intersectObjects(sceneSync.pickable(), false)[0];
    if (!hit) return null;
    const mesh = hit.object as THREE.Mesh;
    const at = local(mesh, hit.point);
    const r = resolvePick(hit);
    return { target: r ? { node: r.partId, handle: r.tag, at } : { node: mesh.userData.partId as string, at }, mesh, world: hit.point };
  }

  const draggable = (t: Target) => !o.editBlocked() && !o.posed?.() && !!handleDrives(o.store.doc, t)?.constraint;
  /** What a press on a pick would drag: a selected handle, or a face of a selected block (it pushes and pulls). */
  const dragTarget = (p: Picked): Target | null => {
    const { node } = p.target;
    return selection.has(p.target) || (o.store.doc.parts[node]?.block && selection.has({ node })) ? p.target : null;
  };

  // ── Drag ──────────────────────────────────────────────────────────────────────
  let drag: Drag | null = null;
  let down: { x: number; y: number; pick: ReturnType<typeof pick>; additive: boolean } | null = null;

  const snap = (n: number, step: number) => Math.round(n / step) * step;
  const signed = (u: number) => `${u >= 0 ? '+' : '−'}${fmt(Math.abs(u))}`;
  const unitsPerPx = viewport.unitsPerPx;

  function updateDrag(e: PointerEvent) {
    const d = drag!;
    const seen = o.view?.(d.base) ?? d.base;
    setRay(e);
    const c = d.hd.constraint!;
    const step = e.altKey ? 1 : d.hd.part.block ? BLOCK_STEP : 4;
    const tol = e.altKey ? 0 : SNAP_PX * unitsPerPx(d.startWorld);
    const ray = raycaster.ray;
    let disp: V3;
    let moved: string;
    let inferred: string[] = [];
    let snapNode: string | null = null;
    if (c.kind === 'line') {
      const dirL = v3(c.dir);
      const D = dirL.clone().transformDirection(d.mw);
      const w0 = d.startWorld.clone().sub(ray.origin);
      const b = D.dot(ray.direction);
      const denom = 1 - b * b;
      if (denom < 1e-4) return; // dragging straight along the view direction
      const t = (b * ray.direction.dot(w0) - D.dot(w0)) / denom;
      const p = d.startWorld.clone().addScaledVector(D, t).applyMatrix4(d.inv).sub(d.startLocal);
      const inf = tol ? inferLine(seen, d.hd, c.dir, p.dot(dirL), tol, d.boxes) : null;
      const s = inf ? inf.s : snap(p.dot(dirL), step);
      if (inf) {
        inferred = [inf.label];
        snapNode = inf.node;
      }
      disp = [dirL.x * s, dirL.y * s, dirL.z * s];
      moved = signed(s);
    } else {
      const U = v3(c.u).transformDirection(d.mw);
      const V = v3(c.v).transformDirection(d.mw);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(U.clone().cross(V).normalize(), d.startWorld);
      const hit = ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      const p = hit.applyMatrix4(d.inv).sub(d.startLocal);
      const raw: [number, number] = [p.dot(v3(c.u)), p.dot(v3(c.v))];
      const inf = tol ? inferPlane(seen, d.hd, c.u, c.v, raw, tol, d.boxes) : null;
      const pick = (i: 0 | 1) => (inf && inf.s[i] !== raw[i] ? inf.s[i] : snap(raw[i], step));
      const [su, sv] = [pick(0), pick(1)];
      if (inf) {
        inferred = inf.labels;
        snapNode = inf.nodes.find((n) => n !== d.hd.part.id) ?? null;
      }
      disp = [0, 1, 2].map((k) => c.u[k]! * su + c.v[k]! * sv) as V3;
      moved = `${signed(su)}, ${signed(sv)}`;
    }
    const changes = dragChanges(d.hd, disp);
    const ops = driveOps(d.base, d.hd.part.id, changes);
    const r = ops.length ? applyOps(d.base, ops) : ({ ok: true, doc: d.base } as const);
    const one = changes.length === 1 ? changes[0]! : null;
    const text = (one ? `${one.drive.label} ${fmt(one.drive.value + one.delta)} (${signed(one.delta)})` : `moved ${moved}`) + inferred.map((x) => ` · ${x}`).join('');
    o.setSnapNode(snapNode);
    if (r.ok) {
      d.ops = ops;
      d.error = null;
      o.setDragPreview(r.doc);
      label.replaceChildren(...shop(text));
    } else {
      d.error = r.error;
      label.replaceChildren(...shop(`${text} — ${r.error.split('\n')[0]}`));
    }
    label.classList.toggle('bad', !r.ok);
    label.style.display = '';
    label.style.left = `${e.clientX + 16}px`;
    label.style.top = `${e.clientY + 12}px`;
  }

  function endDrag(commit: boolean) {
    const d = drag!;
    drag = null;
    label.style.display = 'none';
    controls.enabled = true;
    if (canvas.hasPointerCapture(d.pointerId)) canvas.releasePointerCapture(d.pointerId);
    canvas.style.cursor = '';
    o.setSnapNode(null);
    o.setDragPreview(null);
    if (!d.moved) return; // a click on a selected handle, not an edit
    if (!commit) return o.onStatus('Edit cancelled.');
    if (d.ops.length) {
      const r = o.store.dispatch(d.ops);
      if (!r.ok) return o.onStatus(r.error, true);
    }
    o.onStatus(d.error ? `Stopped at the last size that works: ${d.error.split('\n')[0]}` : '', !!d.error);
  }

  container.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || drag || o.gizmo?.dragging || o.toolActive?.()) return;
      if (o.gizmo?.down(e)) {
        // The gizmo took the gesture from the orbit controls.
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      const p = pick(e);
      down = { x: e.clientX, y: e.clientY, pick: p, additive: e.shiftKey || e.ctrlKey || e.metaKey };
      const t = p && !('pin' in p) ? dragTarget(p) : null;
      if (!p || 'pin' in p || !t) return;
      const blocked = o.editBlocked();
      const hd = handleDrives(o.store.doc, t);
      if (!hd?.constraint) return;
      if (blocked) return o.onStatus(blocked, true);
      // Drawn open: the handles aren't where the model has them (clicks still select).
      if (o.posed?.()) return;
      // Take the gesture from the orbit controls.
      e.stopPropagation();
      e.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      const mw = p.mesh.matrixWorld.clone();
      const inv = mw.clone().invert();
      const base = o.store.doc;
      drag = { hd, base, mw, inv, startWorld: p.world.clone(), startLocal: p.world.clone().applyMatrix4(inv), pointerId: e.pointerId, moved: false, ops: [], error: null, boxes: partFrameBoxes(base, hd.part.id) };
      canvas.style.cursor = 'grabbing';
    },
    { capture: true },
  );

  // ── Box select ────────────────────────────────────────────────────────────────
  let boxing = false;

  function showBox(x0: number, y0: number, x1: number, y1: number) {
    boxing = true;
    box.classList.toggle('crossing', x1 < x0);
    Object.assign(box.style, { display: '', left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
  }

  const shownInScene = (obj: THREE.Object3D | null): boolean => !obj || (obj.visible && shownInScene(obj.parent));

  /** Parts in a client-space box: wholly inside it (window), or touching it (crossing, dragged right to left). */
  function partsInBox(x0: number, y0: number, x1: number, y1: number): string[] {
    const r = canvas.getBoundingClientRect();
    const [left, right, top, bottom] = [Math.min(x0, x1) - r.left, Math.max(x0, x1) - r.left, Math.min(y0, y1) - r.top, Math.max(y0, y1) - r.top];
    const crossing = x1 < x0;
    const p = new THREE.Vector3();
    const ids: string[] = [];
    for (const mesh of sceneSync.pickable()) {
      if (!shownInScene(mesh)) continue;
      const pos = mesh.geometry.getAttribute('position');
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      let behind = false;
      for (let i = 0; i < pos.count; i++) {
        const s = toScreen(p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
        if (s.behind) {
          behind = true;
          continue;
        }
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
      }
      if (minX > maxX) continue;
      const hit = crossing
        ? minX <= right && maxX >= left && minY <= bottom && maxY >= top
        : !behind && minX >= left && maxX <= right && minY >= top && maxY <= bottom;
      if (hit) ids.push(mesh.userData.partId as string);
    }
    return ids;
  }

  function endBox(e: PointerEvent, d: NonNullable<typeof down>) {
    boxing = false;
    box.style.display = 'none';
    const ids = partsInBox(d.x, d.y, e.clientX, e.clientY);
    const picked = ids.map((node) => ({ node }));
    if (!d.additive) return selection.set(picked);
    const added = picked.filter((t) => !selection.has(t));
    if (added.length) selection.set([...selection.targets, ...added]);
  }

  const hover = (t: Target | null) => {
    selection.setHover(t);
    o.onHover?.(t);
  };

  /** Where the ray meets the drawn floor grid (voice notes about nothing on the model pin there). */
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundAt(): Target | null {
    const p = raycaster.ray.intersectPlane(floor, new THREE.Vector3());
    if (!p || !viewport.grid.contains(p.x, p.z)) return null;
    // Not through the model (edge / vertex modes pick nothing off a handle).
    if (raycaster.intersectObjects(sceneSync.pickable(), false).length) return null;
    return { node: GROUND, at: round3(p.setY(0).multiplyScalar(UNITS_PER_INCH)) };
  }

  let hoverFrame = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      if (!drag.moved && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_PX) return;
      drag.moved = true;
      return updateDrag(e);
    }
    if (o.gizmo?.dragging) return o.gizmo.move(e);
    if (o.toolActive?.()) return selection.setHover(null);
    if (down) {
      if (boxing || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) {
        hover(null);
        showBox(down.x, down.y, e.clientX, e.clientY);
      }
      return;
    }
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      if (o.gizmo?.hover(e)) {
        selection.setHover(null);
        canvas.style.cursor = 'grab';
        return;
      }
      const p = pick(e);
      const picked = p && !('pin' in p) ? p : null;
      const t = picked ? picked.target : null;
      if (t || p) hover(t);
      else {
        selection.setHover(null);
        o.onHover?.(groundAt());
      }
      const grab = picked && dragTarget(picked);
      canvas.style.cursor = p && 'pin' in p ? 'pointer' : grab && draggable(grab) ? 'grab' : '';
    });
  });
  canvas.addEventListener('pointerleave', () => {
    if (!drag) hover(null);
  });

  window.addEventListener('pointerup', (e) => {
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      endDrag(true);
      if (moved) return; // else it was a click: select below
    }
    if (o.gizmo?.dragging) return o.gizmo.end(true);
    const d = down;
    down = null;
    if (d && boxing) return endBox(e, d);
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX || o.toolActive?.()) return;
    const p = d.pick;
    if (p && 'pin' in p) return o.onPin(p.pin);
    if (p) {
      if (d.additive) selection.toggle(p.target);
      else selection.set([p.target]);
    } else if (!d.additive) {
      selection.set([]);
    }
  });

  // Double-click: the whole part (shift / ctrl: added, in place of its faces, edges and corners).
  container.addEventListener('dblclick', (e) => {
    if (o.toolActive?.() || drag) return;
    const p = pick(e);
    if (!p || 'pin' in p) return;
    const { node } = p.target;
    const rest = e.shiftKey || e.ctrlKey || e.metaKey ? selection.targets.filter((t) => t.node !== node) : [];
    selection.set([...rest, { node }]);
  });

  // Triple-click: the whole piece (the top-level assembly) the part is in.
  container.addEventListener('click', (e) => {
    if (e.detail !== 3 || o.toolActive?.() || drag) return;
    const p = pick(e);
    if (!p || 'pin' in p) return;
    const doc = o.store.doc;
    const parents = parentIndex(doc);
    let top = p.target.node;
    for (let q = parents.get(top); q; q = parents.get(q)) top = q;
    if (!doc.assemblies[top]) return;
    const locked = unclickableNodes(doc);
    selection.set(descendants(doc, top).filter((id) => doc.parts[id] && !locked.has(id)).map((node) => ({ node })));
  });

  return {
    cancelDrag() {
      if (o.gizmo?.dragging) {
        o.gizmo.end(false);
        return true;
      }
      if (boxing) {
        boxing = false;
        box.style.display = 'none';
        down = null;
        return true;
      }
      if (!drag) return false;
      endDrag(false);
      return true;
    },
  };
}
