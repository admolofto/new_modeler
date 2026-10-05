import { features, generators, motions, PluginError, shapes } from '../plugins';
import { buildPart } from '../plugins/pipeline';
import { descendants, ModelError } from './doc';
import { generatedOwner, genMotionId } from './generate';
import { parseFormula } from './expr';
import { Doc as DocSchema, type Doc } from './schema';
import { allBindings, evaluateBinding, fieldLabel, getField } from './variables';

/** Full integrity check. Returns every problem found (empty = valid). */
export function docErrors(d: Doc): string[] {
  const errors: string[] = [];
  const parsed = DocSchema.safeParse(d);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }

  // Ids: keys match, globally unique.
  const seen = new Map<string, string>();
  for (const [kind, coll] of Object.entries({
    material: d.materials,
    part: d.parts,
    assembly: d.assemblies,
    joint: d.joints,
    annotation: d.annotations,
    variable: d.variables,
    motion: d.motions,
  })) {
    for (const [key, e] of Object.entries(coll)) {
      if (key !== e.id) errors.push(`${kind} stored under "${key}" has id "${e.id}"`);
      const prev = seen.get(e.id);
      if (prev) errors.push(`id "${e.id}" is used by both a ${prev} and a ${kind}`);
      seen.set(e.id, kind);
    }
  }

  // Tree: every node referenced exactly once, no cycles.
  const refCount = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const ref = (id: string, parent: string | null) => {
    refCount.set(id, (refCount.get(id) ?? 0) + 1);
    parentOf.set(id, parent);
    if (!(id in d.parts) && !(id in d.assemblies)) errors.push(`${parent ?? 'roots'} references missing node "${id}"`);
  };
  d.roots.forEach((id) => ref(id, null));
  for (const asm of Object.values(d.assemblies)) asm.children.forEach((id) => ref(id, asm.id));
  for (const id of [...Object.keys(d.parts), ...Object.keys(d.assemblies)]) {
    const n = refCount.get(id) ?? 0;
    if (n !== 1) errors.push(`node "${id}" is referenced ${n} times (must be exactly once)`);
  }
  for (const id of Object.keys(d.assemblies)) {
    const visited = new Set<string>();
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) {
      if (p === id || visited.has(p)) {
        errors.push(`assembly "${id}" is inside itself`);
        break;
      }
      visited.add(p);
    }
  }
  if (errors.length) return errors;

  for (const part of Object.values(d.parts)) {
    const where = `part "${part.name}" (${part.id})`;
    if (part.block) {
      // A placeholder: a plain box standing in for something not built yet.
      if (part.material !== undefined) errors.push(`${where}: blocks have no material`);
      if (part.shape.type !== 'box') errors.push(`${where}: blocks are boxes`);
      if (part.grain !== 'none') errors.push(`${where}: blocks have no grain`);
      if (part.features.length) errors.push(`${where}: blocks can't take features — build a real part in its place`);
      if (part.role !== undefined) errors.push(`${where}: generated parts can't be blocks`);
    } else if (part.material === undefined) {
      errors.push(`${where}: has no material`);
    } else if (!d.materials[part.material]) {
      errors.push(`${where}: material "${part.material}" doesn't exist`);
    }
    if (part.role !== undefined && !generatedOwner(d, part.id, parentOf)) {
      errors.push(`${where}: has role "${part.role}" but isn't a generated part of its assembly`);
    }
    if (!shapes.has(part.shape.type)) {
      errors.push(`${where}: unknown shape "${part.shape.type}"`);
      continue;
    }
    const shapeOk = shapes.get(part.shape.type).schema.safeParse(part.shape.params);
    if (!shapeOk.success) {
      errors.push(`${where}: invalid ${part.shape.type} params — ${shapeOk.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    const featureIds = new Set<string>();
    const before = errors.length;
    for (const cut of part.joinery ?? []) {
      if (!d.joints[cut.joint]) errors.push(`${where}: joint cut ${cut.id} belongs to missing joint "${cut.joint}"`);
    }
    for (const f of [...part.features, ...(part.joinery ?? [])]) {
      if (featureIds.has(f.id)) errors.push(`${where}: duplicate feature id "${f.id}"`);
      featureIds.add(f.id);
      if (!features.has(f.type)) {
        errors.push(`${where}: unknown feature "${f.type}"`);
        continue;
      }
      const def = features.get(f.type);
      const unsupported = def.appliesTo(part.shape);
      if (unsupported) {
        errors.push(`${where}: ${unsupported}`);
        continue;
      }
      const ok = def.schema.safeParse(f.params);
      if (!ok.success) {
        errors.push(`${where}: invalid ${f.type} ${f.id} — ${ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      const problem = def.validate?.(f.params, { part, featureId: f.id });
      if (problem) errors.push(problem);
    }
    // Geometric checks (features fit, don't collide) happen while building: a valid doc always builds.
    if (errors.length === before) {
      try {
        buildPart(part);
      } catch (err) {
        if (!(err instanceof PluginError)) throw err;
        errors.push(`${where}: ${err.message}`);
      }
    }
  }

  for (const asm of Object.values(d.assemblies)) {
    if (asm.role !== undefined && (asm.generator || !generatedOwner(d, asm.id, parentOf))) {
      errors.push(`assembly "${asm.name}" (${asm.id}): has role "${asm.role}" but isn't a generated folder of its parent`);
    }
    if (!asm.generator) continue;
    if (!generators.has(asm.generator.type)) {
      errors.push(`assembly "${asm.name}": unknown generator "${asm.generator.type}"`);
      continue;
    }
    const ok = generators.get(asm.generator.type).schema.safeParse(asm.generator.params);
    if (!ok.success) errors.push(`assembly "${asm.name}": invalid ${asm.generator.type} params`);
  }

  for (const j of Object.values(d.joints)) {
    for (const p of j.parts) {
      if (!d.parts[p]) errors.push(`joint ${j.id}: part "${p}" doesn't exist`);
      else if (d.parts[p].block) errors.push(`joint ${j.id}: "${d.parts[p].name}" is a block; joints join real parts`);
    }
    if (j.parts[0] === j.parts[1]) errors.push(`joint ${j.id}: joins a part to itself`);
  }

  // Motions: a known type with valid params, moving existing siblings that hold a part; one per node.
  const movedBy = new Map<string, string>();
  const nodeName = (id: string) => `"${(d.parts[id] ?? d.assemblies[id])?.name ?? id}"`;
  for (const m of Object.values(d.motions)) {
    const where = `animation ${m.id}`;
    if (!motions.has(m.type)) errors.push(`${where}: unknown motion "${m.type}"`);
    else {
      const ok = motions.get(m.type).schema.safeParse(m.params);
      if (!ok.success) errors.push(`${where}: invalid ${m.type} params — ${ok.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ')}`);
    }
    const missing = m.nodes.find((id) => !d.parts[id] && !d.assemblies[id]);
    if (missing) {
      errors.push(`${where}: "${missing}" isn't a part or folder`);
      continue;
    }
    if (new Set(m.nodes).size !== m.nodes.length) errors.push(`${where} lists something twice`);
    if (new Set(m.nodes.map((id) => parentOf.get(id) ?? null)).size > 1) {
      errors.push(`${where} moves ${m.nodes.map(nodeName).join(', ')} together, so they must be in the same folder — move them together, or change the animation first`);
    }
    if (!m.nodes.some((id) => d.parts[id] || descendants(d, id).some((c) => d.parts[c]))) errors.push(`${where} has no part in it to move`);
    for (const id of m.nodes) {
      const other = movedBy.get(id);
      if (other) errors.push(`${nodeName(id)} has two animations (${other} and ${m.id}); give it one, or animate the folder it's in`);
      movedBy.set(id, m.id);
    }
    if (m.role !== undefined) {
      const asm = generatedOwner(d, m.nodes[0]!, parentOf);
      if (!asm || m.id !== genMotionId(asm.id, m.role)) errors.push(`${where}: has role "${m.role}" but isn't a generated animation of its parts' assembly`);
    }
  }

  // Bindings: resolvable, over existing variables, and current (the stored value is the formula's).
  for (const b of allBindings(d)) {
    const where = fieldLabel(d, b.node, b.path);
    if (generatedOwner(d, b.node, parentOf)) {
      errors.push(`${where}: generated parts and folders can't be bound`);
      continue;
    }
    try {
      const missing = parseFormula(b.src).refs.filter((r) => !d.variables[r]);
      if (missing.length) {
        errors.push(`${where} = ${b.src}: no variable ${missing.map((m) => `"${m}"`).join(', ')}`);
        continue;
      }
      const want = evaluateBinding(d, b.src);
      const have = getField(d, b.node, b.path);
      if (want !== have) errors.push(`${where} is ${have} but its formula ${b.src} gives ${want}`);
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      errors.push(`${where}: ${err.message}`);
    }
  }
  return errors;
}

export function validateDoc(d: Doc): void {
  const errors = docErrors(d);
  if (errors.length) throw new ModelError(errors.slice(0, 5).join('\n') + (errors.length > 5 ? `\n…and ${errors.length - 5} more` : ''));
}
