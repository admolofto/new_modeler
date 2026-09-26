import { features, generators, shapes } from '../plugins';
import { ModelError } from './doc';
import { bareVariable, evalFormula, parseFormula } from './expr';
import { generatedOwner, regenerate } from './generate';
import type { Assembly, Doc, Part, Variable } from './schema';

/**
 * Variables and bindings. A part or assembly can bind numeric fields to formulas over
 * `doc.variables` (`bind: { 'shape.x': '(cabW - gap) / 2' }`). Field values stay concrete in the
 * doc — geometry, drags and validation never see a formula — and `syncBindings` re-evaluates
 * them at the end of every `applyOps` batch.
 *
 * Paths: `position.x|y|z`; parts `shape.<param path>`, `features.<featureId>.<param path>`;
 * generated assemblies `params.<param path>`. Array segments are indexes, or an item's `id`
 * (`shape.points.v2.at.0`).
 */

type Node = Part | Assembly;
type Slot = { obj: Record<string, unknown> | unknown[]; key: string | number };

const AXES: Record<string, number> = { x: 0, y: 1, z: 2 };

const nodeOf = (d: Doc, id: string): Node | undefined => d.parts[id] ?? d.assemblies[id];

/** Where a path points inside a node, or a reason it doesn't. */
function slot(node: Node, path: string): Slot | string {
  const [head, ...rest] = path.split('.');
  let root: unknown;
  if (head === 'position') {
    const i = rest.length === 1 ? AXES[rest[0]!] : undefined;
    return i === undefined ? `"${path}" — use position.x, position.y or position.z` : { obj: node.transform.position, key: i };
  } else if (head === 'shape' && 'shape' in node) {
    root = node.shape.params;
  } else if (head === 'features' && 'features' in node) {
    const f = node.features.find((x) => x.id === rest[0]);
    if (!f) return `no feature "${rest[0] ?? ''}" on "${node.name}"`;
    root = f.params;
    rest.shift();
  } else if (head === 'params' && 'children' in node) {
    if (!node.generator) return `assembly "${node.name}" has no generator params`;
    root = node.generator.params;
  } else {
    return `"${path}" — bindable paths are position.x|y|z, ${'shape' in node ? 'shape.<param>, features.<id>.<param>' : 'params.<generator param>'}`;
  }
  if (!rest.length) return `"${path}" names a group, not a number`;
  let obj = root;
  for (let i = 0; i < rest.length; i++) {
    const seg = rest[i]!;
    let key: string | number = seg;
    if (Array.isArray(obj)) {
      key = /^\d+$/.test(seg) ? Number(seg) : obj.findIndex((x) => (x as { id?: unknown })?.id === seg);
      if (key < 0 || key >= obj.length) return `"${path}": no item "${seg}"`;
    } else if (!obj || typeof obj !== 'object') {
      return `"${path}": nothing at "${seg}"`;
    }
    if (i === rest.length - 1) return { obj: obj as Slot['obj'], key };
    obj = (obj as Record<string | number, unknown>)[key];
  }
  return `"${path}" is empty`;
}

function read(node: Node, path: string): number | string {
  const s = slot(node, path);
  if (typeof s === 'string') return s;
  const v = (s.obj as Record<string | number, unknown>)[s.key];
  return typeof v === 'number' ? v : `"${path}" on "${node.name}" isn't a number`;
}

/** Current value at a bindable path; throws ModelError when it doesn't resolve to a number. */
export function getField(d: Doc, nodeId: string, path: string): number {
  const node = nodeOf(d, nodeId);
  if (!node) throw new ModelError(`no part or assembly "${nodeId}"`);
  const v = read(node, path);
  if (typeof v === 'string') throw new ModelError(`can't bind ${v}`);
  return v;
}

const peek = (d: Doc, nodeId: string, path: string): number | undefined => {
  const node = nodeOf(d, nodeId);
  const v = node && read(node, path);
  return typeof v === 'number' ? v : undefined;
};

/** Human label for a bound field: "Left door x size", "Base cabinet width". */
export function fieldLabel(d: Doc, nodeId: string, path: string): string {
  const name = nodeOf(d, nodeId)?.name ?? nodeId;
  const [head, ...rest] = path.split('.');
  if (head === 'position') return `${name} ${rest[0]} position`;
  if (head === 'shape' && rest.length === 1 && rest[0]! in AXES) return `${name} ${rest[0]} size`;
  if (head === 'params' || head === 'shape') return `${name} ${rest.join('.')}`;
  return `${name} ${path}`;
}

const valueOf = (d: Doc) => (id: string) => d.variables[id]?.value;

/** Evaluates one binding to the integer the field must hold. */
export function evaluateBinding(d: Doc, src: string): number {
  return Math.round(evalFormula(parseFormula(src), valueOf(d)));
}

/** Every binding in the doc. */
export function allBindings(d: Doc): { node: string; path: string; src: string }[] {
  const out: { node: string; path: string; src: string }[] = [];
  for (const n of [...Object.values(d.parts), ...Object.values(d.assemblies)]) {
    for (const [path, src] of Object.entries(n.bind ?? {})) out.push({ node: n.id, path, src });
  }
  return out;
}

/** Fields a variable drives (for tooltips and the inspector). */
export function dependents(d: Doc, varId: string): { node: string; path: string }[] {
  return allBindings(d).filter((b) => parseFormula(b.src).refs.includes(varId));
}

/** Variables a node's bindings read, in doc order. */
export function variablesOf(d: Doc, nodeId: string): Variable[] {
  const refs = new Set(Object.values(nodeOf(d, nodeId)?.bind ?? {}).flatMap((src) => parseFormula(src).refs));
  return Object.values(d.variables).filter((v) => refs.has(v.id));
}

/** Validates and stores (or with null, removes) one binding. Used by the `bind` op. */
export function setBinding(d: Doc, nodeId: string, path: string, src: string | null): void {
  const node = nodeOf(d, nodeId);
  if (!node) throw new ModelError(`no part or assembly "${nodeId}"`);
  if (src === null) {
    if (node.bind) delete node.bind[path];
    if (node.bind && !Object.keys(node.bind).length) delete node.bind;
    return;
  }
  if ('shape' in node && generatedOwner(d, nodeId)) {
    throw new ModelError(`"${node.name}" is generated — bind its assembly's params instead`);
  }
  getField(d, nodeId, path);
  parseFormula(src);
  node.bind = { ...node.bind, [path]: src };
}

/** Removes every binding that reads a variable (their fields keep their current values). */
export function unbindVariable(d: Doc, varId: string): void {
  for (const b of dependents(d, varId)) setBinding(d, b.node, b.path, null);
}

/**
 * Brings bound fields in line with the variables after a batch of ops (`before` = the doc the
 * batch started from):
 * 1. A bound field the batch edited directly (its formula and variables unchanged): when the
 *    formula is a single variable, the edit writes through to that variable (drag the cabinet
 *    side → "Cabinet width" follows, and so does everything else bound to it); otherwise it's refused.
 * 2. Every binding is evaluated and written; edited params are re-validated and generated
 *    assemblies regenerate.
 */
export function syncBindings(before: Doc, d: Doc): void {
  const bindings = allBindings(d);
  if (!bindings.length) return;
  const changedVars = new Set(
    [...Object.keys(before.variables), ...Object.keys(d.variables)].filter((id) => before.variables[id]?.value !== d.variables[id]?.value),
  );

  const writes = new Map<string, number>();
  for (const b of bindings) {
    if (nodeOf(before, b.node)?.bind?.[b.path] !== b.src) continue; // new or changed binding: formula wins
    const f = parseFormula(b.src);
    if (f.refs.some((r) => changedVars.has(r))) continue; // its variables changed: formula wins
    const [was, now] = [peek(before, b.node, b.path), peek(d, b.node, b.path)];
    if (was === undefined || now === undefined || was === now) continue;
    const bare = bareVariable(f);
    if (bare && d.variables[bare]) {
      const other = writes.get(bare);
      if (other !== undefined && other !== now) {
        throw new ModelError(`two fields bound to "${d.variables[bare].name}" were set to different values`);
      }
      writes.set(bare, now);
      continue;
    }
    const names = Object.values(d.variables).filter((v) => f.refs.includes(v.id));
    const groups = [...new Set(names.map((v) => v.group))];
    throw new ModelError(
      `${fieldLabel(d, b.node, b.path)} follows the ${groups.join(' / ')} variables (${names.map((v) => v.name).join(', ')}) — ` +
        'change those, or unlink it from its variables first',
    );
  }
  for (const [id, v] of writes) d.variables[id]!.value = v;

  const dirty = new Set<string>();
  for (const b of bindings) {
    const node = nodeOf(d, b.node)!;
    let v: number;
    try {
      v = evaluateBinding(d, b.src);
    } catch (err) {
      throw new ModelError(`${fieldLabel(d, b.node, b.path)} = ${b.src}: ${(err as Error).message}`);
    }
    const s = slot(node, b.path);
    if (typeof s === 'string') throw new ModelError(`${fieldLabel(d, b.node, b.path)}: can't bind ${s}`);
    const rec = s.obj as Record<string | number, unknown>;
    if (rec[s.key] === v) continue;
    rec[s.key] = v;
    if (!b.path.startsWith('position.')) dirty.add(b.node);
  }

  for (const id of dirty) {
    const where = (err: unknown) => new ModelError(`after applying variables to "${nodeOf(d, id)!.name}": ${(err as Error).message}`);
    try {
      const part = d.parts[id];
      if (part) {
        part.shape.params = shapes.parse(part.shape.type, part.shape.params);
        for (const f of part.features) f.params = features.parse(f.type, f.params);
        continue;
      }
      const asm = d.assemblies[id]!;
      asm.generator!.params = generators.parse(asm.generator!.type, asm.generator!.params);
      regenerate(d, id);
    } catch (err) {
      throw where(err);
    }
  }
}
