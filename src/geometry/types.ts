/**
 * Intermediate geometry ("B-rep lite") passed through the shape → feature pipeline,
 * and the tagged triangle mesh it tessellates to. Pure data: no Three.js.
 * Coordinates are part-local model units (1/64"), origin at the part's min corner.
 */
export type V2 = [number, number];
export type V3 = [number, number, number];

/**
 * A planar face with optional hole loops. `(u, v)` is the face's 2D frame
 * (unit vectors, any handedness); `normal` is the outward direction the
 * tessellator orients triangles toward.
 */
export interface PlanarFace {
  tag: string;
  origin: V3;
  u: V3;
  v: V3;
  normal: V3;
  outer: V2[];
  /**
   * Exact 3D positions for `outer` (1:1), when the face shares boundary vertices
   * with neighbours whose positions weren't computed through this face's frame.
   */
  outer3?: V3[];
  holes: V2[][];
}

/** Pre-triangulated surface (e.g. a cylinder wall). Winding must face outward. */
export interface Patch {
  tag: string;
  positions: number[];
  normals: number[];
  indices: number[];
}

/** Material removed by a cut feature, kept so later cuts can refuse to collide with it. */
export interface Cut {
  featureId: string;
  /** Human noun for messages: `hole`, `pocket`. */
  noun: string;
  /** Rim on the entry face, part-local. */
  rim: V3[];
  /** Unit direction into the material. */
  dir: V3;
  depth: number;
  entryFace: string;
  /** Entry face's in-plane axes. */
  u: V3;
  v: V3;
  center: V3;
}

export interface Geom {
  faces: PlanarFace[];
  patches: Patch[];
  cuts: Cut[];
}

/**
 * Final mesh. `triTags[i]` indexes `tags` for triangle i, so a raycast hit's
 * faceIndex resolves to a semantic id like `face:top` or `f1:wall`.
 */
export interface TaggedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triTags: Uint16Array;
  tags: string[];
}

/** What dragging/clicking a handle edits; `edit/drives.ts` turns these into ops. */
export interface HandleDrive {
  /** `shape` or a feature id on the same part. */
  target: string;
  /** Dotted path into the target's params, e.g. `x`, `at.0`, `points.2.r`. */
  param: string;
  /** Human name for the inspector and drag label, e.g. `width`, `diameter`. */
  label?: string;
  /** Local drag axis for linear params; omitted for radial ones (e.g. diameter). */
  axis?: V3;
  /** Growing the param moves the part origin too (min-side faces): by `axis` × growth. */
  moveOrigin?: boolean;
}

/** A grabbable face / edge / vertex, referenced by the same semantic id as its triangles. */
export interface Handle {
  id: string;
  kind: 'face' | 'edge' | 'vertex';
  /** `shape` or the feature id that produced it. */
  source: string;
  /** face: [centroid]; edge: [a, b]; vertex: [p]. Part-local model units. */
  points: V3[];
  normal?: V3;
  drives: HandleDrive[];
}
