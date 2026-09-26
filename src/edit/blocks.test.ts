import { describe, expect, it } from 'vitest';
import '../plugins';
import { modelSnapshot } from '../ai/context';
import type { V3 } from '../geometry/types';
import { cutParts } from '../model/cutlist';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { frameBoxes, IDENTITY, nodeAffine, overlaps, rotation, worldBoxes, type Affine } from '../model/world';
import { blockPlacement, facingOut, facingToward, frontOf, moveOps, splitEvenOps, splitOps, turnOps } from './blocks';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const addBlock = (size: V3, extra: Record<string, unknown> = {}, parent?: string): Op => ({ op: 'add', entity: { kind: 'block', size, ...extra }, ...(parent && { parent }) });
const W = inches(36);
const H = inches(34.5);
const D = inches(24);

describe('blocks in the model', () => {
  it('adds a block: a box with no material, named after its id', () => {
    const d = ok(emptyDoc(), [addBlock([W, H, D]), addBlock([W, H, D], { name: 'Fridge' })]);
    expect(d.parts.b1).toEqual({
      id: 'b1',
      name: 'Block 1',
      grain: 'none',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
      shape: { type: 'box', params: { x: W, y: H, z: D } },
      features: [],
      block: true,
    });
    expect(d.parts.b2!.name).toBe('Fridge');
  });

  it('renames and resizes blocks, and refuses what only real parts take', () => {
    const d = ok(emptyDoc(), [addBlock([W, H, D]), { op: 'add', entity: { kind: 'part', id: 'p', name: 'Panel', material: 'ply-3-4', shape: { type: 'box', params: { x: W, y: H, z: 46 } } } }]);
    const r = ok(d, [{ op: 'update', id: 'b1', patch: { name: 'Sink base', shape: { params: { x: inches(30) } } } }]);
    expect(r.parts.b1!.name).toBe('Sink base');
    expect(r.parts.b1!.shape.params.x).toBe(inches(30));
    const bad: [Op, RegExp][] = [
      [{ op: 'update', id: 'b1', patch: { material: 'ply-3-4' } }, /is a block/],
      [{ op: 'update', id: 'b1', patch: { shape: { type: 'outline', params: {} } } }, /is a block/],
      [{ op: 'addFeature', part: 'b1', feature: { type: 'hole', params: { face: 'face:front', at: [64, 64], d: 32 } } }, /blocks can't take features/],
      [{ op: 'add', entity: { kind: 'joint', type: 'dado', parts: ['p', 'b1'] } }, /is a block; joints join real parts/],
      [{ op: 'add', entity: { kind: 'block', size: [W, 0, D] } }, /size/],
    ];
    for (const [op, msg] of bad) {
      const res = applyOps(d, [op]);
      expect(res.ok, JSON.stringify(op)).toBe(false);
      if (!res.ok) expect(res.error).toMatch(msg);
    }
  });

  it('never shows up in the cut list', () => {
    const d = ok(demoDoc(), [addBlock([W, H, D], { transform: { position: [inches(80), 0, 0] } })]);
    expect(cutParts(d).parts.map((p) => p.id)).not.toContain('b1');
    expect(cutParts(d).parts).toHaveLength(cutParts(demoDoc()).parts.length);
  });

  it('shows in the AI snapshot with the way its front faces', () => {
    const d = ok(emptyDoc(), [addBlock([W, H, D], { name: 'Sink base', transform: { position: [0, 0, 0], rotation: [0, 90, 0] } })]);
    const tree = JSON.parse(modelSnapshot(d)).tree;
    expect(tree[0]).toMatchObject({ id: 'b1', name: 'Sink base', block: true, rotation: [0, 90, 0], front: '+x', shape: { type: 'box' } });
    expect(tree[0].material).toBeUndefined();
  });
});

describe('drawing a block', () => {
  const box = { min: [0, 0, 0] as V3, max: [W, H, D] as V3 };

  it('fills the drawn box whichever way its front faces', () => {
    const fronts: V3[] = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]];
    for (let turns = 0; turns < 4; turns++) {
      const { transform, size } = blockPlacement(IDENTITY, box, turns);
      const d = ok(emptyDoc(), [addBlock(size, { transform })]);
      expect(worldBoxes(d).get('b1')).toEqual(box);
      expect(frontOf(d, 'b1').map((c) => Math.round(c))).toEqual(fronts[turns]);
    }
    expect(blockPlacement(IDENTITY, box, 1)).toEqual({ transform: { position: [0, 0, D], rotation: [0, 90, 0] }, size: [D, H, W] });
  });

  it("takes on a turned host's frame when drawn on one of its faces", () => {
    const d0 = ok(emptyDoc(), [addBlock([W, H, D], { transform: { position: [inches(10), 0, 0], rotation: [0, 30, 0] } })]);
    const host = nodeAffine(d0, 'b1');
    // A wall cabinet's footprint on the host's top, 12" deep, against its back.
    const onTop = { min: [0, H, 0] as V3, max: [W, H + inches(30), inches(12)] as V3 };
    const { transform, size } = blockPlacement(host, onTop, 0);
    expect(transform.rotation).toEqual([0, 30, 0]);
    const d = ok(d0, [addBlock(size, { transform })]);
    const b2 = frameBoxes(d, host).get('b2')!;
    onTop.min.forEach((c, k) => expect(Math.abs(b2.min[k]! - c)).toBeLessThanOrEqual(1));
    onTop.max.forEach((c, k) => expect(Math.abs(b2.max[k]! - c)).toBeLessThanOrEqual(1));
  });

  it('faces the camera on the floor and out of a wall', () => {
    expect(facingToward(IDENTITY, [0.2, -0.5, 0.8])).toBe(0);
    expect(facingToward(IDENTITY, [-0.9, -0.3, 0.1])).toBe(3);
    const turned: Affine = { m: rotation([0, 90, 0]), t: [0, 0, 0] };
    // World +X is the turned frame's +Z.
    expect(facingToward(turned, [1, 0, 0])).toBe(0);
    expect(facingOut(2, 1)).toBe(0);
    expect(facingOut(0, 1)).toBe(1);
    expect(facingOut(2, -1)).toBe(2);
    expect(facingOut(0, -1)).toBe(3);
  });
});

describe('moving, turning and splitting', () => {
  it('moves by a world displacement, inside turned assemblies too', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'a', transform: { position: [0, 0, 0], rotation: [0, 90, 0] } } },
      addBlock([W, H, D], {}, 'a'),
    ]);
    const before = worldBoxes(d).get('b1')!;
    const after = worldBoxes(ok(d, moveOps(d, ['b1'], [inches(6), 0, 0]))).get('b1')!;
    expect(after.min[0] - before.min[0]).toBe(inches(6));
    expect(after.min[2]).toBe(before.min[2]);
  });

  it('turns several nodes about one pivot', () => {
    const d = ok(emptyDoc(), [addBlock([W, H, D]), addBlock([W, H, D], { transform: { position: [W, 0, 0] } })]);
    const ops = turnOps(d, ['b1', 'b2'], [W, 0, 0], [0, 1, 0], 180);
    const turned = ok(d, ops);
    const w = worldBoxes(turned);
    // Swapped ends, backs to the pivot line.
    expect(w.get('b1')).toEqual({ min: [W, 0, -D], max: [2 * W, H, 0] });
    expect(w.get('b2')).toEqual({ min: [0, 0, -D], max: [W, H, 0] });
    expect(turned.parts.b1!.transform.rotation).toEqual([0, 180, 0]);
  });

  it('splits a run into cabinets, turned or not', () => {
    for (const rot of [[0, 0, 0], [0, 90, 0], [0, 30, 0]] as V3[]) {
      const d = ok(emptyDoc(), [addBlock([inches(120), H, D], { name: 'Base run', transform: { position: [0, 0, 0], rotation: rot } })]);
      const s = ok(d, splitOps(d, 'b1', 0, inches(36)));
      expect(s.parts.b1!.name).toBe('Base run');
      expect(s.parts.b1!.shape.params.x).toBe(inches(36));
      expect(s.parts.b2).toMatchObject({ name: 'Block 2', block: true, shape: { params: { x: inches(84), y: H, z: D } } });
      expect(s.roots).toEqual(['b1', 'b2']);
      // Side by side along the run: touching, not overlapping.
      const b2 = frameBoxes(s, nodeAffine(s, 'b1')).get('b2')!;
      expect(Math.abs(b2.min[0] - inches(36))).toBeLessThanOrEqual(1);
      expect(overlaps(s, ['b1', 'b2'])).toEqual([]);
    }
  });

  it('splits into equal pieces', () => {
    const d = ok(emptyDoc(), [addBlock([100, H, D])]);
    const s = ok(d, splitEvenOps(d, 'b1', 0, 3));
    expect(['b1', 'b2', 'b3'].map((id) => s.parts[id]!.shape.params.x)).toEqual([33, 34, 33]);
    expect(worldBoxes(s).get('b3')!.max[0]).toBe(100);
  });
});
