import type { Doc, Part } from './schema';

export class ModelError extends Error {}

export type EntityKind = 'part' | 'assembly' | 'joint' | 'material' | 'annotation' | 'variable';

export function entityKind(d: Doc, id: string): EntityKind | null {
  if (id in d.parts) return 'part';
  if (id in d.assemblies) return 'assembly';
  if (id in d.joints) return 'joint';
  if (id in d.materials) return 'material';
  if (id in d.annotations) return 'annotation';
  if (id in d.variables) return 'variable';
  return null;
}

/** Smallest unused `${prefix}${n}` across every collection (ids are globally unique). */
export function nextId(d: Doc, prefix: string): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (entityKind(d, id) === null) return id;
  }
}

export function nextFeatureId(part: Part): string {
  const used = new Set(part.features.map((f) => f.id));
  for (let n = 1; ; n++) if (!used.has(`f${n}`)) return `f${n}`;
}

/** Node id → parent assembly id (null = root). */
export function parentIndex(d: Doc): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const id of d.roots) parents.set(id, null);
  for (const asm of Object.values(d.assemblies)) for (const c of asm.children) parents.set(c, asm.id);
  return parents;
}

/** All part and assembly ids under an assembly (not including itself). */
export function descendants(d: Doc, asmId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const c of d.assemblies[id]?.children ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(asmId);
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
