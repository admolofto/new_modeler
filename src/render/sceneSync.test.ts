import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../plugins/testDecor';
import { emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { PALETTE } from './palette';
import { createSceneSync } from './sceneSync';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const hex = (m: THREE.Material) => `#${(m as THREE.MeshStandardMaterial).color.getHexString()}`;
const mats = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];

/** A part in a material without a finish (drawn in its color), a painted one, a block, and a two-surface lamp. */
function scene(): Doc {
  return ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'material', id: 'oak', name: 'Old oak', thickness: 48, color: '#aa7744', stock: 'solid' } },
    { op: 'add', entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'oak', grain: 'x', shape: { type: 'box', params: { x: 1280, y: 48, z: 640 } } } },
    { op: 'add', entity: { kind: 'part', id: 'door', name: 'Door', material: 'oak', finish: { preset: 'paint', color: '#1f2a44' }, transform: { position: [0, 0, 1000] }, shape: { type: 'box', params: { x: 640, y: 1280, z: 48 } } } },
    { op: 'add', entity: { kind: 'block', size: [960, 960, 960], transform: { position: [3000, 0, 0] } } },
    { op: 'add', entity: { kind: 'decor', id: 'lamp', transform: { position: [5000, 0, 0] }, shape: { type: 'testLamp', params: { x: 320, y: 640, z: 320 } } } },
  ]);
}

describe('the editor look', () => {
  const sync = createSceneSync(new THREE.Scene());
  const doc = scene();
  sync.update(doc);

  it('draws a part in its material\'s color when its finish is inferred, with edges', () => {
    const shelf = sync.meshOf('shelf')!;
    expect(mats(shelf).map(hex)).toEqual(['#aa7744']);
    expect(Array.isArray(shelf.material)).toBe(false);
    expect(shelf.geometry.groups).toEqual([]);
    expect(shelf.children.map((c) => c.type)).toEqual(['LineSegments']);
    expect(shelf.userData.partId).toBe('shelf');
    expect(shelf.parent!.scale.x).toBeCloseTo(1 / 64);
  });

  it('draws an explicit finish in its swatch', () => {
    expect(mats(sync.meshOf('door')!).map(hex)).toEqual(['#1f2a44']);
  });

  it('draws a block in clay with a lighter front, edges and an arrow on top', () => {
    const block = sync.meshOf('b1')!;
    expect(mats(block).map(hex)).toEqual([PALETTE.blockCss, PALETTE.blockFrontCss]);
    // Two materials; a group per run of triangles (the box's front face is a run in the middle).
    expect(block.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 0]);
    expect(block.children.map((c) => c.type)).toEqual(['LineSegments', 'Mesh']);
    // The groups cover every triangle, in order, so picking by triangle tags still works.
    const count = block.geometry.index!.count;
    expect(block.geometry.groups.reduce((n, g) => n + g.count, 0)).toBe(count);
  });

  it('draws decor one material per surface, glass see-through', () => {
    const lamp = sync.meshOf('lamp')!;
    const [body, top] = mats(lamp);
    expect([hex(body!), hex(top!)]).toEqual(['#c9a55c', '#e8eef0']);
    expect([body!.transparent, top!.transparent, top!.opacity, top!.depthWrite]).toEqual([false, true, 0.35, false]);
    const { triTags, tags } = lamp.geometry.userData as { triTags: Uint16Array; tags: string[] };
    for (const g of lamp.geometry.groups) {
      for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) expect(tags[triTags[t]!] === 'face:top').toBe(g.materialIndex === 1);
    }
  });

  it('tints what an AI proposal changes and what an opening hits, on every surface', () => {
    sync.update(doc, { highlight: new Set(['shelf', 'lamp']) });
    expect(mats(sync.meshOf('shelf')!)[0]!.emissive.getHex()).toBe(PALETTE.ai);
    expect(mats(sync.meshOf('lamp')!).map((m) => m.emissive.getHex())).toEqual([PALETTE.ai, PALETTE.ai]);
    expect(mats(sync.meshOf('door')!)[0]!.emissive.getHex()).toBe(0);
    sync.setWarn(new Set(['door']));
    expect(mats(sync.meshOf('door')!)[0]!.emissive.getHex()).toBe(PALETTE.clash);
    sync.setWarn(new Set());
    // Same geometry, new look: the mesh is kept and only its materials change.
    const before = sync.meshOf('door');
    sync.update(ok(doc, [{ op: 'update', id: 'door', patch: { finish: { preset: 'wood:walnut' } } }]));
    expect(sync.meshOf('door')).toBe(before);
    expect(mats(before!).map(hex)).toEqual(['#6b4a33']);
  });
});

describe('the cutaway', () => {
  const room: Op = {
    op: 'add',
    entity: {
      kind: 'assembly',
      id: 'room',
      name: 'Room',
      generator: { type: 'room', params: { left: 0, right: 9216, back: 0, front: 7680, openings: [{ kind: 'door', wall: 'front', at: 4608, width: 2048, height: 5120 }] } },
    },
  };
  const doc = ok(emptyDoc(), [room]);
  const sync = createSceneSync(new THREE.Scene());
  sync.update(doc);
  const picked = () => sync.pickable().map((m) => m.userData.partId as string);

  it('takes walls and what they host (a door in its folder) out of the view and out of picking, until set again', () => {
    expect(picked()).toEqual(expect.arrayContaining(['room.wall-front', 'room.door-d1-leaf']));
    sync.setCutaway(new Set(['room.wall-front', 'room.door-d1']));
    expect(sync.meshOf('room.wall-front')!.visible).toBe(false);
    expect(picked()).not.toContain('room.wall-front');
    expect(picked()).not.toContain('room.door-d1-leaf');
    expect(sync.meshes().map((m) => m.userData.partId)).not.toContain('room.door-d1-handle');
    expect(picked()).toContain('room.wall-back');
    // A redraw keeps it; clearing it brings everything back.
    sync.update(doc);
    expect(picked()).not.toContain('room.wall-front');
    sync.setCutaway(new Set());
    expect(picked()).toEqual(expect.arrayContaining(['room.wall-front', 'room.door-d1-leaf']));
    expect(sync.meshOf('room.wall-front')!.visible).toBe(true);
  });
});
