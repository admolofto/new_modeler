import { z } from 'zod';
import { channeledBox, type Block } from '../../geometry/orthogonal';
import { GeometryError, unitAxis, type Axis, type Prism } from '../../geometry/prism';
import type { Geom, Handle, V3 } from '../../geometry/types';
import { formatInches } from '../../model/units';
import { registerShape, type ChannelSpec } from '../registry';

export interface BoxParams {
  x: number;
  y: number;
  z: number;
}

export type BoxFaceId = 'face:left' | 'face:right' | 'face:bottom' | 'face:top' | 'face:back' | 'face:front';
export const BOX_FACE_IDS: BoxFaceId[] = ['face:left', 'face:right', 'face:bottom', 'face:top', 'face:back', 'face:front'];

const PARAM: Record<Axis, keyof BoxParams> = { 0: 'x', 1: 'y', 2: 'z' };
const SIZE_LABEL: Record<Axis, string> = { 0: 'width', 1: 'height', 2: 'depth' };

/**
 * Face frames. `u`/`v` are the in-plane axes a face-local point `[u, v]` is measured
 * along, from the part's min corner: front/back → [x, y], left/right → [z, y],
 * top/bottom → [x, z]. Opposite faces share the frame, so a through hole has the
 * same `at` on both.
 */
export const BOX_FACES: Record<BoxFaceId, { axis: Axis; max: boolean; u: Axis; v: Axis }> = {
  'face:left': { axis: 0, max: false, u: 2, v: 1 },
  'face:right': { axis: 0, max: true, u: 2, v: 1 },
  'face:bottom': { axis: 1, max: false, u: 0, v: 2 },
  'face:top': { axis: 1, max: true, u: 0, v: 2 },
  'face:back': { axis: 2, max: false, u: 0, v: 1 },
  'face:front': { axis: 2, max: true, u: 0, v: 1 },
};

/** Outline-plane axes [a, b] for a prism along each axis; they match the cap faces' [u, v]. */
export const CAP_AXES: Record<Axis, [Axis, Axis]> = { 0: [2, 1], 1: [0, 2], 2: [0, 1] };

/** Size of a box face along its [u, v] axes. */
export function boxFaceSize(p: BoxParams, face: BoxFaceId): [number, number] {
  const f = BOX_FACES[face];
  return [p[PARAM[f.u]], p[PARAM[f.v]]];
}

// Edge / vertex names are built from face words in y, z, x order: `edge:top-front`, `vertex:top-front-left`.
export const WORDS: Record<Axis, [string, string]> = { 0: ['left', 'right'], 1: ['bottom', 'top'], 2: ['back', 'front'] };
const NAME_ORDER: Axis[] = [1, 2, 0];

function boxFace(axis: Axis, max: boolean): BoxFaceId {
  return BOX_FACE_IDS.find((id) => BOX_FACES[id].axis === axis && BOX_FACES[id].max === max)!;
}

/** Name of the box edge where two faces meet, e.g. (y max, z max) → `edge:top-front`. */
function boxEdge(ax1: Axis, max1: boolean, ax2: Axis, max2: boolean): string {
  const [p, q] = NAME_ORDER.indexOf(ax1) < NAME_ORDER.indexOf(ax2) ? [[ax1, max1], [ax2, max2]] : [[ax2, max2], [ax1, max1]];
  return `edge:${WORDS[p![0] as Axis][p![1] ? 1 : 0]}-${WORDS[q![0] as Axis][q![1] ? 1 : 0]}`;
}

function boxHandles(p: BoxParams): Handle[] {
  const size: V3 = [p.x, p.y, p.z];
  const handles: Handle[] = [];

  for (const id of BOX_FACE_IDS) {
    const f = BOX_FACES[id];
    const c: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
    c[f.axis] = f.max ? size[f.axis] : 0;
    handles.push({
      id,
      kind: 'face',
      source: 'shape',
      points: [c],
      normal: unitAxis(f.axis, f.max ? 1 : -1),
      drives: [{ target: 'shape', param: PARAM[f.axis], label: SIZE_LABEL[f.axis], axis: unitAxis(f.axis, f.max ? 1 : -1), moveOrigin: !f.max }],
    });
  }

  // Edges: pick the free axis, fix the other two at min/max.
  for (const free of [0, 1, 2] as Axis[]) {
    const fixed = NAME_ORDER.filter((a) => a !== free);
    for (const s0 of [false, true]) {
      for (const s1 of [false, true]) {
        const a: V3 = [0, 0, 0];
        a[fixed[0]!] = s0 ? size[fixed[0]!] : 0;
        a[fixed[1]!] = s1 ? size[fixed[1]!] : 0;
        const b: V3 = [...a];
        b[free] = size[free];
        handles.push({ id: boxEdge(fixed[0]!, s0, fixed[1]!, s1), kind: 'edge', source: 'shape', points: [a, b], drives: [] });
      }
    }
  }

  for (let i = 0; i < 8; i++) {
    const hi = [(i & 1) === 1, (i & 2) === 2, (i & 4) === 4];
    const pt: V3 = [hi[0] ? p.x : 0, hi[1] ? p.y : 0, hi[2] ? p.z : 0];
    const name = NAME_ORDER.map((a) => WORDS[a][hi[a] ? 1 : 0]).join('-');
    handles.push({ id: `vertex:${name}`, kind: 'vertex', source: 'shape', points: [pt], drives: [] });
  }
  return handles;
}

/** The axis a box's prism runs along: its thinnest (ties: y, z, x). Edges along it are its outline corners. */
export function boxThinAxis(p: BoxParams): Axis {
  const size: V3 = [p.x, p.y, p.z];
  let axis: Axis = 1;
  for (const ax of [2, 0] as Axis[]) if (size[ax] < size[axis]) axis = ax;
  return axis;
}

/**
 * The corner edge at a box vertex: the edge through the thickness (`vertex:top-front-left` on a
 * door lying in z → `edge:top-left`). Rounding or clipping it rounds or clips that corner.
 */
export function boxCornerEdge(p: BoxParams, vertexId: string): string | null {
  const m = /^vertex:(bottom|top)-(back|front)-(left|right)$/.exec(vertexId);
  if (!m) return null;
  const axis = boxThinAxis(p);
  const words = [m[1], m[2], m[3]].filter((_, i) => NAME_ORDER[i] !== axis);
  return `edge:${words.join('-')}`;
}

/**
 * A box is a rectangular prism through its thinnest axis (ties: y, z, x): a panel's big
 * faces are the caps, so profiling "around the edge" of a panel is a cap-perimeter profile.
 * Edges along that axis are the outline's corners (a roundover there rounds the corner).
 */
function boxPrism(p: BoxParams): Prism {
  const size: V3 = [p.x, p.y, p.z];
  const axis = boxThinAxis(p);
  const [a, b] = CAP_AXES[axis];
  const corners: [boolean, boolean][] = [
    [false, false],
    [true, false],
    [true, true],
    [false, true],
  ];
  const sideFaces: [Axis, boolean][] = [
    [b, false],
    [a, true],
    [b, true],
    [a, false],
  ];
  return {
    axis,
    a,
    b,
    thickness: size[axis],
    caps: [boxFace(axis, false), boxFace(axis, true)],
    verts: corners.map(([am, bm]) => ({ at: [am ? size[a] : 0, bm ? size[b] : 0], edge: boxEdge(a, am, b, bm) })),
    sides: sideFaces.map(([ax, max]) => {
      const id = boxFace(ax, max);
      const f = BOX_FACES[id];
      return {
        tag: id,
        sag: 0,
        capEdges: [boxEdge(axis, false, ax, max), boxEdge(axis, true, ax, max)],
        frame: { origin: unitAxis(ax, max ? size[ax] : 0), u: unitAxis(f.u), v: unitAxis(f.v) },
        profiles: [null, null],
      };
    }),
  };
}

/** Channels (dados, grooves, rabbets) as blocks cut from the box; solved exactly on their grid. */
function boxChanneled(p: BoxParams, channels: ChannelSpec[], partName: string): Geom {
  const size: V3 = [p.x, p.y, p.z];
  const blocks = channels.map((c): Block => {
    const f = BOX_FACES[c.face as BoxFaceId];
    if (!f) throw new GeometryError(`${c.label}: "${partName}" has no face ${c.face} (use ${BOX_FACE_IDS.join(', ')})`);
    if (c.depth > size[f.axis] - 1) {
      throw new GeometryError(`${c.label} is ${formatInches(c.depth)} deep but "${partName}" is only ${formatInches(size[f.axis])} thick there`);
    }
    const min: V3 = [0, 0, 0];
    const max: V3 = [...size];
    min[f.axis] = f.max ? size[f.axis] - c.depth : 0;
    max[f.axis] = f.max ? size[f.axis] : c.depth;
    min[f.u] = Math.min(c.from[0], c.to[0]);
    max[f.u] = Math.max(c.from[0], c.to[0]);
    min[f.v] = Math.min(c.from[1], c.to[1]);
    max[f.v] = Math.max(c.from[1], c.to[1]);
    return { featureId: c.featureId, min, max, axis: f.axis, label: c.label };
  });
  return channeledBox(size, blocks, (axis, max) => {
    const id = boxFace(axis, max);
    return { tag: id, u: BOX_FACES[id].u, v: BOX_FACES[id].v };
  }, partName);
}

registerShape<BoxParams>({
  type: 'box',
  version: 1,
  schema: z.object({
    x: z.int().positive(),
    y: z.int().positive(),
    z: z.int().positive(),
  }),
  describe:
    'Rectangular block sized along the part-local X (width), Y (height) and Z (depth) axes, in 1/64". ' +
    'Origin at the min corner. Faces: face:left/right (X), face:bottom/top (Y), face:back/front (Z). ' +
    'Edges and vertices are named from those words in y-z-x order, e.g. edge:top-front, vertex:top-front-left.',
  build: (p) => ({ prism: boxPrism(p) }),
  buildChanneled: boxChanneled,
  handles: boxHandles,
});
