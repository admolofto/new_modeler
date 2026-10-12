import { describe, expect, it } from 'vitest';
import { aiOpSchema } from '../ai/tools';
import type { Part } from '../model/schema';
import { inches } from '../model/units';
import './index';
import { buildPart } from './pipeline';
import { PluginError, shapes, type SurfaceMap } from './registry';
import { bounds, isWatertight, volume } from './testMesh';

/** Every prop shape the AI and the catalog add (A8), at its defaults and at the edges of its params. */
const CASES: [string, Record<string, unknown>][] = [
  ['pendant', {}],
  ['pendant', { shade: 'cylinder', diameter: inches(4), drop: inches(12) }],
  ['pendant', { shade: 'globe', diameter: inches(16), drop: inches(48) }],
  ['pendant', { shade: 'cone', diameter: inches(48), drop: inches(120) }],
  ['recessedLight', {}],
  ['recessedLight', { diameter: inches(6) }],
  ['stripLight', {}],
  ['stripLight', { length: inches(4), width: inches(4) }],
  ['rangeHood', {}],
  ['rangeHood', { style: 'island', width: inches(48), depth: inches(30) }],
  ['rangeHood', { style: 'wall', width: inches(18), depth: inches(18), hoodHeight: inches(4) }],
  ['rangeHood', { style: 'insert', width: inches(72), chimney: 0 }],
  ['barStool', {}],
  ['barStool', { seat: 'square', back: true, seatHeight: inches(30), size: inches(11) }],
  ['barStool', { seatHeight: inches(40), size: inches(22), back: true }],
  ['chair', {}],
  ['chair', { width: inches(14), depth: inches(14), backHeight: inches(26), seatHeight: inches(16) }],
  ['diningTable', {}],
  ['diningTable', { shape: 'round', width: inches(48), base: 'pedestal' }],
  ['diningTable', { shape: 'oval', width: inches(96), depth: inches(42), base: 'trestle' }],
  ['diningTable', { shape: 'rect', width: inches(24), depth: inches(24), base: 'trestle', height: inches(16) }],
  ['diningTable', { shape: 'rect', width: inches(144), base: 'pedestal' }],
  ['rug', {}],
  ['rug', { border: { width: inches(4), finish: { preset: 'fabric:wool', color: '#3a3a3a' } } }],
  ['rug', { shape: 'round', width: inches(72), border: { width: inches(6), finish: { preset: 'fabric:wool' } } }],
  ['rug', { shape: 'round', width: inches(12) }],
  ['plant', {}],
  ['plant', { style: 'bush', seed: 7 }],
  ['plant', { height: inches(96), potDiameter: inches(30), potHeight: inches(30), seed: 9999 }],
  ['plant', { height: inches(8), potDiameter: inches(3), potHeight: inches(2), seed: 0 }],
  ['bowl', {}],
  ['bowl', { fruit: 8, seed: 3 }],
  ['bowl', { fruit: 0, diameter: inches(4), height: inches(1.5) }],
  ['bowl', { fruit: 5, diameter: inches(24), height: inches(12), seed: 42 }],
  ['books', {}],
  ['books', { count: 24, seed: 5 }],
  ['books', { count: 1, height: inches(4), depth: inches(3) }],
  ['vase', {}],
  ['vase', { stems: 9, seed: 11 }],
  ['vase', { stems: 0, height: inches(3), diameter: inches(2) }],
  ['vase', { stems: 5, height: inches(36), diameter: inches(16) }],
];

function prop(type: string, params: Record<string, unknown>): Part {
  return { id: 'p1', name: 'Prop', grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type, params: shapes.parse(type, params) }, features: [] };
}

/** A tag is covered when the map names it, exactly or by a prefix (not only by falling back to base). */
const covered = (map: SurfaceMap, tag: string) => !!map.tags?.[tag] || !!map.prefixes?.some(([p]) => tag.startsWith(p));

describe('prop shapes (A8)', () => {
  it.each(CASES)('%s %j is closed, at its min corner, fills its handles, and covers its tags', (type, params) => {
    const part = prop(type, params);
    const { mesh, handles } = buildPart(part);
    expect(isWatertight(mesh)).toBe(true);
    expect(volume(mesh)).toBeGreaterThan(0);
    const b = bounds(mesh);
    b.min.forEach((v) => expect(v).toBeCloseTo(0, 3));
    // The handles are the box of its bounds.
    const top = handles.find((h) => h.id === 'face:top')!;
    const right = handles.find((h) => h.id === 'face:right')!;
    const front = handles.find((h) => h.id === 'face:front')!;
    expect(b.max[0]).toBeCloseTo(right.points[0]![0], 3);
    expect(b.max[1]).toBeCloseTo(top.points[0]![1], 3);
    expect(b.max[2]).toBeCloseTo(front.points[0]![2], 3);
    const def = shapes.get(type);
    const map = def.surfaces!(part.shape.params);
    for (const tag of mesh.tags) expect(covered(map, tag), `${type}: tag ${tag}`).toBe(true);
    for (const l of def.lights?.(part.shape.params) ?? []) {
      l.at.forEach((v, k) => {
        expect(v).toBeGreaterThanOrEqual(b.min[k]! - 1e-6);
        expect(v).toBeLessThanOrEqual(b.max[k]! + 1e-6);
      });
      if (l.glow) expect(mesh.tags).toContain(l.glow);
    }
  });

  it('are decor the AI may add, with defaults, fields and a category', () => {
    const types = [...new Set(CASES.map(([t]) => t))];
    const schema = aiOpSchema();
    for (const type of types) {
      const decor = shapes.get(type).decor!;
      expect(decor.internal).toBeUndefined();
      expect(['lighting', 'appliance', 'furniture', 'accessory']).toContain(decor.category);
      expect(decor.fields?.length).toBeGreaterThan(0);
      expect(schema.safeParse({ op: 'add', entity: { kind: 'decor', shape: { type, params: decor.defaults ?? {} } } }).success, type).toBe(true);
    }
    // Generator-only pieces stay out.
    for (const type of ['applianceBody', 'applianceDoor']) expect(schema.safeParse({ op: 'add', entity: { kind: 'decor', shape: { type, params: { x: 64, y: 64, z: 64 } } } }).success).toBe(false);
  });

  it('give off light where they should: pendants down (a globe all round), cans down, strips as area lights, hoods as two lamps', () => {
    const lights = (type: string, params: Record<string, unknown> = {}) => shapes.get(type).lights!(shapes.parse(type, params));
    expect(lights('pendant')).toMatchObject([{ kind: 'spot', dir: [0, -1, 0], lumens: 800, kelvin: 2700, glow: 'bulb' }]);
    expect(lights('pendant', { shade: 'globe' })[0]!.kind).toBe('point');
    expect(lights('recessedLight')).toMatchObject([{ kind: 'spot', lumens: 650, kelvin: 3000, beam: 60 }]);
    expect(lights('stripLight', { length: inches(36) })).toMatchObject([{ kind: 'area', size: [inches(36), inches(1)], along: [1, 0, 0], lumens: 900 }]);
    expect(lights('rangeHood').map((l) => [l.kind, l.lumens, l.kelvin])).toEqual([['spot', 300, 3000], ['spot', 300, 3000]]);
  });

  it('vary with their seed, and repeat with the same one', () => {
    const tagsOf = (params: Record<string, unknown>) => Array.from(buildPart(prop('books', params)).mesh.positions.slice(0, 60));
    expect(tagsOf({ seed: 3 })).toEqual(tagsOf({ seed: 3 }));
    expect(tagsOf({ seed: 3 })).not.toEqual(tagsOf({ seed: 4 }));
  });

  it('refuse proportions they can’t make', () => {
    expect(() => buildPart(prop('pendant', { diameter: inches(24), drop: inches(12) }))).toThrow(PluginError);
    expect(() => buildPart(prop('chair', { seatHeight: inches(30), backHeight: inches(30) }))).toThrow(/back/);
    expect(() => buildPart(prop('rug', { width: inches(20), depth: inches(20), border: { width: inches(9), finish: { preset: 'fabric:wool' } } }))).toThrow(/border/);
  });
});
