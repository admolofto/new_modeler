import { deepEqual } from '../model/doc';

/** Dotted-path access into plugin params (`toeKick.depth`, `points.2.at.0`). */

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Sets a value in place; intermediate containers must exist. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (next === null || typeof next !== 'object') throw new Error(`no ${path} in params`);
    cur = next as Record<string, unknown>;
  }
  cur[keys.at(-1)!] = value;
}

/** Top-level keys of `after` that differ from `before` — the shallow patch ops merge. */
export function changedTop(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => !deepEqual(v, before[k])));
}
