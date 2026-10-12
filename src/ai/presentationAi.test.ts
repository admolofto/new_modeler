import { describe, expect, it } from 'vitest';
import '../plugins/testDecor';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { modelSnapshot } from './context';
import { diffDocs } from './diff';
import { treeIssues } from './organization';
import { SYSTEM_PROMPT } from './prompt';
import { aiOpSchema } from './tools';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const stool = (id: string, x: number): Op => ({ op: 'add', entity: { kind: 'decor', id, transform: { position: [x, 0, 0], rotation: [0, 90, 0] }, shape: { type: 'testStool', params: { x: 960, y: 1920, z: 960 } } } });
const params = { x: 960, y: 1920, z: 960 };

describe('decor in the AI schema', () => {
  it('puts stock shapes on parts and decor shapes (not internal ones) on the decor entity', () => {
    const schema = aiOpSchema();
    const add = (entity: Record<string, unknown>) => schema.safeParse({ op: 'add', entity }).success;
    expect(add({ kind: 'decor', shape: { type: 'testStool', params } })).toBe(true);
    expect(add({ kind: 'decor', shape: { type: 'testWall', params } })).toBe(false);
    expect(add({ kind: 'decor', shape: { type: 'box', params } })).toBe(false);
    expect(add({ kind: 'part', material: 'ply-3-4', shape: { type: 'testStool', params } })).toBe(false);
    expect(add({ kind: 'part', material: 'ply-3-4', shape: { type: 'box', params }, finish: { preset: 'paint', color: '#1f2a44' } })).toBe(true);
  });
});

describe('the model snapshot', () => {
  it('shows decor with its shape and front, finishes where set, and the presentation', () => {
    const d = ok(emptyDoc(), [
      stool('s1', 0),
      { op: 'add', entity: { kind: 'assembly', id: 'box', name: 'Box', finish: { preset: 'paint', color: '#1f2a44' } } },
      { op: 'add', parent: 'box', entity: { kind: 'part', id: 'lid', name: 'Lid', material: 'ply-3-4', finish: { preset: 'wood:walnut' }, shape: { type: 'box', params: { x: 640, y: 46, z: 640 } } } },
    ]);
    const snap = JSON.parse(modelSnapshot({ ...d, presentation: { views: [{ id: 'view1', name: 'Island', frame: { nodes: [], from: 'front-left' } }] } }));
    expect(snap.tree[0]).toEqual({ id: 's1', name: 'Test stool 1', decor: true, shape: { type: 'testStool', params }, position: [0, 0, 0], rotation: [0, 90, 0], front: expect.any(String), world: expect.any(Array) });
    expect(snap.tree[1]).toMatchObject({ id: 'box', finish: { preset: 'paint', color: '#1f2a44' }, children: [{ id: 'lid', finish: { preset: 'wood:walnut' } }] });
    expect(snap.materials.find((m: { id: string }) => m.id === 'ply-3-4')).toMatchObject({ finish: { preset: 'wood:birch-ply' } });
    expect(snap.presentation.views[0]).toMatchObject({ id: 'view1', name: 'Island' });
    expect(JSON.parse(modelSnapshot(d)).presentation).toBeUndefined();
  });
});

describe('proposal diffs', () => {
  it('word finish changes and name decor by kind', () => {
    const a = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'box', name: 'Box' } },
      { op: 'add', parent: 'box', entity: { kind: 'part', id: 'lid', name: 'Lid', material: 'ply-3-4', shape: { type: 'box', params: { x: 640, y: 46, z: 640 } } } },
    ]);
    const b = ok(a, [
      { op: 'update', id: 'lid', patch: { finish: { preset: 'paint', color: '#1F2A44' } } },
      { op: 'update', id: 'box', patch: { finish: { preset: 'wood:walnut' } } },
      { op: 'update', id: 'ply-1-2', patch: { finish: { preset: 'melamine', color: '#ffffff' } } },
      stool('s1', 3000),
    ]);
    expect(diffDocs(a, b).lines).toEqual([
      '~ material 1/2" plywood: finish → melamine #ffffff',
      '~ Box: finish → wood:walnut',
      '~ Lid: finish → paint #1f2a44',
      '+ Test stool 1 (test stool)',
    ]);
    const c = ok(b, [{ op: 'update', id: 'lid', patch: { finish: null } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ Lid: finish cleared']);
  });
});

describe('tree check', () => {
  it('asks for loose props to be grouped', () => {
    const before = emptyDoc();
    const after = ok(before, [stool('s1', 0), stool('s2', 2000)]);
    expect(treeIssues(before, after)).toContain('2 props are loose at the top level (s1 "Test stool 1", s2 "Test stool 2"); group props in a folder per area or kind ("Island stools", "Pendants")');
    // Default names are numbered: no shared-name issue.
    expect(treeIssues(before, after).some((i) => i.includes('share a name'))).toBe(false);
    // Props aren't counted as loose parts.
    expect(treeIssues(before, after).some((i) => i.includes('parts are loose'))).toBe(false);
  });
});

describe('the prompt', () => {
  it('teaches finishes as looks, with the vocabulary', () => {
    expect(SYSTEM_PROMPT).toContain('# Finishes');
    expect(SYSTEM_PROMPT).toContain('wood:white-oak');
    expect(SYSTEM_PROMPT).toContain('quartz-3cm');
  });
});

describe('carcass pulls for the AI', () => {
  const base = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [384], doors: 2 } } } }]);
  const pulled = ok(base, [{ op: 'update', id: 'a1', patch: { params: { pulls: { style: 'bar' } } } }]);

  it('leaves generated pulls out of the snapshot (the pulls param says it), keeping the folders', () => {
    const snap = modelSnapshot(pulled);
    expect(snap).not.toContain('a1.door-left-pull');
    expect(snap).toContain('"pulls":{"style":"bar"}');
    expect(snap).toContain('a1.door-left-leaf');
  });

  it('words the change as a param change', () => {
    expect(diffDocs(base, pulled).lines).toEqual(['~ Base: pulls null → {style: "bar"}']);
  });

  it('teaches carcass pulls, and pulls on hand-built doors as decor in their folders', () => {
    expect(SYSTEM_PROMPT).toContain('pulls');
    expect(SYSTEM_PROMPT).toMatch(/decor "pull"/);
  });
});
