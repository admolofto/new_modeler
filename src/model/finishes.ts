import type { Finish, Material } from './schema';

/**
 * The finish vocabulary (binding note 3): the looks a material, part, folder or decor surface can
 * have — preset ids, labels, swatch colors (the flat editor color), inference from a material's
 * name, and the AI's docs. Render parameters per preset live in the render layer. Presets are
 * append-only: never remove one; rename by adding the new id and aliasing the old one. Pure.
 */

export type FinishFamily = 'wood' | 'paint' | 'stone' | 'tile' | 'floor' | 'metal' | 'glass' | 'fabric' | 'ceramic' | 'plant' | 'light';

export interface FinishDef {
  id: string;
  label: string;
  family: FinishFamily;
  /** The flat color it draws in the editor (and exports with) when it has no color of its own. */
  swatch: string;
  /**
   * What a finish's `color` does: tints the look (a stain over wood, a tinted fabric), replaces it
   * (paint), or nothing (stone, metal).
   */
  tint: 'none' | 'multiply' | 'replace';
}

/** v1 vocabulary. Append only. */
export const FINISHES: readonly FinishDef[] = [
  { id: 'wood:white-oak', label: 'White oak', family: 'wood', swatch: '#c9a878', tint: 'multiply' },
  { id: 'wood:red-oak', label: 'Red oak', family: 'wood', swatch: '#d4a373', tint: 'multiply' },
  { id: 'wood:walnut', label: 'Walnut', family: 'wood', swatch: '#6b4a33', tint: 'multiply' },
  { id: 'wood:cherry', label: 'Cherry', family: 'wood', swatch: '#b76e4b', tint: 'multiply' },
  { id: 'wood:maple', label: 'Maple', family: 'wood', swatch: '#ecd9b0', tint: 'multiply' },
  { id: 'wood:birch-ply', label: 'Birch plywood', family: 'wood', swatch: '#e2c9a0', tint: 'multiply' },
  { id: 'paint', label: 'Paint', family: 'paint', swatch: '#f2f0eb', tint: 'replace' },
  { id: 'lacquer', label: 'Lacquer', family: 'paint', swatch: '#f4f3ef', tint: 'replace' },
  { id: 'melamine', label: 'Melamine', family: 'paint', swatch: '#ecebe6', tint: 'replace' },
  { id: 'laminate', label: 'Laminate', family: 'paint', swatch: '#e9e6df', tint: 'replace' },
  { id: 'stone:quartz-white', label: 'White quartz', family: 'stone', swatch: '#eeece8', tint: 'none' },
  { id: 'stone:marble-white', label: 'White marble', family: 'stone', swatch: '#e9e7e3', tint: 'none' },
  { id: 'stone:marble-dark', label: 'Dark marble', family: 'stone', swatch: '#3a3a3c', tint: 'none' },
  { id: 'stone:granite-black', label: 'Black granite', family: 'stone', swatch: '#2a2a2b', tint: 'none' },
  { id: 'tile:subway', label: 'Subway tile', family: 'tile', swatch: '#f3f2ee', tint: 'multiply' },
  { id: 'tile:floor', label: 'Floor tile', family: 'tile', swatch: '#cfcac2', tint: 'multiply' },
  { id: 'floor:oak-plank', label: 'Oak plank floor', family: 'floor', swatch: '#c49a6c', tint: 'multiply' },
  { id: 'floor:herringbone', label: 'Herringbone floor', family: 'floor', swatch: '#b98c5e', tint: 'multiply' },
  { id: 'floor:concrete', label: 'Concrete floor', family: 'floor', swatch: '#a8a7a3', tint: 'multiply' },
  { id: 'metal:stainless', label: 'Stainless steel', family: 'metal', swatch: '#c4c6c8', tint: 'none' },
  { id: 'metal:brushed-nickel', label: 'Brushed nickel', family: 'metal', swatch: '#b9b5ab', tint: 'none' },
  { id: 'metal:chrome', label: 'Chrome', family: 'metal', swatch: '#dfe2e5', tint: 'none' },
  { id: 'metal:matte-black', label: 'Matte black', family: 'metal', swatch: '#2b2b2c', tint: 'none' },
  { id: 'metal:brass', label: 'Brass', family: 'metal', swatch: '#c9a55c', tint: 'none' },
  { id: 'glass:clear', label: 'Clear glass', family: 'glass', swatch: '#dfeef0', tint: 'multiply' },
  { id: 'glass:frosted', label: 'Frosted glass', family: 'glass', swatch: '#e8eef0', tint: 'multiply' },
  { id: 'fabric:linen', label: 'Linen', family: 'fabric', swatch: '#d8cfc0', tint: 'multiply' },
  { id: 'fabric:wool', label: 'Wool', family: 'fabric', swatch: '#e2ddd4', tint: 'multiply' },
  { id: 'fabric:leather', label: 'Leather', family: 'fabric', swatch: '#7a4e32', tint: 'multiply' },
  { id: 'ceramic', label: 'Ceramic', family: 'ceramic', swatch: '#f1efea', tint: 'replace' },
  { id: 'plant', label: 'Plant', family: 'plant', swatch: '#5f8a4f', tint: 'none' },
  { id: 'light', label: 'Light', family: 'light', swatch: '#fff4d6', tint: 'none' },
];

/** Old preset id → the one it became. Empty in v1. */
export const FINISH_ALIASES: Readonly<Record<string, string>> = {};

const BY_ID = new Map(FINISHES.map((f) => [f.id, f]));

/** A preset's definition (aliases followed), or undefined for an unknown preset. */
export function finishDef(preset: string): FinishDef | undefined {
  return BY_ID.get(FINISH_ALIASES[preset] ?? preset);
}

/** Family names in the order the pickers and the prompt list them. */
export const FAMILY_LABELS: Record<FinishFamily, string> = {
  wood: 'Wood',
  paint: 'Paint and solid colors',
  stone: 'Stone',
  tile: 'Tile',
  floor: 'Flooring',
  metal: 'Metal',
  glass: 'Glass',
  fabric: 'Fabric',
  ceramic: 'Ceramic',
  plant: 'Plant',
  light: 'Light',
};

/** null when the finish is one of the vocabulary's, else the reason it isn't. */
export function finishError(f: Finish): string | null {
  if (finishDef(f.preset)) return null;
  return `unknown finish preset "${f.preset}" (known: ${FINISHES.map((d) => d.id).join(', ')})`;
}

/**
 * The finish a material has when none is set, from its id and name: walnut, cherry, white oak, oak
 * (red oak); maple, poplar and pine look like maple; birch, Baltic and plywood like birch ply; MDF
 * and hardboard are painted their color; melamine and laminate; quartz, granite, marble. Else by
 * stock: sheet goods birch ply, solid wood maple, slabs white quartz.
 */
export function inferFinish(m: Pick<Material, 'id' | 'name' | 'color' | 'stock'>): Finish {
  const s = `${m.id} ${m.name}`.toLowerCase();
  if (/melamine|laminate/.test(s)) return { preset: 'melamine', color: m.color };
  if (/quartz/.test(s)) return { preset: 'stone:quartz-white' };
  if (/granite/.test(s)) return { preset: 'stone:granite-black' };
  if (/marble/.test(s)) return { preset: 'stone:marble-white' };
  if (/walnut/.test(s)) return { preset: 'wood:walnut' };
  if (/cherry/.test(s)) return { preset: 'wood:cherry' };
  if (/white.?oak/.test(s)) return { preset: 'wood:white-oak' };
  if (/oak/.test(s)) return { preset: 'wood:red-oak' };
  if (/maple|poplar|pine/.test(s)) return { preset: 'wood:maple' };
  if (/birch|baltic|ply/.test(s)) return { preset: 'wood:birch-ply' };
  if (/mdf|hardboard/.test(s)) return { preset: 'paint', color: m.color };
  if (m.stock === 'slab') return { preset: 'stone:quartz-white' };
  return { preset: m.stock === 'sheet' ? 'wood:birch-ply' : 'wood:maple' };
}

/** A material's finish: its own, else the inferred one. */
export const finishOf = (m: Material): Finish => m.finish ?? inferFinish(m);

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The flat color a finish draws in the editor: its color where the preset takes one as is (paint),
 * the swatch tinted by it (a stain over wood), else the preset's swatch.
 */
export function swatchOf(f: Finish): string {
  const def = finishDef(f.preset);
  if (!def) return f.color ?? '#cccccc';
  if (!f.color || def.tint === 'none') return def.swatch;
  if (def.tint === 'replace') return f.color.toLowerCase();
  const [a, b] = [channels(def.swatch), channels(f.color)];
  return toHex(a.map((v, i) => (v * b[i]!) / 255));
}

/** `paint #1f2a44`, `wood:walnut`: how diffs and the AI word a finish. */
export const finishText = (f: Finish): string => `${f.preset}${f.color ? ` ${f.color.toLowerCase()}` : ''}`;

/** The vocabulary for the AI prompt, one family per line. */
export function finishDocs(): string {
  const lines = (Object.keys(FAMILY_LABELS) as FinishFamily[]).map((family) => {
    const defs = FINISHES.filter((f) => f.family === family);
    const color = defs[0]!.tint === 'replace' ? ' (color = the color)' : defs[0]!.tint === 'multiply' ? ' (color tints it; for wood, the stain)' : '';
    return `${FAMILY_LABELS[family]}${color}: ${defs.map((f) => f.id).join(', ')}`;
  });
  return lines.join('; ');
}
