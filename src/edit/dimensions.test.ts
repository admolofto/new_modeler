import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { dimensionLines, footprintDimensions } from './dimensions';

function ok(ops: Op[]): Doc {
  const r = applyOps(emptyDoc(), ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** A block at [x, 0, z] inches, `w` wide, `d` deep, `h` tall. */
const block = (id: string, x: number, z: number, w: number, d: number, h = 84, parent?: string): Op => ({
  op: 'add',
  entity: { kind: 'block', id, name: id, transform: { position: [inches(x), 0, inches(z)] }, size: [inches(w), inches(h), inches(d)] },
  ...(parent ? { parent } : {}),
});
const values = (doc: Doc, selected: string[] = []) => dimensionLines(doc, selected.map((node) => ({ node }))).map((l) => l.value / 64);
const pt = (x: number, y: number, z: number): V3 => [inches(x), inches(y), inches(z)];

describe('footprint dimensions', () => {
  it('shows each leg of an L across its end, and the overall size along the wall sides', () => {
    // Left leg runs front to back, the back leg along the wall: 60" x 48", both legs 24" deep.
    const doc = ok([block('left', 0, 0, 24, 48), block('back', 24, 0, 36, 24)]);
    const lines = dimensionLines(doc, []);
    expect(lines.map((l) => l.value / 64)).toEqual([60, 24, 84, 48, 24]);
    const [width, frontLeg, height, depth, rightLeg] = lines;
    expect(frontLeg).toMatchObject({ a: pt(0, 84, 48), b: pt(24, 84, 48), out: [0, 1, 0] });
    expect(rightLeg).toMatchObject({ a: pt(60, 84, 0), b: pt(60, 84, 24), out: [1, 0, 0] });
    // The back and left sides run the full size, so the overall lines go there: no corner in mid-air.
    expect(width).toMatchObject({ a: pt(0, 84, 0), b: pt(60, 84, 0), out: [0, 1, 0], offset: frontLeg!.offset });
    expect(depth).toMatchObject({ a: pt(0, 84, 0), b: pt(0, 84, 48), out: [-1, 0, 0], offset: rightLeg!.offset });
    expect(height).toMatchObject({ a: pt(0, 0, 48), b: pt(0, 84, 48) });
  });

  it('puts the overall size out past the legs when no side runs the full size', () => {
    // A peninsula off the front of a run: the left side, like the right, steps.
    const doc = ok([block('run', 0, 0, 120, 24), block('pen', 48, 24, 24, 36)]);
    const lines = dimensionLines(doc, []);
    expect(lines.map((l) => l.value / 64)).toEqual([120, 24, 84, 60, 24]);
    const [width, , , depth, rightLeg] = lines;
    expect(width).toMatchObject({ a: pt(0, 84, 0), b: pt(120, 84, 0) });
    expect(depth).toMatchObject({ a: pt(120, 84, 0), b: pt(120, 84, 60), offset: 2 * rightLeg!.offset });
    expect(rightLeg).toMatchObject({ a: pt(120, 84, 0), b: pt(120, 84, 24) });
  });

  it('adds nothing for a straight run, or for steps too small to be legs', () => {
    expect(values(ok([block('a', 0, 0, 36, 24, 34.5), block('b', 36, 0, 18, 24, 34.5), block('c', 54, 0, 36, 24, 84)]))).toEqual([90, 84, 24]);
    // A 1" deeper cabinet, or a countertop's overhang, is the same leg.
    expect(values(ok([block('a', 0, 0, 36, 24), block('b', 36, 0, 36, 25)]))).toEqual([72, 84, 25]);
    // A generated cabinet: door reveals and the toe kick don't read as steps.
    const cab = ok([{ op: 'add', entity: { kind: 'assembly', id: 'c', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, shelves: 0, drawers: [0, 0] } } } }]);
    expect(values(cab, ['c'])).toHaveLength(3);
  });

  it('shows a U\'s legs and the opening between them', () => {
    const doc = ok([block('l', 0, 0, 24, 48), block('back', 24, 0, 72, 24), block('r', 96, 0, 24, 48)]);
    expect(values(doc)).toEqual([120, 24, 72, 24, 84, 48]);
  });

  it('shows the gap between two cabinets, but not legs for pieces standing apart', () => {
    expect(values(ok([block('a', 0, 0, 36, 24), block('b', 66, 0, 36, 24)]))).toEqual([102, 36, 30, 36, 84, 24]);
    // The starter scene: a cabinet, and a door standing off to its side, set back.
    expect(values(demoDoc())).toHaveLength(3);
  });

  it('puts the legs on the far side when the near side is straight, and the height on a real corner', () => {
    // Back leg along the wall, right leg front to back: the front-left corner is empty.
    const doc = ok([block('back', 0, 0, 36, 24), block('right', 36, 0, 24, 48)]);
    const lines = dimensionLines(doc, []);
    expect(lines.map((l) => l.value / 64)).toEqual([60, 24, 84, 48, 24]);
    expect(lines[1]).toMatchObject({ a: pt(36, 84, 48), b: pt(60, 84, 48) });
    expect(lines[2]).toMatchObject({ a: pt(0, 0, 24), b: pt(0, 84, 24) });
    expect(lines[3]!.offset).toBe(lines[2]!.offset);
    expect(lines[4]).toMatchObject({ a: pt(0, 84, 0), b: pt(0, 84, 24), out: [-1, 0, 0] });
  });

  it('measures a lower leg at its own top, and the height up the tall one', () => {
    const doc = ok([block('tall', 0, 0, 24, 48), block('base', 24, 0, 36, 24, 34.5)]);
    const rightLeg = dimensionLines(doc, []).at(-1)!;
    expect(rightLeg).toMatchObject({ a: pt(60, 34.5, 0), b: pt(60, 34.5, 24) });
    // A base run along the back, a tall leg on the right: the height goes up the tall leg's corner.
    const lines = dimensionLines(ok([block('base', 0, 0, 36, 24, 34.5), block('tall', 36, 0, 24, 48)]), []);
    expect(lines[2]).toMatchObject({ a: pt(36, 0, 48), b: pt(36, 84, 48) });
    expect(lines[4]).toMatchObject({ a: pt(0, 34.5, 0), b: pt(0, 34.5, 24), out: [-1, 0, 0] });
  });

  it('measures a turned L along its own axes', () => {
    const doc = ok([
      { op: 'add', entity: { kind: 'assembly', id: 'g', name: 'Corner', transform: { position: [0, 0, 0], rotation: [0, 30, 0] } } },
      block('left', 0, 0, 24, 48, 84, 'g'),
      block('back', 24, 0, 36, 24, 84, 'g'),
    ]);
    expect(values(doc, ['g']).map(Math.round)).toEqual([60, 24, 84, 48, 24]);
  });

  it('is just the overall size for one box', () => {
    const box = { min: pt(0, 0, 0), max: pt(36, 34.5, 24) };
    expect(footprintDimensions([box]).map((l) => l.value / 64)).toEqual([36, 34.5, 24]);
    expect(footprintDimensions([])).toEqual([]);
  });
});
