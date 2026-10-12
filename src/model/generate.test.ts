import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerGenerator, registerShape, shapes } from '../plugins';
import type { BoxParams } from '../plugins/shapes/box';
import { emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';
import { apply, nodeAffine } from './world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

// A decor knob (no material) for the test cabinet's door.
registerShape<BoxParams>({
  type: 'testKnob',
  version: 1,
  schema: z.object({ x: z.int().positive(), y: z.int().positive(), z: z.int().positive() }),
  describe: 'test only',
  build: (p) => shapes.get('box').build(p),
  handles: (p) => shapes.get('box').handles(p),
  decor: { category: 'hardware', label: 'Knob', internal: true },
  surfaces: () => ({ base: { finish: { preset: 'metal:brass' } } }),
});

/**
 * A case with a door in a folder that sits off the assembly's origin (turned a quarter), a knob on
 * the door (decor, unclickable), a painted trim strip, and the door's hinge on the folder.
 */
registerGenerator<{ width: number }>({
  type: 'testCabinet',
  version: 1,
  schema: z.object({ width: z.int().positive() }),
  describe: 'test only',
  generate: (p) => ({
    groups: [{ role: 'door', name: 'Door', position: [p.width, 0, 640], rotation: [0, 90, 0] }],
    parts: [
      { role: 'case', name: 'Case', material: 'ply-3-4', grain: 'y', position: [0, 0, 0], shape: { type: 'box', params: { x: p.width, y: 1280, z: 640 } } },
      { role: 'panel', name: 'Panel', material: 'ply-3-4', grain: 'y', position: [0, 0, 0], group: 'door', shape: { type: 'box', params: { x: 640, y: 1280, z: 46 } } },
      { role: 'knob', name: 'Knob', grain: 'none', position: [576, 640, 46], group: 'door', unclickable: true, shape: { type: 'testKnob', params: { x: 32, y: 32, z: 64 } } },
      { role: 'trim', name: 'Trim', material: 'ply-3-4', grain: 'x', position: [0, 1280, 0], finish: { preset: 'paint', color: '#ffffff' }, shape: { type: 'box', params: { x: p.width, y: 46, z: 46 } } },
    ],
    joints: [],
    motions: [{ role: 'door', name: 'Door', type: 'hinge', nodes: ['door'], requires: ['panel'], params: { side: 'left' } }],
  }),
  materialRefs: () => ['ply-3-4'],
});

const cabinet = (): Doc => ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 't1', name: 'Cabinet', generator: { type: 'testCabinet', params: { width: 1152 } } } }]);
const resize = (width: number): Op => ({ op: 'update', id: 't1', patch: { params: { width } } });

describe('generated folders, parts and motions', () => {
  it('puts a group\'s folder at its transform, its parts relative to it', () => {
    const d = cabinet();
    expect(d.assemblies['t1.door']!.transform).toEqual({ position: [1152, 0, 640], rotation: [0, 90, 0] });
    expect(d.parts['t1.panel']!.transform.position).toEqual([0, 0, 0]);
    // A quarter turn about y: the panel's local +X runs along world −Z.
    expect(apply(nodeAffine(d, 't1.panel'), [640, 0, 0])).toEqual([1152, 0, 0]);
    expect(d.assemblies.t1!.generator!.overrides).toEqual({});
  });

  it('keeps a moved folder as an override against its own transform', () => {
    let d = ok(cabinet(), [{ op: 'move', id: 't1.door', to: [1152 + 64, 0, 640] }]);
    expect(d.assemblies.t1!.generator!.overrides.door).toEqual({ position: [1216, null, null] });
    d = ok(d, [resize(1280)]);
    // The override wins on the axis it set; the others follow the generator.
    expect(d.assemblies['t1.door']!.transform).toEqual({ position: [1216, 0, 640], rotation: [0, 90, 0] });
  });

  it('emits decor parts without a material, and unclickable parts', () => {
    const d = cabinet();
    expect('material' in d.parts['t1.knob']!).toBe(false);
    expect(d.parts['t1.knob']!.unclickable).toBe(true);
    expect('unclickable' in d.parts['t1.panel']!).toBe(false);
    // Made clickable by hand: an override that survives a regenerate.
    const e = ok(d, [{ op: 'update', id: 't1.knob', patch: { unclickable: false } }, resize(1280)]);
    expect(e.assemblies.t1!.generator!.overrides.knob).toEqual({ unclickable: false });
    expect(e.parts['t1.knob']!.unclickable).toBeUndefined();
  });

  it('gives parts the generator\'s finish; a finish set by hand is an override, and clearing it goes back', () => {
    const d = cabinet();
    expect(d.parts['t1.trim']!.finish).toEqual({ preset: 'paint', color: '#ffffff' });
    expect(d.parts['t1.case']!.finish).toBeUndefined();
    const painted = ok(d, [{ op: 'update', id: 't1.trim', patch: { finish: { preset: 'paint', color: '#000000' } } }, resize(1280)]);
    expect(painted.parts['t1.trim']!.finish).toEqual({ preset: 'paint', color: '#000000' });
    expect(painted.assemblies.t1!.generator!.overrides.trim).toEqual({ finish: { preset: 'paint', color: '#000000' } });
    const cleared = ok(painted, [{ op: 'update', id: 't1.trim', patch: { finish: null } }]);
    expect(cleared.parts['t1.trim']!.finish).toEqual({ preset: 'paint', color: '#ffffff' });
    expect(cleared.assemblies.t1!.generator!.overrides.trim).toBeUndefined();
    // A generated folder's finish is an override too.
    const folder = ok(d, [{ op: 'update', id: 't1.door', patch: { finish: { preset: 'wood:walnut' } } }, resize(1280)]);
    expect(folder.assemblies['t1.door']!.finish).toEqual({ preset: 'wood:walnut' });
    expect(folder.assemblies.t1!.generator!.overrides.door).toEqual({ finish: { preset: 'wood:walnut' } });
  });

  it('moves a folder node, and drops the motion when a node or a required part is gone', () => {
    const d = cabinet();
    expect(d.motions['t1.motion.door']).toMatchObject({ nodes: ['t1.door'], type: 'hinge', role: 'door' });
    // The knob isn't required: the door still swings without it.
    expect(ok(d, [{ op: 'delete', id: 't1.knob' }]).motions['t1.motion.door']).toBeDefined();
    // The panel is: without it the folder (and its knob) stays put.
    const noPanel = ok(d, [{ op: 'delete', id: 't1.panel' }]);
    expect(noPanel.assemblies['t1.door']!.children).toEqual(['t1.knob']);
    expect(noPanel.motions['t1.motion.door']).toBeUndefined();
    // Without the folder there's nothing to move.
    expect(ok(d, [{ op: 'delete', id: 't1.door' }]).motions['t1.motion.door']).toBeUndefined();
  });
});
