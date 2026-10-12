import { z } from 'zod';
import type { V3 } from '../../geometry/types';
import { Finish, type Vec3 } from '../../model/schema';
import { formatInches as f, inches } from '../../model/units';
import { PluginError, registerGenerator, type GenFace, type GenFaceDrive, type GenGroup, type GenMotion, type GenOutput, type GenPart, type ParamField } from '../registry';
import { BLACK_GLASS, type ApplianceBodyParams, type ApplianceDoorParams, type Detail } from '../shapes/decor/appliance';
import { pullBox, type PullParams } from '../shapes/decor/hardware';

/**
 * Appliance generators (A8): a fridge, a range, a dishwasher and a microwave, each a body with
 * cavities behind doors and drawers that open (hinges and slides, so they open on a click in
 * presentation), handles (`pull`s, mounted on their doors) and its look. Decor throughout: never in the
 * cut list. Origin at the left-back-bottom corner, front +Z; width / height / depth are the overall
 * box, doors included (handles stand proud of it), so an appliance can replace its block exactly.
 * The snapshot shows each as one line (`collapse`); only the outer faces push and pull (`lockedParts`).
 */

export const APPLIANCE_LOOKS = ['stainless', 'black', 'white', 'panel'] as const;
export type ApplianceLook = (typeof APPLIANCE_LOOKS)[number];

interface Common {
  width: number;
  height: number;
  depth: number;
  /** Stainless, black, white, or panel-ready (doors in `panelFinish`, to match the cabinets). */
  finish: ApplianceLook;
  panelFinish: Finish;
}

const PANEL: Finish = { preset: 'paint', color: '#f2f0eb' };
const LINER: Finish = { preset: 'paint', color: '#eef0f1', roughness: 0.4 };
const ENAMEL: Finish = { preset: 'paint', color: '#26272b', roughness: 0.3 };
const BIN: Finish = { preset: 'paint', color: '#d6dadd', roughness: 0.45 };
const GAP = inches(1 / 8);

/** Doors, body and handles for a look. */
function looks(p: Common): { door: Finish; body: Finish; handle: Finish } {
  switch (p.finish) {
    case 'black':
      return { door: { preset: 'metal:matte-black' }, body: { preset: 'metal:matte-black' }, handle: { preset: 'metal:matte-black' } };
    case 'white':
      return { door: { preset: 'lacquer', color: '#f3f3f0', roughness: 0.2 }, body: { preset: 'lacquer', color: '#f3f3f0', roughness: 0.2 }, handle: { preset: 'metal:stainless' } };
    case 'panel':
      return { door: structuredClone(p.panelFinish), body: { preset: 'paint', color: '#3a3c3f' }, handle: { preset: 'metal:brushed-nickel' } };
    default:
      return { door: { preset: 'metal:stainless' }, body: { preset: 'metal:stainless' }, handle: { preset: 'metal:stainless' } };
  }
}

/** Collects an appliance's parts, folders and motions; `group` is the folder parts go in. */
function builder() {
  const out = { parts: [] as GenPart[], groups: [] as GenGroup[], joints: [], motions: [] as GenMotion[] };
  let group: string | undefined;
  const part = (role: string, name: string, type: string, params: object, position: Vec3, extra: Partial<GenPart> = {}) =>
    out.parts.push({ role, name, grain: 'none', position, shape: { type, params: params as Record<string, unknown> }, ...(group !== undefined && { group }), ...extra });
  return {
    out: out as GenOutput & { motions: GenMotion[] },
    part,
    inFolder(role: string, name: string, fill: () => void) {
      out.groups.push({ role, name });
      group = role;
      fill();
      group = undefined;
    },
    /** A pull centered at (cx, cy) on the face at z, mounted on `on`. */
    pull(role: string, name: string, params: PullParams, cx: number, cy: number, z: number, on: string) {
      const [bx, by] = pullBox(params);
      part(role, name, 'pull', params, [Math.round(cx - bx / 2), Math.round(cy - by / 2), z], { mountedOn: on });
    },
  };
}

const body = (x: number, y: number, z: number, cavities: ApplianceBodyParams['cavities'], details: Detail[], finish: Finish, inner: Finish): ApplianceBodyParams => ({ x, y, z, cavities, details, finish, inner });
const door = (x: number, y: number, z: number, finish: Finish, inner: Finish, window: ApplianceDoorParams['window'] = null): ApplianceDoorParams => ({ x, y, z, window, finish, inner, glass: { ...BLACK_GLASS } });
/** A drawer's bin: a tub open at the top. */
const bin = (x: number, y: number, z: number, finish: Finish): ApplianceBodyParams => {
  const t = inches(1 / 4);
  return body(x, y, z, [{ id: 'cav-bin', min: [t, t, t], max: [x - t, y, z - t], axis: 1 }], [], finish, finish);
};
/** A bar handle: `length` center to center, `size` thick, standing `projection` off the face. */
const bar = (length: number, orientation: 'h' | 'v', finish: Finish, size = inches(5 / 8), projection = inches(1.75)): PullParams => ({ style: 'bar', length, size, projection, orientation, finish: structuredClone(finish) });
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));

/** Glass shelves (or racks) across a cavity, `n` of them evenly up it, set into its walls. */
function shelves(cav: { min: V3; max: V3 }, n: number, tag: 'shelf' | 'rack', front = inches(1)): Detail[] {
  return Array.from({ length: n }, (_, i): Detail => {
    const y = Math.round(cav.min[1] + ((cav.max[1] - cav.min[1]) * (i + 1)) / (n + 1));
    return { kind: 'box', min: [cav.min[0] - 16, y, cav.min[2] - 16], max: [cav.max[0] + 16, y + (tag === 'shelf' ? 16 : 12), cav.max[2] - front], tag };
  });
}

const DIMS = ['width', 'height', 'depth'] as const;

/** The outer faces resize it, as on a carcass; min-side faces also move it so the far side stays put. */
function faceDrive(p: Common, face: GenFace): GenFaceDrive | null {
  const size = [p.width, p.height, p.depth][face.axis]!;
  if (face.max && face.plane === size) return { param: DIMS[face.axis], label: DIMS[face.axis], sign: 1 };
  if (!face.max && face.plane === 0) return { param: DIMS[face.axis], label: DIMS[face.axis], sign: 1, moveOrigin: true };
  return null;
}

const commonSchema = (w: [number, number, number], h: [number, number, number], d: [number, number, number]) => ({
  width: z.int().min(inches(w[0])).max(inches(w[1])).default(inches(w[2])),
  height: z.int().min(inches(h[0])).max(inches(h[1])).default(inches(h[2])),
  depth: z.int().min(inches(d[0])).max(inches(d[1])).default(inches(d[2])),
  finish: z.enum(APPLIANCE_LOOKS).default('stainless'),
  panelFinish: Finish.default(() => ({ ...PANEL })),
});

const sizeFields: ParamField[] = [
  { path: 'width', label: 'Width', kind: 'length' },
  { path: 'height', label: 'Height', kind: 'length' },
  { path: 'depth', label: 'Depth', kind: 'length' },
];
const lookFields: ParamField[] = [
  { path: 'finish', label: 'Finish', kind: 'choice', options: [...APPLIANCE_LOOKS] },
  { path: 'panelFinish', label: 'Panels', kind: 'finish' },
];
const LOOK_DOC = 'finish "stainless" | "black" | "white" | "panel" (doors in panelFinish)';

// ── fridge ───────────────────────────────────────────────────────────────────

export const FRIDGE_STYLES = ['french', 'side-by-side', 'top-freezer', 'bottom-freezer', 'column'] as const;

export interface FridgeParams extends Common {
  style: (typeof FRIDGE_STYLES)[number];
  /** Single doors' hinge side. */
  hinge: 'left' | 'right';
  handle: 'bar' | 'pocket';
}

function fridge(p: FridgeParams): GenOutput {
  const { width: W, height: H, depth: D } = p;
  const L = looks(p);
  const T = inches(2.25);
  const B = D - T;
  const base = inches(3.5);
  const wall = inches(1.5);
  const back = inches(2);
  if (B < inches(12)) throw new PluginError(`a fridge ${f(D)} deep is too shallow`);
  const g = builder();
  const fz = Math.round((H - base) * (p.style === 'top-freezer' ? 0.28 : 0.3));
  type Space = { id: string; x0: number; x1: number; y0: number; y1: number; shelves: number };
  type Door = { role: string; name: string; x0: number; x1: number; y0: number; y1: number; side: 'left' | 'right'; handleAt: number };
  const spaces: Space[] = [];
  const doors: Door[] = [];
  let drawer: { y0: number; y1: number } | null = null;
  const half = Math.round(W / 2);
  switch (p.style) {
    case 'french':
      spaces.push({ id: 'cav-fresh', x0: 0, x1: W, y0: base + fz, y1: H, shelves: 3 }, { id: 'cav-freezer', x0: 0, x1: W, y0: base, y1: base + fz, shelves: 0 });
      doors.push(
        { role: 'door-left', name: 'Left door', x0: 0, x1: half - GAP / 2, y0: base + fz + GAP, y1: H, side: 'left', handleAt: 0.38 },
        { role: 'door-right', name: 'Right door', x0: half + GAP / 2, x1: W, y0: base + fz + GAP, y1: H, side: 'right', handleAt: 0.38 },
      );
      drawer = { y0: base, y1: base + fz };
      break;
    case 'side-by-side': {
      const fw = Math.round(W * 0.42);
      spaces.push({ id: 'cav-freezer', x0: 0, x1: fw, y0: base, y1: H, shelves: 4 }, { id: 'cav-fresh', x0: fw, x1: W, y0: base, y1: H, shelves: 4 });
      doors.push(
        { role: 'door-left', name: 'Freezer door', x0: 0, x1: fw - GAP / 2, y0: base, y1: H, side: 'left', handleAt: 0.5 },
        { role: 'door-right', name: 'Fridge door', x0: fw + GAP / 2, x1: W, y0: base, y1: H, side: 'right', handleAt: 0.5 },
      );
      break;
    }
    case 'top-freezer':
      spaces.push({ id: 'cav-freezer', x0: 0, x1: W, y0: H - fz, y1: H, shelves: 1 }, { id: 'cav-fresh', x0: 0, x1: W, y0: base, y1: H - fz, shelves: 3 });
      doors.push(
        { role: 'freezer-door', name: 'Freezer door', x0: 0, x1: W, y0: H - fz, y1: H, side: p.hinge, handleAt: 0.3 },
        { role: 'door', name: 'Door', x0: 0, x1: W, y0: base, y1: H - fz - GAP, side: p.hinge, handleAt: 0.75 },
      );
      break;
    case 'bottom-freezer':
      spaces.push({ id: 'cav-fresh', x0: 0, x1: W, y0: base + fz, y1: H, shelves: 3 }, { id: 'cav-freezer', x0: 0, x1: W, y0: base, y1: base + fz, shelves: 0 });
      doors.push({ role: 'door', name: 'Door', x0: 0, x1: W, y0: base + fz + GAP, y1: H, side: p.hinge, handleAt: 0.38 });
      drawer = { y0: base, y1: base + fz };
      break;
    default:
      spaces.push({ id: 'cav-fresh', x0: 0, x1: W, y0: base, y1: H, shelves: 4 });
      doors.push({ role: 'door', name: 'Door', x0: 0, x1: W, y0: base, y1: H, side: p.hinge, handleAt: 0.5 });
  }
  const cavities = spaces.map((s) => ({ id: s.id, min: [s.x0 + wall, s.y0 + wall, back] as V3, max: [s.x1 - wall, s.y1 - wall, B] as V3, axis: 2 as const }));
  const details: Detail[] = [
    ...cavities.flatMap((c, i) => shelves(c, spaces[i]!.shelves, 'shelf')),
    // The toe grille under the doors.
    { kind: 'box', min: [inches(1), inches(0.5), B - 16], max: [W - inches(1), base - inches(0.5), B + inches(0.5)], tag: 'vent' },
  ];
  g.part('body', 'Body', 'applianceBody', body(W, H, B, cavities, details, L.body, LINER), [0, 0, 0]);

  const handle = (vertical: boolean, length: number): PullParams =>
    p.handle === 'pocket'
      ? { style: 'edge', length: length + inches(2), orientation: vertical ? 'v' : 'h', finish: structuredClone(L.handle) }
      : bar(length, vertical ? 'v' : 'h', L.handle, inches(7 / 8), inches(2.25));
  for (const d of doors) {
    const folder = `${d.role}-leaf`;
    g.inFolder(folder, d.name, () => {
      const [w, h] = [d.x1 - d.x0, d.y1 - d.y0];
      g.part(d.role, d.name, 'applianceDoor', door(w, h, T, L.door, LINER), [d.x0, d.y0, B]);
      const params = handle(true, clamp(h * 0.45, inches(8), inches(30)));
      const [bx, by] = pullBox(params);
      const cx = d.side === 'left' ? d.x1 - inches(1.5) - bx / 2 : d.x0 + inches(1.5) + bx / 2;
      const cy = Math.min(d.y1 - by / 2 - inches(2), Math.max(d.y0 + by / 2 + inches(2), d.y0 + h * d.handleAt));
      g.pull(`${d.role}-pull`, `${d.name} handle`, params, cx, cy, D, d.role);
    });
    g.out.motions.push({ role: d.role, name: d.name, type: 'hinge', nodes: [folder], requires: [d.role], params: { side: d.side, angle: 115 } });
  }
  if (drawer) {
    const cav = cavities.find((c) => c.id === 'cav-freezer')!;
    const bz = B - cav.min[2] - inches(1);
    g.inFolder('freezer', 'Freezer drawer', () => {
      g.part('freezer-front', 'Freezer drawer front', 'applianceDoor', door(W, drawer.y1 - drawer.y0, T, L.door, LINER), [0, drawer.y0, B]);
      g.part('freezer-bin', 'Freezer bin', 'applianceBody', bin(cav.max[0] - cav.min[0] - inches(1), cav.max[1] - cav.min[1] - inches(1.5), bz, BIN), [cav.min[0] + inches(0.5), cav.min[1] + inches(0.5), B - bz]);
      const params = handle(false, clamp(W * 0.55, inches(8), inches(30)));
      g.pull('freezer-pull', 'Freezer handle', params, W / 2, drawer.y1 - pullBox(params)[1] / 2 - inches(1.5), D, 'freezer-front');
    });
    g.out.motions.push({ role: 'freezer', name: 'Freezer drawer', type: 'slide', nodes: ['freezer'], requires: ['freezer-front'], params: { distance: Math.round(bz * 0.8) } });
  }
  return g.out;
}

registerGenerator<FridgeParams>({
  type: 'fridge',
  version: 1,
  schema: z.object({
    ...commonSchema([24, 60, 36], [60, 96, 70], [24, 36, 31]),
    style: z.enum(FRIDGE_STYLES).default('french'),
    hinge: z.enum(['left', 'right']).default('right'),
    handle: z.enum(['bar', 'pocket']).default('bar'),
  }) as z.ZodType<FridgeParams>,
  describe:
    `Fridge: width (36"), height (70"), depth (31"), style "french" | "side-by-side" | "top-freezer" | "bottom-freezer" | "column", hinge (single doors), handle "bar" | "pocket", ${LOOK_DOC}.`,
  collapse: true,
  lockedParts: true,
  fields: [
    ...sizeFields,
    { path: 'style', label: 'Style', kind: 'choice', options: [...FRIDGE_STYLES] },
    { path: 'hinge', label: 'Hinge', kind: 'choice', options: ['left', 'right'] },
    { path: 'handle', label: 'Handle', kind: 'choice', options: ['bar', 'pocket'] },
    ...lookFields,
  ],
  generate: (p) => fridge(p),
  faceDrive,
  materialRefs: () => [],
});

// ── range ────────────────────────────────────────────────────────────────────

export interface RangeParams extends Common {
  fuel: 'gas' | 'electric' | 'induction';
  burners: number;
  backguard: boolean;
  drawer: boolean;
}

/** Burner (or cooking zone) centers over a cooktop area, and which are the big ones. */
export function burnerLayout(n: number, x0: number, x1: number, z0: number, z1: number): { x: number; z: number; big: boolean }[] {
  const zs = [Math.round(z0 + (z1 - z0) * 0.72), Math.round(z0 + (z1 - z0) * 0.28)];
  const col = (k: number, of: number) => Math.round(x0 + ((x1 - x0) * (k + 0.5)) / of);
  if (n >= 6) return [0, 1, 2].flatMap((k) => zs.map((z, r) => ({ x: col(k, 3), z, big: k === 0 && r === 0 })));
  const four = [0, 1].flatMap((k) => zs.map((z, r) => ({ x: n === 5 ? Math.round(x0 + ((x1 - x0) * (k === 0 ? 0.2 : 0.8))) : col(k, 2), z, big: k === 0 && r === 0 })));
  return n === 5 ? [...four, { x: Math.round((x0 + x1) / 2), z: Math.round((z0 + z1) / 2), big: true }] : four;
}

function range(p: RangeParams): GenOutput {
  const { width: W, height: H, depth: D } = p;
  const L = looks(p);
  const T = inches(2);
  const B = D - T;
  const base = inches(0.75);
  const band = inches(3.5);
  const wall = inches(1.5);
  const back = inches(2);
  const drawerH = p.drawer ? inches(6) : 0;
  const ovenY0 = base + (p.drawer ? drawerH + GAP : 0);
  const ovenY1 = H - band - GAP;
  if (ovenY1 - ovenY0 < inches(14)) throw new PluginError(`a range ${f(H)} high has no room for its oven`);
  const g = builder();
  const ovenCav = { id: 'cav-oven', min: [wall, ovenY0 + wall, back] as V3, max: [W - wall, ovenY1 - wall, B] as V3, axis: 2 as const };
  const drawerCav = { id: 'cav-drawer', min: [wall, base + 16, back] as V3, max: [W - wall, base + drawerH - 16, B] as V3, axis: 2 as const };
  const details: Detail[] = [...shelves(ovenCav, 2, 'rack', inches(1.5))];
  // The control band under the cooktop, flush with the doors, and its knobs.
  details.push({ kind: 'box', min: [0, H - band, B - 16], max: [W, H, D - 16], tag: 'panel' });
  const knobs = p.fuel === 'gas' ? p.burners : Math.min(p.burners, 5);
  for (let i = 0; i < knobs; i++) {
    const x = Math.round(W * 0.1 + ((W * 0.8) * (i + 0.5)) / knobs);
    details.push({ kind: 'cylinder', base: [x, H - Math.round(band / 2), D - 16], axis: 2, r: inches(0.7), h: inches(1), tag: 'knob' });
  }
  const guard = p.backguard ? inches(1.5) : 0;
  if (p.backguard) details.push({ kind: 'box', min: [0, H - 8, 0], max: [W, H + inches(3), guard], tag: 'guard' });
  const [x0, x1, z0, z1] = [inches(1.5), W - inches(1.5), guard + inches(1.5), D - inches(2)];
  const spots = burnerLayout(p.fuel === 'gas' ? p.burners : Math.min(p.burners, 5), x0, x1, z0, z1);
  if (p.fuel === 'gas') {
    // Burners under a continuous cast-iron grate: a frame, dividers between the cells, a cross over each burner.
    const top = H + inches(1.125);
    const t = inches(3 / 8);
    const barX = (z: number, a: number, b: number, y0 = H): Detail => ({ kind: 'box', min: [a, y0, z - t / 2], max: [b, top, z + t / 2], tag: 'grate' });
    const barZ = (x: number, a: number, b: number, y0 = H): Detail => ({ kind: 'box', min: [x - t / 2, y0, a], max: [x + t / 2, top, b], tag: 'grate' });
    const xs = [...new Set(spots.map((s) => s.x))].sort((a, b) => a - b);
    const cuts = [x0, ...xs.slice(1).map((x, i) => Math.round((x + xs[i]!) / 2)), x1];
    const zm = Math.round((z0 + z1) / 2);
    details.push(barX(z0, x0 - t / 2, x1 + t / 2), barX(z1, x0 - t / 2, x1 + t / 2), barX(zm, x0, x1));
    for (const x of cuts) details.push(barZ(x, z0, z1));
    for (const s of spots) {
      const r = s.big ? inches(1.75) : inches(1.4);
      details.push({ kind: 'cylinder', base: [s.x, H, s.z], axis: 1, r, h: inches(3 / 8), tag: 'burner' });
      details.push({ kind: 'cylinder', base: [s.x, H + inches(3 / 8), s.z], axis: 1, r: Math.round(r * 0.7), h: inches(1 / 4), tag: 'cap' });
      const ci = cuts.findIndex((c) => c > s.x);
      const [ca, cb] = [cuts[ci - 1] ?? x0, cuts[ci] ?? x1];
      const [za, zb] = s.z === zm ? [z0, z1] : s.z > zm ? [zm, z1] : [z0, zm];
      const lift = H + inches(0.875);
      // The cross ends inside the bars around its cell (crosses meeting end to end would share faces).
      const e = t / 2 - 4;
      details.push(barX(s.z, ca + e, cb - e, lift), barZ(s.x, za + e, zb - e, lift));
    }
  } else {
    details.push({ kind: 'box', min: [inches(0.5), H - 8, guard + inches(0.5)], max: [W - inches(0.5), H + inches(0.25), D - inches(0.5)], tag: 'panel' });
    for (const s of spots) details.push({ kind: 'cylinder', base: [s.x, H + inches(0.25), s.z], axis: 1, r: s.big ? inches(4) : inches(3), h: 1, tag: 'zone' });
  }
  g.part('body', 'Body', 'applianceBody', body(W, H, B, p.drawer ? [ovenCav, drawerCav] : [ovenCav], details, L.body, ENAMEL), [0, 0, 0]);

  const doorH = ovenY1 - ovenY0;
  g.inFolder('oven-door-leaf', 'Oven door', () => {
    const win = { min: [Math.round(W * 0.16), Math.round(doorH * 0.3)] as [number, number], max: [Math.round(W * 0.84), Math.round(doorH * 0.76)] as [number, number] };
    g.part('oven-door', 'Oven door', 'applianceDoor', door(W, doorH, T, L.door, ENAMEL, win), [0, ovenY0, B]);
    const params = bar(W - inches(8), 'h', L.handle, inches(3 / 4), inches(2));
    g.pull('oven-door-pull', 'Oven handle', params, W / 2, ovenY1 - inches(2), D, 'oven-door');
  });
  g.out.motions.push({ role: 'oven-door', name: 'Oven door', type: 'hinge', nodes: ['oven-door-leaf'], requires: ['oven-door'], params: { side: 'bottom', angle: 90 } });
  if (p.drawer) {
    const bz = B - back - inches(1);
    g.inFolder('drawer', 'Drawer', () => {
      g.part('drawer-front', 'Drawer front', 'applianceDoor', door(W, drawerH, T, L.door, ENAMEL), [0, base, B]);
      g.part('drawer-bin', 'Drawer bin', 'applianceBody', bin(W - 2 * wall - inches(1), drawerH - inches(1), bz, ENAMEL), [wall + inches(0.5), base + inches(0.5), B - bz]);
      g.pull('drawer-pull', 'Drawer handle', bar(clamp(W * 0.45, inches(6), inches(24)), 'h', L.handle), W / 2, base + drawerH / 2, D, 'drawer-front');
    });
    g.out.motions.push({ role: 'drawer', name: 'Drawer', type: 'slide', nodes: ['drawer'], requires: ['drawer-front'], params: { distance: Math.round(bz * 0.8) } });
  }
  return g.out;
}

registerGenerator<RangeParams>({
  type: 'range',
  version: 1,
  schema: z.object({
    ...commonSchema([20, 60, 30], [30, 40, 36], [20, 32, 27]),
    fuel: z.enum(['gas', 'electric', 'induction']).default('gas'),
    burners: z.int().min(4).max(6).default(4),
    backguard: z.boolean().default(true),
    drawer: z.boolean().default(true),
  }) as z.ZodType<RangeParams>,
  describe: `Range: width (30"), height (36", the cooktop), depth (27"), fuel "gas" | "electric" | "induction", burners (4–6), backguard, drawer, ${LOOK_DOC}.`,
  collapse: true,
  lockedParts: true,
  fields: [
    ...sizeFields,
    { path: 'fuel', label: 'Fuel', kind: 'choice', options: ['gas', 'electric', 'induction'] },
    { path: 'burners', label: 'Burners', kind: 'count', min: 4, max: 6 },
    { path: 'backguard', label: 'Backguard', kind: 'bool' },
    { path: 'drawer', label: 'Drawer', kind: 'bool' },
    ...lookFields,
  ],
  generate: (p) => range(p),
  faceDrive,
  materialRefs: () => [],
});

// ── dishwasher ───────────────────────────────────────────────────────────────

export type DishwasherParams = Common;

function dishwasher(p: DishwasherParams): GenOutput {
  const { width: W, height: H, depth: D } = p;
  const L = looks(p);
  const T = inches(1.25);
  const B = D - T;
  const kick = inches(4);
  const g = builder();
  const tub = { id: 'cav-tub', min: [inches(1), kick + inches(1), inches(1.5)] as V3, max: [W - inches(1), H - inches(1.5), B] as V3, axis: 2 as const };
  const details: Detail[] = [
    ...shelves(tub, 2, 'rack', inches(1)),
    { kind: 'box', min: [inches(0.5), inches(0.25), B - inches(1)], max: [W - inches(0.5), kick - GAP, B + inches(0.25)], tag: 'kick' },
  ];
  g.part('body', 'Body', 'applianceBody', body(W, H, B, [tub], details, L.body, { preset: 'metal:stainless' }), [0, 0, 0]);
  g.inFolder('door-leaf', 'Door', () => {
    g.part('door', 'Door', 'applianceDoor', door(W, H - kick, T, L.door, { preset: 'metal:stainless' }), [0, kick, B]);
    g.pull('door-pull', 'Handle', bar(clamp(W * 0.6, inches(8), inches(20)), 'h', L.handle), W / 2, H - inches(2.5), D, 'door');
  });
  g.out.motions.push({ role: 'door', name: 'Door', type: 'hinge', nodes: ['door-leaf'], requires: ['door'], params: { side: 'bottom', angle: 80 } });
  return g.out;
}

registerGenerator<DishwasherParams>({
  type: 'dishwasher',
  version: 1,
  schema: z.object(commonSchema([18, 30, 24], [30, 38, 34.5], [20, 28, 24])) as z.ZodType<DishwasherParams>,
  describe: `Dishwasher: width (24"), height (34 1/2"), depth (24"), ${LOOK_DOC}.`,
  collapse: true,
  lockedParts: true,
  fields: [...sizeFields, ...lookFields],
  generate: (p) => dishwasher(p),
  faceDrive,
  materialRefs: () => [],
});

// ── microwave ────────────────────────────────────────────────────────────────

export const MICROWAVE_MOUNTS = ['over-range', 'countertop', 'built-in', 'drawer'] as const;

export interface MicrowaveParams extends Common {
  mount: (typeof MICROWAVE_MOUNTS)[number];
}

function microwave(p: MicrowaveParams): GenOutput {
  const { width: W, height: H, depth: D } = p;
  const L = looks(p);
  const T = inches(1.25);
  const B = D - T;
  const back = inches(1.5);
  const g = builder();
  const details: Detail[] = [];
  const inner: Finish = { preset: 'paint', color: '#dcdee0', roughness: 0.4 };
  if (p.mount === 'drawer') {
    const strip = inches(3);
    details.push({ kind: 'box', min: [0, H - strip + GAP, B - 16], max: [W, H, D - 8], tag: 'panel' });
    const cav = { id: 'cav-drawer', min: [inches(1), inches(1), back] as V3, max: [W - inches(1), H - strip - inches(1), B] as V3, axis: 2 as const };
    g.part('body', 'Body', 'applianceBody', body(W, H, B, [cav], details, L.body, inner), [0, 0, 0]);
    const bz = B - back - inches(1);
    const fh = H - strip;
    g.inFolder('drawer', 'Drawer', () => {
      g.part('drawer-front', 'Drawer front', 'applianceDoor', door(W, fh, T, L.door, inner, { min: [inches(2), inches(2.5)], max: [W - inches(2), fh - inches(1.5)] }), [0, 0, B]);
      g.part('drawer-bin', 'Drawer tub', 'applianceBody', bin(W - inches(3), fh - inches(2.5), bz, inner), [inches(1.5), inches(1.25), B - bz]);
      g.pull('drawer-pull', 'Handle', bar(clamp(W * 0.5, inches(6), inches(18)), 'h', L.handle), W / 2, fh - inches(1), D, 'drawer-front');
    });
    g.out.motions.push({ role: 'drawer', name: 'Drawer', type: 'slide', nodes: ['drawer'], requires: ['drawer-front'], params: { distance: Math.round(bz * 0.8) } });
    return g.out;
  }
  const trim = p.mount === 'built-in' ? inches(1.5) : 0;
  const vent = p.mount === 'over-range' ? inches(1.5) : 0;
  const x0 = trim;
  const y0 = trim;
  const y1 = H - trim - vent - (vent ? GAP : 0);
  const xd = Math.round((W - 2 * trim) * 0.74) + trim;
  if (trim) {
    for (const [a, b] of [[[0, 0], [trim, H]], [[W - trim, 0], [W, H]], [[trim - 8, 0], [W - trim + 8, trim]], [[trim - 8, H - trim], [W - trim + 8, H]]] as [[number, number], [number, number]][]) {
      details.push({ kind: 'box', min: [a[0], a[1], B - 16], max: [b[0], b[1], D - 4], tag: 'trim' });
    }
  }
  if (vent) details.push({ kind: 'box', min: [0, H - vent, B - 16], max: [W, H, D - 8], tag: 'vent' });
  details.push({ kind: 'box', min: [xd + GAP, y0, B - 16], max: [W - trim, y1, D - 8], tag: 'panel' });
  const cav = { id: 'cav-oven', min: [x0 + inches(1), y0 + inches(1), back] as V3, max: [xd - inches(1), y1 - inches(1), B] as V3, axis: 2 as const };
  g.part('body', 'Body', 'applianceBody', body(W, H, B, [cav], details, L.body, inner), [0, 0, 0]);
  const [dw, dh] = [xd - x0, y1 - y0];
  g.inFolder('door-leaf', 'Door', () => {
    g.part('door', 'Door', 'applianceDoor', door(dw, dh, T, L.door, inner, { min: [inches(1.25), inches(1.25)], max: [dw - inches(3.5), dh - inches(1.25)] }), [x0, y0, B]);
    g.pull('door-pull', 'Handle', bar(clamp(dh - inches(5), inches(4), inches(12)), 'v', L.handle, inches(5 / 8), inches(1.5)), xd - inches(1.5), y0 + dh / 2, D, 'door');
  });
  g.out.motions.push({ role: 'door', name: 'Door', type: 'hinge', nodes: ['door-leaf'], requires: ['door'], params: { side: 'left', angle: 90 } });
  return g.out;
}

registerGenerator<MicrowaveParams>({
  type: 'microwave',
  version: 1,
  schema: z.object({ ...commonSchema([18, 36, 30], [10, 24, 16.5], [10, 24, 15.5]), mount: z.enum(MICROWAVE_MOUNTS).default('over-range') }) as z.ZodType<MicrowaveParams>,
  describe: `Microwave: width (30"), height (16 1/2"), depth (15 1/2"), mount "over-range" | "countertop" | "built-in" | "drawer", ${LOOK_DOC}.`,
  collapse: true,
  lockedParts: true,
  fields: [...sizeFields, { path: 'mount', label: 'Mount', kind: 'choice', options: [...MICROWAVE_MOUNTS] }, ...lookFields],
  generate: (p) => microwave(p),
  faceDrive,
  materialRefs: () => [],
});

/** The appliance generators, in catalog order, with their catalog labels. */
export const APPLIANCES: readonly { type: string; label: string }[] = [
  { type: 'fridge', label: 'Fridge' },
  { type: 'range', label: 'Range' },
  { type: 'dishwasher', label: 'Dishwasher' },
  { type: 'microwave', label: 'Microwave' },
];
