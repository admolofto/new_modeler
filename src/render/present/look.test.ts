import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../../plugins/testDecor';
import { emptyDoc } from '../../model/defaults';
import { swatchOf } from '../../model/finishes';
import { applyOps, type Op } from '../../model/ops';
import type { Doc } from '../../model/schema';
import { createSceneSync } from '../sceneSync';
import { HOVER_LIFT, MASSING, presentLook, usedTextureSets } from './look';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const hex = (m: THREE.Material) => `#${(m as THREE.MeshStandardMaterial).color.getHexString()}`;
const mats = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
const seeThrough = (mesh: THREE.Mesh) => mesh.children[0] as THREE.Mesh | undefined;

/** Oak with an inferred finish, navy MDF with a set one, a glass panel, a block and a two-surface lamp. */
function scene(): Doc {
  return ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'material', id: 'oak', name: 'Old oak', thickness: 48, color: '#aa7744', stock: 'solid' } },
    { op: 'add', entity: { kind: 'material', id: 'navy', name: 'Navy MDF', thickness: 48, color: '#123456', stock: 'sheet', finish: { preset: 'paint', color: '#1f2a44' } } },
    { op: 'add', entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'oak', grain: 'x', shape: { type: 'box', params: { x: 1280, y: 48, z: 640 } } } },
    { op: 'add', entity: { kind: 'part', id: 'shelf2', name: 'Shelf 2', material: 'oak', transform: { position: [0, 640, 0] }, shape: { type: 'box', params: { x: 1280, y: 48, z: 640 } } } },
    { op: 'add', entity: { kind: 'part', id: 'door', name: 'Door', material: 'navy', transform: { position: [0, 0, 1000] }, shape: { type: 'box', params: { x: 640, y: 1280, z: 48 } } } },
    { op: 'add', entity: { kind: 'part', id: 'pane', name: 'Pane', material: 'oak', finish: { preset: 'glass:clear' }, transform: { position: [0, 0, 2000] }, shape: { type: 'box', params: { x: 640, y: 640, z: 16 } } } },
    { op: 'add', entity: { kind: 'block', size: [960, 960, 960], transform: { position: [3000, 0, 0] } } },
    { op: 'add', entity: { kind: 'decor', id: 'lamp', transform: { position: [5000, 0, 0] }, shape: { type: 'testLamp', params: { x: 320, y: 640, z: 320 } } } },
  ]);
}

describe('the present look', () => {
  const look = presentLook();
  const sync = createSceneSync(new THREE.Scene(), look);
  const doc = scene();
  sync.update(doc);

  it('draws no edge lines or block arrows (only a see-through child where there is glass)', () => {
    for (const id of ['shelf', 'door', 'b1']) expect(sync.meshOf(id)!.children).toEqual([]);
    for (const id of ['pane', 'lamp']) expect(sync.meshOf(id)!.children.map((c) => (c as THREE.Mesh).isMesh)).toEqual([true]);
  });

  it('colors a part by its finish swatch (no textures loaded), inferred or set, not by the material color', () => {
    // "Old oak" infers red oak.
    expect(mats(sync.meshOf('shelf')!).map(hex)).toEqual([swatchOf({ preset: 'wood:red-oak' })]);
    expect(mats(sync.meshOf('door')!).map(hex)).toEqual(['#1f2a44']);
    expect(mats(sync.meshOf('shelf')!)[0]!.roughness).toBeCloseTo(0.5);
  });

  it('shares one material per finish', () => {
    expect(sync.meshOf('shelf')!.material).toBe(sync.meshOf('shelf2')!.material);
  });

  it('draws blocks as white massing', () => {
    expect(mats(sync.meshOf('b1')!).map(hex)).toEqual([MASSING, MASSING]);
  });

  it('draws decor one material per surface: metal, see-through glass', () => {
    const lamp = sync.meshOf('lamp')!;
    const [body, top] = mats(lamp);
    expect([hex(body!), hex(top!)]).toEqual(['#c9a55c', swatchOf({ preset: 'glass:frosted' })]);
    expect(body!.metalness).toBe(1);
    expect([body!.transparent, top!.transparent, top!.depthWrite]).toEqual([false, true, false]);
    // The frosted top glows (its surface has a glow).
    expect(top!.emissiveIntensity).toBeGreaterThan(1);
  });

  it('gives every vertex a UV', () => {
    for (const mesh of sync.meshes()) {
      const g = mesh.geometry;
      expect(g.getAttribute('uv').count).toBe(g.getAttribute('position').count);
    }
  });

  it('sorts triangles by surface: one group per slot, pick tags following their triangles', () => {
    const lamp = sync.meshOf('lamp')!;
    const g = lamp.geometry;
    const child = seeThrough(lamp)!;
    // The brass body draws from the part's mesh, the glowing glass top from its child.
    expect(g.groups.map((x) => x.materialIndex)).toEqual([0]);
    expect(child.geometry.groups.map((x) => x.materialIndex)).toEqual([1]);
    expect(g.groups[0]!.count + child.geometry.groups[0]!.count).toBe(g.getIndex()!.count);
    // Every triangle in the top's run is tagged face:top (picking still names the right face).
    const { triTags, tags } = g.userData as { triTags: Uint16Array; tags: string[] };
    const top = child.geometry.groups[0]!;
    for (let t = top.start / 3; t < (top.start + top.count) / 3; t++) expect(tags[triTags[t]!]).toBe('face:top');
    // The child shares the part's buffers.
    expect(child.geometry.getAttribute('position')).toBe(g.getAttribute('position'));
    expect(child.geometry.getIndex()).toBe(g.getIndex());
  });

  it('casts and receives shadows, except glass and glowing surfaces, which also skip AO', () => {
    for (const id of ['shelf', 'door', 'b1', 'lamp']) {
      const mesh = sync.meshOf(id)!;
      expect([id, mesh.castShadow, mesh.receiveShadow]).toEqual([id, true, true]);
    }
    expect(sync.meshOf('pane')!.castShadow).toBe(false);
    for (const id of ['pane', 'lamp']) {
      const child = seeThrough(sync.meshOf(id)!)!;
      expect([child.castShadow, child.receiveShadow, child.userData.noAO]).toEqual([false, true, true]);
    }
  });

  it('keeps pick data on the mesh', () => {
    const door = sync.meshOf('door')!;
    expect(door.userData.partId).toBe('door');
    expect((door.geometry.userData as { tags: string[] }).tags.length).toBeGreaterThan(0);
  });

  it('hovers with a cached clone lifted a little, the see-through child too', () => {
    const m = mats(sync.meshOf('door')!)[0]!;
    const h = look.hover(m) as THREE.MeshStandardMaterial;
    expect(h).not.toBe(m);
    expect(look.hover(m)).toBe(h);
    expect(hex(h)).toBe(hex(m));
    expect(h.emissive.getHex()).toBe(0xffffff);
    expect(h.emissiveIntensity).toBeCloseTo(HOVER_LIFT);
    expect(m.emissive.getHex()).toBe(0);
    const lamp = sync.meshOf('lamp')!;
    look.paintHover(lamp);
    expect(seeThrough(lamp)!.material).toBe(lamp.material);
    expect((lamp.material as THREE.Material[]).map((x) => x.name.endsWith(':hover'))).toEqual([true, true]);
    look.paint(lamp, doc, doc.parts.lamp!, null);
    expect((seeThrough(lamp)!.material as THREE.Material[]).map((x) => x.name.endsWith(':hover'))).toEqual([false, false]);
  });

  it('repaints a cut-away mesh (one shadow-only material) back into its slots', () => {
    const lamp = sync.meshOf('lamp')!;
    const before = (lamp.material as THREE.Material[]).map((m) => m.uuid);
    const shadowOnly = new THREE.MeshBasicMaterial();
    lamp.material = shadowOnly;
    seeThrough(lamp)!.material = shadowOnly;
    look.paint(lamp, doc, doc.parts.lamp!, null);
    expect((lamp.material as unknown as THREE.Material[]).map((m) => m.uuid)).toEqual(before);
    expect(seeThrough(lamp)!.material).toBe(lamp.material);
  });

  it('repaints a kept mesh when the finish changes within a family', () => {
    const before = sync.meshOf('door');
    sync.update(ok(doc, [{ op: 'update', id: 'door', patch: { finish: { preset: 'paint', color: '#335544' } } }]));
    expect(sync.meshOf('door')).toBe(before);
    expect(mats(before!).map(hex)).toEqual(['#335544']);
  });

  it('rebuilds when the grain or the preset changes (UVs, what casts)', () => {
    const before = sync.meshOf('shelf');
    sync.update(ok(doc, [{ op: 'update', id: 'shelf', patch: { grain: 'z' } }]));
    expect(sync.meshOf('shelf')).not.toBe(before);
    const pane = ok(doc, [{ op: 'update', id: 'door', patch: { finish: { preset: 'glass:frosted' } } }]);
    const door = sync.meshOf('door');
    sync.update(pane);
    expect(sync.meshOf('door')).not.toBe(door);
    expect(sync.meshOf('door')!.castShadow).toBe(false);
  });

  it('lists the texture sets a doc uses', () => {
    expect([...usedTextureSets(doc)].sort()).toEqual(['paint-micro', 'wood-oak']);
  });

  it('frees everything on dispose', () => {
    const other = new THREE.Scene();
    const s = createSceneSync(other, presentLook());
    s.update(doc);
    expect(other.children.length).toBe(1);
    s.dispose();
    expect(other.children.length).toBe(0);
    expect(s.meshes()).toEqual([]);
  });
});
