import { describe, expect, it } from 'vitest';
import type { Part } from '../model/schema';
import { inches } from '../model/units';
import { holeSegments } from './features/hole';
import './index';
import { buildPart } from './pipeline';
import { bounds, isWatertight, volume } from './testMesh';

function panel(features: Part['features'] = []): Part {
  return {
    id: 'p1',
    name: 'Panel',
    material: 'ply-3-4',
    grain: 'y',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } },
    features,
  };
}

describe('box shape', () => {
  const { mesh, handles } = buildPart(panel());

  it('is a closed, outward-facing 12-triangle box', () => {
    expect(mesh.indices.length / 3).toBe(12);
    expect(isWatertight(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(inches(12) * inches(30) * 46);
  });

  it('spans [0, size] from the min corner', () => {
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [inches(12), inches(30), 46] });
  });

  it('tags two triangles per semantic face', () => {
    const counts: Record<string, number> = {};
    mesh.triTags.forEach((t) => (counts[mesh.tags[t]!] = (counts[mesh.tags[t]!] ?? 0) + 1));
    expect(counts).toEqual({ 'face:left': 2, 'face:right': 2, 'face:bottom': 2, 'face:top': 2, 'face:back': 2, 'face:front': 2 });
  });

  it('exposes 6 face, 12 edge and 8 vertex handles', () => {
    expect(handles.filter((h) => h.kind === 'face')).toHaveLength(6);
    expect(handles.filter((h) => h.kind === 'edge')).toHaveLength(12);
    expect(handles.filter((h) => h.kind === 'vertex')).toHaveLength(8);
    expect(handles.map((h) => h.id)).toContain('edge:top-front');
    expect(handles.map((h) => h.id)).toContain('vertex:top-front-left');
    const top = handles.find((h) => h.id === 'face:top')!;
    expect(top.drives).toEqual([{ target: 'shape', param: 'y', label: 'height', axis: [0, 1, 0], moveOrigin: false }]);
  });
});

describe('through hole', () => {
  const d = inches(1);
  const hole = { id: 'f1', type: 'hole', params: { face: 'face:front', at: [inches(6), inches(10)], d } };
  const { mesh, handles } = buildPart(panel([hole]));

  it('stays watertight and removes the hole volume', () => {
    expect(isWatertight(mesh)).toBe(true);
    const n = holeSegments(d);
    const polygonArea = (n / 2) * (d / 2) ** 2 * Math.sin((2 * Math.PI) / n);
    const expected = inches(12) * inches(30) * 46 - polygonArea * 46;
    expect(Math.abs(volume(mesh) - expected) / expected).toBeLessThan(1e-7); // float32 positions
  });

  it('keeps bounds and tags the wall with the feature id', () => {
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [inches(12), inches(30), 46] });
    expect(mesh.tags).toContain('f1:wall');
    const wallTris = [...mesh.triTags].filter((t) => mesh.tags[t] === 'f1:wall').length;
    expect(wallTris).toBe(holeSegments(d) * 2);
  });

  it('exposes wall and center handles', () => {
    expect(handles.find((h) => h.id === 'f1:wall')?.drives[0]).toEqual({ target: 'f1', param: 'd', label: 'diameter' });
    expect(handles.find((h) => h.id === 'f1:center')?.points[0]).toEqual([inches(6), inches(10), 46]);
  });

  it('handles holes on every axis', () => {
    const multi = buildPart(
      panel([
        hole,
        { id: 'f2', type: 'hole', params: { face: 'face:left', at: [23, inches(20)], d: 20 } },
        { id: 'f3', type: 'hole', params: { face: 'face:back', at: [inches(9), inches(25)], d: 32 } },
      ]),
    );
    expect(isWatertight(multi.mesh)).toBe(true);
    expect(volume(multi.mesh)).toBeGreaterThan(0);
  });
});
