import { descendants, parentIndex } from '../model/doc';
import type { Op } from '../model/ops';
import type { Doc } from '../model/schema';

/**
 * The ops that erase these parts. A folder whose parts are all erased (two or more) goes whole, the
 * way deleting a selected cabinet does, rather than leaving an empty shell behind. Pure.
 */
export function eraseOps(doc: Doc, partIds: readonly string[]): Op[] {
  const picked = new Set(partIds.filter((id) => doc.parts[id]));
  const parents = parentIndex(doc);
  const covered = (asm: string) => {
    const parts = descendants(doc, asm).filter((id) => doc.parts[id]);
    return parts.length >= 2 && parts.every((id) => picked.has(id));
  };
  /** The biggest fully-erased folder above a node, if any. */
  const wholeAbove = (id: string): string | null => {
    let top: string | null = null;
    for (let p = parents.get(id); p; p = parents.get(p)) if (covered(p)) top = p;
    return top;
  };
  const out = new Set<string>();
  for (const id of picked) out.add(wholeAbove(id) ?? id);
  return [...out].map((id): Op => ({ op: 'delete', id }));
}
