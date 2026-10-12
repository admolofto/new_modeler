import * as THREE from 'three';
import { proceduralMap } from './procedural';
import { TEXTURE_SETS, type MapKind, type TextureSet } from './textureSets';

/**
 * Presentation's textures (B3): the bundled photo sets, loaded as ImageBitmaps off the main thread,
 * and the procedural ones, drawn on first use. A map is handed out only once it's ready (a material
 * made before then draws its finish's flat color; `onLoad` tells the session to redo its materials).
 */

/** Hands out a texture set's maps (`null`: the set has no such map, or it isn't loaded yet). */
export interface TextureProvider {
  get(set: string, kind: MapKind): THREE.Texture | null;
}

/** No textures at all (tests, or before anything loads): every finish draws its flat color. */
export const NO_TEXTURES: TextureProvider = { get: () => null };

export interface Textures extends TextureProvider {
  /** Loads these sets (procedural ones are drawn at once); resolves when all are ready or failed. */
  preload(ids: Iterable<string>): Promise<void>;
  dispose(): void;
}

/**
 * A map's sampling: color in sRGB, data (normal, roughness) as is; repeating, mipmapped and
 * anisotropic; one repeat per the set's real size (UVs are inches), turned a quarter when the image's
 * grain runs along u (UVs run v along the grain).
 */
export function configureTexture<T extends THREE.Texture>(t: T, set: TextureSet, kind: MapKind, anisotropy = 1): T {
  t.name = `${set.id}/${kind}`;
  t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.repeat.set(1 / set.size[0], 1 / set.size[1]);
  t.rotation = set.grain === 'u' ? Math.PI / 2 : 0;
  return t;
}

export function createTextures(renderer: THREE.WebGLRenderer, o: { onLoad(set: string): void; small?: boolean }): Textures {
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const ready = new Map<string, THREE.Texture>();
  const loading = new Map<string, Promise<void>>();
  const loader = new THREE.ImageBitmapLoader();
  loader.setOptions({
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    // Lighter on the Fast tier (integrated or software GPUs).
    ...(o.small && { resizeWidth: 512, resizeHeight: 512, resizeQuality: 'high' }),
  });
  let disposed = false;
  const keyOf = (set: string, kind: MapKind) => `${set}/${kind}`;

  const load = (set: TextureSet): Promise<void> => {
    let p = loading.get(set.id);
    if (p) return p;
    const kinds = Object.keys(set.files) as MapKind[];
    p = Promise.all(
      kinds.map(async (kind) => {
        const bitmap = await loader.loadAsync(`${import.meta.env.BASE_URL}textures/${set.id}/${set.files[kind]}`);
        if (disposed) return (bitmap as ImageBitmap).close?.();
        const t = configureTexture(new THREE.Texture(bitmap as ImageBitmap), set, kind, anisotropy);
        t.flipY = false; // flipped by the loader
        t.needsUpdate = true;
        renderer.initTexture(t);
        ready.set(keyOf(set.id, kind), t);
      }),
    ).then(
      () => {
        if (!disposed) o.onLoad(set.id);
      },
      (err) => console.warn(`presentation: texture set ${set.id} didn't load; it draws flat`, err),
    );
    loading.set(set.id, p);
    return p;
  };

  return {
    get(id, kind) {
      const set = TEXTURE_SETS[id];
      if (!set?.files[kind]) return null;
      const hit = ready.get(keyOf(id, kind));
      if (hit) return hit;
      if (set.procedural) {
        const px = proceduralMap(set.procedural, kind);
        if (!px) return null;
        const t = configureTexture(new THREE.DataTexture(px.data, px.width, px.height, THREE.RGBAFormat), set, kind, anisotropy);
        t.needsUpdate = true;
        ready.set(keyOf(id, kind), t);
        return t;
      }
      void load(set);
      return null;
    },
    async preload(ids) {
      const sets = [...new Set(ids)].map((id) => TEXTURE_SETS[id]).filter((s): s is TextureSet => !!s);
      for (const s of sets.filter((s) => s.procedural)) for (const kind of Object.keys(s.files) as MapKind[]) this.get(s.id, kind);
      await Promise.all(sets.filter((s) => !s.procedural).map(load));
    },
    dispose() {
      disposed = true;
      for (const t of ready.values()) {
        t.dispose();
        (t.image as ImageBitmap | undefined)?.close?.();
      }
      ready.clear();
      loading.clear();
    },
  };
}
