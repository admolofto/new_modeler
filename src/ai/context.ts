import { directionText, frontOf } from '../edit/blocks';
import { isGround, targetPoint } from '../edit/targets';
import { clashText, clearance } from '../model/clearance';
import { decorInfo, isDecor } from '../model/decor';
import { descendants } from '../model/doc';
import { roomIssues, roomParams } from '../model/room';
import { generators } from '../plugins/registry';
import type { Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import { worldBoxes } from '../model/world';
import { hiddenNodes } from '../model/visibility';

/**
 * The model as the AI sees it each turn: compact JSON of the tree, parts, materials and variables
 * (with each node's `bind` formulas), plus each node's world bounds (so it can place things
 * relative to what exists without composing transforms itself), and the user's open markup
 * notes with each target's world point. Blocks (placeholders) show as `block: true` with the way
 * their front faces, and decor (props, hardware, room pieces) as `decor: true` with its shape.
 * Finishes show where they're set. Generated joints, animations and hardware (a carcass's pulls) are left out; they
 * follow the generator. A generator that makes a whole thing (`collapse`: the room) is one line with its params,
 * how many parts it made and (the room) its inside, plus what the user put in it; `roomIssues` lists openings
 * something stands in front of. The
 * user's own animations follow, then anything that hits something as it opens ("clashes"). The
 * user's saved recipes follow as a short catalog (get_recipe has the rest), so the AI knows they exist.
 */
export function modelSnapshot(doc: Doc, recipes: readonly Recipe[] = []): string {
  const boxes = worldBoxes(doc);
  const hidden = hiddenNodes(doc);
  const world = (id: string) => {
    const b = boxes.get(id);
    return b && [b.min, b.max];
  };
  const isZero = (v: number[]) => v.every((c) => c === 0);
  /** A generated pull: its generator's params (`pulls`) say all there is to say. */
  const generatedHardware = (id: string) => {
    const part = doc.parts[id];
    return !!part && part.role !== undefined && isDecor(part) && decorInfo(part.shape.type)!.category === 'hardware';
  };

  const node = (id: string): unknown => {
    const part = doc.parts[id];
    if (part && isDecor(part)) {
      return {
        id,
        name: part.name,
        decor: true,
        ...(part.role && { role: part.role }),
        ...(part.hidden && { hidden: true }),
        ...(hidden.has(id) && !part.hidden && { hiddenByParent: true }),
        ...(part.unclickable && { unclickable: true }),
        shape: part.shape,
        position: part.transform.position,
        ...(!isZero(part.transform.rotation) && { rotation: part.transform.rotation }),
        front: directionText(frontOf(doc, id)),
        world: world(id),
      };
    }
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
        ...(part.finish && { finish: part.finish }),
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
    if (asm.generator && generators.has(asm.generator.type) && generators.get(asm.generator.type).collapse) return collapsed(id);
    return {
      id,
      name: asm.name,
      assembly: true,
      ...(asm.role && { role: asm.role }),
      ...(asm.hidden && { hidden: true }),
      ...(hidden.has(id) && !asm.hidden && { hiddenByParent: true }),
      ...(asm.unclickable && { unclickable: true }),
      ...(asm.finish && { finish: asm.finish }),
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
      children: asm.children.filter((c) => !generatedHardware(c)).map(node),
    };
  };

  /**
   * A generator that makes a whole thing (the room, an appliance) is one line: its params say it all.
   * What the user put in it (or in its folders) still shows; the room adds its inside.
   */
  const collapsed = (id: string) => {
    const asm = doc.assemblies[id]!;
    const inside = descendants(doc, id);
    const generated = inside.filter((c) => doc.parts[c]?.role !== undefined).length;
    const folders = asm.children.filter((c) => doc.assemblies[c]?.role !== undefined);
    const user = [...asm.children, ...folders.flatMap((f) => doc.assemblies[f]!.children)].filter((c) => (doc.parts[c] ?? doc.assemblies[c])?.role === undefined);
    const room = asm.generator!.type === 'room' ? roomParams(asm) : null;
    return {
      id,
      name: asm.name,
      assembly: true,
      ...(asm.hidden && { hidden: true }),
      ...(hidden.has(id) && !asm.hidden && { hiddenByParent: true }),
      ...(asm.unclickable && { unclickable: true }),
      generator: {
        type: asm.generator!.type,
        params: asm.generator!.params,
        ...(Object.keys(asm.generator!.overrides).length && { overrides: asm.generator!.overrides }),
      },
      world: world(id),
      generatedParts: generated,
      ...(room && { interior: [[room.left, 0, room.back], [room.right, room.height, room.front]] }),
      ...(user.length && { children: user.map(node) }),
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
  const userMotions = Object.values(doc.motions).filter((m) => m.role === undefined);
  let clashes: string[] = [];
  let issues: string[] = [];
  try {
    clashes = clearance(doc).map((c) => clashText(doc, c));
    issues = roomIssues(doc);
  } catch {
    // something doesn't build: the tool results say what
  }
  return JSON.stringify({
    materials: Object.values(doc.materials).map(({ id, name, thickness, stock, finish }) => ({ id, name, thickness, stock, ...(finish && { finish }) })),
    ...(variables.length && { variables: variables.map(({ id, name, group, unit, value }) => ({ id, group, name, unit, value })) }),
    tree: doc.roots.map(node),
    ...(userJoints.length && { joints: userJoints }),
    ...(userMotions.length && { motions: userMotions }),
    ...(clashes.length && { clashes }),
    ...(issues.length && { roomIssues: issues }),
    ...(notes.length && { notes }),
    ...(recipes.length && { recipes: recipeCatalog(recipes) }),
    ...(doc.presentation && { presentation: doc.presentation }),
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
