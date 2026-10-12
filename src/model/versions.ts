import { z } from 'zod';
import { ModelError } from './doc';
import { serialize, upgradeDoc } from './persistence';
import type { Doc } from './schema';

/**
 * Design versions: alternatives of one model (four layouts of a kitchen) the user flips between from
 * tabs over the view. Each version is a whole doc. The set lives beside the doc, not in it: the open
 * version's doc is the store's, and a saved file is that doc with the others under `versions`, so an
 * app from before versions still opens the file (as the open version alone). Pure; the tabs and the
 * archive are ui/versions.ts.
 */

export interface Version {
  /** `v${n}`: never reused, so an archived v2 stays v2. */
  id: string;
  n: number;
  /** What the user (or the AI) called it; empty = just its number. */
  name: string;
  by: 'user' | 'ai';
  /** What makes it different, in a line (the AI writes one). */
  summary?: string;
  /** Put away: out of the tabs, still in the archive. */
  archived?: boolean;
  /** Made by the AI and not opened yet. */
  unseen?: boolean;
  /** Epoch ms. */
  created: number;
  /** For the open version this is as of when it was last left; the store holds the live one. */
  doc: Doc;
}

export interface VersionSet {
  /** The open version's id. */
  active: string;
  versions: Version[];
}

export const versionLabel = (v: Pick<Version, 'n'>) => `v${v.n}`;
export const versionTitle = (v: Pick<Version, 'n' | 'name'>) => (v.name ? `${versionLabel(v)} · ${v.name}` : versionLabel(v));

export function newVersionSet(doc: Doc, now = Date.now()): VersionSet {
  return { active: 'v1', versions: [{ id: 'v1', n: 1, name: '', by: 'user', created: now, doc }] };
}

export const openVersions = (set: VersionSet) => set.versions.filter((v) => !v.archived);

/** A version by id ("v2"), label ("V2") or name (any case). */
export function findVersion(set: VersionSet, ref: string): Version | undefined {
  const r = ref.trim().toLowerCase();
  return set.versions.find((v) => v.id === r) ?? set.versions.find((v) => v.name.toLowerCase() === r);
}

export function addVersion(set: VersionSet, init: { doc: Doc; by: Version['by']; name?: string; summary?: string; now?: number }): { set: VersionSet; version: Version } {
  const n = Math.max(0, ...set.versions.map((v) => v.n)) + 1;
  const version: Version = {
    id: `v${n}`,
    n,
    name: init.name?.trim() ?? '',
    by: init.by,
    ...(init.summary?.trim() && { summary: init.summary.trim() }),
    ...(init.by === 'ai' && { unseen: true }),
    created: init.now ?? Date.now(),
    doc: init.doc,
  };
  return { set: { ...set, versions: [...set.versions, version] }, version };
}

export type VersionPatch = Partial<Pick<Version, 'name' | 'summary' | 'archived' | 'unseen' | 'doc'>>;

export function updateVersion(set: VersionSet, id: string, patch: VersionPatch): VersionSet {
  return {
    ...set,
    versions: set.versions.map((v) => {
      if (v.id !== id) return v;
      const next = { ...v, ...patch };
      for (const k of ['summary', 'archived', 'unseen'] as const) if (!next[k]) delete next[k];
      return next;
    }),
  };
}

/** The open version to show when `id` is put away: the next tab, else the one before; null if it's the last one open. */
export function neighborOf(set: VersionSet, id: string): string | null {
  const open = openVersions(set);
  const i = open.findIndex((v) => v.id === id);
  return (open[i + 1] ?? open[i - 1])?.id ?? null;
}

/** Deletes a version for good. The open one can't be deleted. */
export function removeVersion(set: VersionSet, id: string): VersionSet {
  if (id === set.active) throw new ModelError('the open version can’t be deleted');
  return { ...set, versions: set.versions.filter((v) => v.id !== id) };
}

// ── Saving ──────────────────────────────────────────────────────────────

const SavedVersion = z.object({
  id: z.string().regex(/^v\d+$/),
  n: z.int().positive(),
  name: z.string(),
  by: z.enum(['user', 'ai']),
  summary: z.string().optional(),
  archived: z.boolean().optional(),
  unseen: z.boolean().optional(),
  created: z.number(),
  doc: z.unknown().optional(),
});
const SavedSet = z.object({ active: z.string(), list: z.array(SavedVersion).min(1) });
export type VersionMeta = Omit<Version, 'doc'>;

export function versionMeta(v: Version): VersionMeta {
  const { doc: _doc, ...meta } = v;
  return meta;
}

/** The set as JSON: every version's details, and the docs of all but `omit` (whose doc is saved elsewhere). */
export function versionsToJson(set: VersionSet, omit?: string): { active: string; list: (VersionMeta & { doc?: unknown })[] } {
  return {
    active: set.active,
    list: set.versions.map((v) => ({ ...versionMeta(v), ...(v.id !== omit && { doc: JSON.parse(serialize(v.doc)) as unknown }) })),
  };
}

/**
 * JSON from `versionsToJson` → a set, every doc upgraded to the current schema. `docOf` supplies the
 * docs not in the JSON (the open one; local storage keeps each elsewhere); a version whose doc it
 * can't supply is dropped. Throws ModelError naming the version that doesn't load.
 */
export function versionsFromJson(raw: unknown, docOf: (id: string) => Doc | null): VersionSet {
  const parsed = SavedSet.safeParse(raw);
  if (!parsed.success) throw new ModelError('the file’s versions are damaged');
  const versions: Version[] = [];
  for (const { doc: saved, ...meta } of parsed.data.list) {
    let doc: Doc | null;
    try {
      doc = saved === undefined ? docOf(meta.id) : upgradeDoc(saved);
    } catch (err) {
      throw new ModelError(`version ${versionTitle(meta)}: ${(err as Error).message}`);
    }
    if (doc) versions.push({ ...meta, doc });
  }
  const active = versions.find((v) => v.id === parsed.data.active) ?? versions[0];
  if (!active) throw new ModelError('the file has no versions');
  // Opening a file never lands on an archived version.
  return { active: active.id, versions: versions.map((v) => clean(v === active ? { ...v, archived: false } : v)) };
}

const clean = (v: Version): Version => {
  const out = { ...v };
  for (const k of ['summary', 'archived', 'unseen'] as const) if (!out[k]) delete out[k];
  return out;
};

/** The model file: the open version's doc, with the other versions under `versions` when there are any. */
export function serializeVersions(set: VersionSet, openDoc: Doc): string {
  if (set.versions.length === 1) return serialize(openDoc);
  return JSON.stringify({ ...(JSON.parse(serialize(openDoc)) as object), versions: versionsToJson(set, set.active) }, null, 2);
}

/** A model file (with or without versions) → its set. Throws ModelError with a readable reason. */
export function deserializeVersions(text: string, now = Date.now()): VersionSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ModelError('file is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ModelError('not a model file');
  const { versions, ...docRaw } = raw as { versions?: unknown };
  const doc = upgradeDoc(docRaw);
  if (versions === undefined) return newVersionSet(doc, now);
  const active = (versions as { active?: unknown }).active;
  return versionsFromJson(versions, (id) => (id === active ? doc : null));
}
