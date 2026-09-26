import { generators, PluginError, pluginVersions } from '../plugins';
import { ModelError } from './doc';
import { regenerate } from './generate';
import { syncJoints } from './joinery';
import { migrateDoc, migratePluginParams } from './migrations';
import { Doc as DocSchema, type Doc } from './schema';
import { validateDoc } from './validate';

/** Doc → JSON text, stamped with current plugin versions. Pure; storage adapters live in ui/. */
export function serialize(doc: Doc): string {
  return JSON.stringify({ ...doc, pluginVersions: pluginVersions() }, null, 2);
}

/** JSON text → validated, fully migrated doc. Throws ModelError with a readable reason. */
export function deserialize(text: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ModelError('file is not valid JSON');
  }
  const migrated = migratePluginParams(migrateDoc(raw));
  const parsed = DocSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new ModelError(`file doesn't match the model schema — ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const doc = { ...parsed.data, pluginVersions: pluginVersions() };
  try {
    // Before v4, generated joints were metadata only; regenerate so their params match what the
    // generator cuts now. Joint cuts are derived data: re-derive them.
    if ((raw as { version: number }).version < 4) {
      for (const asm of Object.values(doc.assemblies)) {
        if (!asm.generator || !generators.has(asm.generator.type)) continue;
        asm.generator.params = generators.parse(asm.generator.type, asm.generator.params);
        regenerate(doc, asm.id);
      }
    }
    syncJoints(doc);
  } catch (err) {
    if (err instanceof PluginError) throw new ModelError(err.message);
    throw err;
  }
  validateDoc(doc);
  return doc;
}
