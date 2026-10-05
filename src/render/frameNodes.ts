import { Vector3 } from 'three';
import type { Doc } from '../model/schema';
import { union, worldBoxes, type Box3 } from '../model/world';
import type { Viewport } from './viewport';

/** Fit inserted nodes using world bounds; preserve the user's viewing direction. */
export function frameNodes(viewport: Pick<Viewport, 'camera' | 'controls'>, doc: Doc, ids: readonly string[]): void {
  const boxes = worldBoxes(doc);
  const selected = ids.map((id) => boxes.get(id)).filter((box): box is Box3 => !!box);
  if (!selected.length) return;
  const bounds = union(selected);
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) return;
  const min = new Vector3(...bounds.min).divideScalar(64);
  const max = new Vector3(...bounds.max).divideScalar(64);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const radius = Math.max(1, min.distanceTo(max) / 2);
  const { camera, controls } = viewport;
  const vertical = camera.getEffectiveFOV() * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = radius * 1.15 / Math.sin(Math.min(vertical, horizontal));
  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 0.001) direction.set(1, 0.8, 1);
  camera.far = Math.max(camera.far, distance + radius * 2);
  camera.updateProjectionMatrix();
  setView(viewport, center.clone().addScaledVector(direction.normalize(), distance), center);
}

/** Puts the camera at `position` looking at `target` (inches), with no orbit damping carrying the old motion on. */
export function setView(viewport: Pick<Viewport, 'camera' | 'controls'>, position: Vector3, target: Vector3): void {
  const { camera, controls } = viewport;
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.target.copy(target);
  camera.position.copy(position);
  controls.update();
  controls.enableDamping = damping;
}
