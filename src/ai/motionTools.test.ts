import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, demoDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { modelSnapshot } from './context';
import { diffDocs } from './diff';
import { SYSTEM_PROMPT } from './prompt';
import { runTool, toolDefs, type ToolState } from './tools';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const apply = (state: ToolState, ops: Op[]) => runTool(state, 'apply_ops', { ops });

describe('animations for the AI', () => {
  it('teaches the motion types in the apply_ops schema and the prompt', () => {
    const text = JSON.stringify(toolDefs()[0]!.input_schema);
    for (const needle of ['"motion"', '"hinge"', '"slide"', 'Swings about one edge', 'Slides straight', '"doors"', '"doorHinge"']) expect(text).toContain(needle);
    expect(text.length).toBeLessThan(40_000);
    expect(SYSTEM_PROMPT).toContain('# Animation (how things open)');
  });

  it('reports the hinge line it worked out, and what a door hits as it opens', () => {
    const state: ToolState = { draft: demoDoc(), ops: [] };
    // The demo door stands 6" right of the cabinet; a wall block flush on its left is in the way past 90°.
    const out = apply(state, [
      { op: 'add', entity: { kind: 'block', id: 'wall', name: 'Wall', size: [inches(4), inches(40), inches(60)], transform: { position: [inches(36 + 6 - 4), 0, inches(-20)] } } },
      { op: 'add', entity: { kind: 'motion', id: 'swing', nodes: ['door'], type: 'hinge', params: { side: 'left' } } },
    ]);
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/Animations:\n {2}swing "Door": hinges left, opens 105° — hinge line along [+-]y through world \[2688, 256, 430\]/);
    expect(out.content).toMatch(/Opening check — fix these unless intended:\n {2}Door hits “Wall” at 9\d°/);
    expect(out.summary).toMatch(/1 opening warning/);
    // Hinged on the other side, it clears.
    const fixed = apply(state, [{ op: 'update', id: 'swing', patch: { params: { side: 'right' } } }]);
    expect(fixed.content).not.toMatch(/Opening check/);
  });

  it('describes a cabinet’s generated animations without listing them as created', () => {
    const state: ToolState = { draft: demoDoc(), ops: [] };
    const out = apply(state, [{ op: 'update', id: 'a1', patch: { params: { drawers: [inches(6)], doors: 2 } } }]);
    expect(out.content).not.toMatch(/Created:.*motion/);
    expect(out.content).toMatch(/a1\.motion\.drawer-1 "Drawer 1": slides out \d+ ?[\d/]*" — travels .* toward world \+z/);
    expect(out.content).toMatch(/a1\.motion\.door-left "Left door": hinges left, opens 105°/);
  });

  it('puts the user’s animations and what hits something in the snapshot, not the generated ones', () => {
    const d = ok(demoDoc(), [
      { op: 'update', id: 'a1', patch: { params: { drawers: [0, 0], shelves: 0 } } },
      { op: 'add', entity: { kind: 'block', id: 'wall', name: 'Wall', size: [inches(4), inches(40), inches(60)], transform: { position: [inches(36 + 6 - 4), 0, inches(-20)] } } },
      { op: 'add', entity: { kind: 'motion', id: 'swing', nodes: ['door'], type: 'hinge', params: { side: 'left' } } },
    ]);
    const snap = JSON.parse(modelSnapshot(d));
    expect(snap.motions).toEqual([{ id: 'swing', type: 'hinge', nodes: ['door'], params: { side: 'left', angle: 105, seconds: 0.8 } }]);
    expect(snap.clashes).toEqual([expect.stringMatching(/^Door hits “Wall” at 9\d°$/)]);
  });

  it('shows animation changes in the proposal and tints what moves', () => {
    const a = ok(demoDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a2', name: 'Drawers', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [0, 0], shelves: 0 } } } }]);
    const b = ok(a, [{ op: 'add', entity: { kind: 'motion', id: 'swing', name: 'Pantry door', nodes: ['door'], type: 'hinge', params: { side: 'right' } } }]);
    const added = diffDocs(a, b);
    expect(added.lines).toEqual(['+ Pantry door animation: hinges right, opens 105°']);
    expect([...added.touched]).toEqual(['door']);
    const c = ok(b, [{ op: 'update', id: 'swing', patch: { params: { angle: 90 } } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ Pantry door animation: hinges right, opens 90°']);
    expect(diffDocs(c, ok(c, [{ op: 'delete', id: 'swing' }])).lines).toEqual(['− Pantry door animation: hinges right, opens 90°']);
    // A cabinet param change reports the param, not each generated animation.
    expect(diffDocs(a, ok(a, [{ op: 'update', id: 'a2', patch: { params: { doors: 2, drawers: [inches(6)], shelves: 1 } } }])).lines[0]).toMatch(/^~ Drawers: .*doors 0 → 2/);
  });
});
