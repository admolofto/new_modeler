import { generators } from '../plugins/registry';
import { openingLabel, wallFrame, wallOpening, wallToRoom, type OpeningSpec, type RoomOpening, type RoomSide } from '../plugins/generators/room';
import { wallCut, type WallPieceParams } from '../plugins/generators/wall';
import { decorInfo } from './decor';
import { roomParams, rooms } from './room';
import type { Doc } from './schema';
import { inches } from './units';
import { hiddenNodes } from './visibility';
import { allAffines, apply, composeAffine, invertAffine, localBox, nodeAffine, transformBox, union, worldBoxes, type Affine, type Box3 } from './world';

/**
 * The model seen from above as a floor plan (the 2D sketch view): the rooms' walls, cut at their
 * openings, with doors (leaf and swing), windows and cased openings; and every piece standing in
 * the room — cabinets, appliances, furniture, blocks — as its footprint, with its front marked and
 * whether it's a base, an upper or a tall one. Pure; points are world [x, z] in model units, so a
 * plan drawn with x right and z down is the room seen from above with its front wall at the bottom.
 */

export type P2 = [number, number];

export interface PlanWall {
  side: RoomSide;
  /** One closed outline per stretch of wall between openings. */
  pieces: P2[][];
}

/** An opening as the plan draws it, in a room's wall or a wall piece. */
export interface PlanWallOpening {
  id: string;
  kind: RoomOpening['kind'];
  label: string;
  width: number;
  /** Its jambs: the left one (as seen from inside) and the right one, on the inside face and the outside face. */
  inside: [P2, P2];
  outside: [P2, P2];
  /** A door's leaf, drawn open: the hinge, the leaf's far end, and its swing (an arc from closed to open). */
  door?: { hinge: P2; leaf: P2; arc: P2[] };
}

/** An opening in one of a room's walls. */
export interface PlanOpening extends PlanWallOpening {
  wall: RoomSide;
  room: string;
}

export interface PlanRoom {
  id: string;
  /** Inside faces of the walls. */
  min: P2;
  max: P2;
  walls: PlanWall[];
  openings: PlanOpening[];
}

export type PlanItemKind = 'cabinet' | 'appliance' | 'furniture' | 'accessory' | 'block' | 'part' | 'wall';
/** Base: stands on the floor; upper: hangs above the counter (dashed in a plan); tall: floor to above it. */
export type PlanLevel = 'base' | 'upper' | 'tall';

export interface PlanItem {
  /** The node to select for it. */
  id: string;
  name: string;
  kind: PlanItemKind;
  level: PlanLevel;
  /** Its footprint, in order around it: back-left, back-right, front-right, front-left (its own frame). */
  corners: [P2, P2, P2, P2];
  /** Its own width (x) and depth (z). */
  width: number;
  depth: number;
  /** Bottom and top, world y. */
  bottom: number;
  top: number;
  /** A wall piece: its outline, cut at its openings (one closed outline per stretch), and the openings. */
  wall?: { pieces: P2[][]; openings: PlanWallOpening[] };
}

export interface Plan {
  rooms: PlanRoom[];
  items: PlanItem[];
  /** Everything drawn (walls' outsides included), or null for an empty model. */
  bounds: { min: P2; max: P2 } | null;
}

/** Above this off the floor, a piece is an upper. */
export const UPPER_BOTTOM = inches(30);
/** A floor piece reaching this high is tall (a pantry, a fridge). */
export const TALL_TOP = inches(60);

const APPLIANCES = new Set(['fridge', 'range', 'dishwasher', 'microwave']);

const xz = (A: Affine, x: number, y: number, z: number): P2 => {
  const p = apply(A, [x, y, z]);
  return [p[0], p[2]];
};

/**
 * An opening's footprint through a wall `T` thick (wall-local x from `l` to `r`; its room side at
 * z = T), and a door's leaf drawn open toward the side it swings to. `at` maps wall-local (x, z) to the plan.
 */
function planOpening(o: OpeningSpec, l: number, r: number, T: number, at: (x: number, z: number) => P2): PlanWallOpening {
  const op: PlanWallOpening = { id: o.id, kind: o.kind, label: openingLabel(o), width: o.width, inside: [at(l, T), at(r, T)], outside: [at(l, 0), at(r, 0)] };
  if (o.kind === 'door' && o.leaf !== 'none') {
    // Wall-local: x along the wall (left → right from the room side), z into the room.
    const hx = o.hinge === 'left' ? l : r;
    const ux = o.hinge === 'left' ? 1 : -1;
    const [hz, uz] = o.swing === 'in' ? [T, 1] : [0, -1];
    const end = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return at(hx + ux * o.width * Math.cos(a), hz + uz * o.width * Math.sin(a));
    };
    const steps = Math.max(4, Math.ceil(o.angle / 6));
    op.door = { hinge: at(hx, hz), leaf: end(o.angle), arc: Array.from({ length: steps + 1 }, (_, i) => end((o.angle * i) / steps)) };
  }
  return op;
}

/** A wall piece from above: the stretches of wall between its openings, and the openings. */
function planWallPiece(doc: Doc, id: string): NonNullable<PlanItem['wall']> {
  const p = doc.assemblies[id]!.generator!.params as unknown as WallPieceParams;
  const A = nodeAffine(doc, id);
  const T = p.thickness;
  const at = (x: number, z: number) => xz(A, x, 0, z);
  const cuts = p.openings.map(wallCut).sort((a, b) => a.x - b.x);
  const pieces: P2[][] = [];
  let from = 0;
  for (const c of [...cuts, { x: p.length, w: 0 }]) {
    if (c.x - from > 0) pieces.push([at(from, 0), at(c.x, 0), at(c.x, T), at(from, T)]);
    from = Math.max(from, c.x + c.w);
  }
  const openings = p.openings.map((o) => {
    const w = wallCut(o);
    return planOpening(o, w.x, w.x + w.w, T, at);
  });
  return { pieces, openings };
}

function planRoom(doc: Doc, id: string): PlanRoom {
  const asm = doc.assemblies[id]!;
  const p = roomParams(asm);
  const A = nodeAffine(doc, id);
  const T = p.wallThickness;
  const at = (side: RoomSide, x: number, z: number) => xz(A, ...wallToRoom(p, side, [x, 0, z]));
  const walls: PlanWall[] = [];
  const openings: PlanOpening[] = [];
  for (const side of p.walls) {
    const len = wallFrame(p, side).length;
    const cuts = p.openings
      .filter((o) => o.wall === side)
      .map((o) => wallOpening(p, o))
      .sort((a, b) => a.x - b.x);
    const pieces: P2[][] = [];
    let from = 0;
    for (const c of [...cuts, { x: len, w: 0 }]) {
      if (c.x - from > 0) pieces.push([at(side, from, 0), at(side, c.x, 0), at(side, c.x, T), at(side, from, T)]);
      from = Math.max(from, c.x + c.w);
    }
    walls.push({ side, pieces });
    for (const o of p.openings) {
      if (o.wall !== side) continue;
      const w = wallOpening(p, o);
      openings.push({ ...planOpening(o, w.x, w.x + w.w, T, (x, z) => at(side, x, z)), wall: side, room: id });
    }
  }
  const min = xz(A, p.left, 0, p.back);
  const max = xz(A, p.right, 0, p.front);
  return { id, min: [Math.min(min[0], max[0]), Math.min(min[1], max[1])], max: [Math.max(min[0], max[0]), Math.max(min[1], max[1])], walls, openings };
}

/**
 * What a plan draws as one piece: a cabinet or appliance (a generator), a block, a prop; a loose
 * part. Plain folders are looked into; the room's own pieces (walls, trim, doors) are the room's.
 */
function pieces(doc: Doc, hidden: Set<string>): { id: string; kind: PlanItemKind }[] {
  const out: { id: string; kind: PlanItemKind }[] = [];
  const visit = (id: string) => {
    if (hidden.has(id)) return;
    const part = doc.parts[id];
    if (part) {
      if (part.role !== undefined) return;
      if (part.block) return void out.push({ id, kind: 'block' });
      const info = decorInfo(part.shape.type);
      if (!info) return void out.push({ id, kind: 'part' });
      if (info.category === 'furniture' || info.category === 'appliance' || info.category === 'accessory') out.push({ id, kind: info.category });
      return;
    }
    const asm = doc.assemblies[id];
    if (!asm) return;
    const gen = asm.generator;
    if (gen && generators.has(gen.type) && generators.get(gen.type).surroundings) {
      // A wall piece is a piece of its own (it moves); the room isn't.
      if (generators.get(gen.type).movable) return void out.push({ id, kind: 'wall' });
      // Only what was put in the room by hand: its own pieces have roles.
      for (const c of asm.children) if ((doc.parts[c] ?? doc.assemblies[c])?.role === undefined) visit(c);
      return;
    }
    if (gen) return void out.push({ id, kind: APPLIANCES.has(gen.type) ? 'appliance' : 'cabinet' });
    for (const c of asm.children) visit(c);
  };
  for (const id of doc.roots) visit(id);
  return out;
}

/** A node's bounds in its own frame: a part's, or its parts' (and the world y they span). */
function ownBox(doc: Doc, id: string, affines: Map<string, Affine>, world: Map<string, Box3>, local: (part: string) => Box3 | null): Box3 | null {
  const A = affines.get(id);
  if (!A) return null;
  if (doc.parts[id]) return local(id);
  const inv = invertAffine(A);
  const boxes: Box3[] = [];
  const walk = (c: string) => {
    if (doc.parts[c]) {
      const B = affines.get(c);
      const b = local(c);
      if (B && b) boxes.push(transformBox(composeAffine(inv, B), b));
    } else for (const k of doc.assemblies[c]?.children ?? []) walk(k);
  };
  walk(id);
  return boxes.length && world.has(id) ? union(boxes) : null;
}

const plans = new WeakMap<Doc, Plan>();

/** The floor plan of a doc. Memoized per doc. */
export function floorPlan(doc: Doc): Plan {
  const hit = plans.get(doc);
  if (hit) return hit;
  const hidden = hiddenNodes(doc);
  const affines = allAffines(doc);
  const world = worldBoxes(doc);
  const locals = new Map<string, Box3 | null>();
  const local = (id: string) => {
    if (!locals.has(id)) {
      let b: Box3 | null = null;
      try {
        b = localBox(doc, id);
      } catch {
        // a part that doesn't build: left out
      }
      locals.set(id, b);
    }
    return locals.get(id)!;
  };

  const planRooms = rooms(doc)
    .filter((r) => !hidden.has(r.id))
    .map((r) => planRoom(doc, r.id));
  const items: PlanItem[] = [];
  for (const { id, kind } of pieces(doc, hidden)) {
    const box = ownBox(doc, id, affines, world, local);
    const wb = world.get(id);
    if (!box || !wb) continue;
    const A = affines.get(id)!;
    const [x0, x1, z0, z1] = [box.min[0], box.max[0], box.min[2], box.max[2]];
    const [bottom, top] = [wb.min[1], wb.max[1]];
    const level: PlanLevel = bottom >= UPPER_BOTTOM ? 'upper' : top >= TALL_TOP ? 'tall' : 'base';
    const node = doc.parts[id] ?? doc.assemblies[id]!;
    items.push({
      id,
      name: node.name,
      kind,
      level,
      corners: [xz(A, x0, 0, z0), xz(A, x1, 0, z0), xz(A, x1, 0, z1), xz(A, x0, 0, z1)],
      width: x1 - x0,
      depth: z1 - z0,
      bottom,
      top,
      ...(kind === 'wall' && { wall: planWallPiece(doc, id) }),
    });
  }
  // Walls first and uppers last, so each draws over what's under it.
  const order = (i: PlanItem) => (i.kind === 'wall' ? 0 : i.level === 'upper' ? 2 : 1);
  items.sort((a, b) => order(a) - order(b));

  const pts: P2[] = [
    ...planRooms.flatMap((r) => [r.min, r.max, ...r.walls.flatMap((w) => w.pieces.flat()), ...r.openings.flatMap((o) => o.door?.arc ?? [])]),
    ...items.flatMap((i) => [...i.corners, ...(i.wall?.openings.flatMap((o) => o.door?.arc ?? []) ?? [])]),
  ];
  const bounds = pts.length
    ? { min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as P2, max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as P2 }
    : null;
  const plan = { rooms: planRooms, items, bounds };
  plans.set(doc, plan);
  return plan;
}
