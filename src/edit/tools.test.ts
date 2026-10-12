import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import { arrayCopyOps, parseAngle, parseArray } from './array';
import { moveOps, turnOps } from './blocks';
import { eraseOps } from './erase';
import { alongLine, angleAbout, onPlane, type Ray } from './rays';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const block = (size: V3, position: V3 = [0, 0, 0]): Op => ({ op: 'add', entity: { kind: 'block', size, transform: { position, rotation: [0, 0, 0] } } });
const W = inches(36);

describe('rays', () => {
  const down: Ray = { o: [10, 100, 20], d: [0, -1, 0] };

  it('finds where a ray meets a plane, and not behind it', () => {
    expect(onPlane(down, [0, 0, 0], [0, 1, 0])).toEqual([10, 0, 20]);
    expect(onPlane({ o: [10, 100, 20], d: [0, 1, 0] }, [0, 0, 0], [0, 1, 0])).toBeNull();
    expect(onPlane({ o: [0, 5, 0], d: [1, 0, 0] }, [0, 0, 0], [0, 1, 0])).toBeNull();
  });

  it('finds the point of an axis nearest the ray', () => {
    // Looking straight down at x = 10: the x axis through the origin is nearest there.
    expect(alongLine(down, [0, 0, 0], [1, 0, 0])).toBeCloseTo(10);
    // Down the axis itself there's no one nearest point.
    expect(alongLine(down, [0, 0, 0], [0, 1, 0])).toBeNull();
  });

  it('measures a turn about an axis, right-handed', () => {
    expect(angleAbout([1, 0, 0], [0, 0, -1], [0, 1, 0])).toBeCloseTo(90);
    expect(angleAbout([1, 0, 0], [0, 0, 1], [0, 1, 0])).toBeCloseTo(-90);
    // Height off the plane doesn't count.
    expect(angleAbout([1, 5, 0], [1, -3, -1], [0, 1, 0])).toBeCloseTo(45);
    expect(angleAbout([0, 1, 0], [1, 0, 0], [0, 1, 0])).toBeNull();
  });
});

describe('typed values', () => {
  it('reads rows of copies, and leaves lengths alone', () => {
    expect(parseArray('3x')).toEqual({ kind: 'times', n: 3 });
    expect(parseArray('x3')).toEqual({ kind: 'times', n: 3 });
    expect(parseArray('*4')).toEqual({ kind: 'times', n: 4 });
    expect(parseArray('/3')).toEqual({ kind: 'divide', n: 3 });
    expect(parseArray('3/')).toEqual({ kind: 'divide', n: 3 });
    for (const length of ['3', '3/4', '1 1/2', '18mm', '0x', '']) expect(parseArray(length)).toBeNull();
  });

  it('reads angles', () => {
    expect(parseAngle('45')).toBe(45);
    expect(parseAngle('-22.5')).toBe(-22.5);
    expect(parseAngle('30°')).toBe(30);
    expect(parseAngle('15 deg')).toBe(15);
    expect(parseAngle('3/4')).toBeNull();
    expect(parseAngle('720')).toBeNull();
  });
});

describe('rows of copies', () => {
  const d = ok(emptyDoc(), [block([W, inches(34.5), inches(24)])]);
  const minX = (doc: Doc, ids: string[]) => ids.map((id) => worldBoxes(doc).get(id)!.min[0]);

  it('3x: three copies, each as far again', () => {
    const row = arrayCopyOps(d, ['b1'], { kind: 'times', n: 3 }, (doc, copies, f) => moveOps(doc, copies, [W * f, 0, 0]));
    const next = ok(d, row.ops);
    expect(row.copies).toHaveLength(3);
    expect(minX(next, row.copies)).toEqual([W, 2 * W, 3 * W]);
    expect(Object.keys(next.parts)).toHaveLength(4);
  });

  it('/3: three copies spaced evenly up to where the copy landed', () => {
    const row = arrayCopyOps(d, ['b1'], { kind: 'divide', n: 3 }, (doc, copies, f) => moveOps(doc, copies, [inches(90) * f, 0, 0]));
    expect(minX(ok(d, row.ops), row.copies)).toEqual([inches(30), inches(60), inches(90)]);
  });

  it('turns copies about a point', () => {
    const row = arrayCopyOps(d, ['b1'], { kind: 'times', n: 3 }, (doc, copies, f) => turnOps(doc, copies, [0, 0, 0], [0, 1, 0], 90 * f));
    const next = ok(d, row.ops);
    expect(row.copies.map((id) => next.parts[id]!.transform.rotation[1])).toEqual([90, 180, -90]);
  });
});

describe('erasing', () => {
  it('deletes the parts it is given', () => {
    const d = ok(emptyDoc(), [block([W, W, W]), block([W, W, W], [2 * W, 0, 0])]);
    const next = ok(d, eraseOps(d, ['b2']));
    expect(Object.keys(next.parts)).toEqual(['b1']);
  });

  it('takes a folder whole once every part in it is erased', () => {
    const d = demoDoc();
    const cabinet = descendants(d, 'a1').filter((id) => d.parts[id]);
    expect(eraseOps(d, cabinet)).toEqual([{ op: 'delete', id: 'a1' }]);
    // One part short, and they go one by one.
    expect(eraseOps(d, cabinet.slice(1))).toHaveLength(cabinet.length - 1);
    expect(ok(d, eraseOps(d, cabinet)).assemblies.a1).toBeUndefined();
  });

  it('ignores ids that are not parts', () => {
    expect(eraseOps(demoDoc(), ['a1', 'nope'])).toEqual([]);
  });
});
