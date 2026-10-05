import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { cutList, cutListText } from '../model/cutlist';
import { applyOps, makeOpSchema, motionEntity, type Op } from '../model/ops';
import { Id, type Doc, type Motion } from '../model/schema';
import { formatInches, parseInches } from '../model/units';
import { features, generators, motions, shapes } from '../plugins';
import { buildPart } from '../plugins/pipeline';
import { apply, boxSize, nodeAffine, overlaps, rotate, union, worldBoxes, type Box3 } from '../model/world';
import { parentIndex } from '../model/doc';
import { directionText } from '../edit/blocks';
import { clashText, clearance } from '../model/clearance';
import { generatedOwner } from '../model/generate';
import { motionBasis, motionName, motionSummary } from '../model/motion';
import { placeRecipe, recipeInputs, type Recipe } from '../model/recipes';
import { hingePoint, towardOf, type HingeParams } from '../plugins/motions/hinge';
import { cross, normal, type Side } from '../plugins/motions/sides';
import { treeIssues } from './organization';

/**
 * AI tools. Their input schemas are generated from the plugin registry (every shape,
 * feature and generator contributes its params schema + docs), so a new plugin teaches
 * the AI without touching this file. Tools run against a draft doc; nothing reaches the
 * store until the user accepts the preview.
 */

type Tool = Anthropic.Beta.BetaTool;

interface Def {
  type: string;
  schema: z.ZodType;
  describe: string;
}

function refUnion(defs: Def[], withId: boolean): z.ZodType {
  const options = defs.map((d) =>
    z
      .object({ ...(withId && { id: Id.optional() }), type: z.literal(d.type), params: d.schema })
      .describe(d.describe),
  );
  if (options.length === 1) return options[0]!;
  return z.discriminatedUnion('type', options as unknown as [z.ZodObject, z.ZodObject]);
}

/** One motion entity per motion plugin, flat: {kind: "motion", nodes, type, params}. */
function motionUnion() {
  const options = motions.all().map((d) => motionEntity(z.literal(d.type), d.schema).describe(d.describe));
  if (options.length === 1) return options[0]!;
  return z.discriminatedUnion('type', options as unknown as [ReturnType<typeof motionEntity>, ReturnType<typeof motionEntity>]);
}

export function aiOpSchema() {
  return makeOpSchema({
    shape: refUnion(shapes.all(), false),
    feature: refUnion(features.all(), true),
    generator: refUnion(generators.all(), false),
    motion: motionUnion(),
  });
}

function jsonSchema(schema: z.ZodType): Tool['input_schema'] {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest as Tool['input_schema'];
}

export const TOOL_APPLY = 'apply_ops';
export const TOOL_INSPECT = 'inspect_part';
export const TOOL_GET_MODEL = 'get_model';
export const TOOL_CUT_LIST = 'cut_list';
export const TOOL_GET_RECIPE = 'get_recipe';
export const TOOL_INSERT_RECIPE = 'insert_recipe';

/** A length in 1/64" or an inch string ("30in"). */
const Length = z.union([z.int(), z.string()]);
const RecipeRef = z.string().min(1).describe('The recipe\'s id from the "recipes" catalog in the model snapshot (its exact name also works).');

export function toolDefs(): Tool[] {
  return [
    {
      name: TOOL_APPLY,
      description:
        'Applies a batch of ops to the working model, atomically: if any op is invalid the whole batch is rejected with the reason ' +
        'and nothing from it is applied (earlier successful batches this turn stay applied). Ops apply in order, so later ops can ' +
        'reference ids created earlier in the batch (give new entities explicit ids to do that). Lengths are integer 1/64"; any length ' +
        'may instead be written as an inch string like "34 1/2in" or "3/4in". The result lists what changed, world bounds of new/changed ' +
        'nodes, and warnings such as parts that interpenetrate — fix real problems with another call. Nothing is final until the ' +
        'user accepts the preview.\n\n' +
        'Ops: add {entity, parent?, index?} (entity.kind part | block | assembly | joint | material | motion; a block is a placeholder box: {kind: "block", name?, transform?, size: [x, y, z]}); update {id, patch} (part: name, material, ' +
        'grain, shape: {params} merged into the current params — a block takes only name and shape params; assembly: name, params merged into its generator params, which ' +
        'regenerates it; material: name, thickness, color, stock; joint: type, parts, params); delete {id} (assemblies take their ' +
        'children with them; deleting a generated part is remembered as an override); move {id, to? | by?, rotation?, parent?, index?, keepWorld?} ' +
        '(parent: assembly id or null = top level; add keepWorld: true when reparenting existing nodes so they stay where they are in the world ' +
        '— their local transform and position formulas adapt; index alone, without parent, reorders a node among its siblings, 0 = first). ' +
        'Organize each piece as a named assembly and each multi-part component (door, drawer, face frame) as a named folder inside it. ' +
        'Parts, blocks and assemblies accept update patch {hidden: boolean} for viewport visibility and {unclickable: boolean} to make them ignore viewport clicks; both apply to folder descendants. ' +
        'addFeature {part, feature}; updateFeature {part, feature: id, params (merged)}; ' +
        'removeFeature {part, feature: id}; bind {node, path, expr} binds a part / assembly field to a formula over variables ' +
        '(expr null unbinds; the value stays). Variables: add {entity: {kind: "variable", id, name, group, unit?, value}}; ' +
        'update {id, patch: {value | name | group}}; delete {id} (unbinds what used it). ' +
        'Notes: update {id: "n1", patch: {resolved: true}} marks a user note addressed. ' +
        'Animations (how doors, drawers and lids open): add {entity: {kind: "motion", nodes: [what moves together: siblings, e.g. a door\'s folder], type, params, name?}}; ' +
        'update {id, patch: {params (merged; null resets one), type?, nodes?, name?}}; delete {id}. Generated ones (carcass drawers and doors) are read-only.',
      input_schema: jsonSchema(z.object({ ops: z.array(aiOpSchema()).min(1) })),
    },
    {
      name: TOOL_INSPECT,
      description:
        'Built geometry of one part in the working model: its flat faces with their [u, v] extents (the frame hole/pocket `at` is ' +
        'measured in), edge ids you can profile, features, and bounds. Use it before placing cuts on outline parts or on faces you ' +
        'are unsure about.',
      input_schema: jsonSchema(z.object({ id: Id })),
    },
    {
      name: TOOL_CUT_LIST,
      description:
        'The cut list of the working model, as text: every part at the size to cut it (parts sitting in dados or rabbets ' +
        'include that depth), grouped by material with quantities, what to machine on each part, sheet / board-foot ' +
        'estimates, and problems such as joints whose parts do not touch. Use it when the user asks for cut sizes, a cut ' +
        'list, or how much material to buy, and to check joinery after adding joints.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: TOOL_GET_RECIPE,
      description:
        'One of the user\'s saved recipes (catalogued under "recipes" in the model snapshot) in full: its construction ' +
        'description, warnings, overall size, materials, its part / assembly tree, and the inputs insert_recipe accepts with ' +
        'their saved values. Read it before inserting a recipe, to pick the inputs and learn how it is built.',
      input_schema: jsonSchema(z.object({ id: RecipeRef })),
    },
    {
      name: TOOL_INSERT_RECIPE,
      description:
        'Inserts an independent, editable copy of a saved recipe into the working model, in the same preview as your other ' +
        'changes. The copy gets fresh ids inside a new wrapper assembly named after the recipe; the result maps the recipe\'s ids ' +
        'to the copy\'s. inputs: {key: value} with input keys from get_recipe (lengths may be inch strings); other dimensions ' +
        'follow the saved design. parent: an assembly id, or null / omitted for top level. position: the wrapper\'s placement ' +
        'relative to the parent; omit it at top level to put the copy 12" to the right of the existing model. Then adapt the ' +
        'copy with apply_ops; insert a recipe once per piece and edit or delete the copy rather than inserting it again.',
      input_schema: jsonSchema(z.object({
        id: RecipeRef,
        inputs: z.record(z.string(), Length).optional(),
        parent: Id.nullable().optional(),
        position: z.tuple([Length, Length, Length]).optional(),
      })),
    },
  ];
}

/** MCP adds get_model: a Claude Code session has no app-built snapshot in its turns. */
export function mcpToolDefs(): Tool[] {
  return [
    {
      name: TOOL_GET_MODEL,
      description:
        'The current model as JSON (materials, the assembly/part tree with generator params, and each node\'s world bounds), plus ' +
        'whether a proposal is pending. If one is, the model shown includes it. Call this before changing anything.',
      input_schema: { type: 'object', properties: {} },
    },
    ...toolDefs(),
  ];
}

/** Converts inch strings ("34 1/2in", `3/4"`, "12 inches") anywhere in a tool input to model units. */
export function normalizeLengths(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = /^\s*(-?\d[\d\s./-]*?)\s*(?:"|in|inch|inches)\s*$/i.exec(value);
    if (!m) return value;
    return parseInches(m[1]!) ?? value;
  }
  if (Array.isArray(value)) return value.map(normalizeLengths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeLengths(v)]));
  }
  return value;
}

export interface ToolState {
  draft: Doc;
  /** Every op applied this turn, in order (what the preview accepts). */
  ops: Op[];
  /** The user's saved recipe library; may throw when browser storage can't be read. */
  recipes?: (() => readonly Recipe[]) | undefined;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** One line for the chat log. */
  summary: string;
}

const fmtBox = (b: Box3) => {
  const s = boxSize(b);
  return `${s.map(formatInches).join(' × ')} (W×H×D) from [${b.min.join(', ')}] to [${b.max.join(', ')}]`;
};

function nodeIds(d: Doc): Set<string> {
  return new Set([
    ...Object.keys(d.parts),
    ...Object.keys(d.assemblies),
    ...Object.keys(d.materials),
    ...Object.keys(d.joints),
    ...Object.keys(d.annotations),
    ...Object.keys(d.variables),
    ...Object.keys(d.motions),
  ]);
}

function describeNode(d: Doc, id: string): string {
  const e = d.parts[id] ?? d.assemblies[id] ?? d.materials[id];
  if (e) return `${id} "${e.name}"`;
  const v = d.variables[id];
  if (v) return `variable ${id} (${v.group} › ${v.name})`;
  const j = d.joints[id];
  if (j) return `${id} (${j.type} joint)`;
  const m = d.motions[id];
  if (m) return `${id} (animation of "${motionName(d, m)}")`;
  return d.annotations[id] ? `${id} (note)` : id;
}

/** How a motion moves, worked out from its parts: its hinge line or its travel, in world terms. */
function motionDetail(d: Doc, m: Motion): string {
  const head = `${m.id} "${motionName(d, m)}": ${motionSummary(m)}`;
  try {
    const basis = motionBasis(d, m);
    const frame = nodeAffine(d, m.nodes[0]!);
    if (m.type === 'hinge') {
      const p = m.params as unknown as HingeParams;
      const toward = towardOf(p);
      const at = apply(frame, hingePoint(basis, p.side, toward)).map(Math.round);
      return `${head} — hinge line along ${directionText(rotate(frame.m, cross(normal(toward), normal(p.side))))} through world [${at.join(', ')}]`;
    }
    const reach = motions.get(m.type).reach(m.params, basis);
    const way = directionText(rotate(frame.m, normal(m.params.toward as Side)));
    return `${head} — travels ${formatInches(reach.value)} toward world ${way}`;
  } catch (e) {
    return `${head} — can't move: ${(e as Error).message}`;
  }
}

function applyTool(state: ToolState, input: unknown): ToolOutcome {
  const parsed = z.object({ ops: z.array(z.unknown()).min(1) }).safeParse(input);
  if (!parsed.success) {
    return { content: 'Expected {"ops": [...]} with at least one op.', isError: true, summary: 'apply_ops: bad input' };
  }
  const ops = normalizeLengths(parsed.data.ops) as Op[];
  const before = state.draft;
  const result = applyOps(before, ops);
  if (!result.ok) {
    return {
      content: `Rejected — nothing from this batch was applied. ${result.error}`,
      isError: true,
      summary: `✗ ${ops.length} op${ops.length === 1 ? '' : 's'} rejected: ${result.error}`,
    };
  }
  const after = result.doc;
  state.draft = after;
  state.ops.push(...ops);

  const prevIds = nodeIds(before);
  const nextIds = nodeIds(after);
  // Generated joints and animations follow their generator; they aren't listed one by one.
  const created = [...nextIds].filter((id) => !prevIds.has(id) && !after.joints[id] && after.motions[id]?.role === undefined);
  const removed = [...prevIds].filter((id) => !nextIds.has(id) && !before.joints[id] && before.motions[id]?.role === undefined);
  const changedParts = Object.keys(after.parts).filter(
    (id) => before.parts[id] && JSON.stringify(before.parts[id]) !== JSON.stringify(after.parts[id]),
  );
  const touched = new Set([...created.filter((id) => after.parts[id]), ...changedParts]);

  const boxes = worldBoxes(after);
  const lines = [`Applied ${ops.length} op${ops.length === 1 ? '' : 's'}.`];
  // Generated parts are summarized per assembly; their roles are in the generator docs.
  const generated = new Map<string, string[]>();
  const listed: string[] = [];
  for (const id of created) {
    const role = (after.parts[id] ?? after.assemblies[id])?.role;
    if (role) generated.set(id.slice(0, -role.length - 1), [...(generated.get(id.slice(0, -role.length - 1)) ?? []), role]);
    else listed.push(describeNode(after, id));
  }
  if (listed.length) lines.push(`Created: ${listed.join(', ')}`);
  for (const [asm, roles] of generated) lines.push(`Generated in ${asm}: ${roles.join(', ')}`);
  if (removed.length) lines.push(`Removed: ${removed.map((id) => describeNode(before, id)).join(', ')}`);
  if (changedParts.length) lines.push(`Changed parts: ${changedParts.length > 12 ? `${changedParts.length} parts` : changedParts.join(', ')}`);
  const oldParents = parentIndex(before);
  const treeChanges = [...parentIndex(after)].filter(([id, parent]) => !oldParents.has(id) || oldParents.get(id) !== parent);
  if (treeChanges.length) lines.push('Tree placement:', ...treeChanges.filter(([id]) => (after.parts[id] ?? after.assemblies[id])?.role === undefined).map(([id, parent]) =>
    `  ${describeNode(after, id)} under ${parent ? describeNode(after, parent) : 'Model (top level)'}`));
  const vars = Object.values(after.variables);
  const varBits = vars
    .filter((v) => before.variables[v.id]?.value !== v.value || before.variables[v.id]?.name !== v.name)
    .map((v) => `${v.id} (${v.group} › ${v.name}) = ${v.unit === 'length' ? formatInches(v.value) : v.value}`);
  if (varBits.length) lines.push(`Variables set: ${varBits.join(', ')}`);
  const bindCount = (d: Doc) => [...Object.values(d.parts), ...Object.values(d.assemblies)].reduce((n, x) => n + Object.keys(x.bind ?? {}).length, 0);
  if (bindCount(after) !== bindCount(before)) lines.push(`Bound fields: ${bindCount(after)} (was ${bindCount(before)})`);
  const resolved = Object.values(after.annotations).filter((n) => n.resolved && before.annotations[n.id] && !before.annotations[n.id]!.resolved);
  if (resolved.length) lines.push(`Resolved notes: ${resolved.map((n) => n.id).join(', ')}`);

  // Bounds of the top-most new/changed nodes, so the AI can check placement without recomputing.
  const shown = new Set<string>();
  for (const id of [...created, ...changedParts]) {
    const top = topAncestor(after, id);
    if (top && !shown.has(top) && boxes.has(top)) {
      shown.add(top);
      lines.push(`World bounds of ${describeNode(after, top)}: ${fmtBox(boxes.get(top)!)}`);
    }
    if (shown.size >= 8) break;
  }
  const clash = overlaps(after, touched, boxes);
  lines.push(...clashLines(after, clash));
  // Animations made or changed (generated ones too, when a cabinet gains them), and what opening hits.
  const newMotions = Object.values(after.motions).filter((m) => JSON.stringify(before.motions[m.id]) !== JSON.stringify(m));
  if (newMotions.length) lines.push('Animations:', ...newMotions.slice(0, 12).map((m) => `  ${motionDetail(after, m)}`));
  const moved = new Set(newMotions.map((m) => m.id));
  const opening = clearance(after).filter((c) => moved.has(c.motion) || (c.with !== undefined && moved.has(c.with)) || touched.has(c.part) || touched.has(c.hits));
  if (opening.length) lines.push('Opening check — fix these unless intended:', ...opening.slice(0, 10).map((c) => `  ${clashText(after, c)}`));
  const issues = treeIssues(before, after);
  if (issues.length) lines.push('Tree check — fix these unless intended:', ...issues.slice(0, 10).map((i) => `  ${i}`));
  const warnings = [
    ...(clash.length ? [`${clash.length} overlap warning${clash.length === 1 ? '' : 's'}`] : []),
    ...(opening.length ? [`${opening.length} opening warning${opening.length === 1 ? '' : 's'}`] : []),
  ];
  return {
    content: lines.join('\n'),
    isError: false,
    summary: `✓ ${ops.length} op${ops.length === 1 ? '' : 's'} applied${warnings.length ? ` (${warnings.join(', ')})` : ''}`,
  };
}

function clashLines(d: Doc, clash: ReturnType<typeof overlaps>): string[] {
  if (!clash.length) return [];
  return [
    'Warning — these parts interpenetrate (their bounds overlap by the given depth); move or resize them unless intended:',
    ...clash.slice(0, 10).map((c) => `  ${describeNode(d, c.a)} × ${describeNode(d, c.b)}: ${c.depth.map(formatInches).join(' × ')}`),
  ];
}

const fail = (content: string, summary: string): ToolOutcome => ({ content, isError: true, summary: `✗ ${summary}` });

/** The recipe a tool call names (by id, or exact name), or the error to return. */
function findRecipe(state: ToolState, ref: unknown): Recipe | ToolOutcome {
  if (!state.recipes) return fail('No recipe library is available in this session.', 'no recipe library');
  let all: readonly Recipe[];
  try {
    all = state.recipes();
  } catch (e) {
    return fail((e as Error).message, 'recipes could not be loaded');
  }
  const key = typeof ref === 'string' ? ref.trim() : '';
  const found = all.find((r) => r.id === key) ?? all.find((r) => r.name.trim().toLowerCase() === key.toLowerCase());
  if (found) return found;
  const known = all.map((r) => `${r.id} "${r.name}"`).join(', ');
  return fail(`No recipe "${key}". ${all.length ? `Saved recipes: ${known}.` : 'The user has no saved recipes.'}`, `no recipe "${key}"`);
}

const fmtInput = (unit: 'length' | 'number', value: number) => (unit === 'length' ? formatInches(value) : String(value));

/** Indented outline of a recipe's tree; generated parts are summarized on their generator's line. */
function treeOutline(d: Doc, max = 80): string[] {
  const lines: string[] = [];
  const visit = (id: string, depth: number) => {
    if (lines.length >= max) return;
    const pad = '  '.repeat(depth + 1);
    const part = d.parts[id];
    if (part) {
      lines.push(`${pad}${part.name} [${id}]${part.block ? ' (block)' : ''}`);
      return;
    }
    const asm = d.assemblies[id];
    if (!asm) return;
    const generated = asm.children.filter((c) => generatedOwner(d, c)?.id === asm.id);
    const gen = asm.generator ? ` (${asm.generator.type} generator: ${generated.map((c) => (d.parts[c] ?? d.assemblies[c])!.name).join(', ')})` : '';
    lines.push(`${pad}${asm.name} [${id}]${gen}`);
    for (const c of asm.children) if (!generated.includes(c)) visit(c, depth + 1);
  };
  for (const id of d.roots) visit(id, 0);
  if (lines.length >= max) lines.push('  …');
  return lines;
}

function getRecipeTool(state: ToolState, input: unknown): ToolOutcome {
  const recipe = findRecipe(state, (input as { id?: unknown } | undefined)?.id);
  if (!('doc' in recipe)) return recipe;
  const d = recipe.doc;
  const boxes = worldBoxes(d);
  const roots = d.roots.flatMap((id) => (boxes.has(id) ? [boxes.get(id)!] : []));
  const inputs = recipeInputs(recipe);
  const lines = [
    `Recipe ${recipe.id} "${recipe.name}" (${recipe.scope === 'model' ? 'whole model' : 'component'}, ${Object.keys(d.parts).length} parts).`,
    `Description: ${recipe.description.trim() || '(none saved)'}`,
    ...(recipe.warnings.length ? [`Warnings: ${recipe.warnings.join(' ')}`] : []),
    ...(roots.length ? [`Overall size: ${fmtBox(union(roots))}`] : []),
    `Materials: ${Object.values(d.materials).map((m) => `${m.id} "${m.name}" (${formatInches(m.thickness)} ${m.stock})`).join(', ') || 'none'}`,
    inputs.length ? 'Inputs (insert_recipe inputs keys = saved values):' : 'Inputs: none; resize the copy with apply_ops after inserting it.',
    ...inputs.map((i) => `  ${i.key}: ${i.group ? `${i.group} › ` : ''}${i.label} = ${fmtInput(i.unit, i.value)}`),
    'Tree:',
    ...treeOutline(d),
  ];
  return { content: lines.join('\n'), isError: false, summary: `read recipe "${recipe.name}"` };
}

const InsertInput = z.object({
  id: z.string(),
  inputs: z.record(z.string(), z.number()).optional(),
  parent: Id.nullable().optional(),
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
});

function insertRecipeTool(state: ToolState, input: unknown): ToolOutcome {
  const parsed = InsertInput.safeParse(normalizeLengths(input));
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return fail(`Expected {"id", "inputs"?: {key: length or number}, "parent"?, "position"?: [x, y, z]}. ${why}`, 'insert_recipe: bad input');
  }
  const recipe = findRecipe(state, parsed.data.id);
  if (!('doc' in recipe)) return recipe;
  const { inputs, parent, position } = parsed.data;
  let insertion;
  try {
    insertion = placeRecipe(state.draft, recipe, { inputs, parent, ...(position && { position: position.map(Math.round) as [number, number, number] }) });
  } catch (e) {
    const why = (e as Error).message;
    return fail(`Rejected — nothing was inserted. ${why}`, `recipe "${recipe.name}" not inserted: ${why}`);
  }
  const before = state.draft;
  const after = insertion.doc;
  state.draft = after;
  state.ops.push(...insertion.ops);

  const named = (id: string) => describeNode(after, id);
  // Materials the model already had under the same id need no mapping.
  const copies = Object.entries(insertion.idMap).filter(([from, copy]) => from !== copy && !after.joints[copy] && !after.parts[copy]?.role);
  const generated = Object.values(insertion.idMap).filter((id) => after.parts[id]?.role);
  const newParts = Object.values(insertion.idMap).filter((id) => after.parts[id]);
  const applied = recipeInputs(recipe).flatMap((i) => (inputs?.[i.key] === undefined ? [] : [`${i.label} = ${fmtInput(i.unit, inputs[i.key]!)}`]));
  const boxes = worldBoxes(after);
  const box = boxes.get(insertion.wrapperId);
  const lines = [
    `Inserted a copy of recipe "${recipe.name}" as ${named(insertion.wrapperId)} under ${parent ? named(parent) : 'Model (top level)'}; it is part of the pending proposal.`,
    `Copy roots: ${insertion.rootIds.map(named).join(', ')}`,
    ...(applied.length ? [`Inputs applied: ${applied.join(', ')}`] : []),
    `Recipe id → copy: ${copies.map(([from, to]) => `${from} → ${named(to)}`).join(', ')}`,
    ...(generated.length ? [`Plus ${generated.length} generated parts inside the copied generator assemblies.`] : []),
    ...(box ? [`World bounds of ${named(insertion.wrapperId)}: ${fmtBox(box)}`] : []),
    ...(insertion.warnings.length ? [`Recipe warnings: ${insertion.warnings.join(' ')}`] : []),
    ...clashLines(after, overlaps(after, newParts, boxes)),
    // Only the wrapper is judged: the saved design's own names are the user's.
    ...treeIssues(before, after).filter((i) => i.includes(`${insertion.wrapperId} "`)).map((i) => `Tree check: ${i}`),
    `Next: adapt this copy with apply_ops using the copy ids above (change its variables or generator params rather than scaling boards), ` +
      `rename ${insertion.wrapperId} for its role in this model if that helps, and don't insert this recipe again.`,
  ];
  return { content: lines.join('\n'), isError: false, summary: `✓ inserted recipe "${recipe.name}"` };
}

function topAncestor(d: Doc, id: string): string | undefined {
  if (!d.parts[id] && !d.assemblies[id]) return undefined;
  const parents = new Map<string, string>();
  for (const a of Object.values(d.assemblies)) for (const c of a.children) parents.set(c, a.id);
  let cur = id;
  while (parents.has(cur)) cur = parents.get(cur)!;
  return cur;
}

function inspectTool(state: ToolState, input: unknown): ToolOutcome {
  const id = (input as { id?: unknown })?.id;
  const part = typeof id === 'string' ? state.draft.parts[id] : undefined;
  if (!part) {
    const known = Object.keys(state.draft.parts).slice(0, 40).join(', ');
    return { content: `No part "${String(id)}". Parts: ${known}`, isError: true, summary: `✗ inspect ${String(id)}: no such part` };
  }
  const built = buildPart(part);
  const faces = new Map<string, { u: [number, number]; v: [number, number] }>();
  for (const f of built.geom.faces) {
    if (!f.tag.startsWith('face:') && !f.tag.endsWith(':floor')) continue;
    const us = f.outer.map((q) => q[0]);
    const vs = f.outer.map((q) => q[1]);
    const prev = faces.get(f.tag);
    const u: [number, number] = [Math.min(...us, prev?.u[0] ?? Infinity), Math.max(...us, prev?.u[1] ?? -Infinity)];
    const v: [number, number] = [Math.min(...vs, prev?.v[0] ?? Infinity), Math.max(...vs, prev?.v[1] ?? -Infinity)];
    faces.set(f.tag, { u, v });
  }
  const round = (n: number) => Math.round(n);
  const box = worldBoxes(state.draft).get(part.id);
  const content = JSON.stringify({
    id: part.id,
    name: part.name,
    shape: part.shape,
    features: part.features,
    flatFaces: [...faces].map(([tag, { u, v }]) => ({ id: tag, u: u.map(round), v: v.map(round) })),
    edges: built.handles.filter((h) => h.kind === 'edge').map((h) => h.id),
    world: box && [box.min, box.max],
  });
  return { content, isError: false, summary: `inspected ${part.id}` };
}

export function runTool(state: ToolState, name: string, input: unknown): ToolOutcome {
  if (name === TOOL_APPLY) return applyTool(state, input);
  if (name === TOOL_INSPECT) return inspectTool(state, input);
  if (name === TOOL_CUT_LIST) return { content: cutListText(cutList(state.draft)), isError: false, summary: 'read the cut list' };
  if (name === TOOL_GET_RECIPE) return getRecipeTool(state, input);
  if (name === TOOL_INSERT_RECIPE) return insertRecipeTool(state, input);
  return { content: `Unknown tool "${name}".`, isError: true, summary: `✗ unknown tool ${name}` };
}

