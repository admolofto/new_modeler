import { features, generators, motions, shapes } from '../plugins';
import { ModelError } from './doc';
import { SCHEMA_VERSION } from './schema';

type Raw = Record<string, unknown>;

/** Upgrades a raw doc from version N to N+1. Never edit one after release; add a new one. */
export type Migration = (doc: Raw) => Raw;

/** Keyed by the version they upgrade *from*. */
export const MIGRATIONS: Record<number, Migration> = {
  // v2: markup notes.
  1: (doc) => ({ ...doc, annotations: {} }),
  // v3: variables (and optional per-node `bind`).
  2: (doc) => ({ ...doc, variables: {} }),
  // v4: joints cut dados / rabbets (`part.joinery`, re-derived on load); materials gain optional
  // sheet size, nominal thickness and price. Nothing stored changes shape.
  3: (doc) => doc,
  // v5: blockout placeholders (`part.block`, which have no `material`) and rotations at any angle.
  // Nothing stored changes shape; the bump keeps older apps from misreading blocks.
  4: (doc) => doc,
  // v6: motions (how doors, drawers and lids open). Loading regenerates older generated
  // assemblies, so a carcass's drawers gain theirs (persistence.ts `upgradeDoc`).
  5: (doc) => ({ ...doc, motions: {} }),
  // v7: generated folders (`assembly.role`: a carcass's drawers each get a "Drawer N" folder).
  // Loading regenerates older generated assemblies to group their parts (persistence.ts `upgradeDoc`).
  6: (doc) => doc,
};

/** Runs doc-level migrations up to `target`. Input is untrusted JSON. */
export function migrateDoc(raw: unknown, migrations = MIGRATIONS, target = SCHEMA_VERSION): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ModelError('not a model file');
  let doc = raw as Raw;
  const version = doc.version;
  if (!Number.isInteger(version) || (version as number) < 1) throw new ModelError('model file has no valid version');
  if ((version as number) > target) {
    throw new ModelError(`file is schema v${version}, this app only reads up to v${target} — update the app`);
  }
  for (let v = version as number; v < target; v++) {
    const step = migrations[v];
    if (!step) throw new ModelError(`no migration from schema v${v} to v${v + 1}`);
    doc = step(structuredClone(doc));
    doc.version = v + 1;
  }
  return doc;
}

/**
 * Upgrades shape / feature / generator params saved by older plugin versions,
 * using the `pluginVersions` map recorded at save time (missing = v1).
 */
export function migratePluginParams(doc: Raw): Raw {
  const saved = (doc.pluginVersions ?? {}) as Record<string, number>;
  const upgrade = (
    kind: string,
    reg: typeof shapes | typeof features | typeof generators | typeof motions,
    type: string,
    params: Raw,
  ): Raw => {
    if (!reg.has(type)) return params; // validation reports unknown types
    const def = reg.get(type);
    const from = saved[`${kind}:${type}`] ?? 1;
    if (from > def.version) throw new ModelError(`file uses ${kind} "${type}" v${from}; this app has v${def.version} — update the app`);
    if (from === def.version) return params;
    if (!def.migrate) throw new ModelError(`${kind} "${type}" can't upgrade params from v${from}`);
    return def.migrate(params, from);
  };

  const parts = (doc.parts ?? {}) as Record<string, { shape?: { type: string; params: Raw }; features?: { type: string; params: Raw }[] }>;
  for (const part of Object.values(parts)) {
    if (part.shape) part.shape.params = upgrade('shape', shapes, part.shape.type, part.shape.params);
    for (const f of part.features ?? []) f.params = upgrade('feature', features, f.type, f.params);
  }
  const asms = (doc.assemblies ?? {}) as Record<string, { generator?: { type: string; params: Raw } }>;
  for (const asm of Object.values(asms)) {
    if (asm.generator) asm.generator.params = upgrade('generator', generators, asm.generator.type, asm.generator.params);
  }
  for (const m of Object.values((doc.motions ?? {}) as Record<string, { type: string; params: Raw }>)) {
    m.params = upgrade('motion', motions, m.type, m.params);
  }
  return doc;
}
