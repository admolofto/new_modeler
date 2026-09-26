import * as THREE from 'three';
import type { V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';
import type { Mat3 } from '../model/world';
import { PALETTE } from './palette';
import type { Viewport } from './viewport';

/**
 * The move / turn gizmo, Blender-style, drawn over everything at the center of what's selected:
 * three arrows (move along the piece's own axes), a square (slide along its floor plane) and three
 * rings (turn about each axis). It keeps the same size on screen. Picking uses fatter invisible
 * shapes than the ones drawn, so the thin lines are easy to grab.
 */

export type GizmoHandle = { kind: 'axis'; k: 0 | 1 | 2 } | { kind: 'plane' } | { kind: 'ring'; k: 0 | 1 | 2 };

export interface Gizmo {
  /** Puts the gizmo at a world point (model units), turned to a frame; null hides it. */
  place(at: { pivot: V3; m: Mat3 } | null): void;
  readonly visible: boolean;
  /** The handle under the ray, if any. */
  pick(raycaster: THREE.Raycaster): GizmoHandle | null;
  /** Lights up a handle (hover or drag). */
  highlight(h: GizmoHandle | null): void;
}

/** Arrow length in screen pixels (everything else scales with it). */
const SIZE_PX = 72;
const AXIS_COLORS = [PALETTE.axisX, PALETTE.axisY, PALETTE.axisZ];
const key = (h: GizmoHandle | null) => (h ? `${h.kind}${'k' in h ? h.k : ''}` : '');

export function createGizmo(viewport: Viewport): Gizmo {
  const root = new THREE.Group();
  root.name = 'gizmo';
  root.visible = false;
  root.renderOrder = 30;
  viewport.scene.add(root);

  const parts: { h: GizmoHandle; shown: THREE.Mesh[]; hit: THREE.Mesh; color: number }[] = [];
  const mat = (color: number, opacity = 1) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, side: THREE.DoubleSide });
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const add = (h: GizmoHandle, color: number, shown: THREE.Mesh[], hit: THREE.Mesh) => {
    for (const m of shown) {
      m.renderOrder = 30;
      root.add(m);
    }
    hit.userData.handle = h;
    root.add(hit);
    parts.push({ h, shown, hit, color });
  };
  // Axis k's direction in the gizmo's local frame, and a rotation that turns +Y onto it.
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const onto = (k: number) => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirs[k]!);

  for (const k of [0, 1, 2] as const) {
    const q = onto(k);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.78, 8).translate(0, 0.39 + 0.12, 0), mat(AXIS_COLORS[k]!));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 16).translate(0, 1, 0), mat(AXIS_COLORS[k]!));
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1, 6).translate(0, 0.6, 0), hitMat);
    for (const m of [shaft, head, hit]) m.quaternion.copy(q);
    add({ kind: 'axis', k }, AXIS_COLORS[k]!, [shaft, head], hit);
  }

  // The floor square, colored like the axis it's across (y).
  const square = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2).rotateX(-Math.PI / 2).translate(0.3, 0, 0.3), mat(PALETTE.axisY, 0.55));
  const squareHit = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28).rotateX(-Math.PI / 2).translate(0.3, 0, 0.3), hitMat);
  add({ kind: 'plane' }, PALETTE.axisY, [square], squareHit);

  for (const k of [0, 1, 2] as const) {
    // TorusGeometry lies in XY (axis Z): turn its axis onto k.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirs[k]!);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.016, 6, 96), mat(AXIS_COLORS[k]!, 0.9));
    const hit = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.06, 6, 48), hitMat);
    for (const m of [ring, hit]) m.quaternion.copy(q);
    add({ kind: 'ring', k }, AXIS_COLORS[k]!, [ring], hit);
  }

  let placed: { pivot: V3; m: Mat3 } | null = null;
  let lit = '';
  const S = 1 / UNITS_PER_INCH;
  viewport.onFrame(() => {
    if (!placed) return;
    // Arrow length SIZE_PX pixels: scene units are inches.
    root.scale.setScalar((viewport.unitsPerPx(root.position) * SIZE_PX) / UNITS_PER_INCH);
  });

  return {
    place(at) {
      placed = at;
      root.visible = !!at;
      if (!at) return;
      root.position.set(at.pivot[0] * S, at.pivot[1] * S, at.pivot[2] * S);
      const [r0, r1, r2] = at.m;
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(r0[0], r0[1], r0[2], 0, r1[0], r1[1], r1[2], 0, r2[0], r2[1], r2[2], 0, 0, 0, 0, 1));
      root.scale.setScalar((viewport.unitsPerPx(root.position) * SIZE_PX) / UNITS_PER_INCH);
      root.updateMatrixWorld(true);
    },
    get visible() {
      return root.visible;
    },
    pick(raycaster) {
      if (!root.visible) return null;
      root.updateMatrixWorld(true);
      const hits = raycaster.intersectObjects(parts.map((p) => p.hit), false);
      // Arrows and the square win over the rings they sit inside.
      const best = hits.find((x) => (x.object.userData.handle as GizmoHandle).kind !== 'ring') ?? hits[0];
      return (best?.object.userData.handle as GizmoHandle | undefined) ?? null;
    },
    highlight(h) {
      const k = key(h);
      if (k === lit) return;
      lit = k;
      for (const p of parts) {
        const on = key(p.h) === k;
        for (const m of p.shown) (m.material as THREE.MeshBasicMaterial).color.set(on ? PALETTE.gizmoHot : p.color);
      }
    },
  };
}
