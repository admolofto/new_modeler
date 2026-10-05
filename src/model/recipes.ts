import { z } from 'zod';
import { generators, pluginVersions } from '../plugins';
import { deepEqual, descendants, ModelError, parentIndex } from './doc';
import { parseFormula, type Expr } from './expr';
import { generatedOwner, genJointId, genPartId, regenerate } from './generate';
import { syncJoints } from './joinery';
import { applyOps, type Op } from './ops';
import { Doc as DocSchema, Id, type Doc, type Material, type Vec3 } from './schema';
import { validateDoc } from './validate';
import { allBindings } from './variables';
import { union, worldBoxes } from './world';

type Params = Record<string, unknown>;

/** A recipe is an independent, editable construction document. Dimensions use model units. */
export const RECIPE_VERSION = 1;
export const Recipe = z.strictObject({
  version: z.literal(RECIPE_VERSION),
  id: Id,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(8000),
  createdAt: z.iso.datetime(),
  scope: z.enum(['model', 'selection']),
  doc: DocSchema,
  warnings: z.array(z.string()),
});
export type Recipe = z.infer<typeof Recipe>;

export interface CaptureRecipeOptions {
  name: string;
  description?: string;
  /** Omit for the entire model. Explicit empty selection is an error. */
  nodeIds?: readonly string[];
  id?: string;
  now?: string;
}

/** Material fields also include currently inactive choices (e.g. drawer material with no drawers). */
function materialFields(params: Params): string[] {
  const refs: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string' && /material$/i.test(key)) refs.push(value);
    else if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k));
  };
  visit(params);
  return refs;
}

function neededMaterials(doc: Doc): Set<string> {
  const refs = new Set(Object.values(doc.parts).flatMap((p) => p.material ? [p.material] : []));
  for (const asm of Object.values(doc.assemblies)) {
    const g = asm.generator;
    if (!g) continue;
    for (const id of [...generators.get(g.type).materialRefs(g.params), ...materialFields(g.params)]) refs.add(id);
    for (const ov of Object.values(g.overrides)) if (ov.material) refs.add(ov.material);
  }
  return refs;
}

/**
 * Validate before storage or insertion. Reject malformed trees before any recursive traversal,
 * and reject stale generated snapshots rather than silently replacing saved construction.
 */
export function parseRecipe(value: unknown): Recipe {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new ModelError('recipe is not valid JSON'); }
  }
  const parsed = Recipe.safeParse(value);
  if (!parsed.success) throw new ModelError(`invalid recipe — ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const recipe = parsed.data;
  const doc = recipe.doc;
  validateDoc(doc);
  if (!doc.roots.length) throw new ModelError('a recipe must contain at least one part or assembly');
  if (Object.keys(doc.annotations).length) throw new ModelError('recipes cannot contain project annotations');
  for (const id of neededMaterials(doc)) if (!doc.materials[id]) throw new ModelError(`recipe is missing material "${id}"`);
  const rebuilt = structuredClone(doc);
  for (const asm of Object.values(rebuilt.assemblies)) if (asm.generator) regenerate(rebuilt, asm.id);
  syncJoints(rebuilt);
  validateDoc(rebuilt);
  for (const part of Object.values(doc.parts)) {
    // A visibility / clickability toggle can leave explicit false; regenerated parts omit the flag.
    const other = rebuilt.parts[part.id];
    const norm = (p: typeof part) => ({ ...p, hidden: p.hidden || undefined, unclickable: p.unclickable || undefined });
    if (part.role !== undefined && (!other || !deepEqual(norm(part), norm(other)))) {
      throw new ModelError(`recipe's generated part "${part.name}" is stale; regenerate its assembly before saving`);
    }
  }
  if (Object.keys(rebuilt.parts).length !== Object.keys(doc.parts).length || !deepEqual(rebuilt.joints, doc.joints)) {
    throw new ModelError('recipe generator output does not match its saved parts or joints; regenerate before saving');
  }
  return recipe;
}

export function serializeRecipe(recipe: Recipe): string {
  return JSON.stringify(parseRecipe(recipe), null, 2);
}

/**
 * Capture whole models, or complete sibling components. The first selected root is the local
 * origin. Ancestor placement is omitted; position formulas subtract that fixed saved offset,
 * preserving their response to dimension changes. Cross-parent selections must be grouped first.
 */
export function captureRecipe(source: Doc, options: CaptureRecipeOptions): Recipe {
  validateDoc(source);
  const parents = parentIndex(source);
  const requested = new Set(options.nodeIds ?? source.roots);
  if (!requested.size) throw new ModelError('select a component or build a model before saving a recipe');
  for (const id of requested) if (!source.parts[id] && !source.assemblies[id]) throw new ModelError(`no part or assembly "${id}" to save`);
  const roots = [...requested].filter((id) => {
    for (let p = parents.get(id); p; p = parents.get(p)) if (requested.has(p)) return false;
    return true;
  });
  for (const id of roots) {
    const owner = generatedOwner(source, id);
    if (owner) throw new ModelError(`"${source.parts[id]!.name}" is generated; select the complete "${owner.name}" assembly to preserve its construction`);
  }
  if (new Set(roots.map((id) => parents.get(id))).size > 1) {
    throw new ModelError('selected components have different parents; select their common assembly or group them before saving a recipe');
  }
  const keep = new Set(roots.flatMap((id) => [id, ...descendants(source, id)]));
  const doc: Doc = {
    version: source.version, pluginVersions: pluginVersions(), roots,
    parts: {}, assemblies: {}, joints: {}, materials: {}, variables: {}, annotations: {},
  };
  for (const id of keep) {
    if (source.parts[id]) doc.parts[id] = structuredClone(source.parts[id]!);
    else doc.assemblies[id] = structuredClone(source.assemblies[id]!);
  }
  const warnings: string[] = [];
  for (const joint of Object.values(source.joints)) {
    const included = joint.parts.filter((id) => keep.has(id));
    if (included.length === 2) doc.joints[joint.id] = structuredClone(joint);
    else if (included.length) warnings.push(`Joint ${joint.id} to an excluded part was omitted; reconnect it in the new model if needed.`);
  }
  const anchor = (source.parts[roots[0]!] ?? source.assemblies[roots[0]!]!).transform.position;
  for (const id of roots) {
    const node = doc.parts[id] ?? doc.assemblies[id]!;
    node.transform.position = node.transform.position.map((v, axis) => v - anchor[axis]!) as Vec3;
    for (const [axis, name] of ['x', 'y', 'z'].entries()) {
      const path = `position.${name}`;
      if (node.bind?.[path] && anchor[axis] !== 0) node.bind[path] = `(${node.bind[path]}) - (${anchor[axis]})`;
    }
  }
  const vars = new Set(allBindings(doc).flatMap((b) => parseFormula(b.src).refs));
  const mats = neededMaterials(doc);
  for (const variable of Object.values(source.variables)) {
    if (options.nodeIds === undefined || vars.has(variable.id)) doc.variables[variable.id] = structuredClone(variable);
  }
  for (const material of Object.values(source.materials)) {
    if (options.nodeIds === undefined || mats.has(material.id)) doc.materials[material.id] = structuredClone(material);
  }
  if (options.nodeIds !== undefined) {
    const externalVars = new Set(allBindings(source).filter((b) => !keep.has(b.node)).flatMap((b) => parseFormula(b.src).refs));
    for (const id of vars) if (externalVars.has(id)) warnings.push(`"${source.variables[id]!.name}" also drives excluded parts; its saved value is an independent recipe input.`);
  }
  syncJoints(doc);
  return parseRecipe({ version: RECIPE_VERSION, id: options.id ?? `recipe-${crypto.randomUUID()}`, name: options.name,
    description: options.description ?? '', createdAt: options.now ?? new Date().toISOString(),
    scope: options.nodeIds === undefined ? 'model' : 'selection', doc, warnings });
}

export type RecipeInput = {
  key: string; label: string; group: string; value: number; unit: 'length' | 'number';
} & ({ kind: 'variable'; variableId: string } | { kind: 'generator'; nodeId: string; path: string });

/** Existing inputs only: no inferred scaling or construction rules, and no material thickness scaling. */
export function recipeInputs(recipe: Recipe): RecipeInput[] {
  const inputs: RecipeInput[] = Object.values(recipe.doc.variables).map((v) => ({
    key: `variable:${v.id}`, label: v.name, group: v.group, value: v.value, unit: v.unit, kind: 'variable', variableId: v.id,
  }));
  for (const asm of Object.values(recipe.doc.assemblies)) {
    if (asm.generator?.type !== 'carcass') continue;
    const paths = ['width', 'height', 'depth', 'toeKick.height', 'toeKick.depth', 'shelves'];
    const drawers = asm.generator.params.drawers;
    if (Array.isArray(drawers)) drawers.forEach((_, index) => paths.push(`drawers.${index}`));
    for (const path of paths) {
      if (asm.bind?.[`params.${path}`]) continue;
      const value = path.split('.').reduce<unknown>((obj, key) => obj && typeof obj === 'object' ? (obj as Params)[key] : undefined, asm.generator.params);
      if (typeof value !== 'number') continue;
      inputs.push({ key: `generator:${asm.id}:${path}`, label: path.replace('toeKick.', 'toe kick ').replace(/^drawers\.(\d+)$/, (_, n: string) => `drawer ${Number(n) + 1} front height`),
        group: asm.name, value, unit: path === 'shelves' ? 'number' : 'length', kind: 'generator', nodeId: asm.id, path });
    }
  }
  return inputs;
}

function resizedDoc(recipe: Recipe, values: Readonly<Record<string, number>>): Doc {
  const available = new Map(recipeInputs(recipe).map((input) => [input.key, input]));
  const ops: Op[] = [];
  const params = new Map<string, Params>();
  for (const [key, value] of Object.entries(values)) {
    const input = available.get(key);
    if (!input) throw new ModelError(`unknown recipe input "${key}"`);
    if (!Number.isFinite(value)) throw new ModelError(`recipe input "${input.label}" must be a finite number`);
    if (input.kind === 'variable') ops.push({ op: 'update', id: input.variableId, patch: { value } });
    else {
      const p = params.get(input.nodeId) ?? structuredClone(recipe.doc.assemblies[input.nodeId]!.generator!.params);
      const segments = input.path.split('.');
      let at = p;
      for (const segment of segments.slice(0, -1)) at = at[segment] as Params;
      at[segments.at(-1)!] = value;
      params.set(input.nodeId, p);
    }
  }
  for (const [id, p] of params) ops.push({ op: 'update', id, patch: { params: p } });
  const result = applyOps(recipe.doc, ops);
  if (!result.ok) throw new ModelError(result.error);
  return result.doc;
}

/** Rewrite parsed tokens, so variable names cannot corrupt function names or inch literals. */
function remapFormula(src: string, ids: Record<string, string>): string {
  const print = (e: Expr): string => {
    switch (e.k) {
      case 'num': return String(e.v);
      case 'var': return ids[e.id]!;
      case 'neg': return `(-${print(e.a)})`;
      case 'bin': return `(${print(e.a)} ${e.op} ${print(e.b)})`;
      case 'call': return `${e.fn}(${e.args.map(print).join(', ')})`;
    }
  };
  return print(parseFormula(src).ast);
}

function remapMaterialParams(params: Params, ids: Record<string, string>): Params {
  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string' && /material$/i.test(key)) return ids[value] ?? value;
    if (Array.isArray(value)) return value.map((v) => visit(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    return value;
  };
  return visit(params) as Params;
}

/** What makes two materials the same stock: color and price are this project's, not the stock's. */
const stockKey = (m: Material) => JSON.stringify([m.name.trim().toLowerCase(), m.thickness, m.stock, m.sheet ?? null, m.nominal ?? null]);

/** The target's material for the same stock, preferring the one with the recipe material's id. */
function matchingStock(target: Doc, material: Material): Material | undefined {
  const same = Object.values(target.materials).filter((m) => stockKey(m) === stockKey(material));
  return same.find((m) => m.id === material.id) ?? same[0];
}

export interface InsertRecipeOptions {
  parent?: string | null;
  /** Placement of the independent wrapper, relative to parent. */
  position?: Vec3;
  inputs?: Readonly<Record<string, number>>;
}
export interface RecipeInsertion {
  ops: Op[];
  doc: Doc;
  wrapperId: string;
  rootIds: string[];
  /** Source entity id → inserted entity id (feature ids are part-local and remain stable). */
  idMap: Record<string, string>;
  warnings: string[];
}

/** Pure proposal. Dispatch its entire ops array once for a single undo step. */
export function insertRecipe(target: Doc, value: Recipe, options: InsertRecipeOptions = {}): RecipeInsertion {
  const recipe = parseRecipe(value);
  const doc = resizedDoc(recipe, options.inputs ?? {});
  const used = new Set([target.materials, target.parts, target.assemblies, target.joints, target.annotations, target.variables].flatMap(Object.keys));
  let prefix = '';
  for (let n = 1; ; n++) {
    const candidate = `recipe${n}`;
    if (![...used].some((id) => id === candidate || id.startsWith(`${candidate}.`) || id.startsWith(`${candidate}_`))) { prefix = candidate; break; }
  }
  const ids: Record<string, string> = {};
  // Materials are shop stock, not construction: use the target's matching stock so the cut list
  // keeps one group per stock, and bring in only the needed materials the target lacks.
  const added: Material[] = [];
  const needed = neededMaterials(doc);
  for (const material of Object.values(doc.materials)) {
    if (!needed.has(material.id)) continue;
    const stock = matchingStock(target, material);
    if (stock) ids[material.id] = stock.id;
    else {
      added.push(material);
      ids[material.id] = `${prefix}_m${added.length}`;
    }
  }
  Object.keys(doc.variables).forEach((id, i) => { ids[id] = `${prefix}_v${i + 1}`; });
  Object.keys(doc.assemblies).forEach((id, i) => { ids[id] = `${prefix}_a${i + 1}`; });
  Object.values(doc.parts).forEach((part, i) => {
    const owner = generatedOwner(doc, part.id);
    ids[part.id] = owner ? genPartId(ids[owner.id]!, part.role!) : `${prefix}_p${i + 1}`;
  });
  Object.values(doc.joints).forEach((joint, i) => {
    const owner = joint.role === undefined ? undefined : Object.values(doc.assemblies).find((a) => joint.id === genJointId(a.id, joint.role!));
    ids[joint.id] = owner ? genJointId(ids[owner.id]!, joint.role!) : `${prefix}_j${i + 1}`;
  });
  const ops: Op[] = [];
  for (const material of added) ops.push({ op: 'add', entity: { kind: 'material', ...structuredClone(material), id: ids[material.id]! } });
  for (const variable of Object.values(doc.variables)) ops.push({ op: 'add', entity: { kind: 'variable', ...variable, id: ids[variable.id]! } });
  ops.push({ op: 'add', entity: { kind: 'assembly', id: prefix, name: recipe.name,
    transform: { position: options.position ?? [0, 0, 0], rotation: [0, 0, 0] } }, parent: options.parent ?? null });
  const copyNode = (id: string, parent: string, index?: number) => {
    const part = doc.parts[id];
    const node = part ?? doc.assemblies[id]!;
    const common = { id: ids[id]!, name: node.name, transform: structuredClone(node.transform) };
    if (part) {
      if (part.block) {
        const p = part.shape.params as { x: number; y: number; z: number };
        ops.push({ op: 'add', entity: { kind: 'block', ...common, size: [p.x, p.y, p.z] }, parent, index });
      } else ops.push({ op: 'add', entity: { kind: 'part', ...common, material: ids[part.material!]!, grain: part.grain,
        shape: structuredClone(part.shape), features: structuredClone(part.features) }, parent, index });
    } else {
      const asm = doc.assemblies[id]!;
      const g = asm.generator;
      const overrides = structuredClone(g?.overrides ?? {});
      for (const ov of Object.values(overrides)) if (ov.material) ov.material = ids[ov.material]!;
      const generator = g && { type: g.type, params: remapMaterialParams(g.params, ids) };
      if (generator && generators.get(generator.type).materialRefs(generator.params).some((ref) => !Object.values(ids).includes(ref))) {
        throw new ModelError(`generator "${generator.type}" needs recipe material-reference support`);
      }
      ops.push({ op: 'add', entity: { kind: 'assembly', ...common, ...(generator && { generator, overrides }) }, parent, index });
      asm.children.forEach((child, at) => { if (!generatedOwner(doc, child)) copyNode(child, ids[id]!, at); });
    }
    if (node.hidden !== undefined) ops.push({ op: 'update', id: ids[id]!, patch: { hidden: node.hidden } });
    if (node.unclickable !== undefined) ops.push({ op: 'update', id: ids[id]!, patch: { unclickable: node.unclickable } });
    for (const [path, expr] of Object.entries(node.bind ?? {})) ops.push({ op: 'bind', node: ids[id]!, path, expr: remapFormula(expr, ids) });
  };
  for (const root of doc.roots) copyNode(root, prefix);
  for (const joint of Object.values(doc.joints)) if (joint.role === undefined) ops.push({ op: 'add', entity: {
    kind: 'joint', id: ids[joint.id]!, type: joint.type, parts: [ids[joint.parts[0]]!, ids[joint.parts[1]]!], params: structuredClone(joint.params),
  } });
  const result = applyOps(target, ops);
  if (!result.ok) throw new ModelError(result.error);
  return { ops, doc: result.doc, wrapperId: prefix, rootIds: doc.roots.map((id) => ids[id]!), idMap: ids, warnings: [...recipe.warnings] };
}

/**
 * `insertRecipe`, placed: at `position` when given, else (at top level) 12" to the right of everything
 * in the model, on the same floor and back line, so a new copy never lands inside existing work.
 */
export function placeRecipe(target: Doc, recipe: Recipe, options: InsertRecipeOptions = {}): RecipeInsertion {
  const insertion = insertRecipe(target, recipe, options);
  if (options.position || options.parent) return insertion;
  const boxes = worldBoxes(target);
  const existing = target.roots.flatMap((id) => boxes.has(id) ? [boxes.get(id)!] : []);
  const added = worldBoxes(insertion.doc).get(insertion.wrapperId);
  if (!existing.length || !added) return insertion;
  const model = union(existing);
  const position: Vec3 = [model.max[0] + 12 * 64 - added.min[0], model.min[1] - added.min[1], model.min[2] - added.min[2]];
  return insertRecipe(target, recipe, { ...options, position });
}
