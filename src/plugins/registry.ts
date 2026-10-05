import type { z } from 'zod';
import type { Prism } from '../geometry/prism';
import type { Geom, Handle, V2, V3 } from '../geometry/types';
import type { Feature, JointType, Material, Part, Rotation, Shape, Vec3 } from '../model/schema';
import type { Affine, Box3 } from '../model/world';

/**
 * Plugin contract (ROADMAP "Plugin contract"). Shapes, features and generators
 * register here; the model validates params through `schema`, the pipeline builds
 * geometry through `build` / `apply`, and Phase 2 generates AI tool docs from
 * `describe` + `schema`. Plugins are pure: no Three.js, no DOM.
 */

interface PluginBase<P> {
  type: string;
  /** Bump when params change shape; implement `migrate` to upgrade older saves. */
  version: number;
  schema: z.ZodType<P>;
  /** AI-facing documentation. */
  describe: string;
  migrate?(old: Record<string, unknown>, fromVersion: number): Record<string, unknown>;
}

/** 2.5D shapes return a prism (edge profiles can reshape it); others return finished geometry. */
export type ShapeOutput = { prism: Prism } | { geom: Geom };

/**
 * A square-bottomed channel into a flat face that may run off the face's edges: a dado, groove
 * or rabbet. `from` / `to` are opposite corners of its footprint in the face's (u, v) frame.
 */
export interface ChannelSpec {
  featureId: string;
  face: string;
  from: V2;
  to: V2;
  depth: number;
  /** For messages, e.g. `dado f1`. */
  label: string;
}

export interface ShapeDef<P = unknown> extends PluginBase<P> {
  /** Throws GeometryError / PluginError when the params don't make a valid solid. */
  build(params: P): ShapeOutput;
  /** Builds the shape with channels cut in (instead of `build`). Shapes without it refuse channels. */
  buildChanneled?(params: P, channels: ChannelSpec[], partName: string): Geom;
  handles(params: P): Handle[];
  /**
   * Re-bases edited params so the part origin stays at its min corner (e.g. an outline point
   * dragged below 0). `offset` = where the old origin's frame moves the origin to, part-local.
   * null = nothing to do.
   */
  normalize?(params: P): { params: P; offset: V3 } | null;
}

export interface FeatureContext {
  part: Part;
  featureId: string;
}

/**
 * Features run in stages, each in list order: every `channel` (the shape builds with them cut in —
 * dados, rabbets), or else every `profile` (edits the prism before it's faceted — edge profiles);
 * then every `cut` (edits faceted geometry — holes, pockets). Channels and profiles don't mix on
 * one part yet. All throw GeometryError / PluginError when the feature doesn't fit; the doc
 * validator builds every part, so a doc that validates always builds.
 */
export interface FeatureDef<P = unknown> extends PluginBase<P> {
  /** null if the feature can go on this shape, otherwise the reason it can't. */
  appliesTo(shape: Shape): string | null;
  /** Checks on params alone. null = ok. Geometric checks happen while building. */
  validate?(params: P, ctx: FeatureContext): string | null;
  channel?(params: P, ctx: FeatureContext): ChannelSpec;
  profile?(prism: Prism, params: P, ctx: FeatureContext): void;
  /** Adds geometry tagged `${featureId}:…`. */
  cut?(geom: Geom, params: P, ctx: FeatureContext): void;
  /** Called on the finished geometry. */
  handles(params: P, ctx: FeatureContext & { geom: Geom }): Handle[];
}

/** A part as emitted by a generator, before ids and overrides are applied. */
export interface GenPart {
  role: string;
  name: string;
  material: string;
  grain: Part['grain'];
  position: Vec3;
  rotation?: Rotation;
  shape: Shape;
  features?: Feature[];
  /** Role of the generated folder it goes in (one of the output's `groups`); none = directly in the assembly. */
  group?: string;
}

/** A folder grouping a component's generated parts ("Drawer 1"); it sits at the assembly's origin. */
export interface GenGroup {
  role: string;
  name: string;
}

export interface GenJoint {
  role: string;
  type: JointType;
  /** Part roles. */
  parts: [string, string];
  params: { depth?: number };
}

/** A motion as emitted by a generator: part roles that move together, the first one's frame first. */
export interface GenMotion {
  role: string;
  name: string;
  type: string;
  /** Part roles, all in the same group (or none). */
  parts: string[];
  params: Record<string, unknown>;
}

export interface GenOutput {
  parts: GenPart[];
  groups?: GenGroup[];
  joints: GenJoint[];
  motions?: GenMotion[];
}

export interface GeneratorContext {
  materials: Record<string, Material>;
}

/** A face of a generated part, in the assembly's frame. */
export interface GenFace {
  role: string;
  /** Axis the face is perpendicular to, and whether it faces +axis. */
  axis: 0 | 1 | 2;
  max: boolean;
  /** Assembly-local coordinate of the face plane along `axis`. */
  plane: number;
}

/** Which generator param a face push/pull drives. Growth is measured along the face's outward normal. */
export interface GenFaceDrive {
  /** Dotted path into the generator params, e.g. `width`, `toeKick.depth`. */
  param: string;
  label: string;
  /** -1: pulling the face outward shrinks the param. */
  sign: 1 | -1;
  /** Growing also moves the assembly origin outward (min-side faces), so the far side stays put. */
  moveOrigin?: boolean;
}

export interface GeneratorDef<P = unknown> extends PluginBase<P> {
  generate(params: P, ctx: GeneratorContext): GenOutput;
  /**
   * Handles for generated parts (ROADMAP rule 12): pushing/pulling this face edits a generator
   * param instead of overriding the part. null = the part's own handle applies (as an override).
   */
  faceDrive?(params: P, face: GenFace): GenFaceDrive | null;
  /** Material ids the params reference (regenerate when one changes; block deleting them). */
  materialRefs(params: P): string[];
}

/**
 * Where a motion's parts sit in its frame (the first node's local frame, front = +Z): each part's
 * box and their union, in model units.
 */
export interface MotionBasis {
  box: Box3;
  parts: Box3[];
}

/**
 * How something opens: a hinge, a slide… `pose` is the rigid move at `t` (0 closed … 1 open) in the
 * motion's frame, worked out from where its parts sit, so the AI and the user only pick a side or a
 * direction and resizing keeps it right.
 */
export interface MotionDef<P = unknown> extends PluginBase<P> {
  /** Named starting points for the UI ("Door — hinges left"), filled in over the defaults. */
  presets: { label: string; params: Partial<P> }[];
  /** A few words for lists, diffs and the AI: "hinges left, opens 105°". */
  summary(params: P): string;
  /** Seconds a full open takes. */
  seconds(params: P): number;
  /** How far it goes, all the way open: degrees it turns, or a length it travels. */
  reach(params: P, basis: MotionBasis): { value: number; unit: 'deg' | 'length' };
  /** Throws PluginError when these parts can't move this way. */
  pose(params: P, basis: MotionBasis, t: number): Affine;
}

export class PluginError extends Error {}

type AnyDef = ShapeDef | FeatureDef | GeneratorDef | MotionDef;

class Registry<D extends AnyDef> {
  private defs = new Map<string, D>();
  constructor(readonly kind: string) {}

  register(def: D): void {
    if (this.defs.has(def.type)) throw new PluginError(`${this.kind} "${def.type}" is already registered`);
    this.defs.set(def.type, def);
  }

  get(type: string): D {
    const def = this.defs.get(type);
    if (!def) throw new PluginError(`unknown ${this.kind} type "${type}" (known: ${[...this.defs.keys()].join(', ')})`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  all(): D[] {
    return [...this.defs.values()];
  }

  /** Validates + normalizes params (fills defaults). Throws PluginError with a readable message. */
  parse(type: string, params: unknown): Record<string, unknown> {
    const result = this.get(type).schema.safeParse(params);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`);
      throw new PluginError(`invalid ${type} params — ${issues.join('; ')}`);
    }
    return result.data as Record<string, unknown>;
  }
}

export const shapes = new Registry<ShapeDef>('shape');
export const features = new Registry<FeatureDef>('feature');
export const generators = new Registry<GeneratorDef>('generator');
export const motions = new Registry<MotionDef>('motion');

/** Registers a typed def (params are validated before any plugin method is called). */
export function registerShape<P>(def: ShapeDef<P>): void {
  shapes.register(def as unknown as ShapeDef);
}
export function registerFeature<P>(def: FeatureDef<P>): void {
  features.register(def as unknown as FeatureDef);
}
export function registerGenerator<P>(def: GeneratorDef<P>): void {
  generators.register(def as unknown as GeneratorDef);
}
export function registerMotion<P>(def: MotionDef<P>): void {
  motions.register(def as unknown as MotionDef);
}

/** Current version of every registered plugin (`shape:box`, `feature:hole`…), recorded in saved files. */
export function pluginVersions(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reg of [shapes, features, generators, motions] as Registry<AnyDef>[]) {
    for (const def of reg.all()) out[`${reg.kind}:${def.type}`] = def.version;
  }
  return out;
}
