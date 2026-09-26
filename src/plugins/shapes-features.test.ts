import { describe, expect, it } from 'vitest';
import type { Feature, Part } from '../model/schema';
import { inches } from '../model/units';
import { holeSegments } from './features/hole';
import './index';
import { buildPart } from './pipeline';
import { features as featureDefs, shapes } from './registry';
import { bounds, isWatertight, tagArea, volume } from './testMesh';

let n = 0;
/** Unique name so the build cache never hides an error message under test. */
function part(shape: Part['shape'], features: Feature[] = []): Part {
  return {
    id: 'p1',
    name: `Part ${++n}`,
    material: 'ply-3-4',
    grain: 'none',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    shape: { type: shape.type, params: shapes.parse(shape.type, shape.params) },
    features: features.map((f) => ({ ...f, params: featureDefs.parse(f.type, f.params) })),
  };
}
const box = (x: number, y: number, z: number, features: Feature[] = []) => part({ type: 'box', params: { x, y, z } }, features);
const profile = (id: string, edges: string[], kind: 'roundover' | 'chamfer', r: number): Feature => ({
  id,
  type: 'edgeProfile',
  params: { edges, profile: kind, r },
});
const hole = (id: string, face: string, at: [number, number], d: number, depth?: number): Feature => ({
  id,
  type: 'hole',
  params: { face, at, d, ...(depth !== undefined && { depth }) },
});
const circleArea = (d: number) => {
  const k = holeSegments(d);
  return (k / 2) * (d / 2) ** 2 * Math.sin((2 * Math.PI) / k);
};
const near = (actual: number, expected: number, rel = 1e-6) => expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);

const W = inches(24);
const D = inches(16);
const T = 48;

/** A 24 × 16 tabletop outline lying flat (thickness along y). */
function tabletop(r: number | undefined, features: Feature[] = []) {
  const pts = [
    { id: 'bl', at: [0, 0] },
    { id: 'br', at: [W, 0] },
    { id: 'fr', at: [W, D] },
    { id: 'fl', at: [0, D] },
  ].map((p) => (r ? { ...p, r } : p));
  return part({ type: 'outline', params: { axis: 'y', thickness: T, points: pts } }, features);
}
const TOP_EDGES = ['edge:top-bl', 'edge:top-br', 'edge:top-fr', 'edge:top-fl'];

describe('blind holes', () => {
  it('leave a floor and keep the mesh closed', () => {
    const d = 13; // ~5mm shelf pin
    const { mesh } = buildPart(box(46, inches(30), inches(12), [hole('f1', 'face:right', [inches(2), inches(10)], d, 24)]));
    expect(isWatertight(mesh)).toBe(true);
    near(volume(mesh), 46 * inches(30) * inches(12) - circleArea(d) * 24, 1e-7);
    expect(mesh.tags).toEqual(expect.arrayContaining(['f1:wall', 'f1:floor']));
  });

  it('can come from both faces as long as they miss each other', () => {
    const at: [number, number] = [inches(6), inches(6)];
    const ok = box(46, inches(12), inches(12), [hole('f1', 'face:left', at, 64, 20), hole('f2', 'face:right', at, 64, 20)]);
    expect(isWatertight(buildPart(ok).mesh)).toBe(true);
    const clash = box(46, inches(12), inches(12), [hole('f1', 'face:left', at, 64, 30), hole('f2', 'face:right', at, 64, 30)]);
    expect(() => buildPart(clash)).toThrow(/hole f2 .* overlaps hole f1/);
  });

  it('refuse to go deeper than the part', () => {
    expect(() => buildPart(box(46, inches(12), inches(12), [hole('f1', 'face:right', [inches(6), inches(6)], 64, 46)]))).toThrow(
      /23\/32" thick there/,
    );
  });

  it('can go into the floor of an earlier cut', () => {
    const p = box(inches(8), 46, inches(8), [
      { id: 'f1', type: 'pocket', params: { face: 'face:top', at: [inches(4), inches(4)], size: [inches(3), inches(3)], depth: 16 } },
      hole('f2', 'f1:floor', [inches(4), inches(4)], 32),
    ]);
    const { mesh } = buildPart(p);
    expect(isWatertight(mesh)).toBe(true);
    near(volume(mesh), inches(8) * 46 * inches(8) - inches(3) * inches(3) * 16 - circleArea(32) * 30, 1e-7);
  });
});

describe('pockets', () => {
  it('cut rounded blind pockets and through cutouts', () => {
    const p = box(inches(20), 46, inches(12), [
      { id: 'f1', type: 'pocket', params: { face: 'face:top', at: [inches(5), inches(6)], size: [inches(4), inches(6)], r: 16, depth: 16 } },
      { id: 'f2', type: 'pocket', params: { face: 'face:top', at: [inches(14), inches(6)], size: [inches(6), inches(4)] } },
    ]);
    const { mesh, handles } = buildPart(p);
    expect(isWatertight(mesh)).toBe(true);
    const cutout = inches(6) * inches(4) * 46;
    expect(volume(mesh)).toBeLessThan(inches(20) * 46 * inches(12) - cutout);
    expect(handles.find((h) => h.id === 'f1:floor')?.drives[0]?.param).toBe('depth');
  });

  it('rejects a corner radius bigger than the pocket', () => {
    expect(() => featureDefs.parse('pocket', { face: 'face:top', at: [320, 320], size: [32, 32], r: 20 })).toThrow(/corner radius/);
  });
});

describe('outline shape', () => {
  it('builds a tabletop with rounded corners', () => {
    const { mesh, handles } = buildPart(tabletop(inches(2)));
    expect(isWatertight(mesh)).toBe(true);
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [W, T, D] });
    // A prism: volume = cap area × thickness; corners take away (4 − π)r² (less the chord error).
    near(volume(mesh), tagArea(mesh, 'face:top') * T);
    const cornerLoss = W * D - tagArea(mesh, 'face:top');
    near(cornerLoss, (4 - Math.PI) * inches(2) ** 2, 0.02);
    expect(mesh.tags).toEqual(expect.arrayContaining(['face:top', 'face:bottom', 'face:side-bl', 'face:corner-fr']));
    expect(handles.find((h) => h.id === 'face:top')?.drives[0]).toMatchObject({ param: 'thickness' });
  });

  it('assigns stable ids to points that lack one', () => {
    const params = shapes.parse('outline', { thickness: 48, points: [{ at: [0, 0] }, { id: 'v1', at: [64, 0] }, { at: [0, 64] }] });
    expect((params.points as { id: string }[]).map((p) => p.id)).toEqual(['v2', 'v1', 'v3']);
  });

  it('builds arced sides both ways (curved apron)', () => {
    const apron = (sag: number) =>
      part({
        type: 'outline',
        params: {
          axis: 'z',
          thickness: 48,
          points: [
            { id: 'bl', at: [0, 0], sag },
            { id: 'br', at: [inches(30), 0] },
            { id: 'tr', at: [inches(30), inches(4)] },
            { id: 'tl', at: [0, inches(4)] },
          ],
        },
      });
    for (const sag of [inches(1.5), -inches(1.5)]) {
      const { mesh } = buildPart(apron(sag));
      expect(isWatertight(mesh)).toBe(true);
      near(volume(mesh), tagArea(mesh, 'face:front') * 48);
      expect(bounds(mesh).min[1]).toBeCloseTo(sag > 0 ? -sag : 0, 3);
    }
  });

  it('handles concave outlines', () => {
    const L = part({
      type: 'outline',
      params: { thickness: 48, points: [{ at: [0, 0] }, { at: [inches(10), 0] }, { at: [inches(10), inches(4)] }, { at: [inches(4), inches(4)], r: 32 }, { at: [inches(4), inches(10)] }, { at: [0, inches(10)] }] },
    });
    expect(isWatertight(buildPart(L).mesh)).toBe(true);
  });

  it('rejects broken outlines with readable errors', () => {
    const bad = (points: unknown[]) => () => buildPart(part({ type: 'outline', params: { thickness: 48, points } }));
    expect(bad([{ at: [0, 0] }, { at: [100, 60] }, { at: [100, 0] }, { at: [0, 40] }])).toThrow(/crosses itself/);
    expect(bad([{ at: [0, 0], r: 40 }, { at: [64, 0], r: 40 }, { at: [64, 64] }, { at: [0, 64] }])).toThrow(/too big for the side/);
    expect(bad([{ at: [0, 0], sag: 40 }, { at: [64, 0] }, { at: [64, 64] }])).toThrow(/at most half its chord/);
  });
});

describe('edge profiles', () => {
  it('chamfers a straight edge exactly', () => {
    const { mesh } = buildPart(box(inches(10), 48, inches(6), [profile('f1', ['edge:top-front'], 'chamfer', 16)]));
    expect(isWatertight(mesh)).toBe(true);
    near(volume(mesh), inches(10) * 48 * inches(6) - (inches(10) * 16 * 16) / 2);
  });

  it('rounds over a straight edge', () => {
    const r = 16;
    const { mesh, handles } = buildPart(box(inches(10), 48, inches(6), [profile('f1', ['edge:top-front'], 'roundover', r)]));
    expect(isWatertight(mesh)).toBe(true);
    near(volume(mesh), inches(10) * 48 * inches(6) - inches(10) * (1 - Math.PI / 4) * r * r, 0.002);
    expect(mesh.tags).toContain('f1:edge:top-front');
    expect(handles.find((h) => h.id === 'f1:edge:top-front')?.drives).toEqual([{ target: 'f1', param: 'r', label: 'radius' }]);
  });

  it('miters around a panel and keeps its bounds', () => {
    const edges = ['edge:top-front', 'edge:top-back', 'edge:top-left', 'edge:top-right'];
    const { mesh } = buildPart(box(inches(10), 48, inches(6), [profile('f1', edges, 'roundover', 16)]));
    expect(isWatertight(mesh)).toBe(true);
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [inches(10), 48, inches(6)] });
  });

  it('mixes profiles on one face and profiles both faces', () => {
    const p = box(inches(10), 48, inches(6), [
      profile('f1', ['edge:top-front', 'edge:top-back'], 'chamfer', 8),
      profile('f2', ['edge:top-left', 'edge:top-right'], 'roundover', 12),
      profile('f3', ['edge:bottom-front'], 'roundover', 8),
    ]);
    expect(isWatertight(buildPart(p).mesh)).toBe(true);
  });

  it('rounds a whole block (corners collapse into the cap profile)', () => {
    const r = 16;
    const all = ['edge:top-front', 'edge:top-back', 'edge:top-left', 'edge:top-right', 'edge:front-left', 'edge:front-right', 'edge:back-left', 'edge:back-right'];
    const bottom = ['edge:bottom-front', 'edge:bottom-back', 'edge:bottom-left', 'edge:bottom-right'];
    const { mesh } = buildPart(box(inches(4), inches(2), inches(3), [profile('f1', all, 'roundover', r), profile('f2', bottom, 'roundover', r)]));
    expect(isWatertight(mesh)).toBe(true);
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [inches(4), inches(2), inches(3)] });
  });

  it('follows the rounded corners of a tabletop', () => {
    const { mesh } = buildPart(tabletop(inches(1), [profile('f1', TOP_EDGES, 'roundover', 16)]));
    expect(isWatertight(mesh)).toBe(true);
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [W, T, D] });
    expect(volume(mesh)).toBeLessThan(tagArea(mesh, 'face:bottom') * T);
  });

  it('works on outline sides that are arcs', () => {
    const p = part(
      {
        type: 'outline',
        params: { axis: 'z', thickness: 48, points: [{ id: 'a', at: [0, 0], sag: 64 }, { id: 'b', at: [inches(20), 0] }, { id: 'c', at: [inches(20), inches(4)] }, { id: 'd', at: [0, inches(4)] }] },
      },
      [profile('f1', ['edge:front-a', 'edge:front-b', 'edge:front-c', 'edge:front-d'], 'roundover', 8)],
    );
    expect(isWatertight(buildPart(p).mesh)).toBe(true);
  });

  it('refuses profiles that do not fit', () => {
    const thin = (features: Feature[]) => () => buildPart(box(inches(10), 16, inches(6), features));
    expect(thin([profile('f1', ['edge:top-front'], 'roundover', 10), profile('f2', ['edge:bottom-front'], 'roundover', 10)])).toThrow(/deeper than the part is thick/);
    expect(thin([profile('f1', ['edge:top-nowhere'], 'roundover', 4)])).toThrow(/no edge edge:top-nowhere/);
    expect(thin([profile('f1', ['edge:top-front'], 'roundover', 4), profile('f2', ['edge:top-front'], 'chamfer', 4)])).toThrow(/already profiled by f1/);
    // A rounded corner needs matching profiles on both sides.
    expect(thin([profile('f1', ['edge:front-left'], 'roundover', 32), profile('f2', ['edge:top-front'], 'chamfer', 4)])).toThrow(/need the same edge profile/);
  });
});

describe('cuts and profiles together', () => {
  it('keeps holes off profiled edges', () => {
    const p = (at: [number, number]) => tabletop(inches(1), [profile('f1', TOP_EDGES, 'roundover', 16), hole('f2', 'face:top', at, 32)]);
    expect(isWatertight(buildPart(p([inches(12), inches(8)])).mesh)).toBe(true);
    expect(() => buildPart(p([inches(12), 24]))).toThrow(/doesn't fit inside face:top/);
  });

  it('drills into the flat part of a profiled edge face', () => {
    // Dowel hole into the front edge of a 3/4" shelf with a roundover along the top-front edge.
    const p = box(inches(12), 48, inches(10), [profile('f1', ['edge:top-front'], 'roundover', 8), hole('f2', 'face:front', [inches(6), 20], 16, 64)]);
    const { mesh } = buildPart(p);
    expect(isWatertight(mesh)).toBe(true);
    expect(() => buildPart(box(inches(12), 48, inches(10), [profile('f1', ['edge:top-front'], 'roundover', 8), hole('f2', 'face:front', [inches(6), 38], 16, 64)]))).toThrow(
      /doesn't fit/,
    );
  });

  it('builds a cabinet side with shelf-pin holes and hinge-cup bores', () => {
    const features: Feature[] = [];
    let id = 1;
    for (const z of [inches(2), inches(22)]) for (let y = inches(10); y <= inches(26); y += 80) features.push(hole(`f${id++}`, 'face:right', [z, y], 13, 24));
    for (const y of [inches(3), inches(27)]) features.push(hole(`f${id++}`, 'face:left', [inches(23) - 57, y], 88, 32));
    const { mesh } = buildPart(box(46, inches(30), inches(24), features));
    expect(isWatertight(mesh)).toBe(true);
    expect(volume(mesh)).toBeGreaterThan(0);
  });
});
