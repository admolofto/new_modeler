import { describe, expect, it } from 'vitest';
import { demoDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { deserialize, serialize } from './persistence';
import type { Doc } from './schema';
import { createStore } from './store';
import { inches } from './units';
import { dependents, variablesOf } from './variables';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
function err(doc: Doc, ops: Op[]): string {
  const r = applyOps(doc, ops);
  if (r.ok) throw new Error('expected the batch to be rejected');
  return r.error;
}

const DOOR_W = '(cabW - 2*reveal - gap) / 2';
const door = (id: string, name: string): Op => ({
  op: 'add',
  parent: 'a1',
  entity: { kind: 'part', id, name, material: 'ply-3-4', grain: 'y', shape: { type: 'box', params: { x: 64, y: 64, z: 46 } } },
});

/** Two full-overlay doors on the demo cabinet, the way the AI is asked to build them (also the v3 golden file). */
const doorOps: Op[] = [
  { op: 'add', entity: { kind: 'variable', id: 'cabW', name: 'Width', group: 'Cabinet', value: inches(36) } },
  { op: 'add', entity: { kind: 'variable', id: 'cabH', name: 'Height', group: 'Cabinet', value: inches(34.5) } },
  { op: 'add', entity: { kind: 'variable', id: 'gap', name: 'Door gap', group: 'Doors', value: inches(1 / 8) } },
  { op: 'add', entity: { kind: 'variable', id: 'reveal', name: 'Edge reveal', group: 'Doors', value: inches(1 / 16) } },
  { op: 'bind', node: 'a1', path: 'params.width', expr: 'cabW' },
  { op: 'bind', node: 'a1', path: 'params.height', expr: 'cabH' },
  door('door-l', 'Left door'),
  door('door-r', 'Right door'),
  ...['door-l', 'door-r'].flatMap((id): Op[] => [
    { op: 'bind', node: id, path: 'shape.x', expr: DOOR_W },
    { op: 'bind', node: id, path: 'shape.y', expr: 'cabH - 4in - reveal' },
    { op: 'bind', node: id, path: 'position.y', expr: '4in' },
    { op: 'bind', node: id, path: 'position.z', expr: '24in' },
  ]),
  { op: 'bind', node: 'door-l', path: 'position.x', expr: 'reveal' },
  { op: 'bind', node: 'door-r', path: 'position.x', expr: `reveal + ${DOOR_W} + gap` },
];

const withDoors = () => ok(demoDoc(), doorOps);
const W = inches(36);

describe('variables and bindings', () => {
  it('evaluates bound fields when they are created', () => {
    const d = withDoors();
    const l = d.parts['door-l']!;
    const r = d.parts['door-r']!;
    expect(l.shape.params.x).toBe((W - 16) / 2);
    expect(l.shape.params.y).toBe(inches(34.5 - 4) - 4);
    expect(l.transform.position).toEqual([4, inches(4), inches(24)]);
    expect(r.transform.position[0]).toBe(4 + (W - 16) / 2 + 8);
    expect(r.transform.position[0] + (r.shape.params.x as number)).toBe(W - 4); // right edge 1/16" in from the side
  });

  it('a variable edit resizes and moves everything bound to it, in one batch', () => {
    const store = createStore(withDoors());
    store.dispatch([{ op: 'update', id: 'gap', patch: { value: inches(1 / 4) } }]);
    const d = store.doc;
    expect(d.parts['door-l']!.shape.params.x).toBe((W - 24) / 2);
    expect(d.parts['door-r']!.transform.position[0]).toBe(4 + (W - 24) / 2 + 16);
    store.undo();
    expect(store.doc.parts['door-l']!.shape.params.x).toBe((W - 16) / 2);
  });

  it('a generator param bound to a variable regenerates the assembly', () => {
    const d = ok(withDoors(), [{ op: 'update', id: 'cabW', patch: { value: inches(30) } }]);
    expect(d.assemblies.a1!.generator!.params.width).toBe(inches(30));
    expect(d.parts['a1.side-right']!.transform.position[0]).toBe(inches(30) - 46);
    expect(d.parts['door-l']!.shape.params.x).toBe((inches(30) - 16) / 2);
  });

  it('editing a field bound to one bare variable writes through to it (push the cabinet side)', () => {
    const d = ok(withDoors(), [{ op: 'update', id: 'a1', patch: { params: { width: inches(38) } } }]);
    expect(d.variables.cabW!.value).toBe(inches(38));
    expect(d.parts['door-l']!.shape.params.x).toBe((inches(38) - 16) / 2);
    const moved = ok(withDoors(), [{ op: 'move', id: 'door-l', to: [8, inches(4), inches(24)] }]);
    expect(moved.variables.reveal!.value).toBe(8);
    expect(moved.parts['door-r']!.transform.position[0]).toBe(8 + (W - 24) / 2 + 8);
  });

  it('refuses direct edits to a field set by a formula, naming the variables', () => {
    const e = err(withDoors(), [{ op: 'update', id: 'door-l', patch: { shape: { params: { x: inches(10) } } } }]);
    expect(e).toMatch(/Left door x size follows the Cabinet \/ Doors variables \(Width, Door gap, Edge reveal\)/);
    expect(e).toMatch(/unlink/);
    // Unlinked, it edits freely and keeps its other bindings.
    const d = ok(withDoors(), [
      { op: 'bind', node: 'door-l', path: 'shape.x', expr: null },
      { op: 'update', id: 'door-l', patch: { shape: { params: { x: inches(10) } } } },
    ]);
    expect(d.parts['door-l']!.shape.params.x).toBe(inches(10));
    expect(Object.keys(d.parts['door-l']!.bind!)).not.toContain('shape.x');
  });

  it('deleting a variable unbinds what used it and keeps the values', () => {
    const before = withDoors();
    const d = ok(before, [{ op: 'delete', id: 'gap' }]);
    expect(d.variables.gap).toBeUndefined();
    expect(d.parts['door-l']!.shape.params.x).toBe(before.parts['door-l']!.shape.params.x);
    expect(d.parts['door-l']!.bind).toEqual({ 'shape.y': 'cabH - 4in - reveal', 'position.y': '4in', 'position.z': '24in', 'position.x': 'reveal' });
    expect(d.parts['door-r']!.bind!['position.x']).toBeUndefined();
  });

  it('rejects bad bindings with clear errors', () => {
    const d = withDoors();
    expect(err(d, [{ op: 'bind', node: 'a1.side-left', path: 'shape.x', expr: 'cabW' }])).toMatch(/generated — bind its assembly's params/);
    expect(err(d, [{ op: 'bind', node: 'door-l', path: 'shape.q', expr: '1' }])).toMatch(/nothing at|isn't a number/);
    expect(err(d, [{ op: 'bind', node: 'door-l', path: 'material', expr: '1' }])).toMatch(/bindable paths/);
    expect(err(d, [{ op: 'bind', node: 'door-l', path: 'shape.x', expr: 'cabW +' }])).toMatch(/ends too soon/);
    expect(err(d, [{ op: 'bind', node: 'door-l', path: 'shape.x', expr: 'nope' }])).toMatch(/Left door x size = nope: .*no variable "nope"/);
    expect(err(d, [{ op: 'update', id: 'gap', patch: { value: inches(40) } }])).toMatch(/Left door|positive/);
    expect(err(d, [{ op: 'add', entity: { kind: 'variable', id: 'min', name: 'x', group: 'g', value: 1 } }])).toMatch(/reserved/);
    expect(err(d, [{ op: 'add', entity: { kind: 'variable', id: 'door-l', name: 'x', group: 'g', value: 1 } }])).toMatch(/letters, digits and _/);
  });

  it('binds feature params and drops them with the feature', () => {
    const d = ok(withDoors(), [
      { op: 'add', entity: { kind: 'variable', id: 'cupIn', name: 'Cup inset', group: 'Doors', value: inches(3) } },
      { op: 'addFeature', part: 'door-l', feature: { id: 'f1', type: 'hole', params: { face: 'face:back', at: [57, 64], d: 88, depth: 32 } } },
      { op: 'bind', node: 'door-l', path: 'features.f1.at.1', expr: 'cupIn' },
    ]);
    expect(d.parts['door-l']!.features[0]!.params.at).toEqual([57, inches(3)]);
    const gone = ok(d, [{ op: 'removeFeature', part: 'door-l', feature: 'f1' }]);
    expect(gone.parts['door-l']!.bind!['features.f1.at.1']).toBeUndefined();
  });

  it('lists dependents and a node\'s variables', () => {
    const d = withDoors();
    expect(dependents(d, 'cabW').map((b) => `${b.node} ${b.path}`)).toEqual(['door-l shape.x', 'door-r shape.x', 'door-r position.x', 'a1 params.width']);
    expect(variablesOf(d, 'door-r').map((v) => v.id)).toEqual(['cabW', 'cabH', 'gap', 'reveal']);
  });

  it('survives save and load', () => {
    const d = withDoors();
    expect(deserialize(serialize(d))).toEqual(d);
    const broken = JSON.parse(serialize(d));
    broken.parts['door-l'].shape.params.x = 999;
    expect(() => deserialize(JSON.stringify(broken))).toThrow(/Left door x size is 999 but its formula/);
  });
});
