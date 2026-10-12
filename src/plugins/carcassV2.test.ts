import { describe, expect, it } from 'vitest';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { effectiveFinish } from '../model/look';
import { motionOf, movedAffines } from '../model/motion';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { doorPullCenter } from './generators/carcass';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

function carcass(params: Record<string, unknown> = {}): Doc {
  return ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } } },
  ]);
}

const T = 46; // 23/32"
const D = inches(24);
const kH = inches(4);
/** A 5" bar pull's box, lying (h): 7" overall, a 28/64" bar, standing off 1 3/8". */
const bar = { x: inches(7), y: 28, z: inches(1 + 3 / 8) };

describe('carcass v2: door folders', () => {
  it('puts each door in a folder that swings, keeping the door part’s id and the motion ids', () => {
    const d = carcass({ drawers: [inches(6)], doors: 2 });
    expect(d.assemblies.a1!.children.filter((id) => d.assemblies[id])).toEqual(['a1.drawer-1', 'a1.door-left-leaf', 'a1.door-right-leaf']);
    expect(d.assemblies['a1.door-left-leaf']).toMatchObject({ name: 'Left door', role: 'door-left-leaf', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, children: ['a1.door-left'] });
    expect(d.parts['a1.door-left']!.role).toBe('door-left');
    expect(Object.values(d.motions).map((m) => [m.id, m.nodes])).toEqual([
      ['a1.motion.drawer-1', ['a1.drawer-1']],
      ['a1.motion.door-left', ['a1.door-left-leaf']],
      ['a1.motion.door-right', ['a1.door-right-leaf']],
    ]);
    expect(motionOf(d, 'a1.door-left')!.id).toBe('a1.motion.door-left');
    const single = carcass({ doors: 1 });
    expect(single.assemblies['a1.door-leaf']!.children).toEqual(['a1.door']);
    expect(single.motions['a1.motion.door']!.nodes).toEqual(['a1.door-leaf']);
    // No pulls unless asked: an old cabinet gains no parts.
    expect(Object.keys(d.parts).some((id) => id.endsWith('-pull'))).toBe(false);
  });

  it('swings a door about the same hinge line as v1 (the door part alone), with or without a pull', () => {
    for (const pulls of [null, { style: 'bar' }, { style: 'knob' }, { style: 'edge' }]) {
      const d = carcass({ drawers: [inches(6)], doors: 2, pulls });
      for (const role of ['door-left', 'door-right']) {
        const m = d.motions[`a1.motion.${role}`]!;
        const v1 = { ...m, id: `v1-${role}`, nodes: [`a1.${role}`] };
        for (const t of [0.5, 1]) {
          const [now, then] = [movedAffines(d, m, t).get(`a1.${role}`)!, movedAffines(d, v1, t).get(`a1.${role}`)!];
          [...now.m.flat(), ...now.t].forEach((v, i) => expect(v).toBeCloseTo([...then.m.flat(), ...then.t][i]!, 6));
        }
      }
    }
  });

  it('carries anything put in a drawer or door folder along as it opens', () => {
    const d = ok(carcass({ drawers: [inches(6)], doors: 1 }), [
      { op: 'add', entity: { kind: 'decor', id: 'knob', shape: { type: 'pull', params: { style: 'knob' } }, transform: { position: [900, 1900, D + T] } }, parent: 'a1.drawer-1' },
      { op: 'add', entity: { kind: 'part', id: 'rail', name: 'Rail', material: 'ply-3-4', transform: { position: [64, 600, D + T] }, shape: { type: 'box', params: { x: 64, y: 64, z: 64 } } }, parent: 'a1.door-leaf' },
    ]);
    expect(motionOf(d, 'knob')!.id).toBe('a1.motion.drawer-1');
    expect(movedAffines(d, d.motions['a1.motion.drawer-1']!, 1).get('knob')!.t[2]).toBeGreaterThan(D);
    expect(movedAffines(d, d.motions['a1.motion.door']!, 1).has('rail')).toBe(true);
  });
});

describe('carcass v2: pulls', () => {
  it('centers a horizontal pull on each drawer front, or near its top', () => {
    const d = carcass({ drawers: [inches(6), 0], shelves: 0, pulls: { style: 'bar' } });
    expect(d.assemblies['a1.drawer-1']!.children.at(-1)).toBe('a1.drawer-1-pull');
    const front = d.parts['a1.drawer-1-front']!;
    const pull = d.parts['a1.drawer-1-pull']!;
    expect(pull).toMatchObject({ name: 'Drawer 1 pull', grain: 'none', shape: { type: 'pull', params: { style: 'bar', orientation: 'h', finish: { preset: 'metal:brushed-nickel' } } } });
    expect(pull.material).toBeUndefined();
    const [fy, fh] = [front.transform.position[1], front.shape.params.y as number];
    expect(pull.transform.position).toEqual([(inches(36) - bar.x) / 2, Math.round(fy + fh / 2 - bar.y / 2), D + T]);
    const top = carcass({ drawers: [inches(10)], shelves: 0, pulls: { style: 'bar', drawerAt: 'top' } });
    const f1 = top.parts['a1.drawer-1-front']!;
    expect(top.parts['a1.drawer-1-pull']!.transform.position[1]).toBe(f1.transform.position[1] + inches(10) - inches(2) - bar.y / 2);
  });

  it('hangs door pulls vertically 1 1/2" in from the opening edge, placed by cabinet kind', () => {
    const base = carcass({ drawers: [inches(6)], doors: 2, pulls: { style: 'bar' } });
    const left = base.parts['a1.door-left']!;
    const right = base.parts['a1.door-right']!;
    const lp = base.parts['a1.door-left-pull']!;
    expect(base.assemblies['a1.door-left-leaf']!.children).toEqual(['a1.door-left', 'a1.door-left-pull']);
    expect(lp.shape.params).toMatchObject({ orientation: 'v' });
    const doorTop = left.transform.position[1] + (left.shape.params.y as number);
    // Base cabinet: the pull's top 3" below the door's top; centered 1 1/2" from the meeting edges.
    expect(lp.transform.position).toEqual([left.transform.position[0] + (left.shape.params.x as number) - inches(1.5) - bar.y / 2, doorTop - inches(3) - bar.x, D + T]);
    expect(base.parts['a1.door-right-pull']!.transform.position[0]).toBe(right.transform.position[0] + inches(1.5) - bar.y / 2);
    // Wall cabinet (no toe kick), hinged right: the bottom 3" above the door's bottom, on the left.
    const wall = carcass({ height: inches(30), depth: inches(12), toeKick: null, doors: 1, doorHinge: 'right', pulls: { style: 'bar' } });
    expect(wall.parts['a1.door-pull']!.transform.position).toEqual([inches(1 / 16) + inches(1.5) - bar.y / 2, inches(3), inches(12) + T]);
    // Tall door: centered 40" above the cabinet's bottom.
    const tall = carcass({ height: inches(84), doors: 2, shelves: 4, pulls: { style: 'bar' } });
    expect(tall.parts['a1.door-left-pull']!.transform.position[1]).toBe(inches(40) - bar.x / 2);
    // Asked for: the middle of the door.
    const mid = carcass({ doors: 1, pulls: { style: 'bar', doorAt: 'middle' } });
    const door = mid.parts['a1.door']!;
    expect(mid.parts['a1.door-pull']!.transform.position[1]).toBe(door.transform.position[1] + (door.shape.params.y as number) / 2 - bar.x / 2);
    expect(doorPullCenter('bottom', kH, inches(30), bar.x, true)).toBe(kH + inches(3) + bar.x / 2);
    // Never off the door: a tall door that starts above 40" gets it as low as it goes.
    expect(doorPullCenter('auto', inches(50), inches(48), bar.x, false)).toBe(inches(50) + bar.x / 2);
  });

  it('gives the pulls the style, length and finish asked for', () => {
    const d = carcass({ drawers: [inches(6)], doors: 1, pulls: { style: 'knob', finish: { preset: 'metal:matte-black' } } });
    expect(d.parts['a1.door-pull']!.shape.params).toEqual({ style: 'knob', orientation: 'v', finish: { preset: 'metal:matte-black' } });
    const long = carcass({ drawers: [inches(6)], pulls: { style: 'bar', length: inches(8) } });
    expect(long.parts['a1.drawer-1-pull']!.shape.params).toMatchObject({ length: inches(8) });
    expect(long.parts['a1.drawer-1-pull']!.transform.position[0]).toBe((inches(36) - inches(10)) / 2);
  });

  it('keeps a false front (and its pull) still, and drops a deleted front’s pull with it', () => {
    const d = carcass({ drawers: [inches(6), 0], shelves: 0, pulls: { style: 'bar' } });
    const sink = ok(d, ['bottom', 'side-left', 'side-right', 'back', 'sub-front'].map((s): Op => ({ op: 'delete', id: `a1.drawer-1-${s}` })));
    expect(sink.assemblies['a1.drawer-1']!.children).toEqual(['a1.drawer-1-front', 'a1.drawer-1-pull']);
    expect(Object.keys(sink.motions)).toEqual(['a1.motion.drawer-2']);
    expect(ok(d, [{ op: 'delete', id: 'a1.drawer-2-front' }]).parts['a1.drawer-2-pull']).toBeUndefined();
    const gone = ok(carcass({ doors: 2, pulls: { style: 'bar' } }), [{ op: 'delete', id: 'a1.door-left' }]);
    expect(gone.parts['a1.door-left-pull']).toBeUndefined();
    expect(gone.assemblies['a1.door-left-leaf']).toBeUndefined();
    expect(gone.motions['a1.motion.door-left']).toBeUndefined();
    expect(gone.motions['a1.motion.door-right']).toBeDefined();
  });

  it('finishes the drawer fronts and doors with frontFinish (a look: the material stays)', () => {
    const finish = { preset: 'paint', color: '#1f2a44' };
    const d = carcass({ drawers: [inches(6)], doors: 2, frontFinish: finish, pulls: { style: 'bar' } });
    for (const id of ['a1.drawer-1-front', 'a1.door-left', 'a1.door-right']) expect(d.parts[id]).toMatchObject({ finish, material: 'ply-3-4' });
    for (const id of ['a1.side-left', 'a1.drawer-1-bottom', 'a1.drawer-1-pull']) expect(d.parts[id]!.finish).toBeUndefined();
    expect(effectiveFinish(d, 'a1.door-left')).toMatchObject({ finish, explicit: true });
  });
});
