import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { exportScene } from './gltfExport';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('glTF export', () => {
  const doc = ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [384], doors: 2 } } } },
    { op: 'add', entity: { kind: 'part', id: 'lid', name: 'Lid', material: 'ply-3-4', transform: { position: [3000, 0, 0] }, shape: { type: 'box', params: { x: 1152, y: 46, z: 640 } } } },
    { op: 'add', entity: { kind: 'motion', nodes: ['lid'], type: 'hinge', params: { side: 'back', angle: 90 } } },
  ]);

  it('names a clip for each animation, plus one opening everything', () => {
    const { scene, clips } = exportScene(doc);
    expect(clips.map((c) => c.name)).toEqual(['Open — Drawer 1', 'Open — Left door', 'Open — Right door', 'Open — Lid', 'Open all']);
    // Drawer 1 moves its six parts, a position and a turn track each.
    expect(clips[0]!.tracks).toHaveLength(12);
    expect(clips[0]!.duration).toBeCloseTo(0.6);
    // Open all waits a beat for each next one.
    expect(clips.at(-1)!.duration).toBeGreaterThan(0.8);
    expect(scene.getObjectByName('Model')!.scale.x).toBeCloseTo(0.0254 / 64);
  });

  it('starts closed and ends open', () => {
    const { scene, clips } = exportScene(doc);
    const lid = clips.find((c) => c.name === 'Open — Lid')!;
    const pos = lid.tracks.find((t) => t.name.endsWith('.position'))!;
    const turn = lid.tracks.find((t) => t.name.endsWith('.quaternion'))!;
    const node = scene.getObjectByProperty('uuid', pos.name.split('.')[0]!)!;
    expect(node.name).toBe('Lid');
    expect([...pos.values.slice(0, 3)]).toEqual([3000, 0, 0]);
    expect([...turn.values.slice(0, 4)].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 0, 1]);
    // Hinged at the back and swung 90°, the lid stands up: a quarter turn about x.
    const q = [...turn.values.slice(-4)].map((v) => Math.round(Math.abs(v) * 1000) / 1000);
    expect(q).toEqual([0.707, 0, 0, 0.707]);
  });
});
