/**
 * The texture sets presentation draws with (B3; pure data). Photo sets are bundled CC0 JPGs at
 * `public/textures/<id>/{color,normal,roughness}.jpg` (OpenGL-convention normal maps; credits in
 * `public/textures/LICENSES.md`, fetched by `scripts/fetch-textures.mjs`); procedural sets are drawn
 * at runtime (`procedural.ts`). UVs are in inches (`geometry/uv.ts`, v along the grain), so a set's
 * repeat is one over its real-world size; a set whose image grain runs along u is turned a quarter.
 */

export type MapKind = 'color' | 'normal' | 'roughness';
export type Procedural = 'tile-subway' | 'tile-floor' | 'paint-micro';

export interface TextureSet {
  id: string;
  /** File names under `textures/<id>/`; a procedural set lists the maps it generates instead. */
  files: Partial<Record<MapKind, string>>;
  /** Drawn at runtime instead of loaded. */
  procedural?: Procedural;
  /** Real-world size of one tile of the image, inches, along the image's u and v. */
  size: [number, number];
  /** Which way the image's grain (or its pattern's long side) runs; null when it has none. */
  grain: 'u' | 'v' | null;
  /**
   * The color map is a photograph (its colors are the look; a finish's stain multiplies it). Else it
   * is a light mask (tile with darker grout) multiplied by the finish's own color.
   */
  photo: boolean;
  /** Average color of the color map (sRGB), for reference and a texture-less fallback. */
  avg: string;
  /** Mean of the roughness map (green channel, 0…1): the material's roughness is scaled by 1/this. */
  roughnessMean: number;
  /** Normal map strength. */
  normalScale: number;
  source: string;
  license: 'CC0';
}

const JPG = { color: 'color.jpg', normal: 'normal.jpg', roughness: 'roughness.jpg' } as const;
const inches = (mm: number) => Math.round((mm / 25.4) * 10) / 10;

/**
 * Sizes from the sources (Poly Haven's real-world scale; ambientCG publishes none, so stone is set by
 * eye); grain directions, averages and roughness means measured from the images.
 */
export const TEXTURE_SETS: Readonly<Record<string, TextureSet>> = Object.fromEntries(
  (
    [
      { id: 'wood-oak', files: JPG, size: [inches(1830), inches(1830)], grain: 'v', photo: true, avg: '#a27f58', roughnessMean: 0.53, normalScale: 0.6, source: 'Poly Haven: oak_veneer_01' },
      { id: 'wood-walnut', files: JPG, size: [inches(1800), inches(1800)], grain: 'v', photo: true, avg: '#8a6a51', roughnessMean: 0.577, normalScale: 0.6, source: 'Poly Haven: walnut_veneer' },
      { id: 'wood-cherry', files: JPG, size: [inches(1000), inches(1000)], grain: 'u', photo: true, avg: '#e0b084', roughnessMean: 0.697, normalScale: 0.6, source: 'Poly Haven: cherry_veneer' },
      { id: 'wood-maple', files: JPG, size: [inches(1000), inches(1000)], grain: 'u', photo: true, avg: '#d2bea6', roughnessMean: 0.56, normalScale: 0.6, source: 'Poly Haven: romantic_veneer' },
      { id: 'floor-oak-plank', files: JPG, size: [inches(1200), inches(1200)], grain: 'u', photo: true, avg: '#a37654', roughnessMean: 0.443, normalScale: 1, source: 'Poly Haven: oak_wood_planks' },
      { id: 'floor-herringbone', files: JPG, size: [inches(3400), inches(3400)], grain: null, photo: true, avg: '#94704e', roughnessMean: 0.099, normalScale: 1, source: 'Poly Haven: herringbone_parquet' },
      { id: 'floor-concrete', files: JPG, size: [inches(2500), inches(2500)], grain: null, photo: true, avg: '#6b6358', roughnessMean: 0.784, normalScale: 1, source: 'Poly Haven: brushed_concrete' },
      { id: 'fabric-weave', files: { normal: JPG.normal, roughness: JPG.roughness }, size: [inches(271), inches(271)], grain: null, photo: false, avg: '#ffffff', roughnessMean: 0.718, normalScale: 1, source: 'Poly Haven: rough_linen' },
      { id: 'stone-quartz', files: JPG, size: [48, 48], grain: null, photo: true, avg: '#f4f2f1', roughnessMean: 0.116, normalScale: 0.3, source: 'ambientCG: Marble021' },
      { id: 'stone-marble', files: JPG, size: [60, 60], grain: null, photo: true, avg: '#adaeb7', roughnessMean: 0.066, normalScale: 0.3, source: 'ambientCG: Marble012' },
      { id: 'stone-marble-dark', files: JPG, size: [60, 60], grain: null, photo: true, avg: '#1f1f1e', roughnessMean: 0.097, normalScale: 0.3, source: 'ambientCG: Marble006' },
      // Procedural (procedural.ts): 3×6 subway tile in running bond with its long side along u (a
      // 12" × 12" repeat), 24" floor tile (48" repeat, a little variation per tile), and paint's
      // fine orange-peel normal.
      { id: 'tile-subway', files: JPG, procedural: 'tile-subway', size: [12, 12], grain: 'u', photo: false, avg: '#f4f4f4', roughnessMean: 0.152, normalScale: 1, source: 'generated' },
      { id: 'tile-floor', files: JPG, procedural: 'tile-floor', size: [48, 48], grain: null, photo: false, avg: '#f2f2f2', roughnessMean: 0.369, normalScale: 1, source: 'generated' },
      { id: 'paint-micro', files: { normal: JPG.normal }, procedural: 'paint-micro', size: [4, 4], grain: null, photo: false, avg: '#ffffff', roughnessMean: 1, normalScale: 0.07, source: 'generated' },
    ] satisfies Omit<TextureSet, 'license'>[]
  ).map((s) => [s.id, { ...s, license: 'CC0' as const } as TextureSet]),
);

/** The sets loaded from files (not drawn at runtime). */
export const fileSets = (): TextureSet[] => Object.values(TEXTURE_SETS).filter((s) => !s.procedural);
