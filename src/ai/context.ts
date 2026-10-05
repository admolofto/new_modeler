import { directionText, frontOf } from '../edit/blocks';
import { isGround, targetPoint } from '../edit/targets';
import type { Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import { worldBoxes } from '../model/world';
import { hiddenNodes } from '../model/visibility';

/**
 * The model as the AI sees it each turn: compact JSON of the tree, parts, materials and variables
 * (with each node's `bind` formulas), plus each node's world bounds (so it can place things
 * relative to what exists without composing transforms itself), and the user's open markup
 * notes with each target's world point. Blocks (placeholders) show as `block: true` with the way
 * their front faces. Generated joints are left out; they follow the generator. The user's saved
 * recipes follow as a short catalog (get_recipe has the rest), so the AI knows they exist.
 */
export function modelSnapshot(doc: Doc, recipes: readonly Recipe[] = []): string {
  const boxes = worldBoxes(doc);
  const hidden = hiddenNodes(doc);
  const world = (id: string) => {
    const b = boxes.get(id);
    return b && [b.min, b.max];
  };
  const isZero = (v: number[]) => v.every((c) => c === 0);

  const node = (id: string): unknown => {
    const part = doc.parts[id];
    if (part?.block) {
      return {
        id,
        name: part.name,
        block: true,
        ...(part.hidden && { hidden: true }),
        ...(hidden.has(id) && !part.hidden && { hiddenByParent: true }),
        ...(part.unclickable && { unclickable: true }),
        position: part.transform.position,
        ...(!isZero(part.transform.rotation) && { rotation: part.transform.rotation }),
        shape: part.shape,
        front: directionText(frontOf(doc, id)),
        world: world(id),
      };
    }
    if (part) {
      return {
        id,
        name: part.name,
        ...(part.role && { role: part.role }),
        ...(part.hidden && { hidden: true }),
        ...(hidden.has(id) && !part.hidden && { hiddenByParent: true }),
        ...(part.unclickable && { unclickable: true }),
        material: part.material,
        grain: part.grain,
        position: part.transform.position,
        ...(!isZero(part.transform.rotation) && { rotation: part.transform.rotation }),
        shape: part.shape,
        ...(part.features.length && { features: part.features }),
        // Dados / rabbets its joints cut (derived; change the joint to change them).
        ...(part.joinery && { jointCuts: part.joinery.map(({ joint, params }) => ({ joint, ...params })) }),
        ...(part.bind && { bind: part.bind }),
        world: world(id),
      };
    }
    const asm = doc.assemblies[id]!;
    return {
      id,
      name: asm.name,
      assembly: true,
      ...(asm.hidden && { hidden: true }),
      ...(hidden.has(id) && !asm.hidden && { hiddenByParent: true }),
      ...(asm.unclickable && { unclickable: true }),
      position: asm.transform.position,
      ...(!isZero(asm.transform.rotation) && { rotation: asm.transform.rotation }),
      ...(asm.generator && {
        generator: {
          type: asm.generator.type,
          params: asm.generator.params,
          ...(Object.keys(asm.generator.overrides).length && { overrides: asm.generator.overrides }),
        },
      }),
      ...(asm.bind && { bind: asm.bind }),
      world: world(id),
      children: asm.children.map(node),
    };
  };

  const userJoints = Object.values(doc.joints).filter((j) => j.role === undefined);
  const notes = Object.values(doc.annotations)
    .filter((a) => !a.resolved)
    .map((a) => ({
      id: a.id,
      note: a.note,
      targets: a.targets.map((t) => {
        const n = doc.parts[t.node] ?? doc.assemblies[t.node];
        const p = targetPoint(doc, t);
        return { node: t.node, ...(n ? { name: n.name } : isGround(t) ? { name: 'Ground' } : { missing: true }), ...(t.handle && { handle: t.handle }), ...(p && { point: p.map(Math.round) }) };
      }),
    }));
  const variables = Object.values(doc.variables);
  return JSON.stringify({
    materials: Object.values(doc.materials).map(({ id, name, thickness, stock }) => ({ id, name, thickness, stock })),
    ...(variables.length && { variables: variables.map(({ id, name, group, unit, value }) => ({ id, group, name, unit, value })) }),
    tree: doc.roots.map(node),
    ...(userJoints.length && { joints: userJoints }),
    ...(notes.length && { notes }),
    ...(recipes.length && { recipes: recipeCatalog(recipes) }),
  });
}

const ABOUT = 200;

/** One line per saved recipe: enough to recognize a match, not the whole design. */
export function recipeCatalog(recipes: readonly Recipe[]) {
  return recipes.map((r) => {
    const about = r.description.trim().replace(/\s+/g, ' ');
    return {
      id: r.id, name: r.name, scope: r.scope === 'model' ? 'whole model' : 'component', parts: Object.keys(r.doc.parts).length,
      ...(about && { about: about.length > ABOUT ? `${about.slice(0, ABOUT - 1)}…` : about }),
    };
  });
}

/** The library's recipes, or none when there is no library or it can't be read (the recipe tools report why). */
export function savedRecipes(library: (() => readonly Recipe[]) | undefined): readonly Recipe[] {
  try {
    return library?.() ?? [];
  } catch {
    return [];
  }
}
