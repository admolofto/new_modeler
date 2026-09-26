import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

// Phase 0: proves the test runner and three.js import work. Real tests start with the Phase 1 model.
describe('smoke', () => {
  it('imports three.js', () => {
    const box = new THREE.BoxGeometry(36, 34.5, 24);
    box.computeBoundingBox();
    expect(box.boundingBox?.max.x).toBe(18);
  });
});
