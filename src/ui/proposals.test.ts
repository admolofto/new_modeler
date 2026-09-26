import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import type { Op } from '../model/ops';
import { createStore } from '../model/store';
import { inches } from '../model/units';
import { createProposals } from './proposals';

const panel = (id: string, x: number): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position: [x, 0, 0] }, shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } } },
});

describe('proposals', () => {
  it('accumulates tool calls into one proposal and accepts it as one undo step', () => {
    const store = createStore(emptyDoc());
    const p = createProposals(store);
    expect(p.runTool('apply_ops', { ops: [panel('a', 0)] }).isError).toBe(false);
    expect(p.runTool('apply_ops', { ops: [panel('b', inches(20))] }).isError).toBe(false);
    expect(p.pending!.ops).toHaveLength(2);
    expect(p.pending!.diff.lines).toEqual(['+ a', '+ b']);
    expect(store.doc.parts).toEqual({}); // nothing lands until accepted

    const model = p.runTool('get_model', {}).content;
    expect(model).toMatch(/proposal of 2 ops is pending/);
    expect(model).toContain('"id":"b"');

    expect(p.accept()).toBe(true);
    expect(Object.keys(store.doc.parts)).toEqual(['a', 'b']);
    expect(p.takeNote()).toMatch(/accepted/);
    store.undo();
    expect(store.doc.parts).toEqual({});
  });

  it('rejects, and says so next turn', () => {
    const store = createStore(emptyDoc());
    const p = createProposals(store);
    p.runTool('apply_ops', { ops: [panel('a', 0)] });
    expect(p.takeNote()).toMatch(/not been accepted yet/);
    p.reject();
    expect(p.pending).toBeNull();
    expect(p.takeNote()).toMatch(/rejected/);
    expect(p.takeNote()).toBeUndefined();
  });

  it('re-applies on store changes and marks the proposal stale when it no longer fits', () => {
    const store = createStore(emptyDoc());
    const p = createProposals(store);
    p.runTool('apply_ops', { ops: [{ op: 'update', id: 'ply-3-4', patch: { name: 'Birch ply' } }] });
    store.dispatch([panel('side', 0)]);
    expect(p.pending!.draft.parts.side).toBeDefined();
    expect(p.pending!.stale).toBeUndefined();

    p.runTool('apply_ops', { ops: [{ op: 'update', id: 'side', patch: { name: 'Left side' } }] });
    store.undo(); // removes "side": the proposal's update no longer applies
    expect(p.pending!.stale).toMatch(/nothing with id "side"/);
    expect(p.accept()).toBe(false);
  });
});
