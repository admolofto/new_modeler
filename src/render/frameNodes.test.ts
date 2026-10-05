import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import { applyOps } from '../model/ops';
import type { Viewport } from './viewport';
import { frameNodes } from './frameNodes';

describe('frame inserted nodes', () => {
  it('centers distant inserted geometry and fits it in a narrow viewport', () => {
    const result = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'part', id: 'far', name: 'Far panel', material: 'ply-3-4',
      transform: { position: [64000, 12800, -6400] }, shape: { type: 'box', params: { x: 6400, y: 1280, z: 64 } } } }]);
    if (!result.ok) throw new Error(result.error);
    const camera = new PerspectiveCamera(45, 0.4, 0.5, 2000);
    camera.position.set(70, 55, 90);
    const target = new Vector3(18, 17, 12);
    const direction = camera.position.clone().sub(target).normalize();
    const controls = { target, enableDamping: true, update: vi.fn(() => { camera.lookAt(target); camera.updateMatrixWorld(); }) };
    frameNodes({ camera, controls: controls as unknown as Viewport['controls'] }, result.doc, ['far']);
    expect(target.toArray()).toEqual([1050, 210, -99.5]);
    expect(camera.position.clone().sub(target).normalize().distanceTo(direction)).toBeLessThan(1e-10);
    expect(controls.enableDamping).toBe(true);
    for (const x of [1000, 1100]) for (const y of [200, 220]) for (const z of [-100, -99]) {
      const point = new Vector3(x, y, z).project(camera);
      expect(Math.abs(point.x)).toBeLessThan(1);
      expect(Math.abs(point.y)).toBeLessThan(1);
      expect(Math.abs(point.z)).toBeLessThan(1);
    }
  });
});
