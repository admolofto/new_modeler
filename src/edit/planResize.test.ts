import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import { planGrips, planResizeOps } from './planResize';

const I = (n: number) => inches(n);
function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('planGrips', () => {
  it('gives a block a grip on each side that pushes that side out', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', id: 'b1', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, size: [I(24), I(34.5), I(24)] } }]);
    const grips = planGrips(d, 'b1');
    expect(grips.map((g) => g.side).sort()).toEqual(['back', 'front', 'left', 'right']);
    const right = grips.find((g) => g.side === 'right')!;
    expect(right.normal).toEqual([1, 0]);
    const wider = ok(d, planResizeOps(d, right, I(6)));
    expect(worldBoxes(wider).get('b1')).toMatchObject({ min: [0, 0, 0], max: [I(30), I(34.5), I(24)] });
    // The left side moves the block's origin with it.
    const left = grips.find((g) => g.side === 'left')!;
    const moved = ok(d, planResizeOps(d, left, I(2)));
    expect(worldBoxes(moved).get('b1')).toMatchObject({ min: [-I(2), 0, 0], max: [I(24), I(34.5), I(24)] });
  });

  it('follows a turned block', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', id: 'b1', transform: { position: [0, 0, 0], rotation: [0, 90, 0] }, size: [I(24), I(30), I(12)] } }]);
    const front = planGrips(d, 'b1').find((g) => g.side === 'front')!;
    // Turned a quarter about +Y, its front looks along +x.
    expect(front.normal[0]).toBeCloseTo(1);
    const deeper = ok(d, planResizeOps(d, front, I(3)));
    expect(deeper.parts.b1!.shape.params).toMatchObject({ z: I(15) });
  });

  it('widens a cabinet from its side', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'c', name: 'c', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    const grips = planGrips(d, 'c');
    const right = grips.find((g) => g.side === 'right');
    expect(right).toBeDefined();
    const before = d.assemblies.c!.generator!.params.width as number;
    const wider = ok(d, planResizeOps(d, right!, I(3)));
    expect(wider.assemblies.c!.generator!.params.width).toBe(before + I(3));
  });
});
