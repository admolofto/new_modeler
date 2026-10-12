import { generators, motions, type GenGroup, type GenOutput, type GenPart } from '../plugins';
import { deepEqual, entityKind, ModelError, parentIndex } from './doc';
import { pruneMotions } from './motion';
import type { Assembly, Doc, Override, Part } from './schema';

/**
 * Generated assemblies keep their generator params; user edits to generated parts are
 * stored as per-role overrides and re-applied on every regenerate (ROADMAP rule 9).
 */

export const genPartId = (asmId: string, role: string) => `${asmId}.${role}`;
export const genJointId = (asmId: string, role: string) => `${asmId}.j.${role}`;
export const genMotionId = (asmId: string, role: string) => `${asmId}.motion.${role}`;

function runGenerator(d: Doc, asm: Assembly): GenOutput {
  const g = asm.generator!;
  return generators.get(g.type).generate(g.params, { materials: d.materials });
}

function genToPart(asmId: string, gp: GenPart, ov: Override | undefined): Part {
  const material = ov?.material ?? gp.material;
  const finish = ov?.finish ?? gp.finish;
  return {
    id: genPartId(asmId, gp.role),
    role: gp.role,
    name: ov?.name ?? gp.name,
    ...(ov?.hidden && { hidden: true }),
    ...((ov?.unclickable ?? gp.unclickable) && { unclickable: true }),
    // Decor parts have no material.
    ...(material !== undefined && { material }),
    ...(finish && { finish: structuredClone(finish) }),
    grain: ov?.grain ?? gp.grain,
    transform: {
      position: [0, 1, 2].map((i) => ov?.position?.[i] ?? gp.position[i]) as Part['transform']['position'],
      rotation: ov?.rotation ?? gp.rotation ?? [0, 0, 0],
    },
    shape: { type: gp.shape.type, params: { ...gp.shape.params, ...ov?.shape } },
    features: structuredClone(ov?.features ?? gp.features ?? []),
  };
}

/**
 * The generated assembly that owns this node, if it's a generated part or folder. Generated parts
 * sit directly in their assembly or in one of its generated folders.
 */
export function generatedOwner(d: Doc, id: string, parents = parentIndex(d)): Assembly | null {
  const node = d.parts[id] ?? d.assemblies[id];
  if (node?.role === undefined) return null;
  let asm = d.assemblies[parents.get(id) ?? ''];
  if (asm?.role !== undefined && d.parts[id]) {
    const folder = asm;
    asm = d.assemblies[parents.get(folder.id) ?? ''];
    if (!asm?.generator || folder.id !== genPartId(asm.id, folder.role!)) return null;
  }
  return asm?.generator && id === genPartId(asm.id, node.role) ? asm : null;
}

/** Rebuilds an assembly's generated parts, joints and motions from its params, re-applying overrides. */
export function regenerate(d: Doc, asmId: string): void {
  const asm = d.assemblies[asmId];
  if (!asm?.generator) throw new ModelError(`assembly ${asmId} has no generator`);
  const out = runGenerator(d, asm);
  const { overrides } = asm.generator;

  // Generated parts and folders go; user nodes in a generated folder wait for its replacement.
  const userChildren: string[] = [];
  const keptIn = new Map<string, string[]>();
  for (const id of asm.children) {
    const folder = d.assemblies[id];
    if (folder?.role !== undefined) {
      const mine = folder.children.filter((c) => {
        const generated = d.parts[c]?.role !== undefined;
        if (generated) delete d.parts[c];
        return !generated;
      });
      if (mine.length) keptIn.set(folder.role, mine);
      delete d.assemblies[id];
    } else if (d.parts[id]?.role !== undefined) delete d.parts[id];
    else userChildren.push(id);
  }
  for (const j of Object.values(d.joints)) {
    if (j.role !== undefined && j.id === genJointId(asmId, j.role)) delete d.joints[j.id];
  }
  for (const m of Object.values(d.motions)) {
    if (m.role !== undefined && m.id === genMotionId(asmId, m.role)) delete d.motions[m.id];
  }

  const collides = (id: string) => entityKind(d, id) !== null;
  const groupDefs = new Map((out.groups ?? []).map((g) => [g.role, g]));
  const genIds: string[] = [];
  // A folder goes where its first part would; empty ones (all their parts deleted) aren't made.
  const folderFor = (role: string): Assembly | null => {
    const id = genPartId(asmId, role);
    if (d.assemblies[id]) return d.assemblies[id];
    const def = groupDefs.get(role);
    if (!def) throw new ModelError(`generator part group "${role}" isn't one of its groups`);
    const ov = overrides[role];
    if (ov?.deleted) return null;
    if (collides(id)) throw new ModelError(`generated folder id ${id} collides with an existing entity`);
    const base = groupTransform(def);
    const folder: Assembly = {
      id,
      role,
      name: ov?.name ?? def.name,
      ...(ov?.hidden && { hidden: true }),
      ...(ov?.unclickable && { unclickable: true }),
      transform: {
        position: [0, 1, 2].map((i) => ov?.position?.[i] ?? base.position[i]) as Assembly['transform']['position'],
        rotation: ov?.rotation ?? base.rotation,
      },
      children: [],
      ...(ov?.finish && { finish: structuredClone(ov.finish) }),
    };
    d.assemblies[id] = folder;
    genIds.push(id);
    return folder;
  };
  for (const gp of out.parts) {
    const ov = overrides[gp.role];
    if (ov?.deleted) continue;
    // A pull goes with its door: none floating where a deleted one was.
    if (gp.mountedOn !== undefined && !d.parts[genPartId(asmId, gp.mountedOn)]) continue;
    const folder = gp.group === undefined ? null : folderFor(gp.group);
    if (gp.group !== undefined && !folder) continue;
    const part = genToPart(asmId, gp, ov);
    if (collides(part.id)) throw new ModelError(`generated part id ${part.id} collides with an existing entity`);
    d.parts[part.id] = part;
    (folder ? folder.children : genIds).push(part.id);
  }
  for (const [role, ids] of keptIn) {
    const folder = d.assemblies[genPartId(asmId, role)];
    if (folder?.role === role) folder.children.push(...ids);
    else userChildren.push(...ids);
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

  for (const gm of out.motions ?? []) {
    const nodes = gm.nodes.map((r) => genPartId(asmId, r));
    // A deleted part or folder (a drawer box taken out behind a false front) leaves the rest fixed.
    if (!nodes.length || nodes.some((id) => !d.parts[id] && !d.assemblies[id])) continue;
    if ((gm.requires ?? []).some((r) => !d.parts[genPartId(asmId, r)])) continue;
    const id = genMotionId(asmId, gm.role);
    if (entityKind(d, id) !== null) throw new ModelError(`generated motion id ${id} collides with an existing entity`);
    d.motions[id] = { id, name: gm.name, type: gm.type, nodes, params: motions.parse(gm.type, gm.params), role: gm.role };
  }
  // User motions lose generated parts that no longer exist.
  pruneMotions(d);
}

/** Where a generated folder sits in its assembly when nothing overrides it. */
function groupTransform(g: GenGroup): Assembly['transform'] {
  return { position: g.position ? [...g.position] : [0, 0, 0], rotation: g.rotation ? [...g.rotation] : [0, 0, 0] };
}

function diffPart(part: Part, base: Part): Override {
  const ov: Override = {};
  if (part.hidden) ov.hidden = true;
  if (!!part.unclickable !== !!base.unclickable) ov.unclickable = !!part.unclickable;
  if (part.name !== base.name) ov.name = part.name;
  if (part.material !== base.material && part.material !== undefined) ov.material = part.material;
  // A finish cleared on a part goes back to the generator's (an override can't say "none").
  if (part.finish && !deepEqual(part.finish, base.finish)) ov.finish = structuredClone(part.finish);
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

function diffFolder(folder: Assembly, def: GenGroup): Override {
  const ov: Override = {};
  const base = groupTransform(def);
  if (folder.hidden) ov.hidden = true;
  if (folder.unclickable) ov.unclickable = true;
  if (folder.name !== def.name) ov.name = folder.name;
  const pos = folder.transform.position.map((c, i) => (c === base.position[i] ? null : c));
  if (pos.some((c) => c !== null)) ov.position = pos as Override['position'];
  if (!deepEqual(folder.transform.rotation, base.rotation)) ov.rotation = [...folder.transform.rotation];
  if (folder.finish) ov.finish = structuredClone(folder.finish);
  return ov;
}

/** Records the difference between a generated part or folder and what its generator would produce. */
export function captureOverride(d: Doc, nodeId: string): void {
  const asm = generatedOwner(d, nodeId);
  if (!asm) return;
  const out = runGenerator(d, asm);
  const part = d.parts[nodeId];
  const folder = d.assemblies[nodeId];
  let ov: Override;
  if (part) {
    const gp = out.parts.find((p) => p.role === part.role);
    if (!gp) return;
    ov = diffPart(part, genToPart(asm.id, gp, undefined));
  } else {
    const def = out.groups?.find((g) => g.role === folder!.role);
    if (!def) return;
    ov = diffFolder(folder!, def);
  }
  const role = (part ?? folder)!.role!;
  if (Object.keys(ov).length) asm.generator!.overrides[role] = ov;
  else delete asm.generator!.overrides[role];
}

/** What the generator makes for one of its parts, before overrides: null when it isn't a generated part. */
export function generatedBase(d: Doc, partId: string): Part | null {
  const asm = generatedOwner(d, partId);
  const part = d.parts[partId];
  if (!asm || !part) return null;
  const gp = runGenerator(d, asm).parts.find((p) => p.role === part.role);
  return gp ? genToPart(asm.id, gp, undefined) : null;
}

/** Deleting a generated part or folder is an override too, so regenerating doesn't bring it back. */
export function deleteGeneratedPart(d: Doc, nodeId: string): void {
  const asm = generatedOwner(d, nodeId)!;
  asm.generator!.overrides[(d.parts[nodeId] ?? d.assemblies[nodeId])!.role!] = { deleted: true };
  regenerate(d, asm.id);
}
