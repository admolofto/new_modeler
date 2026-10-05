import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import { captureRecipe, type Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import { newChat, runTurn, userTurnText, type Message, type Send } from './agent';
import { modelSnapshot } from './context';
import { MCP_INSTRUCTIONS, SYSTEM_PROMPT } from './prompt';
import { mcpToolDefs, runTool, toolDefs, type ToolState } from './tools';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** A saved base cabinet with a door folder and a width variable, like a user's recipe library entry. */
function shakerBase(): Recipe {
  const source = ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'variable', id: 'doorGap', name: 'Door gap', group: 'Doors', value: 8 } },
    { op: 'add', entity: { kind: 'assembly', id: 'base', name: 'Shaker base', transform: { position: [inches(50), 0, 0] }, generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [], shelves: 1 } } } },
    { op: 'add', parent: 'base', entity: { kind: 'assembly', id: 'door', name: 'Door', transform: { position: [0, inches(4), inches(24)] } } },
    { op: 'add', parent: 'door', entity: { kind: 'part', id: 'slab', name: 'Panel', material: 'ply-3-4', shape: { type: 'box', params: { x: inches(23), y: inches(30), z: 46 } } } },
    { op: 'bind', node: 'slab', path: 'position.x', expr: 'doorGap' },
  ]);
  return captureRecipe(source, { name: 'Shaker base', description: 'Frameless box, 3/4 ply, slab door inset by the door gap.', id: 'recipe-shaker', now: '2026-10-01T00:00:00.000Z' });
}

const existing = () => ok(emptyDoc(), [
  { op: 'add', entity: { kind: 'part', id: 'bench', name: 'Bench', material: 'ply-3-4', shape: { type: 'box', params: { x: inches(48), y: inches(18), z: inches(16) } } } },
]);

describe('recipe tools', () => {
  it('catalogs saved recipes in the snapshot, briefly', () => {
    const recipe = { ...shakerBase(), description: `${'x'.repeat(300)}` };
    const snap = JSON.parse(modelSnapshot(emptyDoc(), [recipe]));
    expect(snap.recipes).toEqual([{ id: 'recipe-shaker', name: 'Shaker base', scope: 'whole model', parts: Object.keys(recipe.doc.parts).length, about: `${'x'.repeat(199)}…` }]);
    expect(JSON.parse(modelSnapshot(emptyDoc())).recipes).toBeUndefined();
    // A library that can't be read leaves the catalog out instead of failing the turn.
    expect(userTurnText(emptyDoc(), undefined, 'hi', () => { throw new Error('blocked'); })).not.toContain('"recipes"');
  });

  it('get_recipe describes construction, inputs and tree', () => {
    const state: ToolState = { draft: emptyDoc(), ops: [], recipes: () => [shakerBase()] };
    const r = runTool(state, 'get_recipe', { id: 'Shaker base' }); // exact names work too
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain('slab door inset by the door gap');
    expect(r.content).toContain('variable:doorGap: Doors › Door gap = 1/8"');
    expect(r.content).toContain('generator:base:width: Shaker base › width = 36"');
    expect(r.content).toMatch(/Shaker base \[base\] \(carcass generator: .*Left side/);
    expect(r.content).toContain('      Panel [slab]');
    expect(state.ops).toEqual([]);
  });

  it('insert_recipe adds a sized copy beside the model to the proposal', () => {
    const state: ToolState = { draft: existing(), ops: [], recipes: () => [shakerBase()] };
    const r = runTool(state, 'insert_recipe', { id: 'recipe-shaker', inputs: { 'generator:base:width': '30in', 'variable:doorGap': '1/4in' } });
    expect(r.isError, r.content).toBe(false);
    const d = state.draft;
    expect(d.roots).toEqual(['bench', 'recipe1']);
    expect(d.assemblies.recipe1!.name).toBe('Shaker base');
    expect(d.assemblies.recipe1_a1!.generator!.params.width).toBe(inches(30));
    expect(d.variables.recipe1_v1!.value).toBe(16);
    expect(Object.keys(d.materials)).toEqual(Object.keys(existing().materials)); // same stock, reused
    const boxes = worldBoxes(d);
    expect(boxes.get('recipe1')!.min[0]).toBe(boxes.get('bench')!.max[0] + inches(12));
    expect(state.ops.length).toBeGreaterThan(3);
    expect(r.content).toContain('Inputs applied: Door gap = 1/4", width = 30"');
    expect(r.content).toContain('base → recipe1_a1 "Shaker base"');
    expect(r.content).toContain('slab → recipe1_p1 "Panel"');
    expect(r.content).not.toContain('ply-3-4 →');
    expect(r.content).toContain("don't insert this recipe again");
    // An explicit place wins.
    const placed: ToolState = { draft: existing(), ops: [], recipes: () => [shakerBase()] };
    runTool(placed, 'insert_recipe', { id: 'recipe-shaker', position: ['100in', 0, 0] });
    expect(placed.draft.assemblies.recipe1!.transform.position).toEqual([inches(100), 0, 0]);
    // A second copy of the same recipe needs its own name.
    expect(r.content).not.toContain('Tree check');
    expect(runTool(state, 'insert_recipe', { id: 'recipe-shaker' }).content).toContain('Tree check: recipe1 "Shaker base" and recipe2 "Shaker base" share a name');
  });

  it('explains what went wrong', () => {
    const none: ToolState = { draft: emptyDoc(), ops: [] };
    expect(runTool(none, 'insert_recipe', { id: 'x' }).content).toMatch(/No recipe library/);
    const broken: ToolState = { draft: emptyDoc(), ops: [], recipes: () => { throw new Error('Recipes could not be loaded: corrupt.'); } };
    expect(runTool(broken, 'get_recipe', { id: 'x' }).content).toMatch(/could not be loaded/);
    const state: ToolState = { draft: emptyDoc(), ops: [], recipes: () => [shakerBase()] };
    const missing = runTool(state, 'insert_recipe', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('Saved recipes: recipe-shaker "Shaker base"');
    const badInput = runTool(state, 'insert_recipe', { id: 'recipe-shaker', inputs: { 'variable:nope': 4 } });
    expect(badInput.content).toMatch(/nothing was inserted.*unknown recipe input/);
    expect(state.ops).toEqual([]);
  });

  it('runs inside a chat turn: insert, then adapt, as one proposal', async () => {
    const calls: Message['content'] = [
      { type: 'tool_use', id: 't1', name: 'insert_recipe', input: { id: 'recipe-shaker' } },
    ] as unknown as Message['content'];
    const adapt = [{ type: 'tool_use', id: 't2', name: 'apply_ops', input: { ops: [{ op: 'update', id: 'recipe1', patch: { name: 'Sink base 24"' } }] } }] as unknown as Message['content'];
    const responses = [calls, adapt, [{ type: 'text', text: 'Added your Shaker base.', citations: null }] as unknown as Message['content']];
    const requests: Parameters<Send>[0][] = [];
    const send: Send = async (req) => {
      requests.push(structuredClone(req));
      const content = responses.shift()!;
      return { id: 'm', type: 'message', role: 'assistant', model: 'test', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as Message;
    };
    const r = await runTurn({ send, chat: newChat(), doc: existing(), text: 'add my shaker base', recipes: () => [shakerBase()] });
    expect(r.draft.assemblies.recipe1!.name).toBe('Sink base 24"');
    expect(r.ops.at(-1)).toEqual({ op: 'update', id: 'recipe1', patch: { name: 'Sink base 24"' } });
    expect(JSON.stringify(requests[0]!.messages[0])).toContain('recipe-shaker');
  });
});

describe('prompt', () => {
  it('names every tool, and teaches recipes and tree organization', () => {
    for (const tool of mcpToolDefs()) expect(MCP_INSTRUCTIONS, tool.name).toContain(tool.name);
    for (const tool of toolDefs()) expect(SYSTEM_PROMPT, tool.name).toContain(tool.name);
    for (const text of ['# Recipes', '# Object tree organization', 'keepWorld', 'Tree check', 'Recipe adaptation:']) expect(SYSTEM_PROMPT).toContain(text);
    expect(toolDefs().slice(0, 3).map((t) => t.name)).toEqual(['apply_ops', 'inspect_part', 'cut_list']);
  });
});
