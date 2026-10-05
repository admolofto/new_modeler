import { describe, expect, it } from 'vitest';
import '../plugins';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { boxSize, overlaps, worldBoxes } from '../model/world';
import { moveOps } from './blocks';
import { duplicateOps } from './duplicate';
import { gizmoNodes, gizmoPlace } from './gizmo';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('duplicating', () => {
  it('copies a block in place, then it can be moved alongside', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', name: 'Sink base', size: [inches(36), inches(34.5), inches(24)] } }]);
    const dup = duplicateOps(d, ['b1']);
    expect(dup.copies).toEqual(['b2']);
    const next = ok(d, [...dup.ops, ...moveOps(dup.doc, dup.copies, [inches(36), 0, 0])]);
    expect(next.parts.b2).toMatchObject({ name: 'Sink base', block: true });
    expect(worldBoxes(next).get('b2')!.min[0]).toBe(inches(36));
    expect(overlaps(next, ['b1', 'b2'])).toEqual([]);
  });

  it('copies a generated cabinet with its hand edits, not its variables', () => {
    const d = ok(demoDoc(), [
      { op: 'add', entity: { kind: 'variable', id: 'cabW', name: 'Width', group: 'Cabinet', value: inches(36) } },
      { op: 'bind', node: 'a1', path: 'params.width', expr: 'cabW' },
    ]);
    const dup = duplicateOps(d, ['a1']);
    const next = ok(d, dup.ops);
    const [copy] = dup.copies;
    expect(copy).toBe('a2');
    // The side's through hole and 26 shelf pins (overrides on a generated part) came along.
    expect(next.parts['a2.side-right']!.features).toHaveLength(27);
    expect(next.assemblies.a2!.generator!.overrides).toEqual(next.assemblies.a1!.generator!.overrides);
    expect(next.assemblies.a2!.bind).toBeUndefined();
    // Resizing the original through its variable leaves the copy alone.
    const wider = ok(next, [{ op: 'update', id: 'cabW', patch: { value: inches(40) } }]);
    expect(wider.assemblies.a2!.generator!.params.width).toBe(inches(36));
  });

  it('copies user joints between copied parts', () => {
    const panel = (id: string, x: number, w: number): Op => ({
      op: 'add',
      entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position: [x, 0, 0] }, shape: { type: 'box', params: { x: w, y: inches(30), z: inches(12) } } },
      parent: 'unit',
    });
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'unit', name: 'Unit' } },
      panel('side', 0, 46),
      panel('shelf', 46, inches(20)),
      { op: 'add', entity: { kind: 'joint', type: 'butt', parts: ['side', 'shelf'] } },
    ]);
    const dup = duplicateOps(d, ['unit']);
    const next = ok(d, dup.ops);
    expect(next.assemblies[dup.copies[0]!]!.children).toHaveLength(2);
    expect(Object.values(next.joints)).toHaveLength(2);
  });

  it('copies animations of copied things; a copied cabinet animates on its own', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'door', name: 'Door' } },
      { op: 'add', parent: 'door', entity: { kind: 'part', id: 'slab', name: 'Slab', material: 'ply-3-4', shape: { type: 'box', params: { x: inches(18), y: inches(30), z: 46 } } } },
      { op: 'add', entity: { kind: 'motion', name: 'Pantry door', nodes: ['door'], type: 'hinge', params: { side: 'right' } } },
      { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', transform: { position: [inches(40), 0, 0] }, generator: { type: 'carcass', params: { width: inches(30), height: inches(34.5), depth: inches(24), material: 'ply-3-4', drawers: [0, 0], shelves: 0 } } } },
    ]);
    const next = ok(d, duplicateOps(d, ['door', 'a1']).ops);
    const copy = Object.values(next.motions).filter((m) => m.role === undefined).at(-1)!;
    expect(copy).toMatchObject({ name: 'Pantry door', type: 'hinge', params: { side: 'right' } });
    expect(next.assemblies[copy.nodes[0]!]!.name).toBe('Door');
    expect(copy.nodes).not.toEqual(['door']);
    expect(Object.values(next.motions).filter((m) => m.role !== undefined)).toHaveLength(4);
  });
});

describe('what the gizmo moves', () => {
  it('moves a generated part’s whole cabinet, blocks and loose parts as picked', () => {
    const d = ok(demoDoc(), [{ op: 'add', entity: { kind: 'block', size: [64, 64, 64] } }]);
    expect(gizmoNodes(d, [{ node: 'a1.side-left' }])).toEqual(['a1']);
    expect(gizmoNodes(d, [{ node: 'b1' }, { node: 'door' }])).toEqual(['b1', 'door']);
    expect(gizmoNodes(d, [{ node: 'b1', handle: 'face:top' }])).toBeNull();
    // Every part of the cabinet picked (from its list row): the cabinet.
    const all = Object.keys(d.parts).filter((id) => id.startsWith('a1.')).map((node) => ({ node }));
    expect(gizmoNodes(d, all)).toEqual(['a1']);
  });

  it('sits at the center of what moves, turned with it', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', transform: { position: [0, 0, inches(24)], rotation: [0, 90, 0] }, size: [inches(24), inches(30), inches(36)] } }]);
    const place = gizmoPlace(d, ['b1'])!;
    expect(place.pivot).toEqual([inches(18), inches(15), inches(12)]);
    expect(place.upright).toBe(true);
    // Measured along its own axes (the frame turns with it).
    expect(boxSize(place.box!)).toEqual([inches(24), inches(30), inches(36)]);
  });
});
