import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { cutList, cutListText } from '../model/cutlist';
import { applyOps, makeOpSchema, type Op } from '../model/ops';
import { Id, type Doc } from '../model/schema';
import { formatInches, parseInches } from '../model/units';
import { features, generators, shapes } from '../plugins';
import { buildPart } from '../plugins/pipeline';
import { boxSize, overlaps, worldBoxes, type Box3 } from '../model/world';

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

export function aiOpSchema() {
  return makeOpSchema({
    shape: refUnion(shapes.all(), false),
    feature: refUnion(features.all(), true),
    generator: refUnion(generators.all(), false),
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
        'Ops: add {entity, parent?, index?} (entity.kind part | block | assembly | joint | material; a block is a placeholder box: {kind: "block", name?, transform?, size: [x, y, z]}); update {id, patch} (part: name, material, ' +
        'grain, shape: {params} merged into the current params — a block takes only name and shape params; assembly: name, params merged into its generator params, which ' +
        'regenerates it; material: name, thickness, color, stock; joint: type, parts, params); delete {id} (assemblies take their ' +
        'children with them; deleting a generated part is remembered as an override); move {id, to? | by?, rotation?, parent?, index?} ' +
        '(parent: assembly id or null = top level); addFeature {part, feature}; updateFeature {part, feature: id, params (merged)}; ' +
        'removeFeature {part, feature: id}; bind {node, path, expr} binds a part / assembly field to a formula over variables ' +
        '(expr null unbinds; the value stays). Variables: add {entity: {kind: "variable", id, name, group, unit?, value}}; ' +
        'update {id, patch: {value | name | group}}; delete {id} (unbinds what used it). ' +
        'Notes: update {id: "n1", patch: {resolved: true}} marks a user note addressed.',
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
  ]);
}

function describeNode(d: Doc, id: string): string {
  const e = d.parts[id] ?? d.assemblies[id] ?? d.materials[id];
  if (e) return `${id} "${e.name}"`;
  const v = d.variables[id];
  if (v) return `variable ${id} (${v.group} › ${v.name})`;
  const j = d.joints[id];
  if (j) return `${id} (${j.type} joint)`;
  return d.annotations[id] ? `${id} (note)` : id;
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
  const created = [...nextIds].filter((id) => !prevIds.has(id) && !after.joints[id]);
  const removed = [...prevIds].filter((id) => !nextIds.has(id) && !before.joints[id]);
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
    const role = after.parts[id]?.role;
    if (role) generated.set(id.slice(0, -role.length - 1), [...(generated.get(id.slice(0, -role.length - 1)) ?? []), role]);
    else listed.push(describeNode(after, id));
  }
  if (listed.length) lines.push(`Created: ${listed.join(', ')}`);
  for (const [asm, roles] of generated) lines.push(`Generated in ${asm}: ${roles.join(', ')}`);
  if (removed.length) lines.push(`Removed: ${removed.map((id) => describeNode(before, id)).join(', ')}`);
  if (changedParts.length) lines.push(`Changed parts: ${changedParts.length > 12 ? `${changedParts.length} parts` : changedParts.join(', ')}`);
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
  if (clash.length) {
    lines.push(
      'Warning — these parts interpenetrate (their bounds overlap by the given depth); move or resize them unless intended:',
      ...clash.slice(0, 10).map((c) => `  ${describeNode(after, c.a)} × ${describeNode(after, c.b)}: ${c.depth.map(formatInches).join(' × ')}`),
    );
  }
  return {
    content: lines.join('\n'),
    isError: false,
    summary: `✓ ${ops.length} op${ops.length === 1 ? '' : 's'} applied${clash.length ? ` (${clash.length} overlap warning${clash.length === 1 ? '' : 's'})` : ''}`,
  };
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
  return { content: `Unknown tool "${name}".`, isError: true, summary: `✗ unknown tool ${name}` };
}

