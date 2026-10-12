import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { cutList, cutListText } from '../model/cutlist';
import { applyOps, makeOpSchema, motionEntity, type Op } from '../model/ops';
import { Finish, Id, type Doc, type Motion } from '../model/schema';
import { formatInches, parseInches } from '../model/units';
import { features, generators, motions, shapes } from '../plugins';
import { buildPart } from '../plugins/pipeline';
import { apply, boxSize, nodeAffine, overlaps, rotate, union, worldBoxes, type Box3 } from '../model/world';
import { parentIndex } from '../model/doc';
import { directionText } from '../edit/blocks';
import { clashText, clearance } from '../model/clearance';
import { decorInfo, isDecor } from '../model/decor';
import { generatedOwner } from '../model/generate';
import { motionBasis, motionName, motionSummary } from '../model/motion';
import { placeRecipe, recipeInputs, type Recipe } from '../model/recipes';
import { hingePoint, towardOf, type HingeParams } from '../plugins/motions/hinge';
import { cross, normal, type Side } from '../plugins/motions/sides';
import { refitRoomOps, roomAround, roomIssues, roomOf, roomParams, rooms, openingText, type RoomFitOptions } from '../model/room';
import { entityKind } from '../model/doc';
import { ROOM_SIDES } from '../plugins/generators/room';
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

/** Decor shapes the AI may add (internal ones are its generators' business). */
const addableDecor = () => shapes.all().filter((d) => d.decor && !d.decor.internal);

/**
 * Stock shapes go on parts; decor shapes (props, hardware) on the decor entity — minus the internal
 * ones generators place (walls, trim), and with no decor entity at all while there are none to add.
 */
export function aiOpSchema() {
  const decor = addableDecor();
  return makeOpSchema({
    shape: refUnion(shapes.all().filter((d) => !d.decor), false),
    feature: refUnion(features.all(), true),
    generator: refUnion(generators.all(), false),
    motion: motionUnion(),
    ...(decor.length && { decor: refUnion(decor, false) }),
  });
}

/**
 * The JSON schema a tool shows. Finishes appear in every prop, appliance and room: they show as a
 * bare {preset, color?, roughness?} (the prompt documents the presets and #rrggbb colors; zod still
 * checks them when the ops apply), which keeps the tool schemas within budget.
 */
function jsonSchema(schema: z.ZodType): Tool['input_schema'] {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      if (ctx.zodSchema !== Finish) return;
      const props = ctx.jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
      for (const p of Object.values(props ?? {})) for (const k of ['pattern', 'minimum', 'maximum']) delete p[k];
    },
  }) as Record<string, unknown>;
  return rest as Tool['input_schema'];
}

export const TOOL_APPLY = 'apply_ops';
export const TOOL_INSPECT = 'inspect_part';
export const TOOL_GET_MODEL = 'get_model';
export const TOOL_CUT_LIST = 'cut_list';
export const TOOL_GET_RECIPE = 'get_recipe';
export const TOOL_INSERT_RECIPE = 'insert_recipe';
export const TOOL_FIT_ROOM = 'fit_room';
export const TOOL_ASK = 'ask_user';
export const TOOL_NEW_VERSION = 'new_version';

const Question = z.object({
  question: z.string().trim().min(1).max(400),
  options: z.array(z.string().trim().min(1).max(120)).max(4).optional().describe('2–4 short likely answers; the user can also type their own.'),
});
export type Question = z.infer<typeof Question>;
const AskInput = z.object({ questions: z.array(Question).min(1).max(4) });

/** A length in 1/64" or an inch string ("30in"). */
const Length = z.union([z.int(), z.string()]);
const RecipeRef = z.string().min(1).describe('The recipe\'s id from the "recipes" catalog in the model snapshot (its exact name also works).');

export function toolDefs(): Tool[] {
  const decor = addableDecor().length
    ? '; decor is a prop, hardware or furniture piece: {kind: "decor", name?, transform?, shape} — no material, its looks are in its shape params'
    : '';
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
        `Ops: add {entity, parent?, index?} (entity.kind part | block | assembly | joint | material | motion | view${decor ? ' | decor' : ''}; a block is a placeholder box: {kind: "block", name?, transform?, size: [x, y, z]}${decor}); update {id, patch} (part: name, material, ` +
        'grain, finish, shape: {params} merged into the current params — a block takes only name and shape params; assembly: name, finish, params merged into its generator params, which ' +
        'regenerates it; material: name, thickness, color, stock, finish; joint: type, parts, params; finish: {preset, color?, roughness?} or null to clear it); delete {id} (assemblies take their ' +
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
        'update {id, patch: {params (merged; null resets one), type?, nodes?, name?}}; delete {id}. Generated ones (carcass drawers and doors) are read-only. ' +
        'Presentation: setPresentation {lighting?: {preset: auto | day | evening | night | studio, sun?: {azimuth, elevation}, exposure? (EV), underCabinet?} | null, eyeHeight? | null} ' +
        '(lighting replaces the saved one whole; null resets it). Tour views, in order: add {entity: {kind: "view", name, frame: {nodes (none = whole model), from}, open?: [motion or node ids], caption?}, index?}; ' +
        'update {id, patch} (frame merges; null clears a field); delete {id}; move {id, index} reorders.',
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
    {
      name: TOOL_FIT_ROOM,
      description:
        'Makes the room (walls, floor, ceiling) around the model, or refits the existing room to the model as it is now, in the same ' +
        'preview as your other changes. By default the back wall goes flush behind the model; a side wall flush where a cabinet\'s back ' +
        'faces it, else 36" out; the front wall 48" in front; the ceiling at 96" or the model\'s top. margins: the inside distance from ' +
        'the model to a wall (a length; 0 = flush), overriding those rules for that side. height: floor to ceiling. walls: which to build ' +
        '(default all four). ceiling: false leaves it off. Refitting keeps the openings (sliding them along their wall to stay on it), ' +
        'finishes and height. Then add windows and doors by updating the room\'s openings param.',
      input_schema: jsonSchema(z.object({
        margins: z.object({ left: Length.optional(), right: Length.optional(), back: Length.optional(), front: Length.optional() }).optional(),
        height: Length.optional(),
        walls: z.array(z.enum(ROOM_SIDES)).min(1).optional(),
        ceiling: z.boolean().optional(),
      })),
    },
    {
      name: TOOL_NEW_VERSION,
      description:
        'Starts a new version: a design alternative the user flips to from the version tabs over the view (v1, v2…). It starts as a ' +
        'copy of the version the user has open, as accepted (or of `from`, e.g. "v2"). The user stays where they are; your next changes ' +
        'this turn (apply_ops, insert_recipe, fit_room) build the new version directly instead of proposing changes to the open one, until ' +
        'you call new_version again. Use it when the user asks for alternatives, options or several layouts: one call per alternative, ' +
        'each built in full before the next. name: 1–3 words for what differs ("L-shape", "8 ft island"); summary: one line about it.',
      input_schema: jsonSchema(z.object({ name: z.string().trim().min(1).max(40), summary: z.string().trim().max(200).optional(), from: z.string().optional() })),
    },
    {
      name: TOOL_ASK,
      description:
        'Asks the user clarifying questions in the chat. Use it before building when you are unsure about something that changes ' +
        'the result (overall size, style, which part they mean, how it goes together) and a wrong guess would cost them a redo. ' +
        'Put every question in one call, each with 2–4 short likely answers. Then end your turn: the answers arrive as the user\'s ' +
        'next message. Changes you already made this turn stay in the proposal.',
      input_schema: jsonSchema(AskInput),
    },
  ];
}

/**
 * MCP adds get_model: a Claude Code session has no app-built snapshot in its turns. ask_user is only for the in-app chat
 * (`chat`), where the questions show; an outside MCP client talks to its user itself.
 */
export function mcpToolDefs({ chat = false } = {}): Tool[] {
  return [
    {
      name: TOOL_GET_MODEL,
      description:
        'The current model as JSON (materials, the assembly/part tree with generator params, and each node\'s world bounds), plus ' +
        'whether a proposal is pending. If one is, the model shown includes it. Call this before changing anything.',
      input_schema: { type: 'object', properties: {} },
    },
    ...toolDefs().filter((t) => chat || t.name !== TOOL_ASK),
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
  /** Where new_version makes design alternatives; absent = the tool isn't available here. */
  versions?: VersionHost | undefined;
  /** The version new_version started: changes build it instead of `draft`. */
  building?: { id: string; label: string } | undefined;
}

/** The app's design versions, as new_version sees them. */
export interface VersionHost {
  /** Adds a version copied from the open one (or `from`); throws with a reason the AI can act on. */
  start(name: string, summary?: string, from?: string): { id: string; label: string };
  /** A version's doc as it is now; undefined once it's gone. */
  doc(id: string): Doc | undefined;
  /** Saves a version's doc. */
  save(id: string, doc: Doc): void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** One line for the chat log. */
  summary: string;
  /** ask_user: the questions for the chat to show. */
  questions?: Question[];
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
    ...(d.presentation?.views ?? []).map((v) => v.id),
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
  const view = d.presentation?.views.find((v) => v.id === id);
  if (view) return `${id} (view "${view.name}")`;
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
  const room = roomCheck(before, after);
  if (room.length) lines.push('Room check — fix these unless intended:', ...room.slice(0, 10).map((i) => `  ${i}`));
  const warnings = [
    ...(clash.length ? [`${clash.length} overlap warning${clash.length === 1 ? '' : 's'}`] : []),
    ...(opening.length ? [`${opening.length} opening warning${opening.length === 1 ? '' : 's'}`] : []),
    ...(room.length ? [`${room.length} room warning${room.length === 1 ? '' : 's'}`] : []),
  ];
  return {
    content: lines.join('\n'),
    isError: false,
    summary: `✓ ${ops.length} op${ops.length === 1 ? '' : 's'} applied${warnings.length ? ` (${warnings.join(', ')})` : ''}`,
  };
}

/** The rooms' issues after a change: all of them when a room changed, else the ones it caused. */
function roomCheck(before: Doc, after: Doc): string[] {
  try {
    const now = roomIssues(after);
    if (!now.length) return [];
    const changed = rooms(after).some((r) => JSON.stringify(before.assemblies[r.id]?.generator) !== JSON.stringify(r.generator));
    if (changed) return now;
    const was = new Set(roomIssues(before));
    return now.filter((i) => !was.has(i));
  } catch {
    return [];
  }
}

const FitRoomInput = z.object({
  margins: z.object({ left: z.number().optional(), right: z.number().optional(), back: z.number().optional(), front: z.number().optional() }).optional(),
  height: z.number().positive().optional(),
  walls: z.array(z.enum(ROOM_SIDES)).min(1).optional(),
  ceiling: z.boolean().optional(),
});

/** fit_room: a room around the model (roomAround), or the room refit to it (refitRoomOps), into the draft. */
function fitRoomTool(state: ToolState, input: unknown): ToolOutcome {
  const parsed = FitRoomInput.safeParse(normalizeLengths(input ?? {}));
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return fail(`Expected {"margins"?: {left?, right?, back?, front?}, "height"?, "walls"?: [...], "ceiling"?: boolean}. ${why}`, 'fit_room: bad input');
  }
  const { margins, height, walls, ceiling } = parsed.data;
  const opts: RoomFitOptions = {
    ...(margins && { margins: Object.fromEntries(Object.entries(margins).flatMap(([k, v]) => (v === undefined ? [] : [[k, Math.round(v)]]))) }),
    ...(height !== undefined && { height: Math.round(height) }),
    ...(walls && { walls }),
    ...(ceiling !== undefined && { ceiling }),
  };
  const before = state.draft;
  const existing = roomOf(before);
  let ops: Op[];
  let notes: string[] = [];
  if (existing) ({ ops, notes } = refitRoomOps(before, existing.id, opts));
  else {
    const id = entityKind(before, 'room') === null ? 'room' : undefined;
    ops = [{ op: 'add', entity: { kind: 'assembly', ...(id && { id }), name: 'Room', generator: { type: 'room', params: roomAround(before, opts).params } } }];
  }
  if (!ops.length) return { content: `The room ${existing!.id} already fits the model; nothing changed.`, isError: false, summary: 'room already fits' };
  const result = applyOps(before, ops);
  if (!result.ok) return fail(`Rejected — nothing changed. ${result.error}`, `fit_room rejected: ${result.error}`);
  const after = result.doc;
  state.draft = after;
  state.ops.push(...ops);
  const room = existing ? after.assemblies[existing.id]! : roomOf(after)!;
  const p = roomParams(room);
  const roomParts = Object.keys(after.parts).filter((id) => id.startsWith(`${room.id}.`));
  const lines = [
    `${existing ? 'Refit' : 'Made'} the room ${room.id} "${room.name}": inside ${formatInches(p.right - p.left)} wide (x ${p.left} to ${p.right}) × ` +
      `${formatInches(p.front - p.back)} deep (z ${p.back} to ${p.front}), ${formatInches(p.height)} high; walls: ${p.walls.join(', ') || 'none'}${p.ceiling ? '' : '; no ceiling'}.`,
    ...notes,
    ...(p.openings.length ? [`Openings: ${p.openings.map(openingText).join('; ')}`] : ['No openings yet.']),
    ...clashLines(after, overlaps(after, roomParts)),
    ...roomCheck(before, after).map((i) => `Room check: ${i}`),
    `Change it with apply_ops update {"id": "${room.id}", "patch": {"params": {...}}}; openings: send the whole list.`,
  ];
  return { content: lines.join('\n'), isError: false, summary: `✓ ${existing ? 'refit' : 'made'} the room` };
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
      lines.push(`${pad}${part.name} [${id}]${part.block ? ' (block)' : isDecor(part) ? ` (${decorInfo(part.shape.type)!.label.toLowerCase()})` : ''}`);
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

/** The chat shows the questions; the answers come back as the user's next message, so the turn should end here. */
function askTool(input: unknown): ToolOutcome {
  const r = AskInput.safeParse(input);
  if (!r.success) return { content: `Questions rejected: ${z.prettifyError(r.error)}`, isError: true, summary: '✗ questions rejected' };
  const n = r.data.questions.length;
  return {
    content: 'The questions are shown to the user. End your turn now, without more tool calls and without repeating the questions; their answers arrive as the next message.',
    isError: false,
    summary: `asked ${n} question${n === 1 ? '' : 's'}`,
    questions: r.data.questions,
  };
}

const NewVersionInput = z.object({ name: z.string().trim().min(1).max(40), summary: z.string().trim().max(200).optional(), from: z.string().optional() });

function newVersionTool(state: ToolState, input: unknown): ToolOutcome {
  if (!state.versions) return { content: 'Versions aren’t available here; make the change on the model.', isError: true, summary: '✗ versions unavailable' };
  const r = NewVersionInput.safeParse(input);
  if (!r.success) return { content: `Rejected: ${z.prettifyError(r.error)}`, isError: true, summary: '✗ new_version: bad input' };
  try {
    state.building = state.versions.start(r.data.name, r.data.summary, r.data.from);
  } catch (err) {
    return { content: `No version made: ${(err as Error).message}`, isError: true, summary: `✗ new version: ${(err as Error).message}` };
  }
  const { label } = state.building;
  return {
    content: `Started ${label}. It's a copy of ${r.data.from ?? 'the open version'}; your next changes build it, and the user can open it from its tab now. Build it in full, then start the next alternative with new_version.`,
    isError: false,
    summary: `Started version ${label}`,
  };
}

/**
 * Runs one AI tool. After new_version, tools work on that version's doc and save it there; the
 * open version's proposal (`draft` / `ops`) is left alone.
 */
export function runTool(state: ToolState, name: string, input: unknown): ToolOutcome {
  if (name === TOOL_NEW_VERSION) return newVersionTool(state, input);
  const b = state.building;
  const doc = b && state.versions?.doc(b.id);
  if (!b || !doc || name === TOOL_ASK) return runOn(state, name, input);
  const sub: ToolState = { draft: doc, ops: [], recipes: state.recipes };
  const out = runOn(sub, name, input);
  if (sub.ops.length) state.versions!.save(b.id, sub.draft);
  return { ...out, summary: `${b.label}: ${out.summary}` };
}

function runOn(state: ToolState, name: string, input: unknown): ToolOutcome {
  if (name === TOOL_APPLY) return applyTool(state, input);
  if (name === TOOL_INSPECT) return inspectTool(state, input);
  if (name === TOOL_CUT_LIST) return { content: cutListText(cutList(state.draft)), isError: false, summary: 'read the cut list' };
  if (name === TOOL_GET_RECIPE) return getRecipeTool(state, input);
  if (name === TOOL_INSERT_RECIPE) return insertRecipeTool(state, input);
  if (name === TOOL_FIT_ROOM) return fitRoomTool(state, input);
  if (name === TOOL_ASK) return askTool(input);
  return { content: `Unknown tool "${name}".`, isError: true, summary: `✗ unknown tool ${name}` };
}

