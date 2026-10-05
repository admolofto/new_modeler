import { describe, expect, it } from 'vitest';
import '../plugins';
import { newChat, runTurn, type Message, type Send } from '../ai/agent';
import { emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import { captureRecipe, serializeRecipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import { createStore } from '../model/store';
import { createProposals } from './proposals';
import { createRecipeAdaptation } from './recipeAdaptation';

const part = (id: string): Op => ({ op: 'add', entity: { kind: 'part', id, name: id, material: 'ply-3-4', shape: { type: 'box', params: { x: 2000, y: 256, z: 48 } } } });
function apply(doc: Doc, ops: Op[]): Doc {
  const result = applyOps(doc, ops);
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}
function setup() {
  const source = apply(emptyDoc(), [part('rail'), { op: 'add', entity: { kind: 'variable', id: 'span', name: 'Span', group: 'Construction', value: 2000 } }, { op: 'bind', node: 'rail', path: 'shape.x', expr: 'span' }]);
  const recipe = captureRecipe(source, { name: 'Riser', description: 'Plywood rails with butt joints; retain board thickness.' });
  const store = createStore(apply(emptyDoc(), [part('target')]));
  const proposals = createProposals(store);
  let busy = false;
  const queue = createRecipeAdaptation(proposals, () => busy);
  return { source, recipe, store, proposals, queue, setBusy: (value: boolean) => { busy = value; } };
}
function reply(content: Message['content'], stop: Message['stop_reason'] = 'end_turn'): Message {
  return { id: 'fake', type: 'message', role: 'assistant', model: 'test', content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as Message;
}

describe('recipe adaptation', () => {
  it('queues an isolated attachment and removes it without changing the document or proposal', () => {
    const { recipe, store, proposals, queue } = setup();
    const before = structuredClone(store.doc);
    const targets = [{ node: 'target' }];
    const inputs = { 'variable:span': 2500 };
    queue.attach(recipe, inputs, targets);
    targets[0]!.node = 'gone'; inputs['variable:span'] = 3000; recipe.description = 'changed';
    expect(queue.attachment!.targets).toEqual([{ node: 'target' }]);
    expect(queue.attachment!.inputs['variable:span']).toBe(2500);
    expect(queue.attachment!.recipe.description).toContain('Plywood');
    expect(store.doc).toEqual(before); expect(proposals.pending).toBeNull();
    queue.clear();
    expect(queue.prepare()).toBeNull(); expect(store.doc).toEqual(before);
  });

  it('guards busy AI, existing proposals and duplicate attachments', () => {
    const { recipe, queue, proposals, setBusy } = setup();
    setBusy(true);
    expect(() => queue.attach(recipe, {}, [])).toThrow(/Wait/);
    setBusy(false); queue.attach(recipe, {}, []);
    expect(() => queue.attach(recipe, {}, [])).toThrow(/Remove/);
    setBusy(true); expect(() => queue.prepare()).toThrow(/Wait/);
    setBusy(false); proposals.runTool('apply_ops', { ops: [part('other')] });
    expect(() => queue.prepare()).toThrow(/Accept or reject/);
    expect(queue.attachment).not.toBeNull();
  });

  it('validates targets and inputs at Send, keeping the attachment on failure', () => {
    const { recipe, store, proposals, queue } = setup();
    queue.attach(recipe, {}, [{ node: 'target' }]);
    expect(store.dispatch([{ op: 'delete', id: 'target' }]).ok).toBe(true);
    expect(() => queue.prepare()).toThrow(/selection changed or was removed/);
    expect(queue.attachment).not.toBeNull(); expect(proposals.pending).toBeNull();
    queue.clear(); queue.attach(recipe, { 'variable:span': -100 }, []);
    expect(() => queue.prepare()).toThrow();
    expect(queue.attachment).not.toBeNull(); expect(proposals.pending).toBeNull();
    queue.clear();
    expect(() => queue.attach(recipe, {}, [{ node: 'rail', handle: 'face:missing' }])).toThrow();
  });

  it('uses fresh model and target names after queueing and supplies construction context', () => {
    const { recipe, store, queue } = setup();
    queue.attach(recipe, { 'variable:span': 2500 }, [{ node: 'target' }]);
    store.dispatch([{ op: 'update', id: 'target', patch: { name: 'Straight cabinet' } }, part('added-later')]);
    const prepared = queue.prepare()!;
    expect(prepared.doc.parts['added-later']).toBeDefined();
    expect(prepared.doc.parts[prepared.idMap.rail!]!.shape.params.x).toBe(2500);
    expect(prepared.context).toContain(recipe.description);
    expect(prepared.context).toContain('Straight cabinet');
    expect(prepared.context).toContain(prepared.wrapperId);
    expect(prepared.context).toContain('L-shaped riser to a straight cabinet');
    expect(prepared.context).toContain('engineering guarantees');
  });

  it('simulates AI changes to the inserted copy, accepts once, and undoes insertion plus adaptation', async () => {
    const { recipe, store, proposals, queue } = setup();
    const before = structuredClone(store.doc), saved = serializeRecipe(recipe);
    queue.attach(recipe, {}, [{ node: 'target' }]);
    const prepared = queue.prepare()!;
    const responses = [reply([{ type: 'tool_use', id: 'tool1', name: 'apply_ops', input: { ops: [{ op: 'update', id: prepared.idMap.span!, patch: { value: 3000 } }] } } as Message['content'][number]], 'tool_use'), reply([{ type: 'text', text: 'Adapted.', citations: null } as Message['content'][number]])];
    const requests: Parameters<Send>[0][] = [];
    const send: Send = async (request) => { requests.push(structuredClone(request)); return responses.shift()!; };
    const result = await runTurn({ send, chat: newChat(), doc: proposals.working(), text: `${queue.context}\nMake it straight.` });
    proposals.add(result.ops, result.draft);
    expect(JSON.stringify(requests[0])).toContain(recipe.description);
    expect(store.doc).toEqual(before);
    expect(proposals.pending!.draft.parts[prepared.idMap.rail!]!.shape.params.x).toBe(3000);
    expect(proposals.pending!.draft.parts.target).toEqual(before.parts.target);
    expect(proposals.accept()).toBe(true); expect(queue.context).toBeUndefined();
    expect(store.doc.parts[prepared.idMap.rail!]!.shape.params.x).toBe(3000);
    expect(serializeRecipe(recipe)).toBe(saved);
    store.undo(); expect(store.doc).toEqual(before);
  });

  it('retains prepared context on a failed send so retry cannot silently insert a second copy', async () => {
    const { recipe, store, proposals, queue } = setup();
    queue.attach(recipe, {}, [{ node: 'target' }]);
    const prepared = queue.prepare()!, count = proposals.pending!.ops.length;
    const chat = newChat();
    await expect(runTurn({ send: async () => { throw new Error('offline'); }, chat, doc: proposals.working(), text: `${queue.context}\nFit this cabinet.` })).rejects.toThrow('offline');
    expect(queue.attachment).toBeNull(); expect(queue.prepare()).toBeNull();
    expect(proposals.pending!.ops).toHaveLength(count);
    expect(queue.context).toBe(prepared.context);
    let sent = '';
    const send: Send = async (req) => { sent = JSON.stringify(req); return reply([]); };
    await runTurn({ send, chat, doc: proposals.working(), text: `${queue.context}\nFit this cabinet.` });
    expect(sent).toContain(recipe.description); expect(sent).toContain(prepared.wrapperId);
    expect(Object.keys(store.doc.parts)).toEqual(['target']);
    proposals.reject(); expect(queue.context).toBeUndefined(); expect(queue.attachment).toBeNull();
    expect(proposals.pending).toBeNull(); expect(Object.keys(store.doc.parts)).toEqual(['target']);
  });

  it('adapts independent copies without changing the first instance or saved source', () => {
    const { recipe, store, proposals, queue } = setup();
    const saved = serializeRecipe(recipe);
    queue.attach(recipe, {}, []); const first = queue.prepare()!; proposals.accept();
    queue.attach(recipe, {}, []); const second = queue.prepare()!;
    proposals.runTool('apply_ops', { ops: [{ op: 'update', id: second.idMap.span!, patch: { value: 4000 } }] });
    proposals.accept();
    expect(first.wrapperId).not.toBe(second.wrapperId);
    expect(store.doc.parts[first.idMap.rail!]!.shape.params.x).toBe(2000);
    expect(store.doc.parts[second.idMap.rail!]!.shape.params.x).toBe(4000);
    expect(serializeRecipe(recipe)).toBe(saved);
  });
});
