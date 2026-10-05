import { describe, expect, it } from 'vitest';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { captureRecipe, insertRecipe, parseRecipe, recipeInputs, serializeRecipe } from './recipes';
import { SCHEMA_VERSION, type Doc } from './schema';
import { createStore } from './store';
import { docErrors } from './validate';
import { nodeAffine } from './world';

function ok(doc: Doc, ops: readonly Op[]): Doc {
  const result = applyOps(doc, ops);
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

const panel = (id: string, parent?: string): Op => ({
  op: 'add', parent, entity: { kind: 'part', id, name: id, material: 'ply-3-4',
    shape: { type: 'box', params: { x: 1000, y: 256, z: 46 } } },
});
const variable = (id: string, value: number): Op => ({ op: 'add', entity: { kind: 'variable', id, name: id, group: 'Construction', value } });

/** The two-rail construction and dependencies of the user's corner-closet riser. */
function closet(): Doc {
  return ok(emptyDoc(), [
    variable('closetSpan', 3072), variable('closetDepth', 1536), variable('closetBase', 256),
    variable('closetGap', 8), variable('riserSetback', 192), variable('closetHeight', 5376),
    { op: 'add', entity: { kind: 'assembly', id: 'closet', name: 'Corner closet', transform: { position: [8000, 1200, 3000], rotation: [0, 90, 0] } } },
    { op: 'add', entity: { kind: 'assembly', id: 'riser', name: 'L-shaped base riser' }, parent: 'closet' },
    panel('riserBack', 'riser'), panel('riserFront', 'riser'), panel('outside', 'closet'),
    { op: 'update', id: 'riserFront', patch: { shape: { params: { x: 46, z: 1000 } } } },
    { op: 'move', id: 'riserBack', to: [46, 0, 0] },
    { op: 'bind', node: 'riserBack', path: 'shape.x', expr: 'closetSpan-92' },
    { op: 'bind', node: 'riserBack', path: 'shape.y', expr: 'closetBase' },
    { op: 'bind', node: 'riserBack', path: 'position.z', expr: 'closetDepth-92-closetGap-riserSetback' },
    { op: 'bind', node: 'riserFront', path: 'position.x', expr: 'closetDepth-92-closetGap-riserSetback' },
    { op: 'bind', node: 'riserFront', path: 'position.z', expr: 'closetDepth-46-closetGap-riserSetback' },
    { op: 'bind', node: 'riserFront', path: 'shape.y', expr: 'closetBase' },
    { op: 'bind', node: 'riserFront', path: 'shape.z', expr: 'closetSpan-closetDepth+closetGap+riserSetback' },
    { op: 'bind', node: 'outside', path: 'shape.x', expr: 'closetSpan' },
    { op: 'bind', node: 'outside', path: 'shape.y', expr: 'closetHeight' },
    { op: 'add', entity: { kind: 'joint', id: 'internal', type: 'butt', parts: ['riserBack', 'riserFront'] } },
    { op: 'add', entity: { kind: 'joint', id: 'external', type: 'butt', parts: ['riserBack', 'outside'] } },
    { op: 'add', entity: { kind: 'annotation', id: 'note', note: 'Project-specific note', targets: [{ node: 'riser' }] } },
  ]);
}

describe('recipes', () => {
  it('round trips an entire editable model with generated construction, features and joints', () => {
    const source = demoDoc();
    const before = structuredClone(source);
    const recipe = captureRecipe(source, { name: 'Workshop cabinet', description: 'Frameless construction' });
    const saved = parseRecipe(serializeRecipe(recipe));
    expect(saved).toEqual(recipe);
    const inserted = insertRecipe(emptyDoc(), saved);
    expect(Object.values(inserted.doc.parts)).toHaveLength(Object.keys(source.parts).length);
    expect(Object.values(inserted.doc.joints)).toHaveLength(Object.keys(source.joints).length);
    expect(inserted.doc.parts[inserted.idMap['a1.side-right']!]!.features).toHaveLength(27);
    expect(docErrors(inserted.doc)).toEqual([]);
    expect(source).toEqual(before);
  });

  it('captures only a component and its dependency closure, reporting excluded joints and shared variables', () => {
    const recipe = captureRecipe(closet(), { name: 'L riser', nodeIds: ['riser', 'riserBack'] });
    expect(recipe.doc.roots).toEqual(['riser']);
    expect(Object.keys(recipe.doc.parts)).toEqual(['riserBack', 'riserFront']);
    expect(Object.keys(recipe.doc.variables)).toEqual(['closetSpan', 'closetDepth', 'closetBase', 'closetGap', 'riserSetback']);
    expect(Object.keys(recipe.doc.materials)).toEqual(['ply-3-4']);
    expect(Object.keys(recipe.doc.joints)).toEqual(['internal']);
    expect(recipe.doc.annotations).toEqual({});
    expect(recipe.warnings.join('\n')).toMatch(/external.*omitted/);
    expect(recipe.warnings.join('\n')).toMatch(/closetSpan.*independent/);
    expect(parseRecipe(serializeRecipe(recipe))).toEqual(recipe);
  });

  it('inserts independent copies despite variable collisions, sharing identical stock, and preserves rail thickness when resized', () => {
    const original = closet();
    const recipe = captureRecipe(original, { name: 'L riser', nodeIds: ['riser'] });
    const saved = serializeRecipe(recipe);
    const first = insertRecipe(original, recipe, { position: [10000, 0, 0] });
    const second = insertRecipe(first.doc, recipe, { inputs: { 'variable:closetSpan': 4000 } });
    expect(second.wrapperId).not.toBe(first.wrapperId);
    const changed = ok(second.doc, [{ op: 'update', id: first.idMap.closetSpan!, patch: { value: 3500 } }]);
    expect(changed.parts[first.idMap.riserBack!]!.shape.params.x).toBe(3500 - 92);
    expect(changed.parts[second.idMap.riserBack!]!.shape.params.x).toBe(4000 - 92);
    expect(changed.parts.riserBack!.shape.params.x).toBe(3072 - 92);
    expect(changed.parts[second.idMap.riserFront!]!.shape.params.x).toBe(46);
    // Same stock is one material: one cut-list group, one price.
    expect([first.idMap['ply-3-4'], second.idMap['ply-3-4']]).toEqual(['ply-3-4', 'ply-3-4']);
    expect(Object.keys(changed.materials)).toEqual(Object.keys(original.materials));
    expect(serializeRecipe(recipe)).toBe(saved);
  });

  it('matches stock by name, thickness and kind, copying only the needed materials the target lacks', () => {
    const source = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'material', id: 'birch', name: 'Birch ply', thickness: 46, color: '#e0c89a', stock: 'sheet', price: 90 } },
      { op: 'add', entity: { kind: 'material', id: 'walnut', name: 'Walnut', thickness: 48, color: '#5a3b27', stock: 'solid' } },
      { op: 'add', entity: { kind: 'material', id: 'unused', name: 'Cherry', thickness: 48, color: '#9a4a2a', stock: 'solid' } },
      panel('side'), panel('top'),
      { op: 'update', id: 'side', patch: { material: 'birch' } },
      { op: 'update', id: 'top', patch: { material: 'walnut' } },
    ]);
    const recipe = captureRecipe(source, { name: 'Box' });
    // The target has its own birch ply (different color and price: still the same stock) and a thicker walnut.
    const target = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'material', id: 'ply-birch', name: ' birch PLY', thickness: 46, color: '#ffffff', stock: 'sheet', price: 75 } },
      { op: 'add', entity: { kind: 'material', id: 'walnut', name: 'Walnut', thickness: 64, color: '#5a3b27', stock: 'solid' } },
    ]);
    const inserted = insertRecipe(target, recipe);
    expect(inserted.idMap.birch).toBe('ply-birch');
    expect(inserted.idMap.walnut).toBe('recipe1_m1');
    expect(inserted.idMap.unused).toBeUndefined();
    expect(inserted.idMap['ply-3-4']).toBeUndefined();
    expect(Object.keys(inserted.doc.materials)).toEqual([...Object.keys(target.materials), 'recipe1_m1']);
    expect(inserted.doc.materials.recipe1_m1).toMatchObject({ name: 'Walnut', thickness: 48 });
    expect(inserted.doc.parts[inserted.idMap.side!]!.material).toBe('ply-birch');
    expect(inserted.doc.parts[inserted.idMap.top!]!.material).toBe('recipe1_m1');
  });

  it('removes transformed ancestor placement while retaining root and internal position formulas', () => {
    const source = ok(closet(), [
      { op: 'bind', node: 'riser', path: 'position.x', expr: 'closetSpan / 2' },
      { op: 'bind', node: 'riser', path: 'position.y', expr: 'closetBase' },
    ]);
    const recipe = captureRecipe(source, { name: 'Riser', nodeIds: ['riser'] });
    expect(recipe.doc.assemblies.riser!.transform.position).toEqual([0, 0, 0]);
    expect(recipe.doc.assemblies.riser!.bind).toEqual({ 'position.x': '(closetSpan / 2) - (1536)', 'position.y': '(closetBase) - (256)' });
    const inserted = insertRecipe(emptyDoc(), recipe, { position: [100, 200, 300] });
    expect(nodeAffine(inserted.doc, inserted.idMap.riserBack!).t).toEqual([146, 200, 1544]);
    const wider = ok(inserted.doc, [{ op: 'update', id: inserted.idMap.closetSpan!, patch: { value: 3200 } }]);
    expect(wider.assemblies[inserted.idMap.riser!]!.transform.position[0]).toBe(64);
    expect(wider.parts[inserted.idMap.riserBack!]!.shape.params.x).toBe(3108);
    expect(wider.parts[inserted.idMap.riserFront!]!.shape.params.z).toBe(1864);
  });

  it('preserves sibling arrangement and bindings after shifting the capture origin', () => {
    const source = closet();
    const recipe = captureRecipe(source, { name: 'Rails', nodeIds: ['riserBack', 'riserFront'] });
    expect(recipe.doc.parts.riserBack!.transform.position).toEqual([0, 0, 0]);
    expect(recipe.doc.parts.riserFront!.transform.position).toEqual([1198, 0, 46]);
    const inserted = insertRecipe(emptyDoc(), recipe, { inputs: { 'variable:riserSetback': 256 } });
    expect(inserted.doc.parts[inserted.idMap.riserBack!]!.transform.position[2]).toBe(-64);
    expect(inserted.doc.parts[inserted.idMap.riserFront!]!.transform.position[2]).toBe(-18);
  });

  it('restores active and dormant generator overrides and remaps their materials before regeneration', () => {
    let source = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'cab', name: 'Cabinet', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, joinery: 'butt', shelves: 2 } } } },
      { op: 'update', id: 'cab.side-left', patch: { hidden: true, name: 'Left edited', shape: { params: { y: 2400 } } } },
      { op: 'move', id: 'cab.side-left', to: [0, 100, 0] },
      { op: 'addFeature', part: 'cab.side-left', feature: { id: 'boring', type: 'hole', params: { face: 'face:left', at: [200, 300], d: 32 } } },
      { op: 'update', id: 'cab.shelf-2', patch: { material: 'maple-4-4', hidden: true, shape: { params: { x: 2000 } } } },
      { op: 'delete', id: 'cab.shelf-1' },
      { op: 'update', id: 'cab', patch: { params: { shelves: 0 } } },
      variable('width', DEFAULT_CARCASS.width),
      { op: 'bind', node: 'cab', path: 'params.width', expr: 'width' },
    ]);
    const recipe = captureRecipe(source, { name: 'Cabinet', nodeIds: ['cab'] });
    expect(recipe.doc.materials['maple-4-4']).toBeDefined();
    const inserted = insertRecipe(emptyDoc(), recipe);
    const id = inserted.idMap.cab!;
    source = ok(inserted.doc, [
      { op: 'update', id, patch: { params: { shelves: 2 } } },
      { op: 'update', id: inserted.idMap.width!, patch: { value: 2500 } },
    ]);
    expect(source.parts[`${id}.shelf-1`]).toBeUndefined();
    expect(source.parts[`${id}.shelf-2`]).toMatchObject({ hidden: true, material: inserted.idMap['maple-4-4'], shape: { params: { x: 2000 } } });
    expect(source.parts[`${id}.side-left`]).toMatchObject({ hidden: true, name: 'Left edited', transform: { position: [0, 100, 0] }, shape: { params: { y: 2400 } } });
    expect(source.parts[`${id}.side-left`]!.features[0]!.id).toBe('boring');
    expect(source.parts[`${id}.side-right`]!.transform.position[0]).toBe(2500 - 46);
    expect(docErrors(source)).toEqual([]);
  });

  it('keeps generator material options for currently unused drawer roles without rewriting enum values', () => {
    const source = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'material', id: 'none', name: 'Special wood', thickness: 32, color: '#abcdef' } },
      { op: 'add', entity: { kind: 'assembly', id: 'cab', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, back: 'none', drawerMaterial: 'none' } } } },
    ]);
    const recipe = captureRecipe(source, { name: 'Cabinet', nodeIds: ['cab'] });
    const inserted = insertRecipe(emptyDoc(), recipe);
    expect(inserted.doc.assemblies[inserted.idMap.cab!]!.generator!.params).toMatchObject({ back: 'none', drawerMaterial: inserted.idMap.none });
  });

  it('accepts generated parts toggled back to visible and preserves user-child order', () => {
    const source = ok(demoDoc(), [
      { op: 'update', id: 'a1.side-left', patch: { hidden: true } },
      { op: 'update', id: 'a1.side-left', patch: { hidden: false } },
      panel('extra', 'a1'),
      { op: 'move', id: 'extra', parent: 'a1', index: 0 },
    ]);
    const inserted = insertRecipe(emptyDoc(), captureRecipe(source, { name: 'Visible cabinet' }));
    expect(inserted.doc.parts[inserted.idMap['a1.side-left']!]!.hidden).not.toBe(true);
    expect(inserted.doc.assemblies[inserted.idMap.a1!]!.children[0]).toBe(inserted.idMap.extra);
  });

  it('preserves feature parameter bindings without changing function names or inch literals', () => {
    const source = ok(emptyDoc(), [
      variable('width', 1000), panel('rail'),
      { op: 'addFeature', part: 'rail', feature: { id: 'hole', type: 'hole', params: { face: 'face:front', at: [500, 128], d: 32 } } },
      { op: 'bind', node: 'rail', path: 'features.hole.at.0', expr: 'max(width / 2, 2in)' },
    ]);
    const inserted = insertRecipe(emptyDoc(), captureRecipe(source, { name: 'Rail' }));
    const changed = ok(inserted.doc, [{ op: 'update', id: inserted.idMap.width!, patch: { value: 1200 } }]);
    expect(changed.parts[inserted.idMap.rail!]!.features[0]!.params.at).toEqual([600, 128]);
  });

  it('exposes real variables and unbound generator inputs and validates edits before insertion', () => {
    const source = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'cab', generator: { type: 'carcass', params: DEFAULT_CARCASS } } },
      variable('width', 2304), { op: 'bind', node: 'cab', path: 'params.width', expr: 'width' },
    ]);
    const recipe = captureRecipe(source, { name: 'Cabinet' });
    expect(recipeInputs(recipe).map((input) => input.key)).toContain('variable:width');
    expect(recipeInputs(recipe).map((input) => input.key)).not.toContain('generator:cab:width');
    expect(recipeInputs(recipe).map((input) => input.key)).toContain('generator:cab:toeKick.depth');
    const inserted = insertRecipe(emptyDoc(), recipe, { inputs: { 'generator:cab:depth': 1280, 'variable:width': 2560 } });
    expect(inserted.doc.assemblies[inserted.idMap.cab!]!.generator!.params).toMatchObject({ width: 2560, depth: 1280 });
    expect(() => insertRecipe(emptyDoc(), recipe, { inputs: { 'generator:cab:depth': -1 } })).toThrow(/invalid carcass/);
    expect(() => insertRecipe(emptyDoc(), recipe, { inputs: { nonexistent: 2 } })).toThrow(/unknown recipe input/);
    expect(() => insertRecipe(emptyDoc(), recipe, { inputs: { 'variable:width': Infinity } })).toThrow(/finite/);
  });

  it('uses one undo step for all inserted nodes, variables and materials', () => {
    const target = emptyDoc();
    const store = createStore(target);
    const recipe = captureRecipe(closet(), { name: 'Riser', nodeIds: ['riser'] });
    const inserted = insertRecipe(store.doc, recipe);
    expect(store.dispatch(inserted.ops).ok).toBe(true);
    expect(store.doc).toEqual(inserted.doc);
    expect(store.undo()).toBe(true);
    expect(store.doc).toEqual(target);
    expect(store.canUndo()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.doc).toEqual(inserted.doc);
  });

  it('avoids every existing generated namespace, including IDs used by variables or annotations', () => {
    const target = ok(emptyDoc(), [
      variable('recipe1_v99', 1),
      { op: 'add', entity: { kind: 'block', id: 'recipe2.anything', size: [64, 64, 64] } },
    ]);
    const recipe = captureRecipe(ok(emptyDoc(), [panel('part')]), { name: 'Part' });
    expect(insertRecipe(target, recipe).wrapperId).toBe('recipe3');
  });

  it('rejects partial generated selections and cross-parent selections with actionable errors', () => {
    expect(() => captureRecipe(demoDoc(), { name: 'Side', nodeIds: ['a1.side-left'] })).toThrow(/select the complete/);
    expect(() => captureRecipe(closet(), { name: 'Parts', nodeIds: ['riserBack', 'outside'] })).toThrow(/common assembly/);
    expect(() => captureRecipe(closet(), { name: 'None', nodeIds: [] })).toThrow(/select a component/);
  });

  it('rejects corrupt data, unknown versions, dangling references and stale generated snapshots', () => {
    const recipe = captureRecipe(closet(), { name: 'Riser', nodeIds: ['riser'] });
    expect(() => parseRecipe('{')).toThrow(/JSON/);
    expect(() => parseRecipe({ ...recipe, version: 99 })).toThrow(/invalid recipe/);
    expect(() => parseRecipe({ ...recipe, name: '  ' })).toThrow(/invalid recipe/);
    const missing = structuredClone(recipe);
    delete missing.doc.variables.closetSpan;
    expect(() => parseRecipe(missing)).toThrow(/no variable/);
    const cyclic = structuredClone(recipe);
    cyclic.doc.assemblies.riser!.children.push('riser');
    expect(() => parseRecipe(cyclic)).toThrow(/referenced 2 times|inside itself/);
    const stale = captureRecipe(demoDoc(), { name: 'Cabinet' });
    stale.doc.parts['a1.side-left']!.name = 'Changed without override';
    expect(() => parseRecipe(stale)).toThrow(/stale/);
  });

  it('upgrades recipes saved by an older app, and refuses ones from a newer one', () => {
    const recipe = JSON.parse(serializeRecipe(captureRecipe(closet(), { name: 'Riser', nodeIds: ['riser'] })));
    recipe.doc.version = 5;
    delete recipe.doc.motions;
    const upgraded = parseRecipe(recipe);
    expect(upgraded.doc.version).toBe(SCHEMA_VERSION);
    expect(upgraded.doc.motions).toEqual({});
    expect(() => parseRecipe({ ...recipe, doc: { ...recipe.doc, version: 99 } })).toThrow(/update the app/);
  });

  it('upgrades an older recipe’s cabinet so its drawers slide, in the recipe and in every copy', () => {
    const source = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Drawer base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [0, 0], shelves: 0 } } } }]);
    const recipe = JSON.parse(serializeRecipe(captureRecipe(source, { name: 'Drawer base' })));
    // Saved by an older app: no motions, and no `doors` param yet.
    recipe.doc.version = 5;
    delete recipe.doc.motions;
    delete recipe.doc.assemblies.a1.generator.params.doors;
    const upgraded = parseRecipe(recipe);
    expect(Object.keys(upgraded.doc.motions)).toEqual(['a1.motion.drawer-1', 'a1.motion.drawer-2']);
    const inserted = insertRecipe(emptyDoc(), upgraded);
    expect(Object.values(inserted.doc.motions).map((m) => [m.id, m.name])).toEqual([
      ['recipe1_a1.motion.drawer-1', 'Drawer 1'],
      ['recipe1_a1.motion.drawer-2', 'Drawer 2'],
    ]);
  });

  it('keeps animations inside the selection and says which ones it leaves out', () => {
    const source = ok(closet(), [
      { op: 'add', entity: { kind: 'motion', id: 'lift', nodes: ['riserBack', 'riserFront'], type: 'slide', params: { toward: 'top' } } },
      { op: 'add', entity: { kind: 'motion', id: 'swing', nodes: ['riser', 'outside'], type: 'hinge', params: { side: 'left' } } },
    ]);
    const recipe = captureRecipe(source, { name: 'Riser', nodeIds: ['riser'] });
    expect(Object.keys(recipe.doc.motions)).toEqual(['lift']);
    expect(recipe.warnings.join(' ')).toMatch(/"L-shaped base riser" animation also moves excluded parts/);
    const inserted = insertRecipe(emptyDoc(), recipe);
    const copy = Object.values(inserted.doc.motions);
    expect(copy).toHaveLength(1);
    expect(copy[0]!.nodes).toEqual([inserted.idMap.riserBack, inserted.idMap.riserFront]);
  });

  it('rejects generator overrides without a generator atomically', () => {
    const target = emptyDoc();
    expect(applyOps(target, [{ op: 'add', entity: { kind: 'assembly', overrides: { side: { deleted: true } } } }])).toMatchObject({ ok: false, error: expect.stringContaining('require a generator') });
    expect(target.roots).toEqual([]);
  });
});
