import { describe, expect, it } from 'vitest';
import type { Part } from '../model/schema';
import { inches } from '../model/units';
import './index';
import { buildPart } from './pipeline';
import { PluginError, shapes } from './registry';
import { PULL_STYLES, pullBox, type PullParams } from './shapes/decor/hardware';
import { bounds, isWatertight, volume } from './testMesh';

function pull(params: Record<string, unknown>): { part: Part; params: PullParams } {
  const parsed = shapes.parse('pull', params) as unknown as PullParams;
  return {
    params: parsed,
    part: { id: 'p1', name: 'Pull', grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, shape: { type: 'pull', params: parsed as unknown as Record<string, unknown> }, features: [] },
  };
}

describe('pull (hardware)', () => {
  const cases = PULL_STYLES.flatMap((style) => (['h', 'v'] as const).flatMap((orientation) => [{ style, orientation }, { style, orientation, through: inches(1 + 3 / 8) }]));

  it.each(cases)('$style $orientation (through $through) is closed, outward, and fills exactly its pullBox', (params) => {
    const { part, params: p } = pull(params);
    const { mesh } = buildPart(part);
    expect(isWatertight(mesh)).toBe(true);
    expect(volume(mesh)).toBeGreaterThan(0);
    const b = bounds(mesh);
    const size = pullBox(p);
    b.min.forEach((v) => expect(v).toBeCloseTo(0, 3));
    b.max.forEach((v, k) => expect(v).toBeCloseTo(size[k]!, 3));
  });

  it('gives every tag it makes a surface in its finish', () => {
    for (const style of PULL_STYLES) {
      const { part, params } = pull({ style, finish: { preset: 'metal:matte-black' } });
      const map = shapes.get('pull').surfaces!(params);
      expect(map.base.finish).toEqual({ preset: 'metal:matte-black' });
      for (const tag of buildPart(part).mesh.tags) expect(map.tags?.[tag]?.finish).toEqual({ preset: 'metal:matte-black' });
    }
  });

  it('defaults to a 5" brushed-nickel bar, sized by style', () => {
    const { params } = pull({});
    expect(params).toEqual({ style: 'bar', orientation: 'h', finish: { preset: 'metal:brushed-nickel' } });
    expect(pullBox(params)).toEqual([inches(7), 28, inches(1 + 3 / 8)]);
    expect(pullBox(pull({ orientation: 'v', length: inches(4) }).params)).toEqual([28, inches(6), inches(1 + 3 / 8)]);
    expect(pullBox(pull({ style: 'knob', orientation: 'v' }).params)).toEqual([80, 80, 72]);
    expect(pullBox(pull({ style: 'lever', through: 88 }).params)).toEqual([72 + inches(5), 144, 2 * 160 + 88]);
  });

  it('has box handles of its bounds that edit nothing', () => {
    const { part, params } = pull({ style: 'cup' });
    const { handles } = buildPart(part);
    const front = handles.find((h) => h.id === 'face:front')!;
    expect(front.points[0]![2]).toBe(pullBox(params)[2]);
    expect(handles.every((h) => h.drives.length === 0)).toBe(true);
  });

  it('refuses proportions it can’t make', () => {
    expect(() => buildPart(pull({ style: 'arch', length: inches(2), projection: inches(3) }).part)).toThrow(PluginError);
    expect(() => buildPart(pull({ style: 'bar', size: inches(2), projection: inches(1) }).part)).toThrow(/stand off more/);
    expect(() => buildPart(pull({ style: 'tab', length: 16, size: 48 }).part)).toThrow(/at least as long/);
  });
});
