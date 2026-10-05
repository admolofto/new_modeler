import { parentIndex } from '../model/doc';
import type { Doc } from '../model/schema';

const DEFAULT_NAMES = new Set(['part', 'assembly']);

/**
 * Tree problems an apply_ops batch introduced, listed in its result so the AI fixes them before it
 * finishes. Only nodes the batch created, moved or renamed are judged: a messy model the AI wasn't
 * asked to tidy stays quiet. Generated parts are the generator's business and are skipped.
 */
export function treeIssues(before: Doc, after: Doc): string[] {
  const oldParents = parentIndex(before);
  const parents = parentIndex(after);
  const node = (d: Doc, id: string) => d.parts[id] ?? d.assemblies[id];
  const label = (id: string) => `${id} "${node(after, id)?.name ?? ''}"`;
  const touched = new Set(
    [...parents.keys()].filter((id) => {
      const now = node(after, id);
      if (!now || now.role !== undefined) return false;
      const was = node(before, id);
      return !was || oldParents.get(id) !== parents.get(id) || was.name !== now.name;
    }),
  );
  const issues: string[] = [];

  for (const id of touched) {
    if (DEFAULT_NAMES.has(node(after, id)!.name.trim().toLowerCase())) issues.push(`${label(id)} has a default name; name it for what it is`);
  }
  // New folders left empty, and folders this batch emptied.
  for (const a of Object.values(after.assemblies)) {
    if (a.generator || a.children.length) continue;
    const was = before.assemblies[a.id];
    if (!was || was.children.length) issues.push(`${label(a.id)} is an empty folder; put its parts in it or delete it`);
  }
  for (const parent of new Set([...touched].map((id) => parents.get(id) ?? null))) {
    const siblings = parent ? (after.assemblies[parent]?.children ?? []) : after.roots;
    const byName = new Map<string, string[]>();
    for (const id of siblings) {
      const name = node(after, id)?.name.trim().toLowerCase();
      if (name) byName.set(name, [...(byName.get(name) ?? []), id]);
    }
    for (const ids of byName.values()) {
      if (ids.length > 1 && ids.some((id) => touched.has(id))) {
        issues.push(`${ids.map(label).join(' and ')} share a name under ${parent ? label(parent) : 'the top level'}; make sibling names unique (number repeats)`);
      }
    }
  }
  const loose = [...touched].filter((id) => parents.get(id) === null && after.parts[id] && !after.parts[id]!.block);
  if (loose.length > 1) {
    issues.push(`${loose.length} parts are loose at the top level (${loose.map(label).join(', ')}); put a multi-part piece in a named assembly`);
  }
  return issues;
}
