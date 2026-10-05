import { describe, expect, it } from 'vitest';
import { pluginVersions } from '../plugins';
import { emptyDoc } from './defaults';
import { motionDelta, motionName, motionOf, movedAffines } from './motion';
import { applyOps, type Op } from './ops';
import { deserialize, serialize } from './persistence';
import type { Doc, Vec3 } from './schema';
import { IDENTITY, localBox, transformBox, type Box3 } from './world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const fails = (doc: Doc, ops: Op[]) => {
  const r = applyOps(doc, ops);
  return r.ok ? '' : r.error;
};

const W = 1152; // 18"
const H = 1920; // 30"
const T = 46; // 23/32"
const box = (id: string, size: Vec3, position: Vec3 = [0, 0, 0], parent?: string): Op => ({
  op: 'add',
  parent,
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position }, shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } } },
});
const folder = (id: string, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0], parent?: string): Op => ({
  op: 'add',
  parent,
  entity: { kind: 'assembly', id, name: id, transform: { position, rotation } },
});
const motion = (nodes: string[], type: string, params: Record<string, unknown>, id?: string): Op => ({ op: 'add', entity: { kind: 'motion', id, nodes, type, params } });

/** World bounds of a part with its motion open `t`. */
function openBox(doc: Doc, partId: string, t = 1): Box3 {
  const m = motionOf(doc, partId)!;
  return transformBox(movedAffines(doc, m, t).get(partId)!, localBox(doc, partId));
}

describe('hinge', () => {
  it('swings a door out about the front edge on its hinge side', () => {
    const d = ok(emptyDoc(), [box('door', [W, H, T]), motion(['door'], 'hinge', { side: 'left', angle: 90 })]);
    expect(openBox(d, 'door')).toEqual({ min: [0, 0, T], max: [T, H, T + W] });
    const r = ok(emptyDoc(), [box('door', [W, H, T], [640, 0, 0]), motion(['door'], 'hinge', { side: 'right', angle: 90 })]);
    expect(openBox(r, 'door')).toEqual({ min: [640 + W - T, 0, T], max: [640 + W, H, T + W] });
    // Halfway open sits between: the far edge is out in front, still right of the hinge.
    const half = openBox(d, 'door', 0.5);
    expect(half.max[2]).toBeGreaterThan(T + W / 2);
    expect(half.min[0]).toBe(0);
  });

  it('fills in defaults and opens 105° unless told otherwise', () => {
    const d = ok(emptyDoc(), [box('door', [W, H, T]), motion(['door'], 'hinge', { side: 'left' })]);
    expect(d.motions.mo1).toEqual({ id: 'mo1', type: 'hinge', nodes: ['door'], params: { side: 'left', angle: 105, seconds: 0.8 } });
    // Past square, the free edge swings back past the hinge line.
    expect(openBox(d, 'door').min[0]).toBeLessThan(0);
    expect(motionDelta(d, d.motions.mo1!, 0)).toEqual(IDENTITY);
  });

  it('ignores pulls and hinge leaves when finding the hinge line', () => {
    const d = ok(emptyDoc(), [
      folder('leftDoor'),
      box('slab', [W, H, T], [0, 0, 0], 'leftDoor'),
      box('leaf', [32, 128, T], [-32, 256, 0], 'leftDoor'), // a hinge knuckle sticking out past the edge
      box('pull', [32, 256, 64], [W - 128, 800, T], 'leftDoor'), // sticks out 1" in front
      motion(['leftDoor'], 'hinge', { side: 'left', angle: 90 }),
    ]);
    expect(openBox(d, 'slab')).toEqual({ min: [0, 0, T], max: [T, H, T + W] });
    expect(motionOf(d, 'pull')!.id).toBe('mo1');
  });

  it('lifts a lid hinged at the back (toward defaults to the top)', () => {
    const d = ok(emptyDoc(), [box('lid', [W, T, 640]), motion(['lid'], 'hinge', { side: 'back', angle: 90 })]);
    expect(openBox(d, 'lid')).toEqual({ min: [0, T, 0], max: [W, T + 640, T] });
  });

  it('opens toward the front of a turned cabinet', () => {
    const d = ok(emptyDoc(), [folder('cab', [0, 0, 0], [0, 90, 0]), box('door', [W, H, T], [0, 0, 0], 'cab'), motion(['door'], 'hinge', { side: 'left', angle: 90 })]);
    // The cabinet's front (+Z) faces world +X, so the open door sticks out along +X.
    expect(openBox(d, 'door')).toEqual({ min: [T, 0, -T], max: [T + W, H, 0] });
  });

  it('refuses a toward on the same axis as the hinges', () => {
    expect(fails(emptyDoc(), [box('door', [W, H, T]), motion(['door'], 'hinge', { side: 'left', toward: 'right' })])).toMatch(/side and toward/);
  });
});

describe('slide', () => {
  const drawer = [folder('drawer'), box('front', [W, 384, T], [0, 0, 600], 'drawer'), box('side', [32, 300, 576], [64, 32, 0], 'drawer')];

  it('slides out 90% of its depth by default, or the distance given', () => {
    const d = ok(emptyDoc(), [...drawer, motion(['drawer'], 'slide', {})]);
    expect(d.motions.mo1!.params).toEqual({ toward: 'front', seconds: 0.6 });
    expect(openBox(d, 'front').min[2]).toBe(600 + Math.round(0.9 * (600 + T)));
    const e = ok(d, [{ op: 'update', id: 'mo1', patch: { params: { distance: 512 } } }]);
    expect(openBox(e, 'side')).toEqual({ min: [64, 32, 512], max: [96, 332, 1088] });
    expect(openBox(e, 'side', 0.5).min[2]).toBe(256);
    // null puts a param back to its default.
    const f = ok(e, [{ op: 'update', id: 'mo1', patch: { params: { distance: null } } }]);
    expect(f.motions.mo1!.params.distance).toBeUndefined();
  });

  it('moves sibling parts together', () => {
    const d = ok(emptyDoc(), [box('a', [W, 384, T]), box('b', [W, 64, 200], [0, 0, -200]), motion(['a', 'b'], 'slide', { toward: 'left', distance: 640 })]);
    expect(openBox(d, 'a').min[0]).toBe(-640);
    expect(openBox(d, 'b').min[0]).toBe(-640);
  });
});

describe('motion ops', () => {
  it('updates, renames, changes type and deletes', () => {
    let d = ok(emptyDoc(), [box('door', [W, H, T]), motion(['door'], 'hinge', { side: 'left' })]);
    expect(motionName(d, d.motions.mo1!)).toBe('door');
    d = ok(d, [{ op: 'update', id: 'mo1', patch: { name: 'Left door', params: { angle: 90, toward: 'top' } } }]);
    expect(d.motions.mo1).toMatchObject({ name: 'Left door', params: { side: 'left', toward: 'top', angle: 90 } });
    d = ok(d, [{ op: 'update', id: 'mo1', patch: { name: null, type: 'slide' } }]);
    expect(d.motions.mo1).toEqual({ id: 'mo1', type: 'slide', nodes: ['door'], params: { toward: 'front', seconds: 0.6 } });
    d = ok(d, [{ op: 'delete', id: 'mo1' }]);
    expect(d.motions).toEqual({});
  });

  it('drops deleted parts from a motion, and the motion once it moves nothing', () => {
    let d = ok(emptyDoc(), [box('a', [W, H, T]), box('b', [64, 64, 64]), motion(['a', 'b'], 'slide', {})]);
    d = ok(d, [{ op: 'delete', id: 'b' }]);
    expect(d.motions.mo1!.nodes).toEqual(['a']);
    d = ok(d, [{ op: 'delete', id: 'a' }]);
    expect(d.motions).toEqual({});
  });

  it('refuses what it can’t animate, with reasons', () => {
    const base = ok(emptyDoc(), [box('a', [W, H, T]), folder('f'), box('b', [W, H, T], [0, 0, 0], 'f'), folder('empty')]);
    expect(fails(base, [motion(['nope'], 'slide', {})])).toMatch(/no part or folder "nope"/);
    expect(fails(base, [motion(['a', 'b'], 'slide', {})])).toMatch(/same folder/);
    expect(fails(base, [motion(['a'], 'slide', {}), motion(['a'], 'hinge', { side: 'left' })])).toMatch(/two animations/);
    expect(fails(base, [motion(['empty'], 'slide', {})])).toMatch(/no part in it/);
    expect(fails(base, [motion(['a'], 'spin', {})])).toMatch(/unknown motion type "spin"/);
    expect(fails(base, [motion(['a'], 'hinge', {})])).toMatch(/side/);
    // Moving one of two animated parts away splits them.
    const two = ok(base, [box('c', [64, 64, 64]), motion(['a', 'c'], 'slide', {})]);
    expect(fails(two, [{ op: 'move', id: 'c', parent: 'f' }])).toMatch(/move them together/);
    // A folder and something inside it may both move (a bifold).
    expect(fails(base, [motion(['f'], 'hinge', { side: 'left' }), motion(['b'], 'hinge', { side: 'right' })])).toBe('');
  });

  it('saves and loads motions, and records motion plugin versions', () => {
    const d = ok(emptyDoc(), [box('door', [W, H, T]), motion(['door'], 'hinge', { side: 'right' }, 'swing')]);
    expect(deserialize(serialize(d))).toEqual(d);
    expect(pluginVersions()).toMatchObject({ 'motion:hinge': 1, 'motion:slide': 1 });
  });
});
