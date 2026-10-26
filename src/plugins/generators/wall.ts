import { z } from 'zod';
import { Finish } from '../../model/schema';
import { formatInches as f, inches } from '../../model/units';
import { registerGenerator, type GenAction, type GenFace, type GenFaceDrive, type GenOutput, type GenPart, type ParamField } from '../registry';
import { frameLayout, type TrimParams, type WallOpening } from '../shapes/decor/room';
import {
  CASING_THICKNESS,
  CASING_WIDTH,
  HEADER,
  OPENING_COMMON,
  OPENING_DEFAULTS,
  OPENING_KINDS,
  ROOM_FINISHES,
  openingBottom,
  openingIds,
  openingLabel,
  openingPieces,
  openingSpan,
  type OpeningKind,
  type OpeningSpec,
} from './room';

/**
 * A wall standing on its own: a floor plan's walls, one piece each (what a SketchUp house imports
 * as). A box `length` along its local x, `height` up and `thickness` deep, with windows, doors (in
 * folders that swing) and cased openings cut through it, built like the room's. Its front (+Z) face
 * is its room side: window stools, the window itself and a door's "in" swing are on that side;
 * casings go on both faces unless `casings` is "front". Placed by its assembly's transform, so it
 * moves and turns like a cabinet. Decor (never in the cut list) and surroundings (left out of fits
 * and the model's dims), like the room. Openings are wall-local: `at` is the center's distance from
 * the wall's start (local x = 0).
 */

export type WallPieceOpening = OpeningSpec & { at: number };

export interface WallPieceParams {
  length: number;
  height: number;
  thickness: number;
  openings: WallPieceOpening[];
  casings: 'front' | 'both';
  /** Each one the room's default when absent (kept out of the defaults: the AI's tool schemas stay small). */
  finishes: { wall?: Finish; trim?: Finish; doors?: Finish; windows?: Finish };
}

const base = { ...OPENING_COMMON, at: z.int() };
const Opening = z.discriminatedUnion('kind', [z.object({ ...base, ...OPENING_KINDS.window }), z.object({ ...base, ...OPENING_KINDS.door }), z.object({ ...base, ...OPENING_KINDS.opening })]);

type Parsed = Omit<WallPieceParams, 'openings'> & { openings: (WallPieceOpening | Omit<WallPieceOpening, 'id'>)[] };

/** Where an opening cuts through the wall, wall-local. */
export function wallCut(o: WallPieceOpening): WallOpening {
  return { id: o.id, x: openingSpan(o)[0], y: openingBottom(o), w: o.width, h: o.height };
}

/** Readable checks: each opening inside the wall, with wall left above it, none overlapping. */
function checks(p: Parsed, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const ids = openingIds(p.openings as { id?: string; kind: OpeningKind }[]);
  const all = p.openings.map((o, i) => ({ ...o, id: ids[i]! }) as WallPieceOpening);
  all.forEach((o, i) => {
    if (ids.indexOf(o.id) !== i) issue(['openings', i, 'id'], `openings[${o.id}]: two openings are both ${o.id}`);
    const name = `openings[${o.id}]`;
    const [lo, hi] = openingSpan(o);
    const what = `a ${f(o.width)} ${o.kind} centered ${f(o.at)} along`;
    if (o.width > p.length) issue(['openings', i, 'width'], `${name}: ${what} is wider than the ${f(p.length)} wall`);
    else if (lo < 0) issue(['openings', i, 'at'], `${name}: ${what} runs ${f(-lo)} past the wall's start`);
    else if (hi > p.length) issue(['openings', i, 'at'], `${name}: ${what} runs ${f(hi - p.length)} past the wall's end`);
    const top = openingBottom(o) + o.height;
    if (top > p.height - HEADER) issue(['openings', i, 'height'], `${name}: its top at ${f(top)} leaves less than ${f(HEADER)} of wall under the ${f(p.height)} top`);
    for (const q of all.slice(0, i)) {
      const [a, b] = openingSpan(q);
      const [y0, y1] = [openingBottom(q), openingBottom(q) + q.height];
      if (lo < b && a < hi && openingBottom(o) < y1 && y0 < top) issue(['openings', i, 'at'], `${name}: it overlaps ${openingLabel(q)}`);
    }
  });
}

export const wallPieceSchema = z
  .object({
    length: z.int().min(inches(1)).max(inches(1200)),
    height: z.int().min(inches(6)).max(inches(240)),
    thickness: z.int().min(inches(1 / 4)).max(inches(36)),
    openings: z.array(Opening).default(() => []),
    casings: z.enum(['front', 'both']).default('both'),
    finishes: z.object({ wall: Finish.optional(), trim: Finish.optional(), doors: Finish.optional(), windows: Finish.optional() }).default(() => ({})),
  })
  .superRefine((p, ctx) => checks(p as Parsed, ctx))
  .transform((p): WallPieceParams => {
    const ids = openingIds(p.openings as { id?: string; kind: OpeningKind }[]);
    return { ...(p as Parsed), openings: p.openings.map((o, i) => ({ ...o, id: ids[i]! }) as WallPieceOpening) };
  });

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const IN_PLACE = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };

/** The casing on the wall's back face: a plain frame (a window's stool is on the room side). */
function backCasing(o: WallPieceOpening, finish: Finish): Extract<TrimParams, { style: 'frame' }> {
  return { style: 'frame', w: o.width, h: o.height, width: CASING_WIDTH, thickness: CASING_THICKNESS, sides: openingBottom(o) >= CASING_WIDTH ? 4 : 3, stool: null, apron: null, finish: structuredClone(finish) };
}

function generate(p: WallPieceParams): GenOutput {
  const T = p.thickness;
  const fin = { wall: p.finishes.wall ?? ROOM_FINISHES.walls, trim: p.finishes.trim ?? ROOM_FINISHES.trim, doors: p.finishes.doors ?? ROOM_FINISHES.doors, windows: p.finishes.windows ?? ROOM_FINISHES.windows };
  const out: Required<Pick<GenOutput, 'parts' | 'groups' | 'motions'>> = { parts: [], groups: [], motions: [] };
  const cuts = p.openings.map(wallCut);
  out.parts.push({ role: 'wall', name: 'Wall', grain: 'none', position: [0, 0, 0], shape: { type: 'wall', params: { x: p.length, y: p.height, z: T, openings: cuts, finish: structuredClone(fin.wall) } } });
  p.openings.forEach((o, i) => {
    const w = cuts[i]!;
    const made = openingPieces(o, w, T, fin, IN_PLACE, (part, at): GenPart => ({ ...part, position: at }));
    out.parts.push(...made.parts);
    out.groups.push(...made.groups);
    out.motions.push(...made.motions);
    if (o.casing && p.casings === 'both') {
      // Turned half round onto the back face: its local min x lands at the opening's far jamb.
      const trim = backCasing(o, fin.trim);
      const layout = frameLayout(trim);
      out.parts.push({
        role: `casing-back-${o.id}`,
        name: `${cap(o.kind)} ${o.id} back casing`,
        grain: 'none',
        unclickable: true,
        position: [w.x + w.w + layout.opening[0], w.y - layout.opening[1], 0],
        rotation: [0, 180, 0],
        shape: { type: 'trim', params: trim as unknown as Record<string, unknown> },
      });
    }
  });
  return { ...out, joints: [] };
}

/**
 * Pushing and pulling: the end face moves the end (the length), the top the height, either face the
 * thickness (the back one grows outward, so the front stays). The start stays put: openings are
 * measured from it.
 */
function faceDrive(_p: WallPieceParams, face: GenFace): GenFaceDrive | null {
  if (face.role !== 'wall') return null;
  if (face.axis === 0) return face.max ? { param: 'length', label: 'wall length', sign: 1 } : null;
  if (face.axis === 1) return face.max ? { param: 'height', label: 'wall height', sign: 1 } : null;
  return { param: 'thickness', label: 'wall thickness', sign: 1, ...(!face.max && { moveOrigin: true }) };
}

const half = (u: number) => Math.round(u / 32) * 32;

/**
 * A new opening of this kind centered near `at` along the wall: the room's defaults, shrunk to fit
 * a short or low wall and slid to lie inside it. null when it would overlap another one.
 */
export function newWallOpening(p: WallPieceParams, kind: OpeningKind, at: number): WallPieceOpening | null {
  const d = OPENING_DEFAULTS[kind];
  const width = Math.max(inches(12), Math.min(d.width, p.length));
  const room = p.height - HEADER;
  let sill = d.sill;
  const height = Math.max(inches(12), Math.min(d.height, room - sill));
  if (sill + height > room) sill = Math.max(0, room - height);
  const halfW = Math.floor(width / 2);
  const center = Math.min(Math.max(at, halfW), p.length - width + halfW);
  const id = openingIds([...p.openings, { kind }]).at(-1)!;
  const common = { id, at: center, width, height, casing: true };
  const o: WallPieceOpening =
    kind === 'window' ? { ...common, kind, sill, style: 'double-hung', stool: true } : kind === 'door' ? { ...common, kind, leaf: 'panel', hinge: 'left', swing: 'in', angle: 90, handle: 'lever' } : { ...common, kind, sill };
  const [lo, hi] = openingSpan(o);
  const [y0, y1] = [openingBottom(o), openingBottom(o) + o.height];
  const clash = p.openings.some((q) => {
    const [a, b] = openingSpan(q);
    return lo < b && a < hi && y0 < openingBottom(q) + q.height && openingBottom(q) < y1;
  });
  return clash || lo < 0 || hi > p.length || y1 > room ? null : o;
}

/** The opening a clicked part or reveal belongs to (`w1:jamb-left` on the wall, `window-w1`, `door-d1-leaf`…). */
function openingOn(p: WallPieceParams, role: string, handle?: string): WallPieceOpening | null {
  const tag = handle && /^([A-Za-z0-9_-]+):(jamb-left|jamb-right|head|sill)$/.exec(handle)?.[1];
  for (const o of p.openings) {
    if (tag === o.id && role === 'wall') return o;
    if ([`window-${o.id}`, `casing-${o.id}`, `casing-back-${o.id}`, `door-${o.id}`, `door-${o.id}-leaf`, `door-${o.id}-handle`].includes(role)) return o;
  }
  return null;
}

function actions(p: WallPieceParams, ctx: { role: string; handle?: string; at?: [number, number, number] }): GenAction<WallPieceParams>[] {
  const out: GenAction<WallPieceParams>[] = [];
  if (ctx.role === 'wall' && ctx.at && (ctx.handle === 'face:front' || ctx.handle === 'face:back')) {
    for (const kind of ['window', 'door', 'opening'] as const) {
      const o = newWallOpening(p, kind, half(ctx.at[0]));
      if (o) out.push({ label: `Add ${kind} here`, params: { ...p, openings: [...p.openings, o] } });
    }
  }
  const o = openingOn(p, ctx.role, ctx.handle);
  if (o) out.push({ label: `Remove ${openingLabel(o)}`, params: { ...p, openings: p.openings.filter((x) => x !== o) } });
  return out;
}

const FIELDS: ParamField[] = [
  { path: 'length', label: 'Length', kind: 'length' },
  { path: 'height', label: 'Height', kind: 'length' },
  { path: 'thickness', label: 'Thickness', kind: 'length' },
  { path: 'casings', label: 'Casings', kind: 'choice', options: ['both', 'front'] },
  { path: 'finishes.wall', label: 'Wall', kind: 'finish' },
  { path: 'finishes.trim', label: 'Trim', kind: 'finish' },
  { path: 'finishes.doors', label: 'Doors', kind: 'finish' },
  { path: 'finishes.windows', label: 'Windows', kind: 'finish' },
];

registerGenerator<WallPieceParams>({
  type: 'wall',
  version: 1,
  schema: wallPieceSchema as unknown as z.ZodType<WallPieceParams>,
  describe:
    'One wall of a floor plan on its own (decor; an imported house has one per wall). Its assembly transform places it (it moves ' +
    'and turns); local x runs along it from its start, its front (+Z) is the room side. length, height, thickness, casings ("both" | ' +
    '"front"), finishes {wall?, trim?, doors?, windows?}. openings like the room openings, minus wall, with at = the distance of the ' +
    'center from the start; hinge is seen from the front, swing "in" opens toward it. Roles: wall, window-<id>, casing-<id>, ' +
    'casing-back-<id>, door-<id>.',
  surroundings: true,
  movable: true,
  collapse: true,
  lockedParts: true,
  fields: FIELDS,
  generate: (p) => generate(p),
  faceDrive,
  actions,
  materialRefs: () => [],
});
