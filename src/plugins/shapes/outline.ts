import { z } from 'zod';
import { signedArea } from '../../geometry/polygon';
import { unitAxis, type Axis, type Prism } from '../../geometry/prism';
import type { Handle, HandleDrive, V2, V3 } from '../../geometry/types';
import { registerShape } from '../registry';
import { CAP_AXES, WORDS } from './box';

export interface OutlinePoint {
  id: string;
  at: [number, number];
  /** Corner radius at this point. */
  r?: number | undefined;
  /** Arc bulge of the side from this point to the next: positive bows outward. */
  sag?: number | undefined;
}

export interface OutlineParams {
  axis: 'x' | 'y' | 'z';
  thickness: number;
  points: OutlinePoint[];
}

const AXIS: Record<OutlineParams['axis'], Axis> = { x: 0, y: 1, z: 2 };
const LETTER: Record<Axis, string> = { 0: 'x', 1: 'y', 2: 'z' };

/** Fills missing point ids with the smallest unused `v1`, `v2`… so faces and edges keep stable names. */
export function withIds<T extends { id?: string | undefined }>(points: T[]): (T & { id: string })[] {
  const used = new Set(points.map((p) => p.id).filter(Boolean));
  let n = 1;
  return points.map((p) => {
    if (p.id) return p as T & { id: string };
    while (used.has(`v${n}`)) n++;
    used.add(`v${n}`);
    return { ...p, id: `v${n}` };
  });
}

const PointSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'point ids may only contain letters, digits and _')
    .optional(),
  at: z.tuple([z.int(), z.int()]),
  r: z.int().positive().optional(),
  sag: z.int().optional(),
});

const schema = z
  .object({
    axis: z.enum(['x', 'y', 'z']).default('y'),
    thickness: z.int().positive(),
    points: z.array(PointSchema).min(3),
  })
  .refine(
    (p) => {
      const ids = p.points.map((q) => q.id).filter(Boolean);
      return new Set(ids).size === ids.length;
    },
    { message: 'point ids must be unique', path: ['points'] },
  )
  .transform((p) => ({ ...p, points: withIds(p.points) }));

function frame(p: OutlineParams) {
  const axis = AXIS[p.axis];
  const [a, b] = CAP_AXES[axis];
  const words = WORDS[axis];
  const to3 = (at: V2, w: number): V3 => {
    const v: V3 = [0, 0, 0];
    v[a] = at[0];
    v[b] = at[1];
    v[axis] = w;
    return v;
  };
  return { axis, a, b, words, to3, points: withIds(p.points) };
}

function outlinePrism(p: OutlineParams): Prism {
  const { axis, a, b, words, points } = frame(p);
  return {
    axis,
    a,
    b,
    thickness: p.thickness,
    caps: [`face:${words[0]}`, `face:${words[1]}`],
    verts: points.map((q) => ({
      at: [q.at[0], q.at[1]],
      edge: `edge:corner-${q.id}`,
      ...(q.r && { corner: { kind: 'round' as const, r: q.r, tag: `face:corner-${q.id}` } }),
    })),
    sides: points.map((q) => ({
      tag: `face:side-${q.id}`,
      sag: q.sag ?? 0,
      capEdges: [`edge:${words[0]}-${q.id}`, `edge:${words[1]}-${q.id}`],
      profiles: [null, null],
    })),
  };
}

function outlineHandles(p: OutlineParams): Handle[] {
  const { axis, a, b, words, to3, points } = frame(p);
  const t = p.thickness;
  const n = points.length;
  const at = (i: number): V2 => points[(i + n) % n]!.at;
  const outward = signedArea(points.map((q) => q.at)) > 0 ? 1 : -1;
  const handles: Handle[] = [];
  const [la, lb] = [LETTER[a], LETTER[b]];
  /** Drags point i in the outline plane. */
  const pointDrives = (i: number): HandleDrive[] => [
    { target: 'shape', param: `points.${i}.at.0`, label: `${points[i]!.id} ${la}`, axis: unitAxis(a) },
    { target: 'shape', param: `points.${i}.at.1`, label: `${points[i]!.id} ${lb}`, axis: unitAxis(b) },
  ];

  const centroid: V2 = [points.reduce((s, q) => s + q.at[0], 0) / n, points.reduce((s, q) => s + q.at[1], 0) / n];
  for (const max of [false, true]) {
    handles.push({
      id: `face:${words[max ? 1 : 0]}`,
      kind: 'face',
      source: 'shape',
      points: [to3(centroid, max ? t : 0)],
      normal: unitAxis(axis, max ? 1 : -1),
      drives: [{ target: 'shape', param: 'thickness', label: 'thickness', axis: unitAxis(axis, max ? 1 : -1), moveOrigin: !max }],
    });
  }
  points.forEach((q, i) => {
    const j = (i + 1) % n;
    const [p0, p1] = [at(i), at(i + 1)];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const nrm: V2 = [(outward * (p1[1] - p0[1])) / len, (outward * -(p1[0] - p0[0])) / len];
    const normal: V3 = [0, 0, 0];
    normal[a] = nrm[0];
    normal[b] = nrm[1];
    // Pushing a side (or dragging one of its cap edges) moves both of its end points.
    const segment = [...pointDrives(i), ...pointDrives(j)];
    handles.push({ id: `face:side-${q.id}`, kind: 'face', source: 'shape', points: [to3([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], t / 2)], normal, drives: segment });
    if (q.r) {
      handles.push({
        id: `face:corner-${q.id}`,
        kind: 'face',
        source: 'shape',
        points: [to3(p0, t / 2)],
        drives: [{ target: 'shape', param: `points.${i}.r`, label: `${q.id} corner radius` }],
      });
    } else {
      handles.push({ id: `edge:corner-${q.id}`, kind: 'edge', source: 'shape', points: [to3(p0, 0), to3(p0, t)], drives: pointDrives(i) });
    }
    for (const max of [false, true]) {
      const w = max ? t : 0;
      const word = words[max ? 1 : 0];
      handles.push({ id: `edge:${word}-${q.id}`, kind: 'edge', source: 'shape', points: [to3(p0, w), to3(p1, w)], drives: segment });
      handles.push({ id: `vertex:${word}-${q.id}`, kind: 'vertex', source: 'shape', points: [to3(p0, w)], drives: pointDrives(i) });
    }
  });
  return handles;
}

/** Shifts points so none is below 0 (the origin stays the min corner); the part moves the other way. */
function normalizeOutline(p: OutlineParams): { params: OutlineParams; offset: V3 } | null {
  const { axis, a, b } = frame(p);
  const minA = Math.min(0, ...p.points.map((q) => q.at[0]));
  const minB = Math.min(0, ...p.points.map((q) => q.at[1]));
  if (minA === 0 && minB === 0) return null;
  const offset: V3 = [0, 0, 0];
  offset[a] = minA;
  offset[b] = minB;
  offset[axis] = 0;
  return { params: { ...p, points: p.points.map((q) => ({ ...q, at: [q.at[0] - minA, q.at[1] - minB] })) }, offset };
}

registerShape<OutlineParams>({
  type: 'outline',
  version: 1,
  schema: schema as unknown as z.ZodType<OutlineParams>,
  describe:
    'Flat shaped part: a closed 2D outline extruded `thickness` (1/64") along `axis` ("y" = lying flat like a tabletop or shelf, ' +
    '"z" = standing facing front like a curved apron, "x" = standing facing sideways). Outline coords `at` are part-local 1/64" in the ' +
    'plane across the axis — y: [x, z]; z: [x, y]; x: [z, y] — keep them ≥ 0 so the origin is the min corner. Each point: optional `id` ' +
    '(letters/digits/_; auto v1, v2… if omitted), `r` = corner radius there, `sag` = the side to the next point is an arc bulging `sag` ' +
    'outward from its chord (negative = inward, max half the chord). Faces: the two caps named by the axis (y: face:bottom/top, ' +
    'z: face:back/front, x: face:left/right), face:side-<id> (side starting at that point), face:corner-<id> (rounded corners). ' +
    'Edges: edge:<cap word>-<id>, edge:corner-<id>.',
  build: (p) => ({ prism: outlinePrism(p) }),
  handles: outlineHandles,
  normalize: normalizeOutline,
});
