import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import type { V3 } from '../geometry/types';
import { frameBoxes, IDENTITY, nodeAffine, rotate, rotation, worldBoxes } from '../model/world';
import { boxDimensions, dimensionBoxes, dimensionLines } from './dimensions';
import { handleDrives } from './drives';
import { GROUND } from './targets';
import { CABINET_STEP, inferDraw, inferExtrude, inferLine, inferMove, inferPlane, inferSplit } from './snap';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const box = (id: string, x: number, w: number): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', grain: 'x', transform: { position: [x, 0, 0], rotation: [0, 0, 0] }, shape: { type: 'box', params: { x: w, y: inches(30), z: 46 } } },
});

describe('drag inference', () => {
  const doc = ok(emptyDoc(), [box('a', 0, inches(12)), box('b', inches(20), inches(10))]);
  const hd = handleDrives(doc, { node: 'a', handle: 'face:right' })!;
  const boxes = worldBoxes(doc);

  it('snaps a pushed face flush with a nearby face', () => {
    expect(inferLine(doc, hd, [1, 0, 0], inches(7.9), 16, boxes)).toEqual({ s: inches(8), label: 'flush with b left', node: 'b' });
    expect(inferLine(doc, hd, [1, 0, 0], inches(5), 16, boxes)).toBeNull();
  });

  it('matches another part\'s size', () => {
    expect(inferLine(doc, hd, [1, 0, 0], -inches(1.95), 16, boxes)).toEqual({ s: -inches(2), label: 'width = b width', node: 'b' });
  });

  it('lines an outline point up with its other corners', () => {
    const d = ok(emptyDoc(), [
      {
        op: 'add',
        entity: {
          kind: 'part',
          id: 't',
          name: 'Top',
          material: 'maple-4-4',
          shape: { type: 'outline', params: { axis: 'y', thickness: 48, points: [{ at: [0, 0] }, { at: [inches(20), 0] }, { at: [inches(20), inches(10)] }, { at: [0, inches(10)] }] } },
        },
      },
    ]);
    const h = handleDrives(d, { node: 't', handle: 'vertex:top-v3' })!;
    const r = inferPlane(d, h, [1, 0, 0], [0, 0, 1], [-inches(0.1), inches(3)], 16, worldBoxes(d));
    expect(r.s).toEqual([0, inches(3)]);
    expect(r.labels).toEqual(['in line with top-v2']);
  });
});

describe('drag inference at an angle', () => {
  it('snaps a pushed face flush with a part turned the same way', () => {
    const R = rotation([0, 30, 0]);
    const at = (x: number) => rotate(R, [x, 0, 0]).map(Math.round) as V3;
    const block = (id: string, x: number): Op => ({ op: 'add', entity: { kind: 'block', id, name: id, transform: { position: at(x), rotation: [0, 30, 0] }, size: [inches(12), inches(30), inches(24)] } });
    const doc = ok(emptyDoc(), [block('a', 0), block('b', inches(20))]);
    const hd = handleDrives(doc, { node: 'a', handle: 'face:right' })!;
    const snap = inferLine(doc, hd, [1, 0, 0], inches(7.9), 16)!;
    expect(Math.abs(snap.s - inches(8))).toBeLessThanOrEqual(1);
    expect(snap.label).toBe('flush with b left');
  });
});

describe('move, draw and split inference', () => {
  const block = (id: string, x: number, w: number, y = 0): Op => ({ op: 'add', entity: { kind: 'block', id, name: id, transform: { position: [x, y, 0] }, size: [w, inches(30), inches(24)] } });
  const doc = ok(emptyDoc(), [block('a', 0, inches(24)), block('b', inches(30), inches(24))]);
  const frame = frameBoxes(doc, IDENTITY);
  const rest = new Map([...frame].filter(([id]) => id !== 'a'));
  const a = frame.get('a')!;

  it('moves against a neighbor, in line with it, centered on it, or onto the floor', () => {
    expect(inferMove(doc, 0, a, inches(5.9), 16, rest)).toEqual({ s: inches(6), label: 'against b', node: 'b' });
    expect(inferMove(doc, 0, a, inches(29.9), 16, rest)).toEqual({ s: inches(30), label: 'in line with b left', node: 'b' });
    expect(inferMove(doc, 0, a, inches(3), 16, rest)).toBeNull();
    const up = { min: [0, inches(10), 0] as V3, max: [inches(24), inches(40), inches(24)] as V3 };
    expect(inferMove(doc, 1, up, -inches(9.9), 16, new Map(), 0)).toEqual({ s: -inches(10), label: 'on the floor', node: GROUND });
  });

  it("draws corners in line with other parts' faces, else on the grid", () => {
    const r = inferDraw(doc, 1, [inches(54.1), 0, inches(23.9)], 16, frame, 32);
    expect(r.p).toEqual([inches(54), 0, inches(24)]);
    expect(r.labels).toEqual(['corner of b']);
    expect(inferDraw(doc, 1, [inches(54.1), 0, inches(40)], 16, frame, 32)).toMatchObject({ labels: ['in line with b right'], nodes: ['b'], axes: [0] });
    expect(inferDraw(doc, 1, [inches(70.3), 0, inches(40.2)], 16, frame, 32).p).toEqual([inches(70.5), 0, inches(40)]);
    // Matching a width from the first corner.
    const m = inferDraw(doc, 1, [inches(83.9), 0, inches(40)], 16, frame, 32, [inches(60), 0, inches(40)]);
    expect(m.p[0]).toBe(inches(84));
    expect(m.labels).toEqual(['width = a']);
  });

  it('extrudes flush with a top or to a matching height, else to the grid', () => {
    expect(inferExtrude(doc, 1, 0, 1, inches(29.9), 16, frame, 32)).toMatchObject({ s: inches(30), snapped: true });
    expect(inferExtrude(doc, 1, 0, 1, inches(17.3), 16, frame, 32)).toMatchObject({ s: inches(17.5), snapped: false });
    expect(inferExtrude(doc, 1, 0, 1, 3, 16, new Map(), 32).s).toBe(32);
  });

  it('splits at seams, the middle and cabinet widths', () => {
    const run = ok(emptyDoc(), [block('r', 0, inches(120)), block('u', inches(33), inches(30), inches(54))]);
    const boxes = new Map([...frameBoxes(run, nodeAffine(run, 'r'))].filter(([id]) => id !== 'r'));
    expect(inferSplit(run, 0, inches(120), inches(23.9), 16, boxes, 32)).toEqual({ s: inches(24), label: '', node: '' });
    expect(inferSplit(run, 0, inches(120), inches(60.1), 16, boxes, 32)).toMatchObject({ s: inches(60), label: 'middle' });
    // The seam of the block above wins over the 33" step it sits on.
    expect(inferSplit(run, 0, inches(120), inches(33.1), 16, boxes, 32)).toMatchObject({ s: inches(33), label: 'in line with u left', node: 'u' });
    expect(inferSplit(run, 0, inches(120), inches(10.3), 1, boxes, 32)!.s).toBe(inches(10.5));
    expect(CABINET_STEP).toBe(inches(3));
  });
});

describe('dimensions', () => {
  it('measures width, height and depth of a box, pushed out from it', () => {
    const lines = boxDimensions({ min: [0, 0, 0], max: [inches(36), inches(34.5), inches(24)] });
    expect(lines.map((l) => l.value)).toEqual([inches(36), inches(34.5), inches(24)]);
    expect(lines.map((l) => l.out)).toEqual([[0, 1, 0], [-1, 0, 0], [1, 0, 0]]);
  });

  it('dimensions the selection together, else the whole model', () => {
    const doc = ok(emptyDoc(), [box('a', 0, inches(12)), box('b', inches(20), inches(10))]);
    expect(dimensionBoxes(doc, [{ node: 'a' }])).toEqual([{ min: [0, 0, 0], max: [inches(12), inches(30), 46] }]);
    expect(dimensionBoxes(doc, [])).toEqual([{ min: [0, 0, 0], max: [inches(30), inches(30), 46] }]);
    expect(dimensionBoxes(emptyDoc(), [])).toEqual([]);
  });

  it('measures a turned selection along its own axes', () => {
    const doc = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', id: 'k', transform: { rotation: [0, 30, 0] }, size: [inches(36), inches(34.5), inches(24)] } }]);
    expect(dimensionLines(doc, [{ node: 'k' }]).map((l) => l.value)).toEqual([inches(36), inches(34.5), inches(24)]);
    // Bounding box, measured on the world axes, is bigger.
    expect(dimensionBoxes(doc, [{ node: 'k' }]).flatMap(boxDimensions)[0]!.value).toBeGreaterThan(inches(36));
  });
});
