import { finishDef } from '../../model/finishes';

/**
 * How each finish preset renders in presentation (B3; pure). The vocabulary (ids, labels, swatches)
 * is `model/finishes.ts`; this is the render layer's half (binding note 3) — every preset there has an
 * entry here (tested), so adding a preset means adding its look.
 *
 * Roughness is the surface's mean: a textured set's roughness map is scaled so its mean lands on it
 * (a finish's own `roughness` wins). Clearcoat, anisotropy and sheen apply on the physical tiers.
 */
export interface FinishRender {
  /** A set in `textureSets.ts`. */
  textureSet?: string;
  roughness: number;
  metalness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Brushed metal: stretches highlights across the brushing (which runs along the part's length). */
  anisotropy?: number;
  /** Fabric's soft rim. */
  sheen?: number;
  sheenRoughness?: number;
  /**
   * The color a photo set is multiplied by when the finish gives none (`#ffffff` = the photo as is):
   * a warm red-oak tone over the oak veneer, a whiter marble. A finish's color (a stain) multiplies
   * on top. Untextured and mask-textured presets draw their swatch (`swatchOf`) instead.
   */
  tint: string;
  /** Brightens a photo set (linear factor) whose image is darker than the material it stands for. */
  gain?: number;
  /** A multiplier on the set's normal strength. */
  normalScale?: number;
  castsShadow: boolean;
  /** Drawn see-through (raster): opacity, no depth write, no shadow. */
  glass?: { opacity: number };
  /** Glows: emissive at this color temperature (K), intensity × the fixture level. */
  emissive?: { kelvin: number; intensity: number };
}

const WOOD = { roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.3, castsShadow: true } as const;
const PAINT = { roughness: 0.45, metalness: 0, textureSet: 'paint-micro', tint: '#ffffff', castsShadow: true } as const;
const METAL = { metalness: 1, tint: '#ffffff', castsShadow: true } as const;
const FABRIC = { textureSet: 'fabric-weave', roughness: 0.9, metalness: 0, sheen: 0.5, sheenRoughness: 0.7, tint: '#ffffff', castsShadow: true } as const;

/** Starting values from B3's table, tuned by eye in the studio look. */
export const FINISH_RENDER: Readonly<Record<string, FinishRender>> = {
  // The oak veneer photo is a warm mid-tone: lighter and cooler for white oak, warmer for red oak.
  'wood:white-oak': { ...WOOD, textureSet: 'wood-oak', tint: '#e3ecfa', gain: 1.3 },
  'wood:red-oak': { ...WOOD, textureSet: 'wood-oak', tint: '#ecdcd8', gain: 1.22 },
  // The walnut photo is pale (steamed-looking): deeper chocolate.
  'wood:walnut': { ...WOOD, textureSet: 'wood-walnut', tint: '#c9b8ab' },
  // The cherry photo is freshly cut and pale: cherry's finished reddish brown.
  'wood:cherry': { ...WOOD, textureSet: 'wood-cherry', tint: '#c4a6a6' },
  'wood:maple': { ...WOOD, textureSet: 'wood-maple', tint: '#fff4e0', gain: 1.1 },
  'wood:birch-ply': { ...WOOD, textureSet: 'wood-maple', tint: '#fff0d8', gain: 1.05 },
  paint: PAINT,
  lacquer: { ...PAINT, roughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.15 },
  melamine: { roughness: 0.45, metalness: 0, tint: '#ffffff', castsShadow: true },
  laminate: { roughness: 0.45, metalness: 0, tint: '#ffffff', castsShadow: true },
  'stone:quartz-white': { textureSet: 'stone-quartz', roughness: 0.18, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.1, tint: '#ffffff', castsShadow: true },
  'stone:marble-white': { textureSet: 'stone-marble', roughness: 0.12, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.08, tint: '#ffffff', castsShadow: true },
  'stone:marble-dark': { textureSet: 'stone-marble-dark', roughness: 0.12, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.08, tint: '#ffffff', castsShadow: true },
  'stone:granite-black': { roughness: 0.22, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.12, tint: '#ffffff', castsShadow: true },
  'tile:subway': { textureSet: 'tile-subway', roughness: 0.15, metalness: 0, tint: '#ffffff', castsShadow: true },
  'tile:floor': { textureSet: 'tile-floor', roughness: 0.38, metalness: 0, tint: '#ffffff', castsShadow: true },
  'floor:oak-plank': { textureSet: 'floor-oak-plank', roughness: 0.45, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.35, tint: '#ffffff', castsShadow: true },
  'floor:herringbone': { textureSet: 'floor-herringbone', roughness: 0.38, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.3, tint: '#ffffff', castsShadow: true },
  'floor:concrete': { textureSet: 'floor-concrete', roughness: 0.75, metalness: 0, tint: '#ffffff', castsShadow: true },
  'metal:stainless': { ...METAL, roughness: 0.35, anisotropy: 0.5 },
  'metal:brushed-nickel': { ...METAL, roughness: 0.32, anisotropy: 0.5 },
  'metal:chrome': { ...METAL, roughness: 0.06 },
  'metal:matte-black': { ...METAL, roughness: 0.55, metalness: 0.5 },
  'metal:brass': { ...METAL, roughness: 0.33, anisotropy: 0.5 },
  'glass:clear': { roughness: 0.02, metalness: 0, tint: '#ffffff', castsShadow: false, glass: { opacity: 0.12 } },
  'glass:frosted': { roughness: 0.35, metalness: 0, tint: '#ffffff', castsShadow: false, glass: { opacity: 0.5 } },
  'fabric:linen': FABRIC,
  'fabric:wool': FABRIC,
  // Leather isn't woven: smooth, a little sheen.
  'fabric:leather': { roughness: 0.5, metalness: 0, sheen: 0.25, sheenRoughness: 0.5, tint: '#ffffff', castsShadow: true },
  ceramic: { roughness: 0.15, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.05, tint: '#ffffff', castsShadow: true },
  plant: { roughness: 0.65, metalness: 0, sheen: 0.3, sheenRoughness: 0.6, tint: '#ffffff', castsShadow: true },
  light: { roughness: 0.5, metalness: 0, tint: '#ffffff', castsShadow: false, emissive: { kelvin: 2900, intensity: 6 } },
};

/** A preset's render params (aliases followed); unknown presets render as paint. */
export function finishRender(preset: string): FinishRender {
  return FINISH_RENDER[finishDef(preset)?.id ?? preset] ?? PAINT;
}
