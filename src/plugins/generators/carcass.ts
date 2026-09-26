import { z } from 'zod';
import type { Vec3 } from '../../model/schema';
import { formatInches as f, inches } from '../../model/units';
import { PluginError, registerGenerator, type GenFace, type GenFaceDrive, type GenJoint, type GenPart } from '../registry';

export interface CarcassParams {
  width: number;
  height: number;
  depth: number;
  material: string;
  back: 'none' | 'inset' | 'applied';
  backMaterial?: string | undefined;
  toeKick: { height: number; depth: number } | null;
  shelves: number;
  joinery: 'butt' | 'dado';
  /** Drawer front heights, top-down; 0 = share the leftover face height equally. */
  drawers: number[];
  drawerMaterial?: string | undefined;
  drawerBottomMaterial?: string | undefined;
  frontMaterial?: string | undefined;
}

const DADO_DEPTH = inches(1 / 4);
/** How far an inset back sits into the sides: 3/8" (room to nail it), or half a thin side. */
const BACK_RABBET = (T: number) => (T >= inches(5 / 8) ? inches(3 / 8) : Math.round(T / 2));
const SHELF_SIDE_GAP = 2; // 1/32" each side so adjustable shelves drop in
const SHELF_SETBACK = inches(1 / 4);
const TOP_REVEAL = inches(1 / 16); // above the top drawer front
const FRONT_GAP = inches(1 / 8); // between drawer fronts
const SIDE_REVEAL = inches(1 / 16); // each side of a full-overlay front
const SLIDE_GAP = inches(1 / 2); // each side of a drawer box, for side-mount slides
const BOX_CLEAR = inches(1 / 2); // above and below a drawer box
const MIN_FRONT = inches(3);
const MIN_BOX = inches(2);

const schema = z
  .object({
    width: z.int().min(inches(6)).max(inches(120)),
    height: z.int().min(inches(6)).max(inches(120)),
    depth: z.int().min(inches(4)).max(inches(48)),
    material: z.string().min(1),
    back: z.enum(['none', 'inset', 'applied']).default('inset'),
    backMaterial: z.string().min(1).optional(),
    toeKick: z
      .object({ height: z.int().positive(), depth: z.int().nonnegative() })
      .nullable()
      .default({ height: inches(4), depth: inches(3) }),
    shelves: z.int().min(0).max(12).default(1),
    joinery: z.enum(['butt', 'dado']).default('dado'),
    drawers: z.array(z.int().nonnegative()).max(8).default([]),
    drawerMaterial: z.string().min(1).optional(),
    drawerBottomMaterial: z.string().min(1).optional(),
    frontMaterial: z.string().min(1).optional(),
  })
  .refine((p) => !p.toeKick || p.toeKick.height < p.height / 2, {
    message: 'toe kick must be less than half the cabinet height',
    path: ['toeKick', 'height'],
  });

type Materials = Record<string, { thickness: number; name: string }>;

/** Front heights top-down: 0s share whatever face height the fixed ones leave. */
export function drawerFrontHeights(heights: number[], faceHeight: number): number[] {
  if (!heights.length) return [];
  const avail = faceHeight - TOP_REVEAL - (heights.length - 1) * FRONT_GAP;
  const fixed = heights.reduce((s, h) => s + h, 0);
  const flex = heights.filter((h) => h === 0).length;
  const left = avail - fixed;
  if (left < 0) throw new PluginError(`drawer fronts total ${f(fixed)} but the face only has ${f(avail)} after reveals`);
  const share = flex ? Math.floor(left / flex) : 0;
  let spare = flex ? left - share * flex : 0;
  const out = heights.map((h) => {
    if (h !== 0) return h;
    const extra = spare-- > 0 ? 1 : 0;
    return share + extra;
  });
  for (const h of out) if (h < MIN_FRONT) throw new PluginError(`drawer fronts must be at least 3" tall (got ${f(h)})`);
  return out;
}

/**
 * Frameless box. Origin = left-back-bottom; X = width, Y = height, Z = depth (front +Z).
 * Sides run full height to the floor; bottom sits on the toe kick. Panels are modeled at their
 * visible (butt) size; dado and rabbet joints cut their channels into the sides and the cut list
 * adds the depth to the panels that sit in them (model/joinery.ts).
 * Drawers: full-overlay fronts stacked down from the top, each with a five-piece box
 * (bottom, sides, back, sub-front) on side-mount slides; shelves go in the bay below.
 */
function generate(p: CarcassParams, materials: Materials) {
  const need = (id: string, what: string) => {
    const m = materials[id];
    if (!m) throw new PluginError(`carcass ${what} "${id}" doesn't exist`);
    return m;
  };
  const T = need(p.material, 'material').thickness;
  const backMatId = p.backMaterial ?? p.material;
  const BT = p.back === 'none' ? 0 : need(backMatId, 'back material').thickness;
  const { width: W, height: H, depth: D } = p;
  const kH = p.toeKick?.height ?? 0;
  const kD = p.toeKick?.depth ?? 0;
  const zIn = BT; // interior panels start in front of the back
  const innerW = W - 2 * T;
  const sideZ = p.back === 'applied' ? BT : 0;

  if (innerW <= 0) throw new PluginError(`carcass width ${W} is too narrow for two ${T} sides`);
  if (H - kH - 2 * T <= 0) throw new PluginError('carcass is too short for its toe kick, bottom and top');
  if (D - zIn <= SHELF_SETBACK) throw new PluginError('carcass is too shallow for its back');
  if (p.toeKick && kD + T > D - zIn) throw new PluginError('toe kick is deeper than the cabinet');

  const parts: GenPart[] = [];
  const joints: GenJoint[] = [];
  const panel = (role: string, name: string, grain: GenPart['grain'], position: Vec3, size: Vec3, material = p.material) =>
    parts.push({
      role,
      name,
      material,
      grain,
      position,
      shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } },
    });

  panel('side-left', 'Left side', 'y', [0, 0, sideZ], [T, H, D - sideZ]);
  panel('side-right', 'Right side', 'y', [W - T, 0, sideZ], [T, H, D - sideZ]);
  panel('bottom', 'Bottom', 'x', [T, kH, zIn], [innerW, T, D - zIn]);
  panel('top', 'Top', 'x', [T, H - T, zIn], [innerW, T, D - zIn]);
  if (p.back === 'inset') panel('back', 'Back', 'y', [T, kH, 0], [innerW, H - kH, BT], backMatId);
  if (p.back === 'applied') panel('back', 'Back', 'y', [0, kH, 0], [W, H - kH, BT], backMatId);
  if (p.toeKick) panel('kick', 'Toe kick', 'x', [T, 0, D - kD - T], [innerW, kH, T]);

  // Drawers, top-down. `ceiling` ends up at the bottom of the lowest drawer's space.
  let ceiling = H - T;
  if (p.drawers.length) {
    const frontMat = p.frontMaterial ?? p.material;
    const boxMat = p.drawerMaterial ?? p.material;
    const bottomMat = p.drawerBottomMaterial ?? p.backMaterial ?? p.material;
    const FT = need(frontMat, 'front material').thickness;
    const DT = need(boxMat, 'drawer material').thickness;
    const DB = need(bottomMat, 'drawer bottom material').thickness;
    const boxW = innerW - 2 * SLIDE_GAP;
    const boxD = D - zIn - inches(1);
    if (boxW <= 2 * DT + inches(2)) throw new PluginError('carcass is too narrow for drawer boxes');
    if (boxD < inches(4)) throw new PluginError('carcass is too shallow for drawer boxes');

    const x0 = T + SLIDE_GAP;
    const z0 = zIn + inches(1 / 2);
    let top = H - TOP_REVEAL;
    drawerFrontHeights(p.drawers, H - kH).forEach((fh, i) => {
      const n = i + 1;
      const r = `drawer-${n}`;
      const bottom = top - fh;
      panel(`${r}-front`, `Drawer ${n} front`, 'x', [SIDE_REVEAL, bottom, D], [W - 2 * SIDE_REVEAL, fh, FT], frontMat);
      // The box fits inside its front's band, clear of the carcass top and bottom.
      const lo = Math.max(bottom, kH + T) + BOX_CLEAR;
      const hi = Math.min(top, H - T) - BOX_CLEAR;
      if (hi - lo < MIN_BOX) throw new PluginError(`drawer ${n}'s ${f(fh)} front is too short for a drawer box`);
      const wall = hi - lo - DB;
      panel(`${r}-bottom`, `Drawer ${n} bottom`, 'z', [x0, lo, z0], [boxW, DB, boxD], bottomMat);
      panel(`${r}-side-left`, `Drawer ${n} left side`, 'z', [x0, lo + DB, z0], [DT, wall, boxD], boxMat);
      panel(`${r}-side-right`, `Drawer ${n} right side`, 'z', [x0 + boxW - DT, lo + DB, z0], [DT, wall, boxD], boxMat);
      panel(`${r}-back`, `Drawer ${n} back`, 'x', [x0 + DT, lo + DB, z0], [boxW - 2 * DT, wall, DT], boxMat);
      panel(`${r}-sub-front`, `Drawer ${n} sub-front`, 'x', [x0 + DT, lo + DB, z0 + boxD - DT], [boxW - 2 * DT, wall, DT], boxMat);
      for (const side of ['left', 'right']) {
        for (const end of ['back', 'sub-front']) {
          joints.push({ role: `${r}-${end}-${side}`, type: 'rabbet', parts: [`${r}-side-${side}`, `${r}-${end}`], params: { depth: Math.round(DT / 2) } });
        }
      }
      ceiling = lo - BOX_CLEAR;
      top = bottom - FRONT_GAP;
    });
  }

  // Shelves share the bay below the drawers (the whole interior when there are none).
  const y0 = kH + T;
  const clear = ceiling - y0 - p.shelves * T;
  if (p.shelves > 0 && clear < (p.shelves + 1) * inches(1)) {
    throw new PluginError(
      p.drawers.length
        ? `no room for ${p.shelves} shelves below the drawers — set shelves to 0 or shorten the drawers`
        : `not enough height for ${p.shelves} shelves`,
    );
  }
  for (let i = 1; i <= p.shelves; i++) {
    const y = y0 + Math.round((clear * i) / (p.shelves + 1)) + (i - 1) * T;
    panel(`shelf-${i}`, `Shelf ${i}`, 'x', [T + SHELF_SIDE_GAP, y, zIn], [innerW - 2 * SHELF_SIDE_GAP, T, D - zIn - SHELF_SETBACK]);
  }

  const housing = p.joinery === 'dado' ? ({ type: 'dado', params: { depth: DADO_DEPTH } } as const) : ({ type: 'butt', params: {} } as const);
  for (const panelRole of ['bottom', 'top']) {
    for (const side of ['left', 'right']) {
      joints.push({ role: `${panelRole}-${side}`, parts: [`side-${side}`, panelRole], ...housing });
    }
  }
  if (p.back !== 'none') {
    for (const side of ['left', 'right']) {
      joints.push(
        p.back === 'inset'
          ? { role: `back-${side}`, type: 'rabbet', parts: [`side-${side}`, 'back'], params: { depth: BACK_RABBET(T) } }
          : { role: `back-${side}`, type: 'butt', parts: [`side-${side}`, 'back'], params: {} },
      );
    }
  }
  if (p.toeKick) {
    for (const side of ['left', 'right']) {
      joints.push({ role: `kick-${side}`, type: 'butt', parts: [`side-${side}`, 'kick'], params: {} });
    }
  }
  return { parts, joints };
}

const DIMS = ['width', 'height', 'depth'] as const;

/**
 * Push/pull on the carcass: any part face on the outer box (drawer fronts count for the front)
 * resizes the cabinet; min-side faces also move it so the opposite side stays put. The toe
 * kick's top and front faces drive its height and recess. Other faces fall back to overrides.
 */
function faceDrive(p: CarcassParams, f: GenFace): GenFaceDrive | null {
  if (f.role === 'kick' && p.toeKick) {
    if (f.axis === 1 && f.max) return { param: 'toeKick.height', label: 'toe kick height', sign: 1 };
    if (f.axis === 2 && f.max) return { param: 'toeKick.depth', label: 'toe kick depth', sign: -1 };
  }
  const size = [p.width, p.height, p.depth][f.axis]!;
  const front = f.axis === 2 && f.max && /^drawer-\d+-front$/.test(f.role);
  if (f.max && (f.plane === size || front)) return { param: DIMS[f.axis], label: DIMS[f.axis], sign: 1 };
  if (!f.max && f.plane === 0) return { param: DIMS[f.axis], label: DIMS[f.axis], sign: 1, moveOrigin: true };
  return null;
}

registerGenerator<CarcassParams>({
  type: 'carcass',
  version: 1,
  schema: schema as z.ZodType<CarcassParams>,
  describe:
    'Frameless cabinet box (base, wall or tall cabinet, vanity, drawer bank). Params (lengths in 1/64"): width, height, depth ' +
    '(overall carcass, back included; drawer fronts add their thickness in front), material (material id for sides/top/bottom/shelves), ' +
    'back ("none" | "inset" | "applied"), backMaterial, toeKick ({height, depth} recess, or null for wall cabinets), ' +
    'shelves (count of evenly spaced adjustable shelves in the open bay), joinery ("dado" | "butt" for top/bottom into sides), ' +
    'drawers (full-overlay drawer front heights top-down; 0 = share the leftover face height equally: [0, 0] = two equal drawers ' +
    'filling the face, [384, 0, 0] = a 6" top drawer over two equal ones, [384] = one 6" drawer over an open shelf bay). ' +
    'Face height = height − toeKick.height; reveals are 1/16" above the top front and 1/8" between fronts. When drawers fill the face ' +
    'set shelves to 0. drawerMaterial (box sides/back/sub-front, default material; 1/2" ply is typical), drawerBottomMaterial ' +
    '(default backMaterial), frontMaterial (default material). Origin = left-back-bottom corner. ' +
    'Part roles: side-left, side-right, bottom, top, back, kick, shelf-N, drawer-N-front, drawer-N-bottom, drawer-N-side-left, ' +
    'drawer-N-side-right, drawer-N-back, drawer-N-sub-front (N from the top).',
  generate: (p, ctx) => generate(p, ctx.materials),
  faceDrive,
  materialRefs: (p) => {
    const refs = [p.material];
    if (p.back !== 'none') refs.push(p.backMaterial ?? p.material);
    if (p.drawers.length) {
      refs.push(p.frontMaterial ?? p.material, p.drawerMaterial ?? p.material, p.drawerBottomMaterial ?? p.backMaterial ?? p.material);
    }
    return [...new Set(refs)];
  },
});
