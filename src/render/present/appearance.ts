import * as THREE from 'three';
import { finishDef, swatchOf } from '../../model/finishes';
import type { Finish } from '../../model/schema';
import type { Surface } from '../../plugins/registry';
import { finishRender } from './finishDefs';
import { kelvinToRGB } from './lightPlan';
import { NO_TEXTURES, type TextureProvider } from './textures';
import { TEXTURE_SETS } from './textureSets';

/**
 * Presentation's materials (B3): one per look (finish preset + color + roughness + glow), shared by
 * every part drawn with it — physically based on the Balanced and High tiers, standard (no clearcoat,
 * sheen or anisotropy) on Fast. Textured finishes take their set's maps from the texture provider; a
 * set that isn't loaded yet draws the finish's flat swatch until `refresh()`.
 */

/** Blocks in presentation: white massing, like an architect's model. */
export const MASSING = '#e9e7e3';
/** How much brighter a hovered surface glows. */
export const HOVER_LIFT = 0.08;

export type PresentMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

export interface Appearance {
  /** A surface's material (cached). */
  material(s: Surface): PresentMaterial;
  /** Blocks' white massing. */
  massing(): PresentMaterial;
  /** A material's hover variant: a cached clone (sharing its maps), lifted a little. */
  hover(m: THREE.Material): THREE.Material;
  /** Draws nothing but still takes part in shadows (cut-away walls, phase 6). */
  readonly shadowOnly: THREE.Material;
  /** Glowing surfaces' brightness (fixtures on or off), 0…1. */
  setFixtureLevel(level: number): void;
  readonly physical: boolean;
  /** Physical or standard materials; drops the cache (repaint afterwards). */
  setPhysical(on: boolean): void;
  /** Drops the cache, e.g. once textures arrive (repaint afterwards). */
  refresh(): void;
  dispose(): void;
}

/** Whether a surface casts shadows (glass and glowing surfaces don't). */
export const castsShadow = (s: Surface): boolean => finishRender(s.finish.preset).castsShadow && !s.glow;

const OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } as const;

export function createAppearance(textures: TextureProvider = NO_TEXTURES, o: { physical?: boolean } = {}): Appearance {
  let physical = o.physical ?? true;
  let level = 1;
  const cache = new Map<string, PresentMaterial>();
  const hovers = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  /** Glowing materials and their intensity at full level. */
  const glowing = new Map<THREE.Material, number>();
  const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  shadowOnly.name = 'shadow-only';

  const make = (): PresentMaterial => (physical ? new THREE.MeshPhysicalMaterial(OFFSET) : new THREE.MeshStandardMaterial(OFFSET));

  const build = (f: Finish, glow: Surface['glow']): PresentMaterial => {
    const def = finishDef(f.preset);
    const r = finishRender(f.preset);
    const set = r.textureSet ? TEXTURE_SETS[r.textureSet] : undefined;
    const map = (kind: 'color' | 'normal' | 'roughness') => (set ? textures.get(set.id, kind) : null);
    const m = make();
    const color = map('color');
    if (set?.photo && color) {
      // The photo is the look: tinted (red oak's warmth), stained by the finish's color, brightened.
      m.color.set(r.tint);
      if (def?.tint === 'multiply' && f.color) m.color.multiply(new THREE.Color(f.color));
      if (r.gain) m.color.multiplyScalar(r.gain);
    } else {
      m.color.set(swatchOf(f));
    }
    if (color) m.map = color;
    const normal = map('normal');
    if (normal && set) {
      m.normalMap = normal;
      const k = set.normalScale * (r.normalScale ?? 1);
      m.normalScale.set(k, k);
    }
    const rough = f.roughness ?? r.roughness;
    const roughMap = map('roughness');
    if (roughMap && set) {
      m.roughnessMap = roughMap;
      m.roughness = Math.min(10, rough / set.roughnessMean);
    } else {
      m.roughness = rough;
    }
    m.metalness = r.metalness;
    if (m instanceof THREE.MeshPhysicalMaterial) {
      if (r.clearcoat) {
        m.clearcoat = r.clearcoat;
        m.clearcoatRoughness = r.clearcoatRoughness ?? 0.1;
      }
      if (r.anisotropy) m.anisotropy = r.anisotropy;
      if (r.sheen) {
        m.sheen = r.sheen;
        m.sheenRoughness = r.sheenRoughness ?? 0.6;
        m.sheenColor.copy(m.color);
      }
    }
    if (r.glass) Object.assign(m, { transparent: true, opacity: r.glass.opacity, depthWrite: false });
    if (r.emissive || glow) {
      const [cr, cg, cb] = kelvinToRGB(glow?.kelvin ?? r.emissive?.kelvin ?? 2900);
      m.emissive.setRGB(cr, cg, cb, THREE.SRGBColorSpace);
      const full = (r.emissive?.intensity ?? 6) * (glow?.strength ?? 1);
      glowing.set(m, full);
      m.emissiveIntensity = full * level;
    }
    return m;
  };

  const drop = () => {
    for (const m of cache.values()) m.dispose();
    for (const m of hovers.values()) m.dispose();
    cache.clear();
    hovers.clear();
    glowing.clear();
  };

  return {
    shadowOnly,
    get physical() {
      return physical;
    },
    material(s) {
      const f = s.finish;
      const key = `${f.preset}|${f.color ?? ''}|${f.roughness ?? ''}|${s.glow ? `${s.glow.kelvin}:${s.glow.strength}` : ''}`;
      let m = cache.get(key);
      if (!m) {
        m = build(f, s.glow);
        m.name = key;
        cache.set(key, m);
      }
      return m;
    },
    massing() {
      let m = cache.get('block');
      if (!m) {
        m = make();
        m.color.set(MASSING);
        m.roughness = 0.8;
        m.metalness = 0;
        m.name = 'block';
        cache.set('block', m);
      }
      return m;
    },
    hover(m) {
      let h = hovers.get(m);
      if (!h) {
        h = (m as THREE.MeshStandardMaterial).clone();
        if (h.emissive.getHex() === 0) {
          h.emissive.set('#ffffff');
          h.emissiveIntensity = HOVER_LIFT;
        } else {
          h.emissiveIntensity += HOVER_LIFT * 4; // a light fixture already glows: brighter
        }
        h.name = `${m.name}:hover`;
        hovers.set(m, h);
      }
      return h;
    },
    setFixtureLevel(l) {
      level = Math.max(0, l);
      for (const [m, full] of glowing) (m as THREE.MeshStandardMaterial).emissiveIntensity = full * level;
      for (const [m, h] of hovers) {
        const full = glowing.get(m);
        if (full !== undefined) h.emissiveIntensity = full * level + HOVER_LIFT * 4;
      }
    },
    setPhysical(on) {
      if (on === physical) return;
      physical = on;
      drop();
    },
    refresh: drop,
    dispose() {
      drop();
      shadowOnly.dispose();
    },
  };
}
