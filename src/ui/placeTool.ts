import * as THREE from 'three';
import { ceilingAt, dropPoint, dropTransform, mountOf, type Mount, type SurfaceHit } from '../edit/place';
import type { V3 } from '../geometry/types';
import { nextId } from '../model/doc';
import { numberedName, type Op } from '../model/ops';
import type { Transform } from '../model/schema';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { rotation } from '../model/world';
import { generators, shapes } from '../plugins';
import { buildPart } from '../plugins/pipeline';
import { toGeometry, type SceneSync } from '../render/sceneSync';
import type { Viewport } from '../render/viewport';
import { CLICK_PX } from './interaction';
import type { Selection } from './selection';

/**
 * The place tool (A8): after an item is picked from the Props catalog, a see-through ghost of it
 * follows the cursor — resting on the floor, a counter or a cabinet top (every mesh counts, the
 * unclickable floor too; else the y = 0 plane), hanging from the ceiling (pendants, cans), stuck under
 * a cabinet (strips) or at its usual height (a hood) — its front turned toward the camera. A click
 * drops it as one op (one undo step) and selects it, so the gizmo and Ctrl+D take over; Shift-click
 * keeps the tool for another; Esc cancels. Middle-drag still orbits.
 */

/** A catalog item: a decor shape (a prop) or a generator (an appliance). */
export interface PlaceItem {
  kind: 'decor' | 'generator';
  type: string;
  label: string;
}

export interface PlaceToolOptions {
  viewport: Viewport;
  sceneSync: SceneSync;
  store: Store;
  selection: Selection;
  editBlocked(): string | null;
  onStatus(msg: string, error?: boolean): void;
}

export interface PlaceTool {
  readonly active: boolean;
  readonly item: PlaceItem | null;
  start(item: PlaceItem): void;
  stop(): void;
  /** On / off changed. */
  subscribe(fn: () => void): void;
}

const GHOST = 0x4f8cff;

/** Its params for a new one, and its size (its own x, y, z). */
function prepare(item: PlaceItem): { params: Record<string, unknown>; size: V3; mesh?: ReturnType<typeof buildPart>['mesh'] } {
  if (item.kind === 'generator') {
    const params = generators.parse(item.type, {});
    return { params, size: [params.width as number, params.height as number, params.depth as number] };
  }
  const def = shapes.get(item.type);
  const params = shapes.parse(item.type, def.decor?.defaults ?? {});
  const { mesh } = buildPart({ id: 'ghost', name: item.label, grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type: item.type, params }, features: [] });
  const size: V3 = [0, 0, 0];
  for (let i = 0; i < mesh.positions.length; i++) size[i % 3] = Math.max(size[i % 3]!, mesh.positions[i]!);
  return { params, size, mesh };
}

export function attachPlaceTool(o: PlaceToolOptions): PlaceTool {
  const { viewport, sceneSync, store } = o;
  const { camera, renderer, scene } = viewport;
  const canvas = renderer.domElement;
  const container = canvas.parentElement!;
  const raycaster = new THREE.Raycaster();
  const U = UNITS_PER_INCH;

  // The ghost: in model units under a 1/64 holder, like the model root.
  const holder = new THREE.Group();
  holder.scale.setScalar(1 / U);
  holder.visible = false;
  scene.add(holder);
  const fill = new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.35, depthWrite: false });
  const lines = new THREE.LineBasicMaterial({ color: GHOST, transparent: true, opacity: 0.9 });
  let ghost: THREE.Object3D | null = null;

  let current: { item: PlaceItem; params: Record<string, unknown>; size: V3; mount: Mount } | null = null;
  let drop: Transform | null = null;
  let last: PointerEvent | null = null;
  let down: { x: number; y: number; moved: boolean } | null = null;
  const listeners = new Set<() => void>();

  const clearGhost = () => {
    if (!ghost) return;
    holder.remove(ghost);
    ghost.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) c.geometry.dispose();
    });
    ghost = null;
  };

  function makeGhost(size: V3, mesh?: ReturnType<typeof buildPart>['mesh']): THREE.Object3D {
    const geometry = mesh ? toGeometry(mesh) : new THREE.BoxGeometry(...size).translate(size[0] / 2, size[1] / 2, size[2] / 2);
    const g = new THREE.Group();
    const body = new THREE.Mesh(geometry, fill);
    body.renderOrder = 10;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), lines);
    edges.renderOrder = 11;
    g.add(body, edges);
    // Never picked by anything (the block tool, clicks, hover).
    g.traverse((c) => (c.raycast = () => {}));
    return g;
  }

  const setRay = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  };

  /** Where the item would go for the cursor now (null: nowhere, e.g. pointing at the sky). */
  function where(e: PointerEvent): Transform | null {
    if (!current) return null;
    setRay(e);
    const hitAt = raycaster.intersectObjects(sceneSync.meshes(), false)[0];
    let hit: SurfaceHit | null = null;
    if (hitAt?.face) {
      const n = hitAt.face.normal.clone().transformDirection(hitAt.object.matrixWorld);
      hit = { point: hitAt.point.toArray().map((c) => c * U) as V3, normal: n.toArray() as V3 };
    }
    const ray = raycaster.ray;
    const t = Math.abs(ray.direction.y) > 1e-6 ? -ray.origin.y / ray.direction.y : -1;
    const floor: V3 | null = t > 0 ? (ray.at(t, new THREE.Vector3()).toArray().map((c) => c * U) as V3) : null;
    const at = dropPoint(hit, floor, current.mount);
    if (!at) return null;
    const toCamera = ray.direction.clone().negate().toArray() as V3;
    return dropTransform(current.size, at, toCamera, current.mount, ceilingAt(store.doc, at[0], at[2])).transform;
  }

  function update(e: PointerEvent) {
    drop = where(e);
    if (!ghost || !drop) {
      holder.visible = false;
      return;
    }
    holder.visible = true;
    const R = rotation(drop.rotation);
    const m = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);
    ghost.quaternion.setFromRotationMatrix(m);
    ghost.position.set(...drop.position);
  }

  function commit(keep: boolean) {
    if (!current || !drop) return;
    const blocked = o.editBlocked();
    if (blocked) return o.onStatus(blocked, true);
    const doc = store.doc;
    const { item, params } = current;
    const id = nextId(doc, item.kind === 'decor' ? 'p' : 'a');
    const op: Op =
      item.kind === 'decor'
        ? { op: 'add', entity: { kind: 'decor', id, transform: drop, shape: { type: item.type, params: structuredClone(params) } } }
        : { op: 'add', entity: { kind: 'assembly', id, name: numberedName(doc, item.label), transform: drop, generator: { type: item.type, params: structuredClone(params) } } };
    const r = store.dispatch([op]);
    if (!r.ok) return o.onStatus(r.error, true);
    const name = store.doc.parts[id]?.name ?? store.doc.assemblies[id]?.name ?? item.label;
    if (keep) {
      o.onStatus(`Added ${name}. Click to drop another, Esc to stop.`);
      return;
    }
    stop();
    o.selection.set([{ node: id }]);
    o.onStatus(`Added ${name}. Drag the gizmo to move it; Ctrl+D copies it.`);
  }

  function start(item: PlaceItem) {
    const blocked = o.editBlocked();
    if (blocked) return o.onStatus(blocked, true);
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare(item);
    } catch (err) {
      return o.onStatus(err instanceof Error ? err.message : String(err), true);
    }
    clearGhost();
    current = { item, params: prepared.params, size: prepared.size, mount: mountOf(item.type, prepared.params) };
    ghost = makeGhost(prepared.size, prepared.mesh);
    holder.add(ghost);
    holder.visible = false;
    canvas.style.cursor = 'copy';
    o.selection.setHover(null);
    o.onStatus(`${item.label}: click where it goes (Shift: keep going), Esc to cancel.`);
    if (last) update(last);
    listeners.forEach((fn) => fn());
  }

  function stop() {
    if (!current) return;
    current = null;
    drop = null;
    down = null;
    clearGhost();
    holder.visible = false;
    canvas.style.cursor = '';
    listeners.forEach((fn) => fn());
  }

  container.addEventListener(
    'pointerdown',
    (e) => {
      if (!current || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, moved: false };
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (e) => {
    last = e;
    if (!current) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) down.moved = true;
    update(e);
  });
  canvas.addEventListener('pointerleave', () => {
    if (current) holder.visible = false;
  });
  window.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!current || !d || d.moved || e.button !== 0) return;
    update(e);
    commit(e.shiftKey);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!current || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
      o.onStatus('');
    },
    { capture: true },
  );

  return {
    get active() {
      return !!current;
    },
    get item() {
      return current?.item ?? null;
    },
    start,
    stop,
    subscribe: (fn) => void listeners.add(fn),
  };
}
