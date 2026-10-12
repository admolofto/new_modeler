import { generators, shapes, type DecorInfo } from '../plugins/registry';
import { descendants } from './doc';
import type { Doc, Part } from './schema';

/**
 * Decor (binding note 1): room pieces, props and hardware are parts whose shape is a decor shape.
 * Like blocks, they have no material and stay out of the cut list, joints, nesting and overall
 * dims, so picking, the gizmo, snapping, notes, voice, motions, glTF, undo and the AI schema keep
 * working for them unchanged. Pure.
 */

/** A decor shape's info, or undefined for stock shapes (and unknown ones). */
export function decorInfo(type: string): DecorInfo | undefined {
  return shapes.has(type) ? shapes.get(type).decor : undefined;
}

export const isDecor = (part: Part): boolean => !part.block && !!decorInfo(part.shape.type);

/** A real part to cut: not a block, not decor. */
export const isShopPart = (part: Part): boolean => !part.block && !isDecor(part);

/** Takes up space: everything but rugs, trim, recessed cans… (`DecorInfo.solid: false`). */
export const isSolid = (part: Part): boolean => decorInfo(part.shape.type)?.solid !== false;

/** Part ids made by (or put in) assemblies whose generator surrounds the model: the room. */
export function surroundingsOf(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const asm of Object.values(doc.assemblies)) {
    if (!asm.generator || !generators.has(asm.generator.type) || !generators.get(asm.generator.type).surroundings) continue;
    for (const id of descendants(doc, asm.id)) if (doc.parts[id]) out.add(id);
  }
  return out;
}

/** Every part but the surroundings: what fits, camera framing, whole-model dims and recipe placement measure. */
export function modelPartIds(doc: Doc): string[] {
  const room = surroundingsOf(doc);
  return Object.keys(doc.parts).filter((id) => !room.has(id));
}
