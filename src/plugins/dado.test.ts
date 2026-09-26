import { describe, expect, it } from 'vitest';
import type { Part } from '../model/schema';
import { inches } from '../model/units';
import './index';
import { buildPart } from './pipeline';
import { bounds, isWatertight, tagArea, volume } from './testMesh';

const T = 46; // 23/32"
const [H, D] = [inches(30), inches(24)];

/** A cabinet side: thin along x, inside face = face:right. */
function side(features: Part['features'] = []): Part {
  return {
    id: 'p1',
    name: 'Side',
    material: 'ply-3-4',
    grain: 'y',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    shape: { type: 'box', params: { x: T, y: H, z: D } },
    features,
  };
}

const dado = (id: string, from: [number, number], to: [number, number], depth = 16, face = 'face:right') => ({
  id,
  type: 'dado',
  params: { face, from, to, depth },
});

describe('dado feature', () => {
  it('cuts a through dado across a face: watertight, exact volume, face split in two', () => {
    const { mesh, geom } = buildPart(side([dado('f1', [0, inches(4)], [D, inches(4) + T])]));
    expect(isWatertight(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(T * H * D - 16 * T * D);
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [T, H, D] });
    expect(geom.faces.filter((x) => x.tag === 'face:right')).toHaveLength(2);
    expect(tagArea(mesh, 'f1:floor')).toBeCloseTo(T * D);
    expect(tagArea(mesh, 'f1:wall')).toBeCloseTo(2 * 16 * D);
  });

  it('cuts a stopped dado, a rabbet at an edge, and a footprint running past the face', () => {
    const stopped = buildPart(side([dado('f1', [inches(2), inches(10)], [D + 100, inches(10) + T])]));
    expect(isWatertight(stopped.mesh)).toBe(true);
    expect(volume(stopped.mesh)).toBeCloseTo(T * H * D - 16 * T * (D - inches(2)));
    expect(tagArea(stopped.mesh, 'f1:wall')).toBeCloseTo(2 * 16 * (D - inches(2)) + 16 * T);

    const rabbet = buildPart(side([dado('f1', [0, H - T], [D, H + 64])]));
    expect(isWatertight(rabbet.mesh)).toBe(true);
    expect(volume(rabbet.mesh)).toBeCloseTo(T * H * D - 16 * T * D);
    expect(tagArea(rabbet.mesh, 'f1:wall')).toBeCloseTo(16 * D); // one wall; the other side is open
  });

  it('keeps meeting channels of different depths watertight (back rabbet beside a bottom dado)', () => {
    const BT = 14;
    const { mesh } = buildPart(
      side([
        dado('f1', [BT, inches(4)], [D, inches(4) + T], 16),
        dado('f2', [0, inches(4)], [BT, H], 24),
        dado('f3', [BT, H - T], [D, H], 16),
      ]),
    );
    expect(isWatertight(mesh)).toBe(true);
    const removed = 16 * T * (D - BT) + 24 * BT * (H - inches(4)) + 16 * T * (D - BT);
    expect(volume(mesh)).toBeCloseTo(T * H * D - removed);
  });

  it('takes holes around it, into its floor, and through into it', () => {
    const { mesh } = buildPart(
      side([
        dado('f1', [0, inches(4)], [D, inches(4) + T]),
        { id: 'f2', type: 'hole', params: { face: 'face:right', at: [inches(2), inches(12)], d: 13, depth: 24 } },
        { id: 'f3', type: 'hole', params: { face: 'f1:floor', at: [inches(12), inches(4) + T / 2], d: 16, depth: 8 } },
        { id: 'f4', type: 'hole', params: { face: 'face:left', at: [inches(6), inches(4) + T / 2], d: 20 } },
      ]),
    );
    expect(isWatertight(mesh)).toBe(true);
  });

  it('refuses channels that are too deep, miss the part, split it, or share it with edge profiles', () => {
    expect(() => buildPart(side([dado('f1', [0, 0], [D, T], T)]))).toThrow(/deep but "Side" is only/);
    expect(() => buildPart(side([dado('f1', [D + 10, 0], [D + 20, T])]))).toThrow(/misses "Side"/);
    expect(() =>
      buildPart(side([dado('f1', [0, inches(4)], [D, inches(5)], 30), dado('f2', [0, inches(4)], [D, inches(5)], 30, 'face:left')])),
    ).toThrow(/separate pieces/);
    expect(() =>
      buildPart(side([dado('f1', [0, inches(4)], [D, inches(5)]), { id: 'f2', type: 'edgeProfile', params: { edges: ['edge:top-front'], profile: 'chamfer', r: 8 } }])),
    ).toThrow(/can't also take edgeProfile/);
  });

  it('exposes a floor handle that drives depth', () => {
    const { handles } = buildPart(side([dado('f1', [0, inches(4)], [D, inches(4) + T])]));
    const floor = handles.find((h) => h.id === 'f1:floor')!;
    expect(floor.normal).toEqual([1, 0, 0]);
    expect(floor.drives).toEqual([{ target: 'f1', param: 'depth', label: 'depth', axis: [-1, 0, 0] }]);
  });
});
