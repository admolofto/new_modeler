import * as THREE from 'three';
import { boxUVs, uvOffset } from '../../geometry/uv';
import { isDecor } from '../../model/decor';
import { effectiveFinish, partLook, surfacesOf } from '../../model/look';
import type { Doc, Part } from '../../model/schema';
import type { Surface } from '../../plugins/registry';
import { toGeometry, type Look } from '../sceneSync';
import { castsShadow, createAppearance, HOVER_LIFT, MASSING, type Appearance } from './appearance';
import { finishRender } from './finishDefs';
import { NO_TEXTURES, type TextureProvider } from './textures';

export { HOVER_LIFT, MASSING };

/**
 * Presentation's look (B1, B3): every surface in its finish — a material's finish (set, or inferred
 * from its name) decides the look here, not `material.color` — with textures laid along each part's
 * grain (`geometry/uv.ts`), lit and shadowed; no edge lines, no block arrows; blocks as white massing.
 * Materials come from `appearance.ts`, shared per look.
 *
 * A part's triangles are sorted by surface (stably, with their pick tags), one geometry group each;
 * surfaces that cast no shadow (glass, glowing ones) draw from a child mesh sharing the geometry's
 * buffers, so the rest of the part still casts and ambient occlusion skips them (`userData.noAO`).
 */
export interface PresentLook extends Look {
  readonly appearance: Appearance;
  /** A material's hover variant (a cached clone, lifted a little): what a click would open or close. */
  hover(m: THREE.Material): THREE.Material;
  /** Draws a part's mesh (and its see-through child) with the hover variants of its materials. */
  paintHover(mesh: THREE.Mesh): void;
  /** Frees every material it made (the presentation is over). */
  disposeMaterials(): void;
}

/** The texture sets a doc's visible looks use (to load before the first frame). */
export function usedTextureSets(doc: Doc): Set<string> {
  const out = new Set<string>();
  const add = (s: Surface) => {
    const set = finishRender(s.finish.preset).textureSet;
    if (set) out.add(set);
  };
  for (const part of Object.values(doc.parts)) {
    if (part.block) continue;
    if (isDecor(part)) {
      const map = surfacesOf(part);
      if (!map) continue;
      add(map.base);
      for (const s of Object.values(map.tags ?? {})) add(s);
      for (const [, s] of map.prefixes ?? []) add(s);
    } else add({ finish: effectiveFinish(doc, part.id).finish });
  }
  return out;
}

/**
 * Sorts a geometry's triangles by slot, keeping their order within a slot, and permutes the pick tags
 * with them. Returns each slot's run: `[slot, first index, index count]`, in slot order.
 */
export function sortBySlot(g: THREE.BufferGeometry, tagSlots: readonly number[]): [number, number, number][] {
  const { triTags, tags } = g.userData as { triTags: Uint16Array; tags: string[] };
  const index = g.getIndex()!.array as Uint32Array;
  const n = triTags.length;
  const slotOf = (t: number) => tagSlots[triTags[t]!] ?? 0;
  const slots = Math.max(0, ...tagSlots) + 1;
  const count = new Array<number>(slots).fill(0);
  for (let t = 0; t < n; t++) count[slotOf(t)]!++;
  const start = new Array<number>(slots).fill(0);
  for (let s = 1; s < slots; s++) start[s] = start[s - 1]! + count[s - 1]!;
  const next = [...start];
  // New arrays: the built mesh's are shared with the editor (and cached).
  const sortedIndex = new Uint32Array(index.length);
  const sortedTags = new Uint16Array(n);
  for (let t = 0; t < n; t++) {
    const to = next[slotOf(t)]!++;
    sortedIndex.set(index.subarray(t * 3, t * 3 + 3), to * 3);
    sortedTags[to] = triTags[t]!;
  }
  g.setIndex(new THREE.BufferAttribute(sortedIndex, 1));
  g.userData = { triTags: sortedTags, tags };
  const runs: [number, number, number][] = [];
  for (let s = 0; s < slots; s++) if (count[s]) runs.push([s, start[s]! * 3, count[s]! * 3]);
  return runs;
}

/** The child mesh drawing a part's surfaces that cast no shadow. */
const SEE_THROUGH = 'no-shadow surfaces';

export function presentLook(o: { textures?: TextureProvider; physical?: boolean } = {}): PresentLook {
  const appearance = createAppearance(o.textures ?? NO_TEXTURES, { physical: o.physical ?? true });

  /** A part's surfaces now, each slot's material, and which slots cast. */
  const surfaces = (doc: Doc, part: Part, tags: readonly string[]) => {
    const look = partLook(doc, part, tags);
    const materials = look.kind === 'block' ? look.slots.map(() => appearance.massing()) : look.slots.map((s) => appearance.material(s));
    const casts = look.kind === 'block' ? look.slots.map(() => true) : look.slots.map(castsShadow);
    return { look, materials, casts };
  };
  const tagsOf = (mesh: THREE.Mesh) => (mesh.geometry.userData as { tags: string[] }).tags;
  const childOf = (mesh: THREE.Mesh) => mesh.children.find((c) => c.name === SEE_THROUGH) as THREE.Mesh | undefined;
  const setMaterial = (mesh: THREE.Mesh, m: THREE.Material | THREE.Material[]) => {
    mesh.material = m;
    const child = childOf(mesh);
    if (child) child.material = m;
  };

  return {
    appearance,
    // Grain and (for stock parts) the finish's preset shape the geometry: UVs, and what casts.
    key: (doc, part) => `|${part.grain}|${part.block || isDecor(part) ? '' : effectiveFinish(doc, part.id).finish.preset}`,
    build(doc, part, built) {
      const geometry = toGeometry(built.mesh);
      geometry.setAttribute('uv', new THREE.BufferAttribute(boxUVs(built.mesh, { grain: part.grain, offset: uvOffset(part.id) }), 2));
      const { look, materials, casts } = surfaces(doc, part, built.mesh.tags);
      if (materials.length === 1 && casts[0]) {
        const mesh = new THREE.Mesh(geometry, materials[0]);
        mesh.castShadow = mesh.receiveShadow = true;
        return mesh;
      }
      const runs = sortBySlot(geometry, look.tagSlots);
      for (const [slot, start, count] of runs) if (casts[slot]) geometry.addGroup(start, count, slot);
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.castShadow = runs.some(([slot]) => casts[slot]);
      mesh.receiveShadow = true;
      const quiet = runs.filter(([slot]) => !casts[slot]);
      if (quiet.length) {
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(geometry.attributes)) g.setAttribute(name, attr);
        g.setIndex(geometry.getIndex());
        g.userData = geometry.userData;
        for (const [slot, start, count] of quiet) g.addGroup(start, count, slot);
        g.boundingSphere = geometry.boundingSphere;
        const child = new THREE.Mesh(g, materials);
        child.name = SEE_THROUGH;
        child.castShadow = false;
        child.receiveShadow = true;
        child.userData.noAO = true;
        mesh.add(child);
      }
      return mesh;
    },
    paint(mesh, doc, part) {
      const { materials } = surfaces(doc, part, tagsOf(mesh));
      // By how it was built (groups or a see-through child: one material per slot), not by its material
      // now: a cut-away mesh wears the single shadow-only material.
      setMaterial(mesh, mesh.geometry.groups.length || childOf(mesh) ? materials : materials[0]!);
    },
    dispose(mesh) {
      mesh.geometry.dispose();
      for (const child of mesh.children) (child as THREE.Mesh).geometry?.dispose();
    },
    hover: (m) => appearance.hover(m),
    paintHover(mesh) {
      const m = mesh.material;
      setMaterial(mesh, Array.isArray(m) ? m.map(appearance.hover) : appearance.hover(m));
    },
    disposeMaterials: () => appearance.dispose(),
  };
}
