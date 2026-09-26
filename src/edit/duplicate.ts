import { ModelError, nextId, parentIndex } from '../model/doc';
import { genPartId } from '../model/generate';
import { applyOps, blockName, type Op } from '../model/ops';
import type { Doc } from '../model/schema';

/**
 * Copies of blocks, parts and assemblies, as ops that put each copy exactly where its original is
 * (callers move or turn the copies after). New ids, everything else the same: a generated assembly
 * regenerates from its params and replays its overrides (hand edits and features on its parts); user
 * joints between copied parts are copied too. Bindings are dropped — a copy doesn't follow the
 * original's variables — and notes stay with the original. Pure.
 */
export function duplicateOps(doc: Doc, ids: readonly string[]): { ops: Op[]; copies: string[]; doc: Doc } {
  const ops: Op[] = [];
  let scratch = doc;
  const push = (...batch: Op[]) => {
    const r = applyOps(scratch, batch);
    if (!r.ok) throw new ModelError(r.error);
    scratch = r.doc;
    ops.push(...batch);
  };
  /** Original id → copy id, for joints. */
  const copied = new Map<string, string>();
  const parents = parentIndex(doc);

  const copy = (src: string, parent: string | null, index?: number): string => {
    const at = index === undefined ? {} : { index };
    const part = doc.parts[src];
    if (part) {
      const transform = structuredClone(part.transform);
      if (part.block) {
        const p = part.shape.params as { x: number; y: number; z: number };
        const id = nextId(scratch, 'b');
        // A default name follows the new id (no two "Block 3"s); a name the user gave is kept.
        const name = part.name === blockName(src) ? blockName(id) : part.name;
        push({ op: 'add', entity: { kind: 'block', id, name, transform, size: [p.x, p.y, p.z] }, parent, ...at });
        copied.set(src, id);
        return id;
      }
      if (!part.material) throw new ModelError(`"${part.name}" has no material`);
      const id = nextId(scratch, 'p');
      const entity = { kind: 'part' as const, id, name: part.name, material: part.material, grain: part.grain, transform, shape: structuredClone(part.shape), features: structuredClone(part.features) };
      push({ op: 'add', entity, parent, ...at });
      copied.set(src, id);
      return id;
    }
    const asm = doc.assemblies[src];
    if (!asm) throw new ModelError(`nothing to copy with id "${src}"`);
    const id = nextId(scratch, 'a');
    const generator = asm.generator && { type: asm.generator.type, params: structuredClone(asm.generator.params) };
    push({ op: 'add', entity: { kind: 'assembly', id, name: asm.name, transform: structuredClone(asm.transform), ...(generator && { generator }) }, parent, ...at });
    copied.set(src, id);
    if (asm.generator) {
      // Hand edits to generated parts: replay each override so the copy's overrides match.
      for (const [role, ov] of Object.entries(asm.generator.overrides)) {
        const [from, to] = [genPartId(src, role), genPartId(id, role)];
        if (ov.deleted) {
          if (scratch.parts[to]) push({ op: 'delete', id: to });
          continue;
        }
        const orig = doc.parts[from];
        const mine = scratch.parts[to];
        if (!orig || !mine) continue;
        const patch = {
          ...(ov.name !== undefined && { name: orig.name }),
          ...(ov.material !== undefined && { material: orig.material }),
          ...(ov.grain !== undefined && { grain: orig.grain }),
          ...(ov.shape && { shape: { params: structuredClone(orig.shape.params) } }),
        };
        if (Object.keys(patch).length) push({ op: 'update', id: to, patch });
        if (ov.position || ov.rotation) push({ op: 'move', id: to, to: [...orig.transform.position], rotation: [...orig.transform.rotation] });
        if (ov.features) {
          push(
            ...mine.features.map((f): Op => ({ op: 'removeFeature', part: to, feature: f.id })),
            ...orig.features.map((f): Op => ({ op: 'addFeature', part: to, feature: structuredClone(f) })),
          );
        }
      }
      for (const c of asm.children) if (doc.parts[c]?.role !== undefined && scratch.parts[genPartId(id, doc.parts[c]!.role!)]) copied.set(c, genPartId(id, doc.parts[c]!.role!));
    }
    for (const c of asm.children) if (doc.parts[c]?.role === undefined) copy(c, id);
    return id;
  };

  const copies = ids.map((src, i) => {
    const parent = parents.get(src) ?? null;
    const list = parent ? doc.assemblies[parent]!.children : doc.roots;
    return copy(src, parent, list.indexOf(src) + 1 + i);
  });

  // User joints between copied parts.
  const joints = Object.values(doc.joints).filter((j) => j.role === undefined && copied.has(j.parts[0]) && copied.has(j.parts[1]));
  for (const j of joints) {
    push({ op: 'add', entity: { kind: 'joint', id: nextId(scratch, 'j'), type: j.type, parts: [copied.get(j.parts[0])!, copied.get(j.parts[1])!], params: { ...j.params } } });
  }
  return { ops, copies, doc: scratch };
}
