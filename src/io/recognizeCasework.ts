import type { V3 } from '../geometry/types';
import { formatInches, inches } from '../model/units';
import type { Mat3 } from '../model/world';
import type { CarcassParams } from '../plugins/generators/carcass';
import { generators } from '../plugins/registry';
import type { ColladaMaterial } from './collada';
import { partCorners } from './recognizeWalls';
import type { IR, IRAsm, IRNative, IRPart } from './sketchupImport';

/**
 * Cabinets and countertops in an imported SketchUp model, as the app's own: a group of boards that
 * is a cabinet box becomes a carcass (its sides, top, bottom and back; a riser or kick under it as a
 * toe kick; drawer fronts stacked top-down over one door or a pair, hinged as their lh / rh names
 * say, even ones drawn swung open; its shelves), and a slab at counter height on cabinets becomes a
 * countertop cut from slab stock. Boards are known by name first — `left_side`, `top`, `back`,
 * `door_1_lh`, `drawer_2_drawer_face`… as cabinet extensions name them — then by shape and where
 * they sit. What a cabinet holds that the generator doesn't make (a closet rod) stays in it as it
 * was; a group that doesn't make a cabinet the generator can build stays as it was imported.
 * World coordinates, model units.
 */

const I = inches;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const column = (m: Mat3, k: number): V3 => [m[0][k]!, m[1][k]!, m[2][k]!];
const fromColumns = (a: V3, b: V3, c: V3): Mat3 => [0, 1, 2].map((i) => [a[i]!, b[i]!, c[i]!]) as Mat3;
const UP: V3 = [0, 1, 0];
/** Panels this thin at most. */
const PANEL = I(1.5);
/** Edges this close line up. */
const NEAR = I(1);

type Role = 'side' | 'top' | 'bottom' | 'back' | 'shelf' | 'kick' | 'door' | 'drawerFront' | 'drawerBox' | 'extra';

/** A board of a cabinet, measured in the cabinet's frame. */
interface Board {
  part: IRPart;
  /** Its names inside the cabinet (the cabinet's own name taken off), lower-cased: `_drawer_1/_drawer_1_drawer_face`. */
  label: string;
  min: V3;
  max: V3;
  /** Square to the frame: a door drawn swung open isn't. */
  square: boolean;
  role: Role | null;
}

/** What a board is by its names, or null. */
export function namedRole(label: string): Role | null {
  const last = label.split('/').at(-1)!;
  if (/rod|pull|handle|knob|hinge|bracket|hardware/.test(label)) return 'extra';
  if (/drawer/.test(label)) return /box/.test(label) || !/face|front/.test(last) ? 'drawerBox' : 'drawerFront';
  if (/door/.test(label)) return 'door';
  if (/riser|kick|toe|plinth/.test(label)) return 'kick';
  if (/shelf/.test(last)) return 'shelf';
  if (/side$/.test(last)) return 'side';
  if (/(^|[^a-z])top$/.test(last)) return 'top';
  if (/(^|[^a-z])bottom$/.test(last)) return 'bottom';
  if (/(^|[^a-z])back$/.test(last)) return 'back';
  return null;
}

/** Every board in a group, with the names of the groups it's in below it. */
function boardsOf(asm: IRAsm): { part: IRPart; names: string[] }[] {
  const out: { part: IRPart; names: string[] }[] = [];
  const visit = (ir: IR, names: string[]) => {
    if (ir.kind === 'part') out.push({ part: ir, names: [...names, ir.name] });
    else if (ir.kind === 'asm') for (const c of ir.children) visit(c, [...names, ir.name]);
  };
  for (const c of asm.children) visit(c, []);
  return out;
}

/** The frame turned `quarters` quarter turns about its up axis. */
function turned(F: Mat3, quarters: number): Mat3 {
  const [x, y, z] = [column(F, 0), column(F, 1), column(F, 2)];
  const q = ((quarters % 4) + 4) % 4;
  const neg = (v: V3) => v.map((c) => -c) as V3;
  const cols: [V3, V3, V3][] = [
    [x, y, z],
    [neg(z), y, x],
    [neg(x), y, neg(z)],
    [z, y, neg(x)],
  ];
  return fromColumns(...cols[q]!);
}

/** A part's box in a frame, and whether it's square to it. */
function inFrame(F: Mat3, p: IRPart): { min: V3; max: V3; square: boolean } {
  const pts = partCorners(p).map((c) => [0, 1, 2].map((k) => dot(column(F, k), c)) as V3);
  const min = [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]!))) as V3;
  const max = [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k]!))) as V3;
  const square = [0, 1, 2].every((k) => [0, 1, 2].every((j) => {
    const c = Math.abs(dot(column(F, k), column(p.R, j)));
    return c < 1e-3 || c > 1 - 1e-3;
  }));
  return { min, max, square };
}

const size = (b: Pick<Board, 'min' | 'max'>, k: number) => b.max[k]! - b.min[k]!;
const thinAxis = (b: Pick<Board, 'min' | 'max'>) => [0, 1, 2].reduce((t, k) => (size(b, k) < size(b, t) ? k : t), 0);

/** Roles for boards no name gave one, from their shape and place in the cabinet's box. */
function shapeRoles(boards: Board[]): void {
  const solid = boards.filter((b) => b.role !== 'extra');
  const min = [0, 1, 2].map((k) => Math.min(...solid.map((b) => b.min[k]!))) as V3;
  const max = [0, 1, 2].map((k) => Math.max(...solid.map((b) => b.max[k]!))) as V3;
  const box = { min, max };
  for (const b of boards) {
    if (b.role || !b.square) continue;
    const t = thinAxis(b);
    if (size(b, t) > PANEL) continue;
    if (t === 0 && size(b, 1) >= 0.5 * size(box, 1) && size(b, 2) >= 0.5 * size(box, 2) && (b.min[0] - min[0] <= NEAR || max[0] - b.max[0] <= NEAR)) b.role = 'side';
    else if (t === 2 && b.min[2] - min[2] <= NEAR && size(b, 0) >= 0.6 * size(box, 0) && size(b, 1) >= 0.4 * size(box, 1)) b.role = 'back';
    else if (t === 2 && max[2] - b.max[2] <= NEAR && size(b, 0) >= 0.25 * size(box, 0) && size(b, 1) > I(15)) b.role = 'door';
    else if (t === 1 && size(b, 0) >= 0.6 * size(box, 0) && size(b, 2) >= 0.5 * size(box, 2)) b.role = 'shelf';
  }
  // The lowest and highest full-size flat panels are the bottom and the top.
  const flats = boards.filter((b) => b.role === 'shelf').sort((a, b) => a.min[1] - b.min[1]);
  if (!boards.some((b) => b.role === 'bottom') && flats[0]) flats[0].role = 'bottom';
  if (!boards.some((b) => b.role === 'top') && flats.length > 1) flats.at(-1)!.role = 'top';
}

/** How well a frame fits the boards: sides thin across it, the back at its back, fronts at its front. */
function score(boards: Board[]): number {
  let s = 0;
  const sides = boards.filter((b) => b.role === 'side' && b.square);
  if (sides.length === 2 && sides.every((b) => thinAxis(b) === 0)) s += 4;
  const all = boards.filter((b) => b.role !== 'extra');
  const zMin = Math.min(...all.map((b) => b.min[2]));
  const zMax = Math.max(...all.map((b) => b.max[2]));
  for (const b of boards) {
    if (!b.square) continue;
    if (b.role === 'back') s += b.min[2] - zMin <= NEAR ? 2 : -2;
    if (b.role === 'door' || b.role === 'drawerFront') s += zMax - b.max[2] <= NEAR ? 1 : -1;
  }
  return s;
}

const sixteenth = (u: number) => Math.round(u / 4) * 4;
const madeOf = (p: IRPart): { mat: ColladaMaterial | null; thickness: number } => ({ mat: p.mat, thickness: p.thickness });

/** Whether the carcass generator builds these params (with stand-in materials of the right thicknesses). */
function builds(params: CarcassParams, thickness: Record<string, number>): boolean {
  try {
    const parsed = generators.get('carcass').schema.parse(params);
    const materials = Object.fromEntries(Object.entries(thickness).map(([id, t]) => [id, { id, name: id, thickness: t, color: '#ffffff', stock: 'sheet' as const }]));
    generators.get('carcass').generate(parsed, { materials });
    return true;
  } catch {
    return false;
  }
}

/** A group as a cabinet the carcass generator builds, or null. */
export function cabinetFrom(asm: IRAsm): IRNative | null {
  if (Math.abs(column(asm.R, 1)[1]!) < 0.999) return null;
  const raw = boardsOf(asm);
  if (raw.length < 3 || raw.length > 400) return null;
  const strip = (name: string) => {
    const n = name.toLowerCase();
    const own = asm.name.toLowerCase();
    return own && n.startsWith(own) ? n.slice(own.length) : n;
  };
  const labels = raw.map((r) => r.names.map(strip).join('/'));
  const named = labels.map(namedRole);
  // Up the right way (its own up), then whichever quarter turn fits the boards best.
  const F0 = column(asm.R, 1)[1]! > 0 ? asm.R : fromColumns(column(asm.R, 0), UP, column(asm.R, 2).map((c) => -c) as V3);
  let best: { F: Mat3; boards: Board[]; score: number } | null = null;
  for (let q = 0; q < 4; q++) {
    const F = turned(F0, q);
    const boards = raw.map((r, i): Board => ({ part: r.part, label: labels[i]!, ...inFrame(F, r.part), role: named[i]! }));
    shapeRoles(boards);
    const s = score(boards);
    if (!best || s > best.score) best = { F, boards, score: s };
  }
  const { F, boards } = best!;
  const byRole = (role: Role) => boards.filter((b) => b.role === role);
  const sides = byRole('side').filter((b) => b.square && thinAxis(b) === 0).sort((a, b) => a.min[0] - b.min[0]);
  if (sides.length !== 2) return null;
  const [left, right] = sides as [Board, Board];
  if (left.max[0] > right.min[0]) return null;
  const tops = byRole('top');
  const bottoms = byRole('bottom');
  if (!tops.length && !bottoms.length) return null;
  // Without names to go by, everything must be a part of the box.
  if (!named.some(Boolean) && boards.some((b) => !b.role)) return null;

  const solid = boards.filter((b) => b.role !== 'extra' && b.role !== null);
  const x0 = left.min[0];
  const x1 = right.max[0];
  const yBase = Math.min(...solid.filter((b) => b.square).map((b) => b.min[1]));
  const yTop = Math.max(...[...sides, ...tops].map((b) => b.max[1]));
  const box = [left, right, ...tops, ...bottoms, ...byRole('back')].filter((b) => b.square);
  const zBack = Math.min(...box.map((b) => b.min[2]));
  const zFront = Math.max(...[left, right, ...tops, ...bottoms].filter((b) => b.square).map((b) => b.max[2]));
  const [W, H, D] = [x1 - x0, yTop - yBase, zFront - zBack].map(Math.round) as [number, number, number];
  if (W < I(6) || W > I(120) || H < I(6) || H > I(120) || D < I(4) || D > I(48)) return null;

  const back = byRole('back').filter((b) => b.square).sort((a, b) => size(b, 0) * size(b, 1) - size(a, 0) * size(a, 1))[0];
  const applied = !!back && back.min[0] <= x0 + 2 && back.max[0] >= x1 - 2 && Math.min(left.min[2], right.min[2]) >= back.max[2] - 2;
  const bottom = bottoms.sort((a, b) => a.min[1] - b.min[1])[0];
  const kickH = bottom ? Math.round(bottom.min[1] - yBase) : 0;
  const kicks = byRole('kick').filter((b) => b.square);
  const kickFront = kicks.length ? Math.max(...kicks.map((b) => b.max[2])) : zFront;
  const toeKick = kickH >= I(1) ? { height: kickH, depth: Math.max(0, Math.round(zFront - kickFront)) } : null;

  const fronts = byRole('drawerFront').filter((b) => b.square).sort((a, b) => b.max[1] - a.max[1]);
  const doors = byRole('door');
  if (doors.length > 2) return null;
  // Doors go below the drawers (a door swung open about its hinge still spans the same height).
  if (fronts.length && doors.length && Math.max(...doors.map((d) => d.max[1])) > Math.min(...fronts.map((f) => f.min[1])) + NEAR) return null;
  const heights = fronts.map((f) => sixteenth(size(f, 1)));
  if (heights.length && !doors.length) heights[heights.length - 1] = 0;
  const shelves = byRole('shelf').filter((b) => !fronts.length || b.max[1] < Math.min(...fronts.map((f) => f.min[1])));
  const hinge = doors.length === 1 ? (/(^|[^a-z])(lh|left)([^a-z]|$)/.test(doors[0]!.label) ? 'left' : /(^|[^a-z])(rh|right)([^a-z]|$)/.test(doors[0]!.label) ? 'right' : undefined) : undefined;

  // What it's cut from: the sides, the back, the fronts, the drawer boxes' sides and bottoms.
  const boxParts = byRole('drawerBox');
  const boxSide = boxParts.find((b) => b.square && thinAxis(b) === 0) ?? boxParts[0];
  const boxBottom = boxParts.find((b) => b.square && thinAxis(b) === 1);
  const front = fronts[0] ?? doors[0];
  const materials: NonNullable<IRNative['materials']> = { material: madeOf(left.part) };
  if (back) materials.backMaterial = madeOf(back.part);
  if (front) materials.frontMaterial = madeOf(front.part);
  if (fronts.length && boxSide) materials.drawerMaterial = madeOf(boxSide.part);
  if (fronts.length && boxBottom) materials.drawerBottomMaterial = madeOf(boxBottom.part);

  const params: CarcassParams = {
    width: W,
    height: H,
    depth: D,
    material: 'material',
    back: back ? (applied ? 'applied' : 'inset') : 'none',
    toeKick,
    shelves: shelves.length,
    joinery: 'butt',
    drawers: heights,
    doors: doors.length,
    pulls: null,
    ...(hinge && { doorHinge: hinge }),
  };
  for (const key of ['backMaterial', 'frontMaterial', 'drawerMaterial', 'drawerBottomMaterial'] as const) if (materials[key]) params[key] = key;
  const thickness = Object.fromEntries(Object.entries(materials).map(([k, m]) => [k, m.thickness]));
  if (!builds(params, thickness)) {
    // Fronts that don't quite fit its reveals: let the last one take what's left (no doors under it).
    if (doors.length || !heights.length) return null;
    params.drawers = heights.map((h, i) => (i === heights.length - 1 ? 0 : h));
    if (!builds(params, thickness)) return null;
  }

  const o = [0, 1, 2].map((k) => column(F, 0)[k]! * x0 + column(F, 1)[k]! * yBase + column(F, 2)[k]! * zBack) as V3;
  const extras = boards.filter((b) => b.role === 'extra' || b.role === null).map((b) => b.part);
  const kind = yBase >= I(30) ? 'Wall cabinet' : H >= I(60) ? 'Tall cabinet' : fronts.length && !doors.length ? 'Drawer base' : 'Base cabinet';
  const generic = /^(group|component|part|piece)?[\s_#-]*\d*$/i.test(asm.name.trim());
  return {
    kind: 'native',
    name: generic ? `${kind} ${formatInches(W)}` : asm.name,
    R: F,
    o,
    size: [W, H, D],
    generator: { type: 'carcass', params: params as unknown as Record<string, unknown> },
    materials,
    ...(extras.length && { children: extras }),
    fallback: asm,
  };
}

const worldBox = (p: Pick<IRPart, 'R' | 'o' | 'size'>) => {
  const pts = partCorners(p);
  return { min: [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]!))) as V3, max: [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k]!))) as V3 };
};

/**
 * Whether a board is a countertop: a slab 3/4"–3" thick, its top 28"–46" up, at least 12" by 18",
 * lying on one of the cabinets.
 */
export function isCounter(p: IRPart, cabinets: IRNative[]): boolean {
  if (p.shape?.type !== 'box') return false;
  const up = [0, 1, 2].find((k) => Math.abs(column(p.R, k)[1]!) > 0.999);
  if (up === undefined) return false;
  const t = p.size[up]!;
  const flat = [0, 1, 2].filter((k) => k !== up).map((k) => p.size[k]!).sort((a, b) => a - b);
  const b = worldBox(p);
  if (t < I(0.75) || t > I(3) || b.max[1] < I(28) || b.max[1] > I(46) || flat[0]! < I(12) || flat[1]! < I(18)) return false;
  return cabinets.some((c) => {
    const cb = worldBox(c);
    const over = (k: number) => Math.min(cb.max[k]!, b.max[k]!) - Math.max(cb.min[k]!, b.min[k]!);
    return cb.max[1] >= b.min[1] - I(1.5) && cb.max[1] <= b.min[1] + I(0.25) && over(0) > I(3) && over(2) > I(3);
  });
}
