import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCut } from './cut';

describe('the presentation cutaway', () => {
  const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const wallMat = new THREE.MeshStandardMaterial();
  const glassMat = new THREE.MeshStandardMaterial();
  const make = () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), wallMat);
    wall.castShadow = true;
    const folder = new THREE.Group();
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(), wallMat);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(), glassMat);
    leaf.add(glass);
    folder.add(leaf);
    return { wall, folder, leaf, glass };
  };

  it('draws everything under the cut objects shadow-only, still casting, and marks it', () => {
    const { wall, folder, leaf, glass } = make();
    const cut = createCut(shadowOnly);
    expect(cut.set([wall, folder])).toBe(true);
    for (const m of [wall, leaf, glass]) {
      expect(m.material).toBe(shadowOnly);
      expect(m.userData.cutaway).toBe(true);
      expect(cut.isCut(m)).toBe(true);
    }
    expect(wall.castShadow).toBe(true);
    // The same cut again changes nothing.
    expect(cut.set([wall, folder])).toBe(false);
  });

  it('brings back what is no longer cut, with its own material', () => {
    const { wall, folder, leaf, glass } = make();
    const cut = createCut(shadowOnly);
    cut.set([wall, folder]);
    expect(cut.set([wall])).toBe(true);
    expect(leaf.material).toBe(wallMat);
    expect(glass.material).toBe(glassMat);
    expect(leaf.userData.cutaway).toBeUndefined();
    expect(cut.isCut(glass)).toBe(false);
    cut.clear();
    expect(wall.material).toBe(wallMat);
  });

  it('re-cuts a repainted mesh, keeping its new material for later', () => {
    const { wall } = make();
    const cut = createCut(shadowOnly);
    cut.set([wall]);
    const repainted = new THREE.MeshStandardMaterial();
    wall.material = repainted;
    cut.set([wall]);
    expect(wall.material).toBe(shadowOnly);
    cut.set([]);
    expect(wall.material).toBe(repainted);
  });

  it('lifts the cut for the length of a call', () => {
    const { wall } = make();
    const cut = createCut(shadowOnly);
    cut.set([wall]);
    const seen = cut.lifted(() => wall.material);
    expect(seen).toBe(wallMat);
    expect(wall.material).toBe(shadowOnly);
  });
});
