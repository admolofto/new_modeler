import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import type { RoomParams } from '../plugins/generators/room';
import { modelSnapshot } from './context';
import { diffDocs } from './diff';
import { SYSTEM_PROMPT } from './prompt';
import { aiOpSchema, runTool, TOOL_FIT_ROOM, toolDefs, type ToolState } from './tools';

const I = (n: number) => inches(n);

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const cabinet = (id: string, x: number, params: Record<string, unknown> = {}): Op => ({
  op: 'add',
  entity: { kind: 'assembly', id, name: id, transform: { position: [x, 0, 0] }, generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } },
});
const roomOp = (params: Record<string, unknown>): Op => ({ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params } } });
const params = (d: Doc) => d.assemblies.room!.generator!.params as unknown as RoomParams;
const window = { kind: 'window', wall: 'back', at: I(18), width: I(30), height: I(36), sill: I(40) };

describe('the room for the AI', () => {
  it('has the room generator and fit_room in its tools, but none of the room pieces as decor', () => {
    const schema = aiOpSchema();
    expect(schema.safeParse({ op: 'add', entity: { kind: 'assembly', generator: { type: 'room', params: { left: 0, right: 9216, back: 0, front: 9216 } } } }).success).toBe(true);
    for (const type of ['wall', 'slab', 'trim', 'window', 'doorLeaf']) {
      expect(schema.safeParse({ op: 'add', entity: { kind: 'decor', shape: { type, params: {} } } }).success).toBe(false);
    }
    const fit = toolDefs().find((t) => t.name === TOOL_FIT_ROOM)!;
    expect(JSON.stringify(fit.input_schema)).toContain('margins');
    expect(SYSTEM_PROMPT).toContain('# Presentation: the room');
    expect(SYSTEM_PROMPT).toContain('fit_room');
  });

  it('shows the room as one line with its inside, plus what the user put in it, and the room issues', () => {
    const d = ok(emptyDoc(), [
      cabinet('base', 0),
      roomOp({ left: -I(36), right: I(72), back: 0, front: I(96), openings: [window] }),
      { op: 'add', parent: 'room', entity: { kind: 'block', id: 'plant', name: 'Plant', size: [I(12), I(30), I(12)] } },
    ]);
    const snap = JSON.parse(modelSnapshot(d));
    const room = snap.tree.find((n: { id: string }) => n.id === 'room');
    expect(Object.keys(room)).toEqual(['id', 'name', 'assembly', 'generator', 'world', 'generatedParts', 'interior', 'children']);
    expect(room.generator).toMatchObject({ type: 'room', params: { left: -I(36), openings: [{ id: 'w1' }] } });
    expect(room.generatedParts).toBe(Object.keys(d.parts).filter((id) => id.startsWith('room.')).length);
    expect(room.interior).toEqual([[-I(36), 0, 0], [I(72), I(96), I(96)]]);
    expect(room.children.map((c: { id: string }) => c.id)).toEqual(['plant']);
    expect(JSON.stringify(snap)).not.toContain('room.wall-back');
    expect(snap.roomIssues).toBeUndefined();
    const covered = ok(d, [cabinet('upper', 0, { width: I(30), height: I(30), depth: I(12), toeKick: null }), { op: 'move', id: 'upper', to: [0, I(54), 0] }]);
    expect(JSON.parse(modelSnapshot(covered)).roomIssues).toEqual(['Window w1 (back wall) is covered by “upper”']);
  });

  it('words openings by id in the proposal diff', () => {
    const a = ok(emptyDoc(), [roomOp({ left: 0, right: I(144), back: 0, front: I(120) })]);
    expect(diffDocs(emptyDoc(), a).lines).toEqual(['+ Room (room)']);
    const b = ok(a, [{ op: 'update', id: 'room', patch: { params: { openings: [{ kind: 'window', wall: 'back', at: I(72), width: I(36), height: I(48) }] } } }]);
    expect(diffDocs(a, b).lines).toEqual(['~ Room: + window w1 (back wall, 36" × 48")']);
    const c = ok(b, [{ op: 'update', id: 'room', patch: { params: { openings: [{ ...params(b).openings[0], at: I(80) }, { kind: 'door', wall: 'right', at: I(60), width: I(32), height: I(80), angle: 100 }] } } }]);
    expect(diffDocs(b, c).lines).toEqual(['~ Room: + door d1 (right wall, 32" × 80"); openings[w1].at 72" → 80"']);
    const e = ok(c, [{ op: 'update', id: 'room', patch: { params: { openings: params(c).openings.slice(1) } } }]);
    expect(diffDocs(c, e).lines).toEqual(['~ Room: − window w1 (back wall, 36" × 48")']);
  });

  it('fit_room makes the room around the model, then refits it, into the draft', () => {
    const state: ToolState = { draft: ok(emptyDoc(), [cabinet('a', 0)]), ops: [] };
    const made = runTool(state, TOOL_FIT_ROOM, { margins: { left: '0in', right: '24in' }, height: '108in' });
    expect(made.isError).toBe(false);
    expect(made.content).toContain('Made the room room "Room": inside 60" wide');
    expect(made.content).toContain('108" high');
    expect(params(state.draft)).toMatchObject({ left: 0, right: I(60), back: 0, height: I(108) });
    expect(state.ops).toHaveLength(1);
    // The model grows; the room follows, keeping its openings.
    runTool(state, 'apply_ops', { ops: [cabinet('b', I(36)), { op: 'update', id: 'room', patch: { params: { openings: [window] } } }] });
    const refit = runTool(state, TOOL_FIT_ROOM, { margins: { left: 0, right: '24in' } });
    expect(refit.content).toContain('Refit the room room');
    expect(refit.content).toContain('window w1 (back wall, 30" × 36")');
    expect(params(state.draft)).toMatchObject({ right: I(96), height: I(108), openings: [{ id: 'w1', at: I(18) }] });
    expect(runTool(state, TOOL_FIT_ROOM, { margins: { left: 0, right: '24in' } }).content).toContain('already fits');
    expect(runTool(state, TOOL_FIT_ROOM, { walls: ['up'] }).isError).toBe(true);
  });

  it('lists room checks in apply_ops results', () => {
    const state: ToolState = { draft: ok(emptyDoc(), [cabinet('base', 0), roomOp({ left: -I(36), right: I(72), back: 0, front: I(96), openings: [window] })]), ops: [] };
    const upper = { kind: 'assembly', id: 'upper', name: 'upper', transform: { position: [0, I(54), 0] }, generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, width: I(30), height: I(30), depth: I(12), toeKick: null } } };
    const out = runTool(state, 'apply_ops', { ops: [{ op: 'add', entity: upper }] });
    expect(out.content).toContain('Room check — fix these unless intended:');
    expect(out.content).toContain('Window w1 (back wall) is covered by “upper”');
    expect(out.summary).toContain('1 room warning');
  });
});
