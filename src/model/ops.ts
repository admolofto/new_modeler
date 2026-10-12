import { z } from 'zod';
import { features, generators, motions, PluginError, shapes } from '../plugins';
import { decorInfo, isDecor } from './decor';
import { descendants, entityKind, ModelError, nextFeatureId, nextId, parentIndex } from './doc';
import { swatchOf } from './finishes';
import { captureOverride, deleteGeneratedPart, generatedBase, generatedOwner, regenerate } from './generate';
import { syncJoints } from './joinery';
import { motionName, pruneMotions } from './motion';
import { Annotation, AnnotationTarget, Feature, Finish, Grain, Id, Joint, JointType, Lighting, LightingPreset, Material, Override, Params, Rotation, Variable, Vec3, ViewCamera, ViewFields, ViewFrame, ViewFrom, type Assembly, type Doc, type Part, type View } from './schema';
import { validateDoc } from './validate';
import { setBinding, syncBindings, unbindVariable } from './variables';
import { eulerXYZ, IDENTITY, mul, nodeAffine, toFrame, transpose } from './world';

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
 * A motion entity: what moves (`nodes`, siblings, the first one's frame first) and how (`type` +
 * `params`). The model passes an opaque type; the AI tool schema one option per motion plugin.
 */
export function motionEntity<T extends z.ZodType, P extends z.ZodType>(type: T, params: P) {
  return z.object({ kind: z.literal('motion'), id: Id.optional(), name: z.string().optional(), nodes: z.array(Id).min(1), type, params });
}
type MotionEntity = ReturnType<typeof motionEntity>;

/**
 * A decor entity (model/decor.ts): a room piece, prop or hardware — a decor shape, no material (its
 * looks are in its shape params). Default name: the shape's label.
 */
function decorEntity<D extends z.ZodType>(shape: D) {
  return z.object({
    kind: z.literal('decor'),
    id: Id.optional(),
    name: z.string().optional(),
    transform: TransformInput.default(identityInput),
    /** Texture direction (a floor's planks, a rug). */
    grain: Grain.default('none'),
    shape,
  });
}

/**
 * Builds the op schema around the given shape / feature / generator / motion / decor ref schemas.
 * The model uses opaque `{ type, params }` refs (the registry validates params); the AI tool schema
 * plugs in per-plugin unions so tool docs come straight from the registry (ai/tools.ts). Without a
 * `decor` ref (no decor shapes to offer) there's no decor entity.
 */
export function makeOpSchema<
  S extends z.ZodType,
  F extends z.ZodType,
  G extends z.ZodType,
  M extends MotionEntity | z.ZodDiscriminatedUnion<MotionEntity[]>,
  D extends z.ZodType,
>(refs: { shape: S; feature: F; generator: G; motion: M; decor?: D | undefined }) {
  const common = [
    z.object({
      kind: z.literal('part'),
      id: Id.optional(),
      name: z.string().default('Part'),
      material: Id,
      grain: Grain.default('none'),
      transform: TransformInput.default(identityInput),
      shape: refs.shape,
      features: z.array(refs.feature).default(() => []),
      finish: Finish.optional(),
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
      /** Saved per-role edits, including roles not currently produced by the generator. */
      overrides: z.record(z.string(), Override).optional(),
      finish: Finish.optional(),
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
    refs.motion,
    /** A presentation view (A9): a camera or a frame, what opens or hides, a caption. */
    ViewFields.extend({ kind: z.literal('view'), id: Id.optional() }),
  ] as const;
  const entity = refs.decor ? z.discriminatedUnion('kind', [...common, decorEntity(refs.decor)] as const) : z.discriminatedUnion('kind', common);

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
      /** Reparent: assembly id, or null for top level. Without parent, index reorders among siblings. */
      parent: Id.nullable().optional(),
      index: z.int().nonnegative().optional(),
      /** Reparent without moving in the world: the local transform and position formulas adapt. */
      keepWorld: z.boolean().optional(),
    }),
    z.object({ op: z.literal('addFeature'), part: Id, feature: refs.feature, index: z.int().nonnegative().optional() }),
    z.object({ op: z.literal('updateFeature'), part: Id, feature: Id, params: Params }),
    z.object({ op: z.literal('removeFeature'), part: Id, feature: Id }),
    /** Binds a part / assembly field to a formula over variables; null unbinds (the value stays). */
    z.object({ op: z.literal('bind'), node: Id, path: z.string().min(1), expr: z.union([z.string().min(1), z.number()]).nullable() }),
    /** Presentation settings (A9): `lighting` replaces the saved lighting whole, `eyeHeight` the walk height; null clears either. */
    z.object({ op: z.literal('setPresentation'), lighting: Lighting.nullable().optional(), eyeHeight: z.int().positive().nullable().optional() }),
  ]);
}

export const Op = makeOpSchema({
  shape: z.object({ type: z.string(), params: Params }),
  feature: FeatureInput,
  generator: z.object({ type: z.string(), params: Params }),
  motion: motionEntity(z.string().min(1), Params.default(() => ({}))),
  decor: z.object({ type: z.string(), params: Params }),
});
export type Op = z.input<typeof Op>;

/** `finish: null` clears a node's or material's finish (back to what it inherits or infers). */
const PartPatch = z.strictObject({
  hidden: z.boolean().optional(),
  unclickable: z.boolean().optional(),
  name: z.string().optional(),
  material: Id.optional(),
  grain: Grain.optional(),
  shape: z.strictObject({ type: z.string().optional(), params: Params.optional() }).optional(),
  finish: Finish.nullable().optional(),
});
const AssemblyPatch = z.strictObject({
  name: z.string().optional(),
  hidden: z.boolean().optional(),
  unclickable: z.boolean().optional(),
  params: Params.optional(),
  finish: Finish.nullable().optional(),
});
const MaterialPatch = Material.omit({ id: true }).partial().extend({ finish: Finish.nullable().optional() }).strict();
const JointPatch = Joint.pick({ type: true, parts: true, params: true }).partial().strict();
const AnnotationPatch = Annotation.omit({ id: true }).partial().strict();
const VariablePatch = Variable.omit({ id: true }).partial().strict();
/** `params` merge into the motion's; a null removes one (back to its default). A new `type` starts its params afresh. */
const MotionPatch = z.strictObject({
  name: z.string().nullable().optional(),
  type: z.string().min(1).optional(),
  params: Params.optional(),
  nodes: z.array(Id).min(1).optional(),
});
/**
 * A view's patch: null clears a field. `frame` merges into the view's frame (null clears azimuth /
 * elevation / distance); a view keeps a camera or a frame, so giving one replaces the other.
 */
const ViewPatch = z.strictObject({
  name: z.string().min(1).optional(),
  camera: ViewCamera.nullable().optional(),
  frame: z
    .strictObject({
      nodes: z.array(Id).optional(),
      from: ViewFrom.optional(),
      azimuth: z.number().nullable().optional(),
      elevation: z.number().min(-30).max(90).nullable().optional(),
      distance: z.int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  mode: z.enum(['orbit', 'walk']).nullable().optional(),
  open: z.array(Id).nullable().optional(),
  hide: z.array(Id).nullable().optional(),
  caption: z.string().max(400).nullable().optional(),
  lighting: LightingPreset.nullable().optional(),
});

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
      const decor = decorInfo(e.shape.type);
      if (decor) throw new ModelError(`"${e.shape.type}" is a decor shape (${decor.label.toLowerCase()}): add it with kind "decor" — decor has no material`);
      const id = claimId(d, e.id, 'p');
      const part: Part = {
        id,
        name: e.name,
        material: e.material,
        grain: e.grain,
        transform: e.transform,
        shape: { type: e.shape.type, params: shapes.parse(e.shape.type, e.shape.params) },
        features: [],
        ...(e.finish && { finish: e.finish }),
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
    case 'decor': {
      const decor = decorInfo(e.shape.type);
      if (!decor) throw new ModelError(`"${e.shape.type}" isn't a decor shape (room pieces, props, hardware); add stock parts with kind "part"`);
      const id = claimId(d, e.id, 'p');
      d.parts[id] = {
        id,
        name: e.name ?? numberedName(d, decor.label),
        grain: e.grain,
        transform: e.transform,
        shape: { type: e.shape.type, params: shapes.parse(e.shape.type, e.shape.params) },
        features: [],
      };
      attach(d, id, op.parent, op.index);
      return;
    }
    case 'assembly': {
      const id = claimId(d, e.id, 'a');
      if (e.overrides && !e.generator) throw new ModelError('assembly overrides require a generator');
      d.assemblies[id] = {
        id,
        name: e.name,
        transform: e.transform,
        children: [],
        ...(e.generator && {
          generator: { type: e.generator.type, params: generators.parse(e.generator.type, e.generator.params), overrides: structuredClone(e.overrides ?? {}) },
        }),
        ...(e.finish && { finish: e.finish }),
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
    case 'motion': {
      const id = claimId(d, e.id, 'mo');
      requireNodes(d, e.nodes);
      d.motions[id] = { id, ...(e.name && { name: e.name }), type: e.type, nodes: [...e.nodes], params: motions.parse(e.type, e.params) };
      return;
    }
    case 'view': {
      const id = claimId(d, e.id, 'view');
      const { kind: _kind, id: _id, ...fields } = e;
      const view: View = { id, ...fields };
      checkView(d, view);
      const p = (d.presentation ??= { views: [] });
      p.views.splice(Math.min(op.index ?? p.views.length, p.views.length), 0, view);
      return;
    }
  }
}

/** A view frames, opens and hides what exists, and has a camera or a frame (not both). */
function checkView(d: Doc, v: View): void {
  if (!!v.camera === !!v.frame) throw new ModelError(`view "${v.name}": ${v.camera ? 'give a camera or a frame, not both' : 'give it a camera or a frame'}`);
  const node = (id: string) => !!d.parts[id] || !!d.assemblies[id];
  for (const id of v.frame?.nodes ?? []) if (!node(id)) throw new ModelError(`view "${v.name}": no part or folder "${id}" to frame`);
  for (const id of v.open ?? []) if (!node(id) && !d.motions[id]) throw new ModelError(`view "${v.name}": no animation, part or folder "${id}" to open`);
  for (const id of v.hide ?? []) if (!node(id)) throw new ModelError(`view "${v.name}": no part or folder "${id}" to hide`);
}

const viewIndex = (d: Doc, id: string) => d.presentation?.views.findIndex((v) => v.id === id) ?? -1;

function updateView(d: Doc, id: string, rawPatch: Record<string, unknown>): void {
  const patch = parsePatch(ViewPatch, rawPatch);
  const views = d.presentation!.views;
  const i = viewIndex(d, id);
  const v: View = { ...views[i]! };
  const set = <K extends keyof View>(k: K, value: View[K] | null | undefined) => {
    if (value === null) delete v[k];
    else if (value !== undefined) v[k] = value;
  };
  if (patch.camera && patch.frame) throw new ModelError(`view "${v.name}": give a camera or a frame, not both`);
  if (patch.name !== undefined) v.name = patch.name;
  if (patch.camera) delete v.frame;
  set('camera', patch.camera);
  if (patch.frame === null) delete v.frame;
  else if (patch.frame) {
    const merged: Record<string, unknown> = { ...(v.frame ?? {}), ...patch.frame };
    for (const [k, x] of Object.entries(merged)) if (x === null) delete merged[k];
    v.frame = ViewFrame.parse(merged);
    delete v.camera;
  }
  set('mode', patch.mode);
  set('open', patch.open);
  set('hide', patch.hide);
  set('caption', patch.caption);
  set('lighting', patch.lighting);
  checkView(d, v);
  views[i] = v;
}

function moveView(d: Doc, op: Extract<z.output<typeof Op>, { op: 'move' }>): void {
  const views = d.presentation!.views;
  const v = views[viewIndex(d, op.id)]!;
  if (op.to || op.by || op.rotation || op.parent !== undefined || op.keepWorld) {
    throw new ModelError(`"${v.name}" is a presentation view: move {id, index} reorders the tour; change its camera or frame with update`);
  }
  if (op.index === undefined) throw new ModelError('move a view with an index (its place in the tour, 0 = first)');
  views.splice(views.indexOf(v), 1);
  views.splice(Math.min(op.index, views.length), 0, v);
}

/**
 * Keeps views in step with the model after a change: ids they open, hide or frame that are gone
 * drop out (an emptied open / hide list goes; a frame left with no nodes frames the whole model),
 * and a presentation left with nothing in it goes.
 */
export function prunePresentation(d: Doc): void {
  const p = d.presentation;
  if (!p) return;
  const node = (id: string) => !!d.parts[id] || !!d.assemblies[id];
  p.views = p.views.map((v) => {
    const open = v.open?.filter((id) => node(id) || !!d.motions[id]);
    const hide = v.hide?.filter(node);
    const nodes = v.frame?.nodes.filter(node);
    if (open?.length === v.open?.length && hide?.length === v.hide?.length && nodes?.length === v.frame?.nodes.length) return v;
    const out: View = { ...v };
    if (open?.length) out.open = open;
    else delete out.open;
    if (hide?.length) out.hide = hide;
    else delete out.hide;
    if (v.frame && nodes) out.frame = { ...v.frame, nodes };
    return out;
  });
  if (!p.views.length && !p.lighting && p.eyeHeight === undefined) delete d.presentation;
}

/** What a motion moves must exist when it's set (deleting it later just drops it from the motion). */
function requireNodes(d: Doc, ids: readonly string[]): void {
  for (const id of ids) if (!d.parts[id] && !d.assemblies[id]) throw new ModelError(`no part or folder "${id}" to animate`);
}

/** Generated motions come and go with their cabinet's params, like generated joints. */
function generatedMotion(d: Doc, id: string): ModelError | null {
  const m = d.motions[id]!;
  if (m.role === undefined) return null;
  const asm = generatedOwner(d, m.nodes[0]!);
  return new ModelError(`${motionName(d, m)}'s animation comes with "${asm?.name ?? 'its cabinet'}"; change its params instead`);
}

/** A new prop's default name: its label numbered past every node already named that way (`Bar stool 2`). */
export function numberedName(d: Doc, label: string): string {
  let max = 0;
  for (const node of [...Object.values(d.parts), ...Object.values(d.assemblies)]) {
    const rest = node.name.startsWith(`${label} `) ? node.name.slice(label.length + 1) : '';
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${label} ${max + 1}`;
}

/** `b3` → "Block 3"; other ids → "Block". */
export const blockName = (id: string) => `Block${/^b\d+$/.test(id) ? ` ${id.slice(1)}` : ''}`;

function update(d: Doc, id: string, rawPatch: Record<string, unknown>): void {
  switch (entityKind(d, id)) {
    case 'part': {
      const patch = parsePatch(PartPatch, rawPatch);
      const part = d.parts[id]!;
      if (part.block && (patch.material !== undefined || patch.grain !== undefined || patch.finish !== undefined || (patch.shape?.type ?? 'box') !== 'box')) {
        throw new ModelError(`"${part.name}" is a block (a placeholder): only its name and size change — build real parts in its place instead`);
      }
      const decor = isDecor(part);
      if (decor && (patch.material !== undefined || patch.finish !== undefined)) {
        throw new ModelError(`"${part.name}" is decor: it has no material or finish — its looks are in its shape params`);
      }
      const generated = generatedOwner(d, id) !== null;
      if (patch.name !== undefined) part.name = patch.name;
      if (patch.hidden !== undefined) part.hidden = patch.hidden;
      if (patch.unclickable !== undefined) part.unclickable = patch.unclickable;
      if (patch.material !== undefined) part.material = patch.material;
      if (patch.grain !== undefined) part.grain = patch.grain;
      if (patch.shape) {
        const type = patch.shape.type ?? part.shape.type;
        if (type !== part.shape.type && generated) throw new ModelError(`can't change the shape type of generated part "${part.name}"`);
        if (!!decorInfo(type) !== decor) throw new ModelError(`can't change "${part.name}" between a stock part and decor; delete it and add the other kind`);
        const params = type === part.shape.type ? { ...part.shape.params, ...patch.shape.params } : (patch.shape.params ?? {});
        part.shape = { type, params: shapes.parse(type, params) };
      }
      if (patch.finish === null) {
        // A generated part goes back to what its generator gives it.
        const base = generated ? generatedBase(d, id)?.finish : undefined;
        if (base) part.finish = structuredClone(base);
        else delete part.finish;
      } else if (patch.finish) part.finish = patch.finish;
      if (generated) captureOverride(d, id);
      return;
    }
    case 'assembly': {
      const patch = parsePatch(AssemblyPatch, rawPatch);
      const asm = d.assemblies[id]!;
      if (patch.name !== undefined) asm.name = patch.name;
      if (patch.hidden !== undefined) asm.hidden = patch.hidden;
      if (patch.unclickable !== undefined) asm.unclickable = patch.unclickable;
      if (patch.finish === null) delete asm.finish;
      else if (patch.finish) asm.finish = patch.finish;
      if (patch.params) {
        const owner = generatedOwner(d, id);
        if (owner) throw new ModelError(`"${asm.name}" is generated by "${owner.name}"; change that assembly's params instead`);
        if (!asm.generator) throw new ModelError(`assembly "${asm.name}" has no generator params`);
        asm.generator.params = generators.parse(asm.generator.type, { ...asm.generator.params, ...patch.params });
        regenerate(d, id);
      }
      captureOverride(d, id);
      return;
    }
    case 'material': {
      const { finish, ...patch } = parsePatch(MaterialPatch, rawPatch);
      const m = Object.assign(d.materials[id]!, patch);
      if (finish === null) delete m.finish;
      else if (finish) {
        m.finish = finish;
        // The editor draws a material in its color: a new finish brings its swatch along.
        if (patch.color === undefined) m.color = swatchOf(finish);
      }
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
    case 'motion': {
      const generated = generatedMotion(d, id);
      if (generated) throw generated;
      const patch = parsePatch(MotionPatch, rawPatch);
      const m = d.motions[id]!;
      const type = patch.type ?? m.type;
      const params: Record<string, unknown> = type === m.type ? { ...m.params, ...patch.params } : { ...patch.params };
      for (const [k, v] of Object.entries(params)) if (v === null) delete params[k];
      m.params = motions.parse(type, params);
      m.type = type;
      if (patch.nodes) {
        requireNodes(d, patch.nodes);
        m.nodes = [...patch.nodes];
      }
      if (patch.name === null || patch.name === '') delete m.name;
      else if (patch.name !== undefined) m.name = patch.name;
      return;
    }
    case 'view':
      return updateView(d, id, rawPatch);
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
      if (generatedOwner(d, id)) {
        d.assemblies[id]!.children = [];
        return deleteGeneratedPart(d, id);
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
    case 'motion': {
      const generated = generatedMotion(d, id);
      if (generated) throw generated;
      delete d.motions[id];
      return;
    }
    case 'view':
      d.presentation!.views.splice(viewIndex(d, id), 1);
      return;
    case null:
      throw new ModelError(`nothing with id "${id}"`);
  }
  for (const j of Object.values(d.joints)) {
    if (!d.parts[j.parts[0]] || !d.parts[j.parts[1]]) delete d.joints[j.id];
  }
}

/**
 * Keeps a node where it is in the world under a new parent: its new local transform, and its
 * position formulas offset to match. Formulas can only shift, so a bound position can't follow a
 * parent that is turned differently.
 */
function keepWorld(d: Doc, node: Part | Assembly, parent: string | null): void {
  const world = nodeAffine(d, node.id);
  const oldParent = parentIndex(d).get(node.id);
  const from = oldParent ? nodeAffine(d, oldParent) : IDENTITY;
  const to = parent ? nodeAffine(d, parent) : IDENTITY;
  const turned = from.m.some((row, i) => row.some((v, j) => Math.abs(v - to.m[i]![j]!) > 1e-9));
  const bound = ['x', 'y', 'z'].filter((axis) => node.bind?.[`position.${axis}`] !== undefined);
  if (turned && bound.length) {
    throw new ModelError(`can't keep "${node.name}" in place: its position is bound to a formula and the new parent is turned differently; unbind position.${bound[0]} first or keep its parent`);
  }
  const position = toFrame(to, world.t).map(Math.round) as Vec3;
  if (!turned) {
    const shift = position.map((v, i) => v - node.transform.position[i]!);
    for (const [i, axis] of ['x', 'y', 'z'].entries()) {
      const expr = node.bind?.[`position.${axis}`];
      if (expr !== undefined && shift[i]) node.bind![`position.${axis}`] = `(${expr}) + (${shift[i]})`;
    }
  }
  node.transform = { position, rotation: turned ? eulerXYZ(mul(transpose(to.m), world.m)) : node.transform.rotation };
}

function move(d: Doc, op: Extract<z.output<typeof Op>, { op: 'move' }>): void {
  if (entityKind(d, op.id) === 'view') return moveView(d, op);
  const node = d.parts[op.id] ?? d.assemblies[op.id];
  if (!node) throw new ModelError(`no part or assembly "${op.id}"`);
  const generated = generatedOwner(d, op.id) !== null;
  if (op.keepWorld) {
    if (op.parent === undefined) throw new ModelError('keepWorld applies when reparenting: give parent (an assembly id, or null for top level)');
    if (op.to || op.by || op.rotation) throw new ModelError("keepWorld keeps the world placement, so it can't be combined with to, by or rotation");
  }
  if (op.parent !== undefined) {
    if (generated) throw new ModelError(`can't reparent generated part "${node.name}"`);
    if (op.parent === op.id || (op.parent && descendants(d, op.id).includes(op.parent))) {
      throw new ModelError(`can't move "${node.name}" inside itself`);
    }
    if (op.parent && !d.assemblies[op.parent]) throw new ModelError(`no assembly "${op.parent}"`);
    if (op.keepWorld) keepWorld(d, node, op.parent);
    detach(d, op.id);
    attach(d, op.id, op.parent, op.index);
  } else if (op.index !== undefined) {
    if (generated) throw new ModelError(`can't reorder generated part "${node.name}"; its generator sets the order`);
    const parent = parentIndex(d).get(op.id) ?? null;
    detach(d, op.id);
    attach(d, op.id, parent, Math.min(op.index, (parent ? d.assemblies[parent]!.children : d.roots).length));
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
      if (isDecor(part)) throw new ModelError(`"${part.name}" is decor: it takes no features (holes, profiles, cuts)`);
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
    case 'setPresentation':
      return setPresentation(d, op);
  }
}

/** Saves presentation settings; a doc whose presentation holds nothing drops it (no empty `presentation: {views: []}`). */
function setPresentation(d: Doc, op: Extract<z.output<typeof Op>, { op: 'setPresentation' }>): void {
  const p = d.presentation ?? { views: [] };
  if (op.lighting === null) delete p.lighting;
  else if (op.lighting !== undefined) p.lighting = op.lighting;
  if (op.eyeHeight === null) delete p.eyeHeight;
  else if (op.eyeHeight !== undefined) p.eyeHeight = op.eyeHeight;
  if (!p.views.length && !p.lighting && p.eyeHeight === undefined) delete d.presentation;
  else d.presentation = p;
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
    pruneMotions(d);
    prunePresentation(d);
    syncJoints(d);
    validateDoc(d);
  } catch (err) {
    if (!(err instanceof ModelError || err instanceof PluginError)) throw err;
    return { ok: false, error: err.message, opIndex: ops.length - 1 };
  }
  return { ok: true, doc: d };
}
