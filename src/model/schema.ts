import { z } from 'zod';

/**
 * Document schema. Lengths are integer 1/64" (see units.ts). Frame: X = width,
 * Y = height (up), Z = depth (front faces +Z). Every node's origin is its min corner;
 * transforms are relative to the parent assembly.
 *
 * Shape / feature / generator params are opaque records here; the plugin
 * registry validates them (see plugins/registry.ts).
 */
export const SCHEMA_VERSION = 5;

export const Id = z.string().regex(/^[A-Za-z0-9_\-.:]+$/, 'ids may only contain letters, digits and _ - . :');
export const Vec3 = z.tuple([z.int(), z.int(), z.int()]);
/** Degrees about X, Y, Z (applied in XYZ order, like three.js Euler 'XYZ'). Any angle. */
export const Rotation = z.tuple([z.number(), z.number(), z.number()]);
export const Params = z.record(z.string(), z.unknown());
/**
 * Field path → formula over variables (see model/variables.ts), e.g. `shape.x` → `(cabW - gap) / 2`.
 * Evaluated into the concrete field on every change, so the stored value is always current.
 */
export const Bindings = z.record(z.string(), z.string().min(1));

export const Transform = z.object({
  position: Vec3,
  rotation: Rotation,
});

export const Material = z.object({
  id: Id,
  name: z.string().min(1),
  /** Actual thickness, e.g. 3/4" ply = 23/32" = 46. */
  thickness: z.int().positive(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  stock: z.enum(['sheet', 'solid']),
  /** Sheet goods: sheet size [width, length]; default 48" × 96". Grain runs along the length. */
  sheet: z.tuple([z.int().positive(), z.int().positive()]).optional(),
  /** Solid wood: nominal (rough) thickness board feet are sold by, e.g. 4/4 = 1" = 64. Default: actual + 1/4". */
  nominal: z.int().positive().optional(),
  /** Price per sheet (sheet goods) or per board foot (solid), for the cost estimate. */
  price: z.number().nonnegative().optional(),
});

export const Shape = z.object({ type: z.string().min(1), params: Params });

export const Feature = z.object({ id: Id, type: z.string().min(1), params: Params });

/** A cut a joint makes in one of its parts (a dado joint → a dado in the housing part). Derived; see model/joinery.ts. */
export const JointCut = Feature.extend({ joint: Id });

export const Grain = z.enum(['x', 'y', 'z', 'none']);

export const Part = z.object({
  id: Id,
  name: z.string(),
  /** Hidden in the viewport, still part of the model and cut list. */
  hidden: z.boolean().optional(),
  /** Clicks in the viewport pass through it (still selectable from the tree). */
  unclickable: z.boolean().optional(),
  /** Every real part has one; blocks have none (the validator checks both). */
  material: Id.optional(),
  grain: Grain,
  transform: Transform,
  shape: Shape,
  features: z.array(Feature),
  /**
   * Cuts made by joints (dados, rabbets), kept apart from `features`: re-derived from the joints and
   * part positions at the end of every change, never edited directly. Absent when there are none.
   */
  joinery: z.array(JointCut).optional(),
  /** Set on parts produced by a generator: the role key its overrides are stored under. */
  role: z.string().optional(),
  bind: Bindings.optional(),
  /**
   * A blockout placeholder: a rough box the user sketched to stand in for something not built yet (a
   * cabinet, a run of them, an appliance, a wall). Box-shaped, no material, features or joints, and
   * never in the cut list. Its frame is the frame of what it stands for: local +Z is its front.
   */
  block: z.literal(true).optional(),
});

/** A user tweak to one generated part, re-applied on every regenerate. */
export const Override = z.object({
  deleted: z.literal(true).optional(),
  hidden: z.boolean().optional(),
  unclickable: z.boolean().optional(),
  name: z.string().optional(),
  material: Id.optional(),
  grain: Grain.optional(),
  /** Per-axis; null = follow the generator. */
  position: z.tuple([z.int().nullable(), z.int().nullable(), z.int().nullable()]).optional(),
  rotation: Rotation.optional(),
  /** Shape params that differ from the generator's. */
  shape: Params.optional(),
  /** Full feature list when it differs from the generator's (i.e. user-added features). */
  features: z.array(Feature).optional(),
});

export const GeneratorRef = z.object({
  type: z.string().min(1),
  params: Params,
  /** Keyed by part role. */
  overrides: z.record(z.string(), Override),
});

export const Assembly = z.object({
  id: Id,
  name: z.string(),
  /** Hides this folder and its descendants in the viewport. */
  hidden: z.boolean().optional(),
  /** Makes this folder and its descendants unclickable in the viewport. */
  unclickable: z.boolean().optional(),
  transform: Transform,
  /** Part and assembly ids, in order. */
  children: z.array(Id),
  generator: GeneratorRef.optional(),
  bind: Bindings.optional(),
});

export const JointType = z.enum(['butt', 'dado', 'rabbet', 'dowel', 'pocketScrew']);

/**
 * [housing / receiving part, inserted part]. Parts are modeled at their visible size, touching face
 * to face; dado and rabbet joints cut a channel `depth` deep into the housing where the inserted
 * part meets it, and the cut list adds `depth` to the inserted part (default: a third of the
 * housing's thickness, at most 1/4", for a dado; half of it for a rabbet).
 */
export const Joint = z.object({
  id: Id,
  type: JointType,
  parts: z.tuple([Id, Id]),
  params: z.object({ depth: z.int().positive().optional() }),
  role: z.string().optional(),
});

/**
 * What a note points at: a part or assembly, optionally one of its semantic handles
 * (`face:top`, `edge:top-front`, `f2:wall`…), and optionally the node-local point the user clicked.
 */
export const AnnotationTarget = z.object({
  node: Id,
  handle: z.string().optional(),
  at: Vec3.optional(),
});

/** A markup note pinned to the model. Targets may go stale (a part deleted); that isn't an error. */
export const Annotation = z.object({
  id: Id,
  note: z.string(),
  targets: z.array(AnnotationTarget).min(1),
  resolved: z.boolean(),
});

/** Formula names: letters, digits and _ (no function names, no `in`). */
export const VarId = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'variable ids must be letters, digits and _, not starting with a digit')
  .refine((id) => !['min', 'max', 'round', 'floor', 'ceil', 'in'].includes(id), 'variable id is a reserved word');

/**
 * A named value the user edits in the variables panel, grouped by component ("Doors": Door gap…).
 * Part and assembly fields bind to formulas over variables. Lengths are integer 1/64".
 */
export const Variable = z.object({
  id: VarId,
  name: z.string().min(1),
  group: z.string().min(1),
  unit: z.enum(['length', 'number']),
  value: z.number(),
});

export const Doc = z.object({
  version: z.literal(SCHEMA_VERSION),
  /** Plugin versions at save time; drives per-plugin param migrations on load. */
  pluginVersions: z.record(z.string(), z.int()),
  materials: z.record(z.string(), Material),
  parts: z.record(z.string(), Part),
  assemblies: z.record(z.string(), Assembly),
  joints: z.record(z.string(), Joint),
  annotations: z.record(z.string(), Annotation),
  variables: z.record(z.string(), Variable),
  /** Top-level node ids, in order. */
  roots: z.array(Id),
});

export type Vec3 = z.infer<typeof Vec3>;
export type Rotation = z.infer<typeof Rotation>;
export type Transform = z.infer<typeof Transform>;
export type Material = z.infer<typeof Material>;
export type Shape = z.infer<typeof Shape>;
export type Feature = z.infer<typeof Feature>;
export type JointCut = z.infer<typeof JointCut>;
export type Grain = z.infer<typeof Grain>;
export type Part = z.infer<typeof Part>;
export type Override = z.infer<typeof Override>;
export type GeneratorRef = z.infer<typeof GeneratorRef>;
export type Assembly = z.infer<typeof Assembly>;
export type JointType = z.infer<typeof JointType>;
export type Joint = z.infer<typeof Joint>;
export type AnnotationTarget = z.infer<typeof AnnotationTarget>;
export type Annotation = z.infer<typeof Annotation>;
export type Variable = z.infer<typeof Variable>;
export type Bindings = z.infer<typeof Bindings>;
export type Doc = z.infer<typeof Doc>;

export function identity(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0] };
}
