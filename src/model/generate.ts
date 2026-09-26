import { generators, type GenOutput, type GenPart } from '../plugins';
import { deepEqual, ModelError, parentIndex } from './doc';
import type { Assembly, Doc, Override, Part } from './schema';

/**
 * Generated assemblies keep their generator params; user edits to generated parts are
 * stored as per-role overrides and re-applied on every regenerate (ROADMAP rule 9).
 */

export const genPartId = (asmId: string, role: string) => `${asmId}.${role}`;
export const genJointId = (asmId: string, role: string) => `${asmId}.j.${role}`;

function runGenerator(d: Doc, asm: Assembly): GenOutput {
  const g = asm.generator!;
  return generators.get(g.type).generate(g.params, { materials: d.materials });
}

function genToPart(asmId: string, gp: GenPart, ov: Override | undefined): Part {
  return {
    id: genPartId(asmId, gp.role),
    role: gp.role,
    name: ov?.name ?? gp.name,
    material: ov?.material ?? gp.material,
    grain: ov?.grain ?? gp.grain,
    transform: {
      position: [0, 1, 2].map((i) => ov?.position?.[i] ?? gp.position[i]) as Part['transform']['position'],
      rotation: ov?.rotation ?? gp.rotation ?? [0, 0, 0],
    },
    shape: { type: gp.shape.type, params: { ...gp.shape.params, ...ov?.shape } },
    features: structuredClone(ov?.features ?? gp.features ?? []),
  };
}

/** The generated assembly that owns this part, if it's a generated part. */
export function generatedOwner(d: Doc, partId: string): Assembly | null {
  const part = d.parts[partId];
  if (!part?.role) return null;
  const parent = parentIndex(d).get(partId);
  const asm = parent ? d.assemblies[parent] : undefined;
  return asm?.generator && partId === genPartId(asm.id, part.role) ? asm : null;
}

/** Rebuilds an assembly's generated parts and joints from its params, re-applying overrides. */
export function regenerate(d: Doc, asmId: string): void {
  const asm = d.assemblies[asmId];
  if (!asm?.generator) throw new ModelError(`assembly ${asmId} has no generator`);
  const out = runGenerator(d, asm);
  const { overrides } = asm.generator;

  const userChildren = asm.children.filter((id) => {
    const generated = d.parts[id]?.role !== undefined;
    if (generated) delete d.parts[id];
    return !generated;
  });
  for (const j of Object.values(d.joints)) {
    if (j.role !== undefined && j.id === genJointId(asmId, j.role)) delete d.joints[j.id];
  }

  const genIds: string[] = [];
  for (const gp of out.parts) {
    const ov = overrides[gp.role];
    if (ov?.deleted) continue;
    const part = genToPart(asmId, gp, ov);
    if (part.id in d.assemblies || part.id in d.joints || part.id in d.materials) {
      throw new ModelError(`generated part id ${part.id} collides with an existing entity`);
    }
    d.parts[part.id] = part;
    genIds.push(part.id);
  }
  asm.children = [...genIds, ...userChildren];

  for (const gj of out.joints) {
    const [a, b] = gj.parts.map((r) => genPartId(asmId, r)) as [string, string];
    if (!d.parts[a] || !d.parts[b]) continue;
    const id = genJointId(asmId, gj.role);
    d.joints[id] = { id, role: gj.role, type: gj.type, parts: [a, b], params: { ...gj.params } };
  }
  // User joints to generated parts that no longer exist (e.g. fewer shelves) go away.
  for (const j of Object.values(d.joints)) {
    if (!d.parts[j.parts[0]] || !d.parts[j.parts[1]]) delete d.joints[j.id];
  }
}

function diffPart(part: Part, base: Part): Override {
  const ov: Override = {};
  if (part.name !== base.name) ov.name = part.name;
  if (part.material !== base.material) ov.material = part.material;
  if (part.grain !== base.grain) ov.grain = part.grain;
  const pos = part.transform.position.map((c, i) => (c === base.transform.position[i] ? null : c));
  if (pos.some((c) => c !== null)) ov.position = pos as Override['position'];
  if (!deepEqual(part.transform.rotation, base.transform.rotation)) ov.rotation = [...part.transform.rotation];
  const shape: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(part.shape.params)) {
    if (!deepEqual(v, base.shape.params[k])) shape[k] = structuredClone(v);
  }
  if (Object.keys(shape).length) ov.shape = shape;
  if (!deepEqual(part.features, base.features)) ov.features = structuredClone(part.features);
  return ov;
}

/** Records the difference between a generated part and what its generator would produce. */
export function captureOverride(d: Doc, partId: string): void {
  const asm = generatedOwner(d, partId);
  if (!asm) return;
  const part = d.parts[partId]!;
  const gp = runGenerator(d, asm).parts.find((p) => p.role === part.role);
  if (!gp) return;
  const ov = diffPart(part, genToPart(asm.id, gp, undefined));
  if (Object.keys(ov).length) asm.generator!.overrides[part.role!] = ov;
  else delete asm.generator!.overrides[part.role!];
}

/** Deleting a generated part is an override too, so regenerating doesn't bring it back. */
export function deleteGeneratedPart(d: Doc, partId: string): void {
  const asm = generatedOwner(d, partId)!;
  asm.generator!.overrides[d.parts[partId]!.role!] = { deleted: true };
  regenerate(d, asm.id);
}
