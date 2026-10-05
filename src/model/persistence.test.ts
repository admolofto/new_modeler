import { describe, expect, it } from 'vitest';
import { buildPart } from '../plugins/pipeline';
import { demoDoc } from './defaults';
import { migrateDoc } from './migrations';
import { applyOps } from './ops';
import { deserialize, serialize } from './persistence';
import goldenV1 from './__golden__/v1-demo.json?raw';
import goldenV2 from './__golden__/v2-demo-note.json?raw';
import goldenV3 from './__golden__/v3-doors-vars.json?raw';
import goldenV4 from './__golden__/v4-joinery.json?raw';
import goldenV5 from './__golden__/v5-blocks.json?raw';
import goldenV6 from './__golden__/v6-motions.json?raw';
import { cutParts } from './cutlist';
import { SCHEMA_VERSION } from './schema';

describe('persistence', () => {
  it('round-trips a doc with holes, an outline and edge profiles', () => {
    const d = demoDoc();
    const loaded = deserialize(serialize(d));
    expect(loaded).toEqual(d);
    expect(loaded.parts['a1.side-right']!.features).toHaveLength(27); // through hole + 26 shelf pins
    expect(loaded.parts.tabletop!.shape.type).toBe('outline');
  });

  it('keeps a loaded doc editable (overrides survive the trip)', () => {
    const loaded = deserialize(serialize(demoDoc()));
    const r = applyOps(loaded, [{ op: 'update', id: 'a1', patch: { params: { width: 30 * 64 } } }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.parts['a1.side-right']!.features).toHaveLength(27);
  });

  it('gives readable errors for bad files', () => {
    expect(() => deserialize('{nope')).toThrow(/not valid JSON/);
    expect(() => deserialize('[]')).toThrow(/not a model file/);
    expect(() => deserialize('{"version": 99}')).toThrow(/schema v99.*update the app/);
    const broken = JSON.parse(serialize(demoDoc()));
    broken.parts['a1.top'].material = 'gone';
    expect(() => deserialize(JSON.stringify(broken))).toThrow(/material "gone" doesn't exist/);
  });

  it('refuses params from a newer plugin version', () => {
    const file = JSON.parse(serialize(demoDoc()));
    file.pluginVersions['feature:hole'] = 99;
    expect(() => deserialize(JSON.stringify(file))).toThrow(/feature "hole" v99/);
  });
});

describe('migrations', () => {
  it('runs each step in order up to the target', () => {
    const steps = {
      1: (d: Record<string, unknown>) => ({ ...d, trail: ['1→2'] }),
      2: (d: Record<string, unknown>) => ({ ...d, trail: [...(d.trail as string[]), '2→3'] }),
    };
    expect(migrateDoc({ version: 1 }, steps, 3)).toEqual({ version: 3, trail: ['1→2', '2→3'] });
    expect(migrateDoc({ version: 2, trail: [] }, steps, 3)).toEqual({ version: 3, trail: ['2→3'] });
    expect(() => migrateDoc({ version: 1 }, {}, 2)).toThrow(/no migration from schema v1/);
  });
});

// Golden files are saves from past versions. Never edit them: add a new one per schema version
// and keep every old one loading through the migration chain.
describe('golden files', () => {
  it('v1: demo cabinet loads, validates and builds', () => {
    const d = deserialize(goldenV1);
    expect(d.assemblies.a1!.generator!.params).toMatchObject({ width: 2304, height: 2208, depth: 1536 });
    expect(d.parts['a1.side-right']!.features[0]).toMatchObject({ type: 'hole', params: { d: 64 } });
    for (const part of Object.values(d.parts)) expect(buildPart(part).mesh.indices.length).toBeGreaterThan(0);
    expect(d.version).toBe(SCHEMA_VERSION);
    expect(d.annotations).toEqual({});
    expect(d.variables).toEqual({});
  });

  it('v2: demo with a markup note loads', () => {
    const d = deserialize(goldenV2);
    expect(d.annotations.n1).toMatchObject({ note: 'Top should overhang 1 1/2" at the front', resolved: false });
    expect(d.annotations.n1!.targets.map((t) => t.node)).toEqual(['tabletop', 'a1.side-right']);
    expect(d.version).toBe(SCHEMA_VERSION);
    expect(d.variables).toEqual({});
  });

  it('v3: doors bound to Cabinet / Doors variables load and stay live', () => {
    const d = deserialize(goldenV3);
    expect(Object.values(d.variables).map((v) => `${v.group} › ${v.name}`)).toEqual(['Cabinet › Width', 'Cabinet › Height', 'Doors › Door gap', 'Doors › Edge reveal']);
    expect(d.assemblies.a1!.bind).toEqual({ 'params.width': 'cabW', 'params.height': 'cabH' });
    expect(d.parts['door-l']!.bind!['shape.x']).toBe('(cabW - 2*reveal - gap) / 2');
    const r = applyOps(d, [{ op: 'update', id: 'gap', patch: { value: 16 } }]);
    expect(r.ok && r.doc.parts['door-l']!.shape.params.x).toBe((2304 - 24) / 2);
  });

  it('v3 → v4: old carcass joints are regenerated and cut into the sides', () => {
    const d = deserialize(goldenV3);
    expect(d.version).toBe(SCHEMA_VERSION);
    expect(d.joints['a1.j.back-left']!.params.depth).toBe(24);
    expect(d.parts['a1.side-left']!.joinery!.map((c) => c.joint)).toEqual(['a1.j.bottom-left', 'a1.j.top-left', 'a1.j.back-left']);
  });

  it('v4: joint cuts, a user dado joint and material prices load', () => {
    const d = deserialize(goldenV4);
    expect(d.materials['baltic-18']).toMatchObject({ sheet: [3840, 3840], price: 95 });
    expect(d.parts['ws-l']!.joinery).toEqual([{ id: 'j1', type: 'dado', joint: 'j1', params: { face: 'face:right', from: [0, 640], to: [512, 685], depth: 16 } }]);
    const shelf = cutParts(d).parts.find((p) => p.id === 'ws-s')!;
    expect(shelf.length).toBe(1408 + 32);
    expect(deserialize(serialize(d))).toEqual(d);
    // v6: the carcass regenerates on load, so its drawers slide.
    expect(Object.values(d.motions).map((m) => `${m.name}: ${m.type}`)).toEqual(['Drawer 1: slide', 'Drawer 2: slide']);
  });

  it('v5: blocks, a note on one, and a cabinet turned 30° load', () => {
    const d = deserialize(goldenV5);
    expect(Object.values(d.parts).filter((p) => p.block).map((p) => p.name)).toEqual(['Sink base', 'Fridge', 'Block 3']);
    expect(d.parts.b3!.transform.rotation).toEqual([0, 30, 0]);
    expect(d.assemblies.a1!.transform.rotation).toEqual([0, -30, 0]);
    // The turned cabinet still cuts its dados; blocks stay out of the cut list.
    expect(d.parts['a1.side-left']!.joinery!.length).toBeGreaterThan(0);
    expect(cutParts(d).parts.some((p) => d.parts[p.id]!.block)).toBe(false);
    expect(d.annotations.n1!.targets).toEqual([{ node: 'b1' }]);
    expect(deserialize(serialize(d))).toEqual(d);
  });

  it('v6: carcass doors and drawers, a hand-built door and a lid load with their animations', () => {
    const d = deserialize(goldenV6);
    // Regenerated on load (v7 folders), so the generated animations come after the user's.
    expect(Object.values(d.motions).map((m) => `${m.name ?? m.nodes[0]}: ${m.type}${m.role ? ' (generated)' : ''}`)).toEqual([
      'Pantry door: hinge',
      'lid: hinge',
      'Drawer 1: slide (generated)',
      'Left door: hinge (generated)',
      'Right door: hinge (generated)',
    ]);
    expect(d.assemblies['a1.drawer-1']).toMatchObject({ name: 'Drawer 1', role: 'drawer-1' });
    expect(d.assemblies['a1.drawer-1']!.children).toContain('a1.drawer-1-front');
    expect(d.motions.swing).toEqual({ id: 'swing', name: 'Pantry door', type: 'hinge', nodes: ['pantry'], params: { side: 'left', angle: 95, seconds: 0.8 } });
    expect(d.parts['a1.door-left']!.features.filter((f) => f.type === 'hole')).toHaveLength(2);
    expect(deserialize(serialize(d))).toEqual(d);
  });
});
