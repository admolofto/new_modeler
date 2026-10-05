import { descendants, parentIndex } from './doc';
import type { Doc } from './schema';

/** Viewport visibility is inherited; a parent's eye never overwrites a child's own eye. */
export function hiddenNodes(doc: Doc): Set<string> {
  const hidden = new Set<string>();
  const visit = (id: string, inherited: boolean) => {
    const node = doc.parts[id] ?? doc.assemblies[id];
    if (!node) return;
    const hide = inherited || !!node.hidden;
    if (hide) hidden.add(id);
    for (const child of doc.assemblies[id]?.children ?? []) visit(child, hide);
  };
  for (const id of doc.roots) visit(id, false);
  return hidden;
}

/** Viewport clickability is inherited the same way: an unclickable folder makes its descendants unclickable. */
export function unclickableNodes(doc: Doc): Set<string> {
  const out = new Set<string>();
  const visit = (id: string, inherited: boolean) => {
    const node = doc.parts[id] ?? doc.assemblies[id];
    if (!node) return;
    const lock = inherited || !!node.unclickable;
    if (lock) out.add(id);
    for (const child of doc.assemblies[id]?.children ?? []) visit(child, lock);
  };
  for (const id of doc.roots) visit(id, false);
  return out;
}

const isolated = new WeakMap<Doc, { id: string; view: Doc }>();

/**
 * Isolating a folder (a view, not an edit): the doc as it's drawn with only that folder showing —
 * every sibling on the way down from the top level to it is hidden, so everything outside it is,
 * while inside it the real eyes still apply. Never build ops from it or save it. The same doc and
 * folder give back the same object (so caches keyed on the doc keep working); no folder, or one
 * not in this doc, gives back the doc itself.
 */
export function isolateView(doc: Doc, id: string | null): Doc {
  if (!id || !doc.assemblies[id]) return doc;
  const memo = isolated.get(doc);
  if (memo?.id === id) return memo.view;
  const parents = parentIndex(doc);
  if (!parents.has(id)) return doc;
  const parts = { ...doc.parts };
  const assemblies = { ...doc.assemblies };
  for (let cur = id; ; ) {
    const parent = parents.get(cur) ?? null;
    for (const s of parent ? doc.assemblies[parent]!.children : doc.roots) {
      if (s === cur) continue;
      if (parts[s]) parts[s] = { ...parts[s], hidden: true };
      else if (assemblies[s]) assemblies[s] = { ...assemblies[s], hidden: true };
    }
    if (!parent) break;
    cur = parent;
  }
  const view: Doc = { ...doc, parts, assemblies };
  isolated.set(doc, { id, view });
  return view;
}

/** The innermost folder holding every one of these nodes, or null (one is at the top level). */
export function enclosingAssembly(doc: Doc, ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const parents = parentIndex(doc);
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p = parents.get(id); p; p = parents.get(p)) out.push(p);
    return out;
  };
  let common = ancestors(ids[0]!);
  for (const id of ids.slice(1)) {
    const up = new Set(ancestors(id));
    common = common.filter((a) => up.has(a));
  }
  return common[0] ?? null;
}

/** The ids that aren't the folder or inside it (all of them, if the folder is gone). */
export function outsideOf(doc: Doc, folder: string, ids: Iterable<string>): string[] {
  const inside = new Set(doc.assemblies[folder] ? [folder, ...descendants(doc, folder)] : []);
  return [...ids].filter((id) => !inside.has(id));
}

/**
 * Why an isolated folder can't stay isolated once the doc goes from `prev` to `next`: it's gone or
 * hidden, or something new turned up outside it (a copy of it, an insert, an undo) that would
 * otherwise be invisible.
 */
export function isolationBroken(prev: Doc, next: Doc, folder: string): 'gone' | 'outside' | null {
  if (!next.assemblies[folder] || !parentIndex(next).has(folder) || hiddenNodes(next).has(folder)) return 'gone';
  const added = [...Object.keys(next.parts), ...Object.keys(next.assemblies)].filter((id) => !prev.parts[id] && !prev.assemblies[id]);
  return outsideOf(next, folder, added).length ? 'outside' : null;
}
