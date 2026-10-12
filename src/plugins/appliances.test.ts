import { describe, expect, it } from 'vitest';
import { modelSnapshot } from '../ai/context';
import { diffDocs } from '../ai/diff';
import { handleDrives } from '../edit/drives';
import { clashText, clearance } from '../model/clearance';
import { emptyDoc } from '../model/defaults';
import { surfacesOf } from '../model/look';
import { movedAffines } from '../model/motion';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { docErrors } from '../model/validate';
import { localBox, transformBox, union, worldBoxes, type Box3 } from '../model/world';
import './index';
import { buildPart } from './pipeline';
import { generators, shapes } from './registry';
import { isWatertight } from './testMesh';

const I = inches;

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const add = (type: string, params: Record<string, unknown> = {}, position: [number, number, number] = [0, 0, 0], id = 'a1'): Op => ({
  op: 'add',
  entity: { kind: 'assembly', id, name: type, transform: { position }, generator: { type, params } },
});

const appliance = (type: string, params: Record<string, unknown> = {}) => ok(emptyDoc(), [add(type, params)]);
const roles = (d: Doc) => Object.values(d.parts).map((p) => p.role!);
const motionOf = (d: Doc, role: string) => d.motions[`a1.motion.${role}`]!;
/** World box of everything a motion moves, at `t` open. */
function movedBox(d: Doc, role: string, t = 1): Box3 {
  const m = motionOf(d, role);
  const at = movedAffines(d, m, t);
  return union([...at].filter(([id]) => d.parts[id]).map(([id, A]) => transformBox(A, localBox(d, id))));
}

const VARIANTS: [string, Record<string, unknown>][] = [
  ['fridge', {}],
  ['fridge', { style: 'side-by-side', finish: 'black', handle: 'pocket' }],
  ['fridge', { style: 'top-freezer', hinge: 'left', width: I(24), height: I(60), depth: I(24) }],
  ['fridge', { style: 'bottom-freezer', finish: 'panel', panelFinish: { preset: 'paint', color: '#1f2a44' } }],
  ['fridge', { style: 'column', width: I(60), height: I(96), depth: I(36), finish: 'white' }],
  ['range', {}],
  ['range', { fuel: 'electric', burners: 5, backguard: false, drawer: false, width: I(20), height: I(30), depth: I(20) }],
  ['range', { fuel: 'induction', burners: 6, width: I(60), height: I(40), depth: I(32) }],
  ['range', { burners: 6, width: I(36) }],
  ['range', { burners: 5 }],
  ['dishwasher', {}],
  ['dishwasher', { finish: 'panel', width: I(18), height: I(30), depth: I(20) }],
  ['microwave', {}],
  ['microwave', { mount: 'countertop', width: I(18), height: I(10), depth: I(10) }],
  ['microwave', { mount: 'built-in', width: I(36), height: I(24), depth: I(24) }],
  ['microwave', { mount: 'drawer', width: I(24), height: I(15) }],
];

describe('appliance generators (A8)', () => {
  it.each(VARIANTS)('%s %j builds closed decor parts that fill its box, with no errors', (type, params) => {
    const d = appliance(type, params);
    expect(docErrors(d)).toEqual([]);
    const p = d.assemblies.a1!.generator!.params as { width: number; height: number; depth: number };
    const boxes = worldBoxes(d);
    for (const part of Object.values(d.parts)) {
      expect(part.material).toBeUndefined();
      // Full params: generated parts aren't parsed on their way into the doc.
      expect(part.shape.params, part.role).toEqual(shapes.parse(part.shape.type, part.shape.params));
      expect(isWatertight(buildPart(part).mesh), part.role).toBe(true);
      // Every tag it draws has a look of its own (not the base by accident).
      const map = surfacesOf(part)!;
      for (const tag of buildPart(part).mesh.tags) expect(!!map.tags?.[tag] || !!map.prefixes?.some(([p]) => tag.startsWith(p)), `${part.role} ${tag}`).toBe(true);
    }
    // The body and doors fill width × height × depth exactly; handles and knobs stand proud of the front.
    const shell = union(Object.values(d.parts).filter((x) => x.shape.type !== 'pull').map((x) => {
      const b = boxes.get(x.id)!;
      return { min: b.min, max: [b.max[0], Math.min(b.max[1], p.height), Math.min(b.max[2], p.depth)] } as Box3;
    }));
    expect(shell.min).toEqual([0, 0, 0]);
    expect(shell.max[0]).toBe(p.width);
    expect(shell.max[2]).toBe(p.depth);
    if (type !== 'range') expect(shell.max[1]).toBe(p.height);
    // Handles go on their doors' faces.
    for (const pull of Object.values(d.parts).filter((x) => x.shape.type === 'pull')) expect(boxes.get(pull.id)!.min[2]).toBe(p.depth);
  });

  it('makes a French-door fridge: two doors that swing out to their sides at 115°, a freezer drawer that slides', () => {
    const d = appliance('fridge');
    expect(roles(d)).toEqual(expect.arrayContaining(['body', 'door-left', 'door-left-pull', 'door-right', 'door-right-pull', 'freezer-front', 'freezer-bin', 'freezer-pull']));
    expect(motionOf(d, 'door-left')).toMatchObject({ type: 'hinge', nodes: ['a1.door-left-leaf'], params: { side: 'left', angle: 115 } });
    expect(motionOf(d, 'door-right')).toMatchObject({ type: 'hinge', params: { side: 'right', angle: 115 } });
    expect(motionOf(d, 'freezer')).toMatchObject({ type: 'slide', nodes: ['a1.freezer'] });
    // Open, the left door has swung past the fridge's left side, the right one past its right; the drawer comes out.
    expect(movedBox(d, 'door-left').min[0]).toBeLessThan(0);
    expect(movedBox(d, 'door-right').max[0]).toBeGreaterThan(I(36));
    expect(movedBox(d, 'freezer').min[2]).toBeGreaterThan(I(10));
    expect(movedBox(d, 'freezer').max[1]).toBe(movedBox(d, 'freezer', 0).max[1]);
  });

  it('drops the oven door and the dishwasher door from the bottom, slides drawers out, swings a microwave door left', () => {
    const range = appliance('range');
    expect(motionOf(range, 'oven-door')).toMatchObject({ type: 'hinge', params: { side: 'bottom', angle: 90 } });
    const shut = movedBox(range, 'oven-door', 0);
    const open = movedBox(range, 'oven-door');
    // Down flat: no taller than its thickness and handle, reaching out in front by about its height.
    expect(open.max[1] - open.min[1]).toBeLessThan(I(5));
    expect(open.max[2] - I(27)).toBeGreaterThan(shut.max[1] - shut.min[1] - I(1));
    expect(movedBox(range, 'drawer').min[2]).toBeGreaterThan(I(10));
    const dw = appliance('dishwasher');
    expect(motionOf(dw, 'door')).toMatchObject({ type: 'hinge', params: { side: 'bottom', angle: 80 } });
    expect(movedBox(dw, 'door').max[2]).toBeGreaterThan(I(24 + 25));
    const mw = appliance('microwave');
    expect(motionOf(mw, 'door')).toMatchObject({ type: 'hinge', params: { side: 'left', angle: 90 } });
    expect(movedBox(mw, 'door').max[2]).toBeGreaterThan(I(15.5 + 15));
    expect(motionOf(appliance('microwave', { mount: 'drawer' }), 'drawer')).toMatchObject({ type: 'slide' });
  });

  it('resizes from its outer faces only: the door fronts set the depth, the left side moves it', () => {
    const d = appliance('fridge');
    const drive = (node: string, handle: string) => handleDrives(d, { node, handle })!.drives;
    expect(drive('a1.door-left', 'face:front')).toMatchObject([{ owner: { kind: 'generator', asm: 'a1' }, path: 'depth' }]);
    expect(drive('a1.body', 'face:top')).toMatchObject([{ path: 'height' }]);
    expect(drive('a1.body', 'face:right')).toMatchObject([{ path: 'width' }]);
    expect(drive('a1.body', 'face:left')).toMatchObject([{ path: 'width', moveOrigin: true }]);
    expect(drive('a1.body', 'face:back')).toMatchObject([{ path: 'depth', moveOrigin: true }]);
    // Faces inside its box are locked (no per-part overrides).
    expect(drive('a1.door-left', 'face:right')).toEqual([]);
    expect(drive('a1.body', 'face:front')).toEqual([]);
  });

  it('reports a fridge door that hits the wall beside it', () => {
    const room: Op = { op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: 0, right: I(144), back: 0, front: I(144) } } } };
    const d = ok(emptyDoc(), [room, add('fridge')]);
    const hits = clearance(d).filter((c) => c.motion === 'a1.motion.door-left');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hits).toBe('room.wall-left');
    expect(clashText(d, hits[0]!)).toMatch(/^Left door hits “Left wall” at \d+°$/);
    // A foot from the wall, it opens clear.
    const clear = ok(emptyDoc(), [room, add('fridge', {}, [I(12), 0, 0])]);
    expect(clearance(clear).filter((c) => c.motion.startsWith('a1.'))).toEqual([]);
  });

  it('shows the AI one line per appliance, and words its addition by kind', () => {
    const d = appliance('fridge');
    const snap = JSON.parse(modelSnapshot(d));
    expect(snap.tree[0]).toMatchObject({ id: 'a1', generator: { type: 'fridge' }, generatedParts: expect.any(Number) });
    expect(snap.tree[0].children).toBeUndefined();
    expect(diffDocs(emptyDoc(), d).lines).toEqual(['+ fridge (fridge)']);
  });

  it('are described for the AI and have inspector fields', () => {
    for (const type of ['fridge', 'range', 'dishwasher', 'microwave']) {
      const def = generators.get(type);
      expect(def.collapse && def.lockedParts).toBe(true);
      expect(def.fields!.map((f) => f.path)).toEqual(expect.arrayContaining(['width', 'height', 'depth', 'finish']));
      expect(def.describe).toMatch(/width/);
      expect(Object.keys(generators.parse(type, {}))).toEqual(expect.arrayContaining(['width', 'height', 'depth', 'finish']));
    }
  });
});
