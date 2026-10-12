import type { V3 } from '../geometry/types';
import { shapes, type LightSpec, type Surface, type SurfaceMap } from '../plugins/registry';
import { isDecor } from './decor';
import { parentIndex } from './doc';
import { finishDef, finishOf, swatchOf } from './finishes';
import type { Doc, Finish, Part } from './schema';
import { hiddenNodes } from './visibility';
import { allAffines, apply, rotate } from './world';

/**
 * The look contract (A4): how each part looks, as data. The render layer's single entry point — the
 * editor draws flat colors from it (binding note 9), presentation mode its materials. Pure; memoized
 * per doc (docs never change once made).
 */

/**
 * A part's surfaces: `slots` (one material each), which slot each mesh tag draws with, and whether
 * the look was set on purpose (`explicit`; an inferred finish draws in the material's own color).
 */
export interface PartLook {
  kind: 'stock' | 'decor' | 'block';
  slots: Surface[];
  /** Per mesh tag (`TaggedMesh.tags`) → slot index. */
  tagSlots: number[];
  explicit: boolean;
  /** Set on the part or a folder above it (an override of its material's look), not by the material. */
  node: boolean;
}

/** Blockout clay, as render/palette.ts draws blocks: the sides, and the lighter front. */
export const BLOCK_CLAY = '#a9aeb7';
export const BLOCK_CLAY_FRONT = '#d3d7dd';
/** A part whose material is missing (the validator reports it): loud on purpose. */
const MISSING: Finish = { preset: 'paint', color: '#ff00ff' };

const parentsOf = new WeakMap<Doc, Map<string, string | null>>();
const parents = (doc: Doc) => {
  let hit = parentsOf.get(doc);
  if (!hit) parentsOf.set(doc, (hit = parentIndex(doc)));
  return hit;
};

/** A decor part's surface map, from its shape. */
export function surfacesOf(part: Part): SurfaceMap | null {
  if (!shapes.has(part.shape.type)) return null;
  return shapes.get(part.shape.type).surfaces?.(part.shape.params) ?? null;
}

/** How a mesh tag looks: its exact tag, else the longest prefix it starts with, else the base. */
export function surfaceFor(map: SurfaceMap, tag: string): Surface {
  const exact = map.tags?.[tag];
  if (exact) return exact;
  let best: [string, Surface] | undefined;
  for (const entry of map.prefixes ?? []) if (tag.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best?.[1] ?? map.base;
}

/**
 * A stock part's finish: its own, else the nearest folder's above it, else its material's (explicit
 * when the material sets one; inferred from its name otherwise). Decor gives its base surface; a
 * block, clay.
 */
export function effectiveFinish(doc: Doc, partId: string): { finish: Finish; explicit: boolean; node: boolean } {
  const part = doc.parts[partId];
  if (!part) return { finish: MISSING, explicit: false, node: false };
  if (part.block) return { finish: { preset: 'paint', color: BLOCK_CLAY }, explicit: false, node: false };
  if (isDecor(part)) {
    const map = surfacesOf(part);
    return map ? { finish: map.base.finish, explicit: true, node: true } : { finish: MISSING, explicit: false, node: false };
  }
  if (part.finish) return { finish: part.finish, explicit: true, node: true };
  const up = parents(doc);
  for (let p = up.get(partId); p; p = up.get(p)) {
    const f = doc.assemblies[p]?.finish;
    if (f) return { finish: f, explicit: true, node: true };
  }
  const m = part.material ? doc.materials[part.material] : undefined;
  if (!m) return { finish: MISSING, explicit: false, node: false };
  return { finish: finishOf(m), explicit: !!m.finish, node: false };
}

/** A part's look for a mesh with these tags. Decor: its shape's surfaces; blocks: clay with a lighter front. */
export function partLook(doc: Doc, part: Part, tags: readonly string[]): PartLook {
  if (part.block) {
    const clay = (color: string): Surface => ({ finish: { preset: 'paint', color } });
    return { kind: 'block', slots: [clay(BLOCK_CLAY), clay(BLOCK_CLAY_FRONT)], tagSlots: tags.map((t) => (t === 'face:front' ? 1 : 0)), explicit: false, node: false };
  }
  const map = isDecor(part) ? surfacesOf(part) : null;
  if (map) {
    // Slot 0 is the base; equal surfaces share a slot.
    const slots: Surface[] = [];
    const index = new Map<string, number>();
    const slotOf = (s: Surface) => {
      const key = JSON.stringify(s);
      let i = index.get(key);
      if (i === undefined) {
        index.set(key, (i = slots.length));
        slots.push(s);
      }
      return i;
    };
    slotOf(map.base);
    return { kind: 'decor', slots, tagSlots: tags.map((t) => slotOf(surfaceFor(map, t))), explicit: true, node: true };
  }
  const { finish, explicit, node } = effectiveFinish(doc, part.id);
  return { kind: 'stock', slots: [{ finish }], tagSlots: tags.map(() => 0), explicit, node };
}

/**
 * The flat color each slot draws in the editor (binding note 9): a finish set on the part or a
 * folder draws its swatch; otherwise a stock part keeps its material's color (setting a material's
 * finish moves that color to the finish's swatch, see ops), so docs from before finishes look the same.
 */
export function editorColors(doc: Doc, part: Part, look: PartLook): string[] {
  if (look.kind === 'stock' && !look.node) return [(part.material && doc.materials[part.material]?.color) || MISSING.color!];
  return look.slots.map((s) => swatchOf(s.finish));
}

/** Glass draws see-through. */
export const isGlass = (f: Finish): boolean => finishDef(f.preset)?.family === 'glass';

/** Every light a fixture gives off, in world space (model units). Hidden parts give none. */
export interface SceneLight {
  part: string;
  at: V3;
  dir?: V3;
  /** An area light's width direction (world). */
  along?: V3;
  spec: LightSpec;
}

export function sceneLights(doc: Doc): SceneLight[] {
  const out: SceneLight[] = [];
  const lit = Object.values(doc.parts).filter((p) => shapes.has(p.shape.type) && shapes.get(p.shape.type).lights);
  if (!lit.length) return out;
  const hidden = hiddenNodes(doc);
  const affines = allAffines(doc);
  for (const part of lit) {
    const A = affines.get(part.id);
    if (!A || hidden.has(part.id)) continue;
    for (const spec of shapes.get(part.shape.type).lights!(part.shape.params)) {
      const along = spec.along ?? (spec.kind === 'area' ? ([1, 0, 0] as V3) : undefined);
      out.push({ part: part.id, at: apply(A, spec.at), ...(spec.dir && { dir: rotate(A.m, spec.dir) }), ...(along && { along: rotate(A.m, along) }), spec });
    }
  }
  return out;
}
