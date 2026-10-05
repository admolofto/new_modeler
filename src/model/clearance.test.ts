import { describe, expect, it } from 'vitest';
import { clashesOf, clashText, clearance } from './clearance';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc, Vec3 } from './schema';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const box = (id: string, size: Vec3, position: Vec3 = [0, 0, 0]): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position }, shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } } },
});
const wall = (id: string, size: Vec3, position: Vec3): Op => ({ op: 'add', entity: { kind: 'block', id, name: id, size, transform: { position } } });
const motion = (id: string, nodes: string[], type: string, params: Record<string, unknown>): Op => ({ op: 'add', entity: { kind: 'motion', id, nodes, type, params } });

describe('clearance', () => {
  it('catches a door hinged against a wall just past square', () => {
    const d = ok(emptyDoc(), [box('door', [1152, 1920, 46]), wall('Wall', [256, 3000, 4000], [-256, 0, -1000]), motion('swing', ['door'], 'hinge', { side: 'left' })]);
    const [c] = clearance(d);
    expect(c).toMatchObject({ motion: 'swing', part: 'door', hits: 'Wall' });
    expect(c!.at * 105).toBeGreaterThan(90);
    expect(c!.at * 105).toBeLessThan(92);
    expect(clashText(d, c!)).toMatch(/^door hits “Wall” at (90|91)°$/);
    // Limited to 90° it clears.
    expect(clearance(ok(d, [{ op: 'update', id: 'swing', patch: { params: { angle: 90 } } }]))).toEqual([]);
    // Hinged on the other side it swings away from the wall.
    expect(clearance(ok(d, [{ op: 'update', id: 'swing', patch: { params: { side: 'right' } } }]))).toEqual([]);
  });

  it('says how far a drawer gets before it hits something', () => {
    const d = ok(emptyDoc(), [box('drawer', [600, 200, 600]), wall('Range', [600, 900, 200], [0, 0, 800]), motion('pull', ['drawer'], 'slide', { distance: 900 })]);
    const [c] = clearance(d);
    expect(c).toMatchObject({ motion: 'pull', hits: 'Range' });
    expect(c!.at * 900).toBeGreaterThanOrEqual(200);
    expect(c!.at * 900).toBeLessThan(204);
    expect(clashText(d, c!, (u) => `${u}u`)).toMatch(/^drawer hits “Range” after 20[0-3]u$/);
  });

  it('finds drawers that only collide when both are open (an inside corner)', () => {
    const d = ok(emptyDoc(), [
      box('a', [600, 200, 600]),
      box('b', [600, 200, 600], [1000, 0, 900]),
      motion('ma', ['a'], 'slide', { distance: 900 }),
      motion('mb', ['b'], 'slide', { toward: 'left', distance: 900 }),
    ]);
    expect(clearance(d)).toEqual([{ motion: 'ma', part: 'a', hits: 'b', with: 'mb', at: 1 }]);
    expect(clashesOf(d, 'mb')).toHaveLength(1);
    expect(clashText(d, clearance(d)[0]!)).toBe('a and b hit each other when both are open');
  });

  it('passes a cabinet whose doors and drawer open clear, and ignores what already touches', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [384], doors: 2 } } } },
    ]);
    expect(Object.keys(d.motions)).toHaveLength(3);
    expect(clearance(d)).toEqual([]);
    // A block already overlapping the door when closed isn't news.
    expect(clearance(ok(d, [wall('Stuck', [64, 64, 64], [64, 1024, 1536])]))).toEqual([]);
  });
});
