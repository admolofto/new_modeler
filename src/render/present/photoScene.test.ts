import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../../plugins/testDecor';
import { emptyDoc } from '../../model/defaults';
import { applyOps, type Op } from '../../model/ops';
import type { Doc } from '../../model/schema';
import { createSceneSync } from '../sceneSync';
import { createCut } from './cut';
import { presentLook } from './look';
import { buildPhotoScene, isGlass } from './photoScene';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

type Traced = THREE.Material & { castShadow?: boolean };
const meshesOf = (scene: THREE.Scene) => {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => (o as THREE.Mesh).isMesh && out.push(o as THREE.Mesh));
  return out;
};
const triangles = (meshes: THREE.Mesh[]) => meshes.reduce((n, m) => n + m.geometry.getIndex()!.count / 3, 0);

/**
 * The presentation scene as the session has it: an oak shelf, a wall (cut away), a glass pane, a
 * lamp (brass with a glowing frosted top), a hidden part, a Sky-like shader mesh, a sun, a hemisphere
 * fill and a spot that's off; an environment and a backdrop.
 */
function stage() {
  const doc = ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'material', id: 'oak', name: 'Oak', thickness: 48, color: '#aa7744', stock: 'solid' } },
    { op: 'add', entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'oak', shape: { type: 'box', params: { x: 1280, y: 48, z: 640 } } } },
    { op: 'add', entity: { kind: 'part', id: 'wall', name: 'Wall', material: 'oak', transform: { position: [0, 0, -640] }, shape: { type: 'box', params: { x: 1280, y: 1280, z: 64 } } } },
    { op: 'add', entity: { kind: 'part', id: 'hidden', name: 'Hidden', material: 'oak', transform: { position: [0, 640, 0] }, shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } } },
    { op: 'add', entity: { kind: 'part', id: 'pane', name: 'Pane', material: 'oak', finish: { preset: 'glass:clear' }, transform: { position: [0, 0, 2000] }, shape: { type: 'box', params: { x: 640, y: 640, z: 16 } } } },
    { op: 'add', entity: { kind: 'decor', id: 'lamp', transform: { position: [5000, 0, 0] }, shape: { type: 'testLamp', params: { x: 320, y: 640, z: 320 } } } },
  ]);
  const scene = new THREE.Scene();
  const look = presentLook();
  const sync = createSceneSync(scene, look);
  sync.update(doc);
  sync.meshOf('hidden')!.visible = false;
  const cut = createCut(look.appearance.shadowOnly);
  cut.set([sync.objectOf('wall')!]);

  const sky = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial());
  const sun = new THREE.DirectionalLight(0xfff1de, 3);
  sun.position.set(100, 80, 60);
  sun.target.position.set(10, 0, 5);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.2);
  const off = new THREE.SpotLight(0xffffff, 0);
  scene.add(sky, sun, sun.target, hemi, off, off.target);
  const env = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const backdrop = new THREE.Color(0.8, 0.79, 0.77);
  scene.environment = env;
  scene.background = backdrop;
  // As the session's scene is when a photo starts: placed (it has been drawn).
  scene.updateMatrixWorld(true);
  return { doc, scene, sync, cut, look, sky, sun, env, backdrop };
}

/** What the live scene looks like (to check nothing about it changed). */
function snapshot(scene: THREE.Scene) {
  const out: unknown[] = [scene.environment, scene.background];
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    out.push(o.uuid, o.visible, o.matrixWorld.elements.join(), Array.isArray(m) ? [...m] : m);
    for (const x of Array.isArray(m) ? m : m ? [m] : []) out.push(x.transparent, x.opacity, x.depthWrite, (x as Traced).castShadow, (x as THREE.MeshPhysicalMaterial).transmission);
  });
  return out;
}

describe('the photo scene', () => {
  const build = (s: ReturnType<typeof stage>) =>
    buildPhotoScene({
      live: s.scene,
      skip: new Set([s.sky]),
      isCut: (o) => s.cut.isCut(o),
      environment: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      background: s.backdrop,
      floor: { center: [0, -0.02, 0], radius: 800, near: 100, far: 300, color: [0.5, 0.5, 0.5] },
      softboxes: [{ position: [-50, 60, 80], target: [0, 10, 0], width: 30, height: 30, intensity: 4 }],
    });

  it('leaves the live scene exactly as it was (materials, visibility, environment), and after dispose too', () => {
    const s = stage();
    const before = snapshot(s.scene);
    const photo = build(s);
    expect(snapshot(s.scene)).toEqual(before);
    photo.dispose();
    expect(snapshot(s.scene)).toEqual(before);
    // The sky and the cut wall are still there, as they were.
    expect(s.sky.parent).toBe(s.scene);
    expect(s.sync.meshOf('wall')!.material).toBe(s.look.appearance.shadowOnly);
  });

  it('sets its own environment and background', () => {
    const s = stage();
    const photo = build(s);
    expect(photo.scene.environment).not.toBe(s.env);
    expect(photo.scene.background).toBe(s.backdrop);
    expect(s.scene.environment).toBe(s.env);
  });

  it('leaves out the sky, the cut wall and hidden parts', () => {
    const s = stage();
    const photo = build(s);
    const meshes = meshesOf(photo.scene);
    const at = (src: THREE.Mesh) => meshes.filter((m) => m.matrixWorld.equals(src.matrixWorld) && m.name === src.name);
    expect(meshes.some((m) => (m.material as THREE.Material).type === 'ShaderMaterial')).toBe(false);
    expect(at(s.sync.meshOf('wall')!)).toEqual([]);
    expect(at(s.sync.meshOf('hidden')!)).toEqual([]);
    expect(at(s.sync.meshOf('shelf')!)).toHaveLength(1);
    expect(meshes.some((m) => m.material === s.look.appearance.shadowOnly)).toBe(false);
  });

  it('draws each surface once, with one material per mesh, at its world placement', () => {
    const s = stage();
    const photo = build(s);
    const meshes = meshesOf(photo.scene).filter((m) => m.name !== 'photo floor');
    for (const m of meshes) {
      expect(Array.isArray(m.material)).toBe(false);
      expect(m.geometry.groups).toEqual([]);
    }
    // Every drawn triangle of the shelf, the pane and the lamp, none twice (a see-through child shares its parent's index).
    const drawn = ['shelf', 'pane', 'lamp'].reduce((n, id) => {
      const mesh = s.sync.meshOf(id)!;
      const all = [mesh, ...mesh.children.filter((c) => (c as THREE.Mesh).isMesh)] as THREE.Mesh[];
      // As three draws them: a material list draws its groups only (none: nothing — an all-glass part's
      // parent, whose child draws it); one material draws its groups, else everything.
      const groups = (x: THREE.Mesh) => x.geometry.groups.reduce((a, g) => a + g.count / 3, 0);
      const drawnBy = (x: THREE.Mesh) => (Array.isArray(x.material) ? groups(x) : !x.material.visible ? 0 : x.geometry.groups.length ? groups(x) : x.geometry.getIndex()!.count / 3);
      return n + all.reduce((k, x) => k + drawnBy(x), 0);
    }, 0);
    expect(triangles(meshes)).toBe(drawn);
    expect(triangles(meshes)).toBe(triangles([s.sync.meshOf('shelf')!]) + triangles([s.sync.meshOf('pane')!]) + triangles([s.sync.meshOf('lamp')!]));
    // The shelf sits where it's drawn (the model root's 1/64 included).
    const shelf = meshes.find((m) => m.name === s.sync.meshOf('shelf')!.name)!;
    expect(shelf.matrixWorld.elements).toEqual(s.sync.meshOf('shelf')!.matrixWorld.elements);
    expect(shelf.material).toBe(s.sync.meshOf('shelf')!.material);
  });

  it('turns glass transmissive, opaque and shadowless, in a stand-in material', () => {
    const s = stage();
    const live = s.sync.meshOf('pane')!.children[0] as THREE.Mesh;
    const liveGlass = (live.material as THREE.Material[]).find(isGlass)!;
    expect(liveGlass.transparent).toBe(true);
    const photo = build(s);
    const glass = meshesOf(photo.scene)
      .map((m) => m.material as THREE.MeshPhysicalMaterial & Traced)
      .filter((m) => m.transmission === 1);
    expect(glass.length).toBeGreaterThanOrEqual(2); // the pane's clear glass and the lamp's frosted top
    for (const g of glass) {
      expect(g.transparent).toBe(false);
      expect(g.opacity).toBe(1);
      expect(g.castShadow).toBe(false);
    }
    expect(glass.some((g) => g.roughness > 0.2)).toBe(true); // frosted stays rough
    expect(photo.stats.glass).toBe(glass.length);
    // The live glass is as it was.
    expect(liveGlass.transparent).toBe(true);
    expect((liveGlass as Traced).castShadow).toBeUndefined();
  });

  it('keeps a surface that casts no shadow in the raster from casting (a bulb around its light)', () => {
    const scene = new THREE.Scene();
    const bulbMat = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 6 });
    const brass = new THREE.MeshStandardMaterial();
    const g = new THREE.BoxGeometry();
    // A box comes with a group per face: the parent draws only the first half, the child the rest.
    g.clearGroups();
    g.addGroup(0, 18, 0);
    const parent = new THREE.Mesh(g, [brass, bulbMat]);
    parent.castShadow = true;
    const child = new THREE.Mesh(g.clone(), [brass, bulbMat]);
    child.geometry.clearGroups();
    child.geometry.addGroup(18, 18, 1);
    child.castShadow = false;
    parent.add(child);
    scene.add(parent);
    const photo = buildPhotoScene({ live: scene, skip: new Set(), isCut: () => false, environment: new THREE.Texture(), background: new THREE.Color(), floor: null, softboxes: [] });
    const mats = meshesOf(photo.scene).map((m) => m.material as Traced);
    expect(mats[0]).toBe(brass);
    expect(mats[1]).not.toBe(bulbMat);
    expect(mats[1]!.castShadow).toBe(false);
    expect((mats[1] as THREE.MeshStandardMaterial).emissiveIntensity).toBe(6);
    expect((bulbMat as Traced).castShadow).toBeUndefined();
    expect(meshesOf(photo.scene).map((m) => m.geometry.getIndex()!.count)).toEqual([18, 18]);
  });

  it('copies the lights that are on, in world space, and adds the softboxes', () => {
    const s = stage();
    const photo = build(s);
    const lights: THREE.Light[] = [];
    photo.scene.traverse((o) => (o as THREE.Light).isLight && lights.push(o as THREE.Light));
    const sun = lights.find((l) => (l as THREE.DirectionalLight).isDirectionalLight) as THREE.DirectionalLight;
    expect(sun).not.toBe(s.sun);
    expect(sun.intensity).toBe(3);
    expect(sun.position.toArray()).toEqual([100, 80, 60]);
    expect(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld).toArray()).toEqual([10, 0, 5]);
    // No hemisphere (unsupported), no light that's off.
    expect(lights.some((l) => (l as THREE.HemisphereLight).isHemisphereLight)).toBe(false);
    expect(lights.some((l) => (l as THREE.SpotLight).isSpotLight)).toBe(false);
    // The softbox faces its target with its lit (−Z) side.
    const box = lights.find((l) => l.name === 'photo softbox') as THREE.RectAreaLight;
    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(box.quaternion);
    const toTarget = new THREE.Vector3(0, 10, 0).sub(box.position).normalize();
    expect(facing.dot(toTarget)).toBeCloseTo(1);
    expect(photo.stats.lights).toBe(2);
  });

  it('adds a floor that fades out by alpha', () => {
    const s = stage();
    const photo = build(s);
    const floor = meshesOf(photo.scene).find((m) => m.name === 'photo floor')!;
    const m = floor.material as THREE.MeshStandardMaterial;
    expect(m.vertexColors && m.transparent).toBe(true);
    const color = floor.geometry.attributes.color!;
    expect(color.itemSize).toBe(4);
    const alphas = Array.from({ length: color.count }, (_, i) => color.getW(i));
    expect(Math.max(...alphas)).toBe(1);
    expect(Math.min(...alphas)).toBe(0);
    expect(floor.matrixWorld.elements[13]).toBeCloseTo(-0.02);
  });
});
