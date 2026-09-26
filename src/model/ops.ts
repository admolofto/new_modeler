import { z } from 'zod';
import { features, generators, PluginError, shapes } from '../plugins';
import { descendants, entityKind, ModelError, nextFeatureId, nextId, parentIndex } from './doc';
import { captureOverride, deleteGeneratedPart, generatedOwner, regenerate } from './generate';
import { syncJoints } from './joinery';
import { Annotation, AnnotationTarget, Feature, Grain, Id, Joint, JointType, Material, Params, Rotation, Variable, Vec3, type Doc, type Part } from './schema';
import { validateDoc } from './validate';
import { setBinding, syncBindings, unbindVariable } from './variables';

/**
 * The one mutation path (ROADMAP rule 2). UI, AI, markup and direct drags all
 * produce these ops; `applyOps` is atomic — a batch either fully applies and
 * validates, or the doc is untouched and the error names the failing op.
 */

const zero = (): [number, number, number] => [0, 0, 0];
const TransformInput = z.object({ position: Vec3.default(zero), rotation: Rotation.default(zero) });
const identityInput = () => ({ position: zero(), rotation: zero() });
const FeatureInput = Feature.extend({ id: Id.optional() });
const Size = z.tuple([z.int().positive(), z.int().positive(), z.int().positive()]);

/**
 * Builds the op schema around the given shape / feature / generator ref schemas. The model
 * uses opaque `{ type, params }` refs (the registry validates params); the AI tool schema
 * plugs in per-plugin unions so tool docs come straight from the registry (ai/tools.ts).
 */
export function makeOpSchema<S extends z.ZodType, F extends z.ZodType, G extends z.ZodType>(refs: { shape: S; feature: F; generator: G }) {
  const entity = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('part'),
      id: Id.optional(),
      name: z.string().default('Part'),
      material: Id,
      grain: Grain.default('none'),
      transform: TransformInput.default(identityInput),
      shape: refs.shape,
      features: z.array(refs.feature).default(() => []),
    }),
    /** A blockout placeholder (schema.ts `Part.block`): a box of `size` [x, y, z], no material. */
    z.object({
      kind: z.literal('block'),
      id: Id.optional(),
      name: z.string().optional(),
      transform: TransformInput.default(identityInput),
      size: Size,
    }),
    z.object({
      kind: z.literal('assembly'),
      id: Id.optional(),
      name: z.string().default('Assembly'),
      transform: TransformInput.default(identityInput),
      generator: refs.generator.optional(),
    }),
    z.object({
      kind: z.literal('joint'),
      id: Id.optional(),
      type: JointType,
      parts: z.tuple([Id, Id]),
      params: Joint.shape.params.default(() => ({})),
    }),
    Material.extend({ kind: z.literal('material'), id: Id.optional(), stock: Material.shape.stock.default('sheet') }),
    z.object({
      kind: z.literal('annotation'),
      id: Id.optional(),
      note: z.string(),
      targets: z.array(AnnotationTarget).min(1),
      resolved: z.boolean().default(false),
    }),
    Variable.extend({ kind: z.literal('variable'), unit: Variable.shape.unit.default('length') }),
  ]);

  return z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), entity, parent: Id.nullable().optional(), index: z.int().nonnegative().optional() }),
    z.object({ op: z.literal('update'), id: Id, patch: Params }),
    z.object({ op: z.literal('delete'), id: Id }),
    z.object({
      op: z.literal('move'),
      id: Id,
      to: Vec3.optional(),
      by: Vec3.optional(),
      rotation: Rotation.optional(),
      /** Reparent: assembly id, or null for top level. */
      parent: Id.nullable().optional(),
      index: z.int().nonnegative().optional(),
    }),
    z.object({ op: z.literal('addFeature'), part: Id, feature: refs.feature, index: z.int().nonnegative().optional() }),
    z.object({ op: z.literal('updateFeature'), part: Id, feature: Id, params: Params }),
    z.object({ op: z.literal('removeFeature'), part: Id, feature: Id }),
    /** Binds a part / assembly field to a formula over variables; null unbinds (the value stays). */
    z.object({ op: z.literal('bind'), node: Id, path: z.string().min(1), expr: z.union([z.string().min(1), z.number()]).nullable() }),
  ]);
}

export const Op = makeOpSchema({
  shape: z.object({ type: z.string(), params: Params }),
  feature: FeatureInput,
  generator: z.object({ type: z.string(), params: Params }),
});
export type Op = z.input<typeof Op>;

const PartPatch = z.strictObject({
  name: z.string().optional(),
  material: Id.optional(),
  grain: Grain.optional(),
  shape: z.strictObject({ type: z.string().optional(), params: Params.optional() }).optional(),
});
const AssemblyPatch = z.strictObject({ name: z.string().optional(), params: Params.optional() });
const MaterialPatch = Material.omit({ id: true }).partial().strict();
const JointPatch = Joint.pick({ type: true, parts: true, params: true }).partial().strict();
const AnnotationPatch = Annotation.omit({ id: true }).partial().strict();
const VariablePatch = Variable.omit({ id: true }).partial().strict();

/** Length variables hold whole 1/64ths like every other length. */
const roundLength = (v: { unit: string; value: number }) => (v.unit === 'length' ? Math.round(v.value) : v.value);

export type OpResult = { ok: true; doc: Doc } | { ok: false; error: string; opIndex: number };

function parsePatch<T>(schema: z.ZodType<T>, patch: unknown): T {
  const r = schema.safeParse(patch);
  if (!r.success) throw new ModelError(`invalid patch — ${r.error.issues.map((i) => `${i.path.join('.') || '(patch)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

function requirePart(d: Doc, id: string): Part {
  const part = d.parts[id];
  if (!part) throw new ModelError(`no part "${id}"`);
  return part;
}

function noFeature(part: Part, id: string): ModelError {
  const cut = part.joinery?.find((j) => j.id === id);
  if (cut) return new ModelError(`${id} on "${part.name}" is cut by joint ${cut.joint}; change or delete the joint instead`);
  return new ModelError(`part "${part.name}" has no feature ${id}`);
}

function attach(d: Doc, id: string, parent: string | null | undefined, index: number | undefined): void {
  let list = d.roots;
  if (parent) {
    const asm = d.assemblies[parent];
    if (!asm) throw new ModelError(`no assembly "${parent}"`);
    list = asm.children;
  }
  list.splice(index ?? list.length, 0, id);
}

function detach(d: Doc, id: string): void {
  const parent = parentIndex(d).get(id);
  const list = parent ? d.assemblies[parent]!.children : d.roots;
  list.splice(list.indexOf(id), 1);
}

function claimId(d: Doc, id: string | undefined, prefix: string): string {
  if (id === undefined) return nextId(d, prefix);
  if (entityKind(d, id) !== null) throw new ModelError(`id "${id}" is already in use`);
  return id;
}

function add(d: Doc, op: Extract<z.output<typeof Op>, { op: 'add' }>): void {
  const e = op.entity;
  switch (e.kind) {
    case 'part': {
      const id = claimId(d, e.id, 'p');
      const part: Part = {
        id,
        name: e.name,
        material: e.material,
        grain: e.grain,
        transform: e.transform,
        shape: { type: e.shape.type, params: shapes.parse(e.shape.type, e.shape.params) },
        features: [],
      };
      for (const f of e.features) {
        part.features.push({ id: f.id ?? nextFeatureId(part), type: f.type, params: features.parse(f.type, f.params) });
      }
      d.parts[id] = part;
      attach(d, id, op.parent, op.index);
      return;
    }
    case 'block': {
      const id = claimId(d, e.id, 'b');
      const [x, y, z] = e.size;
      d.parts[id] = {
        id,
        name: e.name ?? blockName(id),
        grain: 'none',
        transform: e.transform,
        shape: { type: 'box', params: { x, y, z } },
        features: [],
        block: true,
      };
      attach(d, id, op.parent, op.index);
      return;
    }
    case 'assembly': {
      const id = claimId(d, e.id, 'a');
      d.assemblies[id] = {
        id,
        name: e.name,
        transform: e.transform,
        children: [],
        ...(e.generator && {
          generator: { type: e.generator.type, params: generators.parse(e.generator.type, e.generator.params), overrides: {} },
        }),
      };
      attach(d, id, op.parent, op.index);
      if (e.generator) regenerate(d, id);
      return;
    }
    case 'joint': {
      const id = claimId(d, e.id, 'j');
      d.joints[id] = { id, type: e.type, parts: e.parts, params: e.params };
      return;
    }
    case 'material': {
      const id = claimId(d, e.id, 'm');
      const { kind: _kind, id: _id, ...fields } = e;
      d.materials[id] = { id, ...fields };
      return;
    }
    case 'annotation': {
      const id = claimId(d, e.id, 'n');
      d.annotations[id] = { id, note: e.note, targets: e.targets, resolved: e.resolved };
      return;
    }
    case 'variable': {
      const id = claimId(d, e.id, 'v');
      d.variables[id] = { id, name: e.name, group: e.group, unit: e.unit, value: roundLength(e) };
      return;
    }
  }
}

/** `b3` → "Block 3"; other ids → "Block". */
export const blockName = (id: string) => `Block${/^b\d+$/.test(id) ? ` ${id.slice(1)}` : ''}`;

function update(d: Doc, id: string, rawPatch: Record<string, unknown>): void {
  switch (entityKind(d, id)) {
    case 'part': {
      const patch = parsePatch(PartPatch, rawPatch);
      const part = d.parts[id]!;
      if (part.block && (patch.material !== undefined || patch.grain !== undefined || (patch.shape?.type ?? 'box') !== 'box')) {
        throw new ModelError(`"${part.name}" is a block (a placeholder): only its name and size change — build real parts in its place instead`);
      }
      const generated = generatedOwner(d, id) !== null;
      if (patch.name !== undefined) part.name = patch.name;
      if (patch.material !== undefined) part.material = patch.material;
      if (patch.grain !== undefined) part.grain = patch.grain;
      if (patch.shape) {
        const type = patch.shape.type ?? part.shape.type;
        if (type !== part.shape.type && generated) throw new ModelError(`can't change the shape type of generated part "${part.name}"`);
        const params = type === part.shape.type ? { ...part.shape.params, ...patch.shape.params } : (patch.shape.params ?? {});
        part.shape = { type, params: shapes.parse(type, params) };
      }
      if (generated) captureOverride(d, id);
      return;
    }
    case 'assembly': {
      const patch = parsePatch(AssemblyPatch, rawPatch);
      const asm = d.assemblies[id]!;
      if (patch.name !== undefined) asm.name = patch.name;
      if (patch.params) {
        if (!asm.generator) throw new ModelError(`assembly "${asm.name}" has no generator params`);
        asm.generator.params = generators.parse(asm.generator.type, { ...asm.generator.params, ...patch.params });
        regenerate(d, id);
      }
      return;
    }
    case 'material': {
      const patch = parsePatch(MaterialPatch, rawPatch);
      Object.assign(d.materials[id]!, patch);
      // Generated parts size themselves from material thickness.
      for (const asm of Object.values(d.assemblies)) {
        if (asm.generator && generators.get(asm.generator.type).materialRefs(asm.generator.params).includes(id)) regenerate(d, asm.id);
      }
      return;
    }
    case 'joint': {
      const joint = d.joints[id]!;
      if (joint.role !== undefined) throw new ModelError(`joint ${id} is generated; change its assembly's params instead`);
      Object.assign(joint, parsePatch(JointPatch, rawPatch));
      return;
    }
    case 'annotation':
      Object.assign(d.annotations[id]!, parsePatch(AnnotationPatch, rawPatch));
      return;
    case 'variable': {
      const v = Object.assign(d.variables[id]!, parsePatch(VariablePatch, rawPatch));
      v.value = roundLength(v);
      return;
    }
    case null:
      throw new ModelError(`nothing with id "${id}"`);
  }
}

function remove(d: Doc, id: string): void {
  switch (entityKind(d, id)) {
    case 'part':
      if (generatedOwner(d, id)) return deleteGeneratedPart(d, id);
      detach(d, id);
      delete d.parts[id];
      break;
    case 'assembly':
      for (const c of descendants(d, id)) {
        delete d.parts[c];
        delete d.assemblies[c];
      }
      detach(d, id);
      delete d.assemblies[id];
      break;
    case 'joint':
      if (d.joints[id]!.role !== undefined) throw new ModelError(`joint ${id} is generated; change its assembly's params instead`);
      delete d.joints[id];
      return;
    case 'material': {
      const users = Object.values(d.parts).filter((p) => p.material === id).length;
      const gens = Object.values(d.assemblies).filter(
        (a) => a.generator && generators.get(a.generator.type).materialRefs(a.generator.params).includes(id),
      ).length;
      if (users || gens) throw new ModelError(`material "${d.materials[id]!.name}" is used by ${users} parts and ${gens} generators`);
      delete d.materials[id];
      return;
    }
    case 'annotation':
      delete d.annotations[id];
      return;
    case 'variable':
      unbindVariable(d, id);
      delete d.variables[id];
      return;
    case null:
      throw new ModelError(`nothing with id "${id}"`);
  }
  for (const j of Object.values(d.joints)) {
    if (!d.parts[j.parts[0]] || !d.parts[j.parts[1]]) delete d.joints[j.id];
  }
}

function move(d: Doc, op: Extract<z.output<typeof Op>, { op: 'move' }>): void {
  const node = d.parts[op.id] ?? d.assemblies[op.id];
  if (!node) throw new ModelError(`no part or assembly "${op.id}"`);
  const generated = generatedOwner(d, op.id) !== null;
  if (op.parent !== undefined) {
    if (generated) throw new ModelError(`can't reparent generated part "${node.name}"`);
    if (op.parent === op.id || (op.parent && descendants(d, op.id).includes(op.parent))) {
      throw new ModelError(`can't move "${node.name}" inside itself`);
    }
    detach(d, op.id);
    attach(d, op.id, op.parent, op.index);
  }
  if (op.to) node.transform.position = [...op.to];
  if (op.by) node.transform.position = node.transform.position.map((c, i) => c + op.by![i]!) as typeof op.by;
  if (op.rotation) node.transform.rotation = [...op.rotation];
  if (generated) captureOverride(d, op.id);
}

function applyOne(d: Doc, op: z.output<typeof Op>): void {
  switch (op.op) {
    case 'add':
      return add(d, op);
    case 'update':
      return update(d, op.id, op.patch);
    case 'delete':
      return remove(d, op.id);
    case 'move':
      return move(d, op);
    case 'addFeature': {
      const part = requirePart(d, op.part);
      const id = op.feature.id ?? nextFeatureId(part);
      if (part.features.some((f) => f.id === id)) throw new ModelError(`part "${part.name}" already has feature ${id}`);
      const params = features.parse(op.feature.type, op.feature.params);
      part.features.splice(op.index ?? part.features.length, 0, { id, type: op.feature.type, params });
      return captureOverride(d, part.id);
    }
    case 'updateFeature': {
      const part = requirePart(d, op.part);
      const f = part.features.find((x) => x.id === op.feature);
      if (!f) throw noFeature(part, op.feature);
      f.params = features.parse(f.type, { ...f.params, ...op.params });
      return captureOverride(d, part.id);
    }
    case 'removeFeature': {
      const part = requirePart(d, op.part);
      const i = part.features.findIndex((x) => x.id === op.feature);
      if (i < 0) throw noFeature(part, op.feature);
      part.features.splice(i, 1);
      for (const path of Object.keys(part.bind ?? {})) if (path.startsWith(`features.${op.feature}.`)) setBinding(d, part.id, path, null);
      return captureOverride(d, part.id);
    }
    case 'bind':
      return setBinding(d, op.node, op.path, op.expr === null ? null : String(op.expr));
  }
}

export function applyOps(doc: Doc, ops: readonly Op[]): OpResult {
  const d = structuredClone(doc);
  for (let i = 0; i < ops.length; i++) {
    const parsed = Op.safeParse(ops[i]);
    try {
      if (!parsed.success) {
        throw new ModelError(parsed.error.issues.map((x) => `${x.path.join('.') || '(op)'}: ${x.message}`).join('; '));
      }
      applyOne(d, parsed.data);
    } catch (err) {
      if (!(err instanceof ModelError || err instanceof PluginError)) throw err;
      const name = parsed.success ? parsed.data.op : 'invalid op';
      return { ok: false, error: `op ${i + 1} (${name}): ${err.message}`, opIndex: i };
    }
  }
  try {
    syncBindings(doc, d);
    syncJoints(d);
    validateDoc(d);
  } catch (err) {
    if (!(err instanceof ModelError || err instanceof PluginError)) throw err;
    return { ok: false, error: err.message, opIndex: ops.length - 1 };
  }
  return { ok: true, doc: d };
}
