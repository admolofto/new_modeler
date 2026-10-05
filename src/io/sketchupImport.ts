import { CAP_AXES } from '../plugins/shapes/box';
import { signedArea } from '../geometry/polygon';
import type { V2, V3 } from '../geometry/types';
import { emptyDoc } from '../model/defaults';
import { entityKind, ModelError } from '../model/doc';
import { MATERIAL_LIBRARY } from '../model/materialLibrary';
import { applyOps, type Op } from '../model/ops';
import type { Doc, Grain, Material } from '../model/schema';
import { formatInches, UNITS_PER_INCH } from '../model/units';
import { apply, eulerXYZ, mul, rotate, transpose, union, worldBoxes, type Affine, type Mat3 } from '../model/world';
import { BLOCKOUT_MATERIAL, type ColladaMaterial, type ColladaNode, type ColladaScene } from './collada';

/**
 * SketchUp model (read from .dae) → editable parts. Each group or component with its own faces
 * becomes one part per connected solid:
 *  - a straight extrusion (caps plus walls square to them) whose outline is a rectangle → box part;
 *  - any other straight extrusion → outline part (notches, angled ends, curves as facets);
 *  - anything else (moldings, hardware, appliances) → blockout of its bounds.
 * Holes and pockets inside an extrusion are dropped (counted as simplified). Groups that hold
 * other groups become assemblies. Thickness picks the material: a same-named material in the
 * model, else any model or library material that thick, else a new one.
 */

export interface ImportSummary {
  boxes: number;
  outlines: number;
  blocks: number;
  /** Parts whose holes or pockets were left out. */
  simplified: number;
  /** Flat faces and stray geometry with no thickness. */
  skipped: number;
  materialsAdded: string[];
}

export interface SketchUpImport {
  ops: Op[];
  doc: Doc;
  wrapperId: string;
  summary: ImportSummary;
}

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));
const column = (m: Mat3, j: number): V3 => [m[0][j]!, m[1][j]!, m[2][j]!];
const fromColumns = (a: V3, b: V3, c: V3): Mat3 => [0, 1, 2].map((i) => [a[i]!, b[i]!, c[i]!]) as Mat3;
const det = (m: Mat3) => dot(column(m, 0), cross(column(m, 1), column(m, 2)));
const compose = (p: Affine, l: Affine): Affine => ({ m: mul(p.m, l.m), t: apply(p, l.t) });

/** Unit normals this close to parallel (|dot|) or perpendicular count as such: about half a degree. */
const PAR = 1 - 5e-5;
const PERP = 0.01;
/** Same-height tolerance for cap faces, in model units. */
const LEVEL = 0.5;

/** File frame → model frame (1/64", Y up, front +Z). */
function fileFrame(scene: ColladaScene): Affine {
  const s = scene.inches * UNITS_PER_INCH;
  const m: Mat3 =
    scene.up === 'Z'
      ? [
          [s, 0, 0],
          [0, 0, s],
          [0, -s, 0],
        ]
      : scene.up === 'X'
        ? [
            [0, -s, 0],
            [s, 0, 0],
            [0, 0, s],
          ]
        : [
            [s, 0, 0],
            [0, s, 0],
            [0, 0, s],
          ];
  return { m, t: [0, 0, 0] };
}

const matrixAffine = (m: number[]): Affine => ({
  m: [
    [m[0]!, m[1]!, m[2]!],
    [m[4]!, m[5]!, m[6]!],
    [m[8]!, m[9]!, m[10]!],
  ],
  t: [m[3]!, m[7]!, m[11]!],
});

/** The rotation part of a node's world matrix (scale removed), or null when it's mirrored or degenerate. */
function orthonormal(m: Mat3): Mat3 | null {
  const x = norm(column(m, 0));
  const yRaw = column(m, 1);
  const y = norm(sub(yRaw, scale(x, dot(x, yRaw))));
  const z = cross(x, y);
  if (!Number.isFinite(z[0]) || Math.hypot(...z) < 0.5 || dot(z, column(m, 2)) <= 0) return null;
  return fromColumns(x, y, z);
}

/** Rounds near-0 and near-±1 entries so square turns stay exact. */
const snap = (m: Mat3): Mat3 => m.map((row) => row.map((v) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-6 ? Math.sign(v) : v))) as Mat3;

const PERMS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * Assigns three orthonormal directions (in the parent frame) to local x, y, z so the part turns
 * as little as possible from its parent: each lands on the parent axis it's closest to, pointing
 * the same way, kept right-handed. Returns the local axes and, for each input, the axis it took.
 */
function alignFrame(dirs: [V3, V3, V3]): { axes: [V3, V3, V3]; slot: [number, number, number] } {
  let best = PERMS[0]!;
  let score = -1;
  for (const p of PERMS) {
    const s = p.reduce((sum, axis, i) => sum + Math.abs(dirs[i]![axis]!), 0);
    if (s > score + 1e-9) [best, score] = [p, s];
  }
  const axes: V3[] = [];
  best.forEach((axis, i) => (axes[axis] = dirs[i]![axis]! < 0 ? scale(dirs[i]!, -1) : dirs[i]!));
  if (det(fromColumns(axes[0]!, axes[1]!, axes[2]!)) < 0) {
    const weakest = [0, 1, 2].reduce((w, k) => (Math.abs(axes[k]![k]!) < Math.abs(axes[w]![w]!) ? k : w), 0);
    axes[weakest] = scale(axes[weakest]!, -1);
  }
  return { axes: axes as [V3, V3, V3], slot: best as [number, number, number] };
}

interface Tri {
  p: [V3, V3, V3];
  n: V3;
  area: number;
  mat: ColladaMaterial | null;
}

/** Splits loose triangles into connected solids (sharing a vertex). */
function pieces(tris: Tri[]): Tri[][] {
  const parent = tris.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  tris.forEach((t, i) => {
    for (const p of t.p) {
      const k = key(p);
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Tri[]>();
  tris.forEach((t, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  });
  return [...groups.values()];
}

/** Welds positions closer than 1/20 of a model unit. */
const key = (p: V3) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)},${Math.round(p[2] * 20)}`;

// ── Intermediate result, all in world (model) coordinates ────────────────

interface IRPart {
  kind: 'part';
  name: string;
  /** Local axes as columns. */
  R: Mat3;
  /** World position of the local min corner. */
  o: V3;
  size: V3;
  shape: { type: 'box'; params: { x: number; y: number; z: number } } | { type: 'outline'; params: { axis: 'x' | 'y' | 'z'; thickness: number; points: { at: V2 }[] } } | null;
  thickness: number;
  grain: Grain;
  mat: ColladaMaterial | null;
  simplified: boolean;
}
interface IRAsm {
  kind: 'asm';
  name: string;
  R: Mat3;
  children: IR[];
}
type IR = IRPart | IRAsm;

const LETTERS = ['x', 'y', 'z'] as const;

/**
 * Fits one solid. `tris` are in the parent's rotated frame (world translation kept); `nodeAxes` is
 * the SketchUp group's own orientation in that frame, used for blockouts.
 */
function fit(name: string, tris: Tri[], nodeAxes: Mat3): IRPart | null {
  // Normal clusters, sign-insensitive (SketchUp faces are often reversed).
  const clusters: { dir: V3; area: number }[] = [];
  for (const t of tris) {
    const c = clusters.find((c) => Math.abs(dot(c.dir, t.n)) > PAR);
    if (c) c.area += t.area;
    else clusters.push({ dir: t.n, area: t.area });
  }
  clusters.sort((a, b) => b.area - a.area);
  const mat = dominantMaterial(tris);
  if (mat?.name === BLOCKOUT_MATERIAL) return block(name, tris, nodeAxes, null);
  // Try the biggest face directions as the extrusion axis; a stick with an L section extrudes along
  // its length even though its long faces are bigger. Prefer a fit that keeps every face.
  let first: IRPart | null = null;
  for (const { dir: d } of clusters.slice(0, 4)) {
    if (!tris.every((t) => Math.abs(dot(t.n, d)) > PAR || Math.abs(dot(t.n, d)) < PERP)) continue;
    const w = clusters.find((c) => Math.abs(dot(c.dir, d)) < PERP)?.dir;
    if (!w) continue;
    const result = extrusion(name, tris, d, norm(sub(w, scale(d, dot(w, d)))), mat);
    if (result && !result.simplified) return result;
    first ??= result;
  }
  return first ?? block(name, tris, nodeAxes, mat);
}

function dominantMaterial(tris: Tri[]): ColladaMaterial | null {
  const area = new Map<ColladaMaterial, number>();
  for (const t of tris) if (t.mat) area.set(t.mat, (area.get(t.mat) ?? 0) + t.area);
  return [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function extents(tris: Tri[], axes: V3[]) {
  const min = axes.map(() => Infinity);
  const max = axes.map(() => -Infinity);
  for (const t of tris) {
    for (const p of t.p) {
      axes.forEach((a, k) => {
        const h = dot(p, a);
        min[k] = Math.min(min[k]!, h);
        max[k] = Math.max(max[k]!, h);
      });
    }
  }
  return { min, max };
}

function extrusion(name: string, tris: Tri[], d: V3, u: V3, mat: ColladaMaterial | null): IRPart | null {
  const { axes, slot } = alignFrame([d, u, cross(d, u)]);
  const dAxis = slot[0];
  const e = axes[dAxis]!; // d, possibly flipped
  const { min, max } = extents(tris, axes);
  const size = [0, 1, 2].map((k) => Math.round(max[k]! - min[k]!)) as V3;
  const t = size[dAxis]!;
  if (t < 1 || size.some((s) => s < 1)) return null;

  // Cap boundaries: edges used by exactly one cap triangle.
  const levelOf = (p: V3) => dot(p, e);
  const caps: Tri[][] = [[], []];
  let inner = false;
  for (const tri of tris) {
    if (Math.abs(dot(tri.n, e)) < PERP) continue;
    const hs = tri.p.map(levelOf);
    if (hs.every((h) => Math.abs(h - max[dAxis]!) < LEVEL)) caps[1]!.push(tri);
    else if (hs.every((h) => Math.abs(h - min[dAxis]!) < LEVEL)) caps[0]!.push(tri);
    else inner = true; // pocket or blind-hole floor
  }
  const loops = boundaryLoops(caps[1]!);
  if (!loops.length || !caps[0]!.length) return null;
  const [a, b] = CAP_AXES[dAxis as 0 | 1 | 2];
  const to2 = (p: V3): V2 => [Math.round(dot(p, axes[a]!) - min[a]!), Math.round(dot(p, axes[b]!) - min[b]!)];
  const polys = loops.map((l) => simplify(l.map(to2))).filter((p) => p.length >= 3);
  if (!polys.length) return null;
  polys.sort((p, q) => Math.abs(signedArea(q)) - Math.abs(signedArea(p)));
  let outer = polys[0]!;
  if (signedArea(outer) < 0) outer = outer.reverse();
  const area = (ts: Tri[]) => ts.reduce((s, x) => s + x.area, 0);
  const simplified = inner || polys.length > 1 || Math.abs(area(caps[0]!) - area(caps[1]!)) > 0.01 * area(caps[1]!);

  const R = snap(fromColumns(axes[0]!, axes[1]!, axes[2]!));
  const o = [0, 1, 2].reduce<V3>((acc, k) => [acc[0] + axes[k]![0]! * min[k]!, acc[1] + axes[k]![1]! * min[k]!, acc[2] + axes[k]![2]! * min[k]!], [0, 0, 0]);
  const inPlane = [a, b].sort((i, j) => size[j]! - size[i]!)[0]!;
  const grain = LETTERS[inPlane]!;
  const rect = outer.length === 4 && outer.every(([x, y]) => (x === 0 || x === size[a]) && (y === 0 || y === size[b]));
  const shape = rect
    ? { type: 'box' as const, params: { x: size[0], y: size[1], z: size[2] } }
    : { type: 'outline' as const, params: { axis: LETTERS[dAxis]!, thickness: t, points: outer.map((at) => ({ at })) } };
  return { kind: 'part', name, R, o, size, shape, thickness: t, grain, mat, simplified };
}

/** Closed loops of a cap's outline edges, as 3D points. */
function boundaryLoops(cap: Tri[]): V3[][] {
  const count = new Map<string, number>();
  const pos = new Map<string, V3>();
  const edgeKey = (i: string, j: string) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  for (const t of cap) {
    const ks = t.p.map(key);
    t.p.forEach((p, i) => pos.set(ks[i]!, p));
    for (let i = 0; i < 3; i++) {
      const k = edgeKey(ks[i]!, ks[(i + 1) % 3]!);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const next = new Map<string, string[]>();
  for (const [k, n] of count) {
    if (n !== 1) continue;
    const [i, j] = k.split('|') as [string, string];
    next.set(i, [...(next.get(i) ?? []), j]);
    next.set(j, [...(next.get(j) ?? []), i]);
  }
  const loops: V3[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: V3[] = [];
    let [prev, cur] = ['', start];
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(pos.get(cur)!);
      const step: string | undefined = next.get(cur)!.find((n) => n !== prev && !used.has(n));
      [prev, cur] = [cur, step ?? ''];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Drops repeated and collinear points (after rounding to 1/64"). */
function simplify(pts: V2[]): V2[] {
  let out = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]!;
    return p[0] !== q[0] || p[1] !== q[1];
  });
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const [p, q, r] = [out[(i + out.length - 1) % out.length]!, out[i]!, out[(i + 1) % out.length]!];
      const crossZ = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      const len = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1;
      if (Math.abs(crossZ) / len < 0.5) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function block(name: string, tris: Tri[], nodeAxes: Mat3, mat: ColladaMaterial | null): IRPart | null {
  const { axes } = alignFrame([column(nodeAxes, 0), column(nodeAxes, 1), column(nodeAxes, 2)]);
  const { min, max } = extents(tris, axes);
  const raw = [0, 1, 2].map((k) => max[k]! - min[k]!);
  // A flat face (a floor plan, a lone rectangle) has no volume to stand in for.
  if (raw.filter((s) => s >= 1).length < 3) return null;
  const size = raw.map((s) => Math.max(1, Math.round(s))) as V3;
  const o = [0, 1, 2].reduce<V3>((acc, k) => [acc[0] + axes[k]![0]! * min[k]!, acc[1] + axes[k]![1]! * min[k]!, acc[2] + axes[k]![2]! * min[k]!], [0, 0, 0]);
  return { kind: 'part', name, R: snap(fromColumns(axes[0]!, axes[1]!, axes[2]!)), o, size, shape: null, thickness: 0, grain: 'none', mat, simplified: false };
}

// ── Tree walk ────────────────────────────────────────────────────────────

const GENERIC = /^(sketchup|instance|group|component|node|mesh|geometry|model|skp|id)?[\s_#-]*\d*$/i;
const pickName = (...names: string[]) => names.find((n) => n.trim() && !GENERIC.test(n.trim()) && !DEFAULT_MATERIAL.test(n.trim()))?.trim() ?? '';

interface WalkState {
  skipped: number;
  /** Inverse rotation of the file frame. */
  unframe: Mat3;
}

function walk(node: ColladaNode, parentWorld: Affine, parentR: Mat3, state: WalkState): IR | null {
  const W = compose(parentWorld, matrixAffine(node.matrix));
  // The group's axes in model terms: its blue (up) axis is our height, like the file frame's.
  const R = orthonormal(mul(W.m, state.unframe)) ?? parentR;
  const children = node.children.map((c) => walk(c, W, R, state)).filter((c): c is IR => c !== null);

  const tris: Tri[] = [];
  for (const mesh of node.meshes) {
    for (let i = 0; i + 8 < mesh.tris.length; i += 9) {
      const p = [0, 3, 6].map((k) => apply(W, [mesh.tris[i + k]!, mesh.tris[i + k + 1]!, mesh.tris[i + k + 2]!])) as [V3, V3, V3];
      const c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      const area = Math.hypot(...c) / 2;
      if (area < 1e-4) continue;
      tris.push({ p, n: scale(c, 1 / (2 * area)), area, mat: mesh.material });
    }
  }
  const solids = pieces(dedupe(tris));
  const name = pickName(node.name);
  // Fit in the frame the result will live in: the group's own when it becomes an assembly.
  const fitIn = (frame: Mat3, label: (i: number) => string) =>
    solids
      .map((solid, i) => {
        const Ft = transpose(frame);
        const local = solid.map((t) => ({ ...t, p: t.p.map((p) => rotate(Ft, p)) as [V3, V3, V3], n: rotate(Ft, t.n) }));
        const part = fit(label(i), local, snap(mul(Ft, R)));
        if (!part) {
          state.skipped++;
          return null;
        }
        return { ...part, R: mul(frame, part.R), o: rotate(frame, part.o) };
      })
      .filter((p): p is IRPart => p !== null);

  if (solids.length === 1 && !children.length) return fitIn(parentR, () => name || pickName(solids[0]![0]!.mat?.name ?? '') || 'Part')[0] ?? null;
  if (!solids.length && children.length === 1) {
    const only = children[0]!;
    return { ...only, name: pickName(node.name, only.name) || only.name };
  }
  if (!solids.length && !children.length) return null;
  const loose = fitIn(R, (i) => `${name || 'Piece'} ${i + 1}`);
  const all = [...children, ...loose];
  if (!all.length) return null;
  return { kind: 'asm', name: name || 'Group', R, children: all };
}

/** Drops triangles listed twice (SketchUp's two-sided export repeats every face reversed). */
function dedupe(tris: Tri[]): Tri[] {
  const seen = new Set<string>();
  return tris.filter((t) => {
    const k = t.p.map(key).sort().join(';');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Ops ──────────────────────────────────────────────────────────────────

function corners(ir: IR): V3[] {
  if (ir.kind === 'asm') return ir.children.flatMap(corners);
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const local: V3 = [i & 1 ? ir.size[0] : 0, i & 2 ? ir.size[1] : 0, i & 4 ? ir.size[2] : 0];
    out.push(apply({ m: ir.R, t: ir.o }, local));
  }
  return out;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** SketchUp's built-in default face colors aren't real materials. */
const DEFAULT_MATERIAL = /^(material|default|frontcolor|backcolor|_*default_*material|edge_?color|face_?color)\d*$/i;

/**
 * Builds the insertion for a parsed scene: one wrapper assembly, applied as a single undo step. Into
 * an empty model it keeps SketchUp's coordinates; otherwise it lands 12" to the right of the model.
 */
export function importSketchUp(target: Doc, scene: ColladaScene, title = 'SketchUp import'): SketchUpImport {
  const frame = fileFrame(scene);
  const state: WalkState = { skipped: 0, unframe: transpose(orthonormal(frame.m)!) };
  const roots = scene.nodes.map((n) => walk(n, frame, I3, state)).filter((r): r is IR => r !== null);
  if (!roots.length) throw new ModelError('the file has no solid geometry to import (only flat faces or lines)');
  const top: IRAsm =
    roots.length === 1 && roots[0]!.kind === 'asm'
      ? { ...roots[0]!, name: pickName(roots[0]!.name) || title }
      : { kind: 'asm', name: title, R: I3, children: roots };

  let prefix = '';
  for (let n = 1; !prefix; n++) {
    const p = `import${n}`;
    if (entityKind(target, p) === null && ![target.materials, target.parts, target.assemblies].some((c) => Object.keys(c).some((id) => id.startsWith(`${p}_`)))) prefix = p;
  }

  const summary: ImportSummary = { boxes: 0, outlines: 0, blocks: 0, simplified: 0, skipped: state.skipped, materialsAdded: [] };
  const materialOps: Op[] = [];
  const nodeOps: Op[] = [];
  const known: Material[] = Object.values(target.materials);
  const chosen = new Map<string, string>();
  let counter = 0;
  const nextId = (kind: string) => `${prefix}_${kind}${++counter}`;

  const materialFor = (p: IRPart): string => {
    const named = p.mat && !DEFAULT_MATERIAL.test(p.mat.name.trim()) ? p.mat.name.trim() : '';
    const cacheKey = `${normName(named)}|${p.thickness}`;
    const hit = chosen.get(cacheKey);
    if (hit) return hit;
    const thick = (m: Material) => Math.abs(m.thickness - p.thickness) <= 1;
    const byName = (m: Material) => !!named && (normName(m.name) === normName(named) || normName(m.id) === normName(named));
    let id =
      known.find((m) => byName(m) && thick(m))?.id ??
      (() => {
        const lib = MATERIAL_LIBRARY.find((m) => byName(m) && thick(m)) ?? (named ? undefined : (known.find(thick) ?? MATERIAL_LIBRARY.find(thick)));
        if (lib && known.some((m) => m.id === lib.id)) return lib.id;
        if (lib) {
          materialOps.push({ op: 'add', entity: { kind: 'material', ...structuredClone(lib) } });
          known.push(lib);
          summary.materialsAdded.push(lib.name);
          return lib.id;
        }
        return undefined;
      })();
    if (!id) {
      id = nextId('m');
      const base = named || `Imported ${formatInches(p.thickness)}`;
      const name = known.some((m) => m.name === base) ? `${base} ${formatInches(p.thickness)}` : base;
      const m: Material = { id, name, thickness: p.thickness, color: p.mat?.color ?? '#d9b98b', stock: p.thickness > UNITS_PER_INCH ? 'solid' : 'sheet' };
      materialOps.push({ op: 'add', entity: { kind: 'material', ...m } });
      known.push(m);
      summary.materialsAdded.push(name);
    }
    chosen.set(cacheKey, id);
    return id;
  };

  /** Part op, or a blockout in its place when the outline can't be built (self-crossing after rounding…). */
  const partOps = (p: IRPart, base: { id: string; name: string; transform: { position: V3; rotation: V3 } }, parent: string): Op => {
    const asBlock = (): Op => ({ op: 'add', entity: { kind: 'block', ...base, size: p.size }, parent });
    if (!p.shape) {
      summary.blocks++;
      return asBlock();
    }
    const material = materialFor(p);
    const op: Op = { op: 'add', entity: { kind: 'part', ...base, material, grain: p.grain, shape: p.shape }, parent: null };
    const scratch = emptyDoc();
    const m = known.find((k) => k.id === material)!;
    const probe = applyOps(scratch, [...(scratch.materials[material] ? [] : [{ op: 'add', entity: { kind: 'material', ...m } } as Op]), op]);
    if (!probe.ok) {
      summary.blocks++;
      return asBlock();
    }
    if (p.shape.type === 'box') summary.boxes++;
    else summary.outlines++;
    if (p.simplified) summary.simplified++;
    return { ...op, parent };
  };

  const emit = (ir: IR, parentR: Mat3, parentO: V3, parent: string | null, id: string) => {
    const o = ir.kind === 'part' ? ir.o : originOf(ir);
    const Pt = transpose(parentR);
    const transform = { position: rotate(Pt, sub(o, parentO)).map(Math.round) as V3, rotation: eulerXYZ(snap(mul(Pt, ir.R))) };
    if (ir.kind === 'part') {
      nodeOps.push(partOps(ir, { id, name: ir.name, transform }, parent!));
      return;
    }
    nodeOps.push({ op: 'add', entity: { kind: 'assembly', id, name: ir.name, transform }, parent });
    // Children are placed against the rounded position so their world spots don't drift.
    const placed = apply({ m: parentR, t: parentO }, transform.position);
    for (const c of ir.children) emit(c, ir.R, placed, id, nextId(c.kind === 'asm' ? 'a' : 'p'));
  };
  emit(top, I3, scale(besideOffset(target, corners(top)), -1), null, prefix);

  const ops = [...materialOps, ...nodeOps];
  const result = applyOps(target, ops);
  if (!result.ok) throw new ModelError(result.error);
  return { ops, doc: result.doc, wrapperId: prefix, summary };
}

/** An assembly's origin: the min corner of its contents, in its own axes. */
function originOf(asm: IRAsm): V3 {
  const Rt = transpose(asm.R);
  const pts = corners(asm).map((c) => rotate(Rt, c));
  const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]!))) as V3;
  return rotate(asm.R, min);
}

/** World shift that puts the import beside the existing model (none for an empty model). */
function besideOffset(target: Doc, pts: V3[]): V3 {
  const boxes = worldBoxes(target);
  const existing = target.roots.flatMap((id) => (boxes.has(id) ? [boxes.get(id)!] : []));
  if (!existing.length || !pts.length) return [0, 0, 0];
  const t = union(existing);
  const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]!)));
  return [t.max[0] + 12 * UNITS_PER_INCH - min[0]!, t.min[1] - min[1]!, t.min[2] - min[2]!].map(Math.round) as V3;
}
