import { describe, expect, it } from 'vitest';
import '../plugins';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { diffDocs } from './diff';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('diffDocs', () => {
  it('reports variables and what got linked to them', () => {
    const a = demoDoc();
    const b = ok(a, [
      { op: 'add', entity: { kind: 'variable', id: 'doorH', name: 'Door height', group: 'Doors', value: inches(30) } },
      { op: 'bind', node: 'door', path: 'shape.y', expr: 'doorH' },
    ]);
    expect(diffDocs(a, b).lines).toEqual(['+ Doors › Door height = 30"', '~ Door: y 30 1/4" → 30"; linked shape.y']);
    const c = ok(b, [{ op: 'update', id: 'doorH', patch: { value: inches(29.5) } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ Doors › Door height 30" → 29 1/2"', '~ Door: y 30" → 29 1/2"']);
    expect(diffDocs(c, ok(c, [{ op: 'delete', id: 'doorH' }])).lines).toEqual(['− Doors › Door height', '~ Door: unlinked shape.y']);
  });

  it('reports generator param changes once, and tints every rebuilt part', () => {
    const a = demoDoc();
    const b = ok(a, [{ op: 'update', id: 'a1', patch: { params: { width: inches(30) } } }]);
    const d = diffDocs(a, b);
    expect(d.lines).toEqual(['~ Base cabinet: width 36" → 30"']);
    expect(d.touched.has('a1.bottom')).toBe(true);
    expect(d.touched.has('door')).toBe(false);
  });

  it('lists added, changed and removed parts', () => {
    const a = demoDoc();
    const b = ok(a, [
      { op: 'delete', id: 'tabletop' },
      { op: 'updateFeature', part: 'door', feature: 'f1', params: { profile: 'chamfer' } },
      { op: 'add', entity: { kind: 'part', name: 'Shelf', material: 'ply-3-4', shape: { type: 'box', params: { x: 640, y: 46, z: 640 } }, transform: { position: [-inches(60), 0, 0] } } },
    ]);
    expect(diffDocs(a, b).lines).toEqual(['~ Door: edgeProfile f1: profile "roundover" → "chamfer"', '+ Shelf', '− Tabletop']);
  });

  it('names the changed leaf of nested params, and notes', () => {
    const a = ok(demoDoc(), [{ op: 'add', entity: { kind: 'annotation', note: 'wider', targets: [{ node: 'tabletop' }] } }]);
    const pts = a.parts.tabletop!.shape.params.points as { at: number[] }[];
    const b = ok(a, [
      { op: 'update', id: 'tabletop', patch: { shape: { params: { points: pts.map((p, i) => (i === 1 ? { ...p, at: [p.at[0]! + 48, p.at[1]] } : p)) } } } },
      { op: 'update', id: 'n1', patch: { resolved: true } },
    ]);
    expect(diffDocs(a, b).lines).toEqual(['~ Tabletop: points[br].at [37 1/2", 0"] → [38 1/4", 0"]', '✓ resolves note "wider"']);
  });

  it('summarizes a new generated assembly as one line', () => {
    const a = demoDoc();
    const b = ok(a, [{ op: 'add', entity: { kind: 'assembly', name: 'Drawer base', transform: { position: [0, 0, inches(40)] }, generator: { type: 'carcass', params: { width: inches(18), height: inches(34.5), depth: inches(24), material: 'ply-3-4', drawers: [0, 0, 0], shelves: 0 } } } }]);
    const d = diffDocs(a, b);
    expect(d.lines).toEqual(['+ Drawer base (carcass)']);
    expect(d.touched.size).toBeGreaterThan(15);
  });
});

describe('joint diffs', () => {
  it('describes an added joint and the cut it makes', () => {
    const base = applyOps(emptyDoc(), [
      { op: 'add', entity: { kind: 'part', id: 'side', name: 'Side', material: 'ply-3-4', shape: { type: 'box', params: { x: 46, y: 1920, z: 768 } } } },
      { op: 'add', entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'ply-3-4', transform: { position: [46, 640, 0] }, shape: { type: 'box', params: { x: 1280, y: 46, z: 768 } } } },
    ]);
    if (!base.ok) throw new Error(base.error);
    const next = applyOps(base.doc, [{ op: 'add', entity: { kind: 'joint', id: 'j1', type: 'dado', parts: ['side', 'shelf'], params: { depth: 16 } } }]);
    if (!next.ok) throw new Error(next.error);
    expect(diffDocs(base.doc, next.doc).lines).toEqual(['~ Side: + dado cut for Shelf', '+ dado joint: Shelf into Side']);
  });
});
