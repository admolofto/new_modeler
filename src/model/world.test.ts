import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';
import { inches } from './units';
import { apply, eulerXYZ, frameBoxes, localBox, nodeAffine, overlaps, rotate, rotateAbout, rotation, worldBoxes } from './world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const block = (id: string, position: V3, rot: V3, size: V3 = [inches(24), inches(30), inches(24)], parent?: string): Op => ({
  op: 'add',
  entity: { kind: 'block', id, transform: { position, rotation: rot }, size },
  ...(parent && { parent }),
});

/** World center of a part. */
const center = (d: Doc, id: string): V3 => {
  const b = localBox(d, id);
  return apply(nodeAffine(d, id), [0, 1, 2].map((k) => (b.min[k]! + b.max[k]!) / 2) as V3);
};
const near = (a: V3, b: V3, tol = 1) => a.every((c, i) => Math.abs(c - b[i]!) <= tol);

describe('rotations at any angle', () => {
  it('reads Euler angles back, picking the least tilted solution', () => {
    const cases: V3[] = [[0, 0, 0], [0, 90, 0], [0, -90, 0], [0, 120, 0], [0, 180, 0], [10, 20, 30], [0, 30, 0], [-45, 0, 15], [90, 0, 0]];
    for (const r of cases) expect(eulerXYZ(rotation(r))).toEqual(r);
    // The same turn written the long way round reads back plainly.
    expect(eulerXYZ(rotation([180, 0, 180]))).toEqual([0, 180, 0]);
  });

  it('turns a node about a world pivot', () => {
    const d = ok(emptyDoc(), [block('b1', [0, 0, 0], [0, 0, 0])]);
    const pivot: V3 = [inches(12), 0, inches(12)];
    // A quarter turn about its own center keeps a square footprint where it was.
    expect(rotateAbout(d, 'b1', pivot, [0, 1, 0], 90)).toEqual({ position: [0, 0, inches(24)], rotation: [0, 90, 0] });
    const turned = ok(d, [{ op: 'move', id: 'b1', to: [0, 0, inches(24)], rotation: [0, 90, 0] }]);
    expect(worldBoxes(turned).get('b1')).toEqual(worldBoxes(d).get('b1'));
    // 30°: the center stays put.
    const t = rotateAbout(d, 'b1', center(d, 'b1'), [0, 1, 0], 30);
    expect(t.rotation).toEqual([0, 30, 0]);
    expect(near(center(ok(d, [{ op: 'move', id: 'b1', to: t.position, rotation: t.rotation }]), 'b1'), center(d, 'b1'))).toBe(true);
  });

  it('turns a node inside a turned assembly in world terms', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'a', transform: { position: [inches(10), 0, 0], rotation: [0, 90, 0] } } },
      block('b1', [inches(5), 0, 0], [0, 0, 0], undefined, 'a'),
    ]);
    const pivot: V3 = [0, 0, 0];
    const before = center(d, 'b1');
    const t = rotateAbout(d, 'b1', pivot, [0, 1, 0], 45);
    const after = center(ok(d, [{ op: 'move', id: 'b1', to: t.position, rotation: t.rotation }]), 'b1');
    const expected = rotate(rotation([0, 45, 0]), before);
    expect(near(after, expected)).toBe(true);
  });
});

describe('frames', () => {
  it('bounds parts square to a frame in its own coordinates', () => {
    const R = rotation([0, 30, 0]);
    const next = rotate(R, [inches(24), 0, 0]).map(Math.round) as V3;
    const d = ok(emptyDoc(), [block('b1', [0, 0, 0], [0, 30, 0]), block('b2', next, [0, 120, 0]), block('b3', [inches(100), 0, 0], [0, 0, 0])]);
    const boxes = frameBoxes(d, nodeAffine(d, 'b1'));
    expect(boxes.get('b1')).toEqual({ min: [0, 0, 0], max: [inches(24), inches(30), inches(24)] });
    // b2 is turned a quarter turn more: still square to b1, so it's in (beside it, within rounding).
    const b2 = boxes.get('b2')!;
    expect(Math.abs(b2.min[0] - inches(24))).toBeLessThanOrEqual(1);
    expect(boxes.has('b3')).toBe(false);
  });
});

describe('overlaps of turned parts', () => {
  it('uses the parts, not their bounding boxes', () => {
    const R = rotation([0, 45, 0]);
    const beside = rotate(R, [inches(24), 0, 0]).map(Math.round) as V3;
    const d = ok(emptyDoc(), [block('b1', [0, 0, 0], [0, 45, 0]), block('b2', beside, [0, 45, 0])]);
    // Their world bounds overlap a lot, but the blocks only touch.
    const w = worldBoxes(d);
    expect(w.get('b1')!.max[0]).toBeGreaterThan(w.get('b2')!.min[0]);
    expect(overlaps(d, ['b1', 'b2'])).toEqual([]);
    const into = ok(d, [{ op: 'move', id: 'b2', to: rotate(R, [inches(12), 0, 0]).map(Math.round) as V3 }]);
    const [clash] = overlaps(into, ['b2']);
    expect(clash?.depth[0]).toBeCloseTo(inches(12), -1);
  });

  it('tests parts at odd angles to each other exactly', () => {
    // A 45° block just off a square one's corner: bounds overlap, the blocks don't.
    const d = ok(emptyDoc(), [block('b1', [0, 0, 0], [0, 0, 0]), block('b2', [inches(20), 0, inches(30)], [0, 45, 0])]);
    const w = worldBoxes(d);
    expect(w.get('b2')!.min[0]).toBeLessThan(inches(24));
    expect(overlaps(d, ['b2'])).toEqual([]);
    const into = ok(d, [{ op: 'move', id: 'b2', to: [inches(12), 0, inches(12)] }]);
    expect(overlaps(into, ['b2'])).toHaveLength(1);
  });
});
