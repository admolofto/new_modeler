import { deepEqual } from '../model/doc';
import type { Bindings, Doc, Joint, JointCut, Part, Variable } from '../model/schema';
import { formatInches } from '../model/units';

/**
 * Human-readable summary of what a proposal changes, for the preview card, plus the part
 * ids to highlight. A regenerated assembly is reported as its param changes, not as every
 * part the generator rebuilt.
 */
export interface DocDiff {
  lines: string[];
  /** Added or changed parts (highlighted in the preview). */
  touched: Set<string>;
}

const COUNTS = new Set(['shelves']);

function fmt(key: string, v: unknown): string {
  if (typeof v === 'number') return COUNTS.has(key) || !Number.isInteger(v) ? String(v) : formatInches(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmt(key, x)).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${fmt(k, x)}`).join(', ')}}`;
  return v === undefined ? '—' : JSON.stringify(v);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const numbers = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'number');

/**
 * Leaf-level changes between two param values: `points[br].at [37 1/2", 0"] → [38 1/4", 0"]`
 * rather than the whole array. Number tuples (`at`, `size`) are shown whole; array items with
 * an `id` are named by it.
 */
function leafChanges(path: string, key: string, a: unknown, b: unknown, out: string[]): void {
  if (deepEqual(a, b)) return;
  const sameShape = isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b) && !numbers(a) && !numbers(b);
  if (sameShape && (!Array.isArray(a) || a.length === (b as unknown as unknown[]).length)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      const item = (b as Record<string, unknown>)[k] ?? a[k];
      const name = Array.isArray(a) ? `${path}[${isObj(item) && typeof item.id === 'string' ? item.id : k}]` : `${path}.${k}`;
      leafChanges(name, k, a[k], (b as Record<string, unknown>)[k], out);
    }
    return;
  }
  out.push(`${path} ${fmt(key, a)} → ${fmt(key, b)}`);
}

function paramChanges(a: Record<string, unknown>, b: Record<string, unknown>, max = 4): string[] {
  const out: string[] = [];
  for (const k of changedKeys(a, b)) leafChanges(k, k, a[k], b[k], out);
  return out.length > max ? [...out.slice(0, max), `…${out.length - max} more`] : out;
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !deepEqual(a[k], b[k]));
}

const fmtVar = (v: Variable) => (v.unit === 'length' ? formatInches(v.value) : String(v.value));

/** "linked shape.x, position.x" / "unlinked shape.y" for changed bindings. */
function bindChanges(a: Bindings | undefined, b: Bindings | undefined): string[] {
  const [pa, pb] = [a ?? {}, b ?? {}];
  const linked = Object.keys(pb).filter((k) => pa[k] !== pb[k]);
  const unlinked = Object.keys(pa).filter((k) => !(k in pb));
  return [...(linked.length ? [`linked ${linked.join(', ')}`] : []), ...(unlinked.length ? [`unlinked ${unlinked.join(', ')}`] : [])];
}

function partChanges(a: Part, b: Part, docB: Doc): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`renamed "${b.name}"`);
  if (a.material !== b.material) out.push(`material → ${b.material === undefined ? 'none' : (docB.materials[b.material]?.name ?? b.material)}`);
  if (a.grain !== b.grain) out.push(`grain → ${b.grain}`);
  if (!deepEqual(a.transform.position, b.transform.position)) out.push(`moved to ${fmt('position', b.transform.position)}`);
  if (!deepEqual(a.transform.rotation, b.transform.rotation)) out.push(`rotated ${b.transform.rotation.join('°, ')}°`);
  if (a.shape.type !== b.shape.type) out.push(`shape → ${b.shape.type}`);
  else out.push(...paramChanges(a.shape.params, b.shape.params));
  const ids = (p: Part) => new Map(p.features.map((f) => [f.id, f]));
  const [fa, fb] = [ids(a), ids(b)];
  for (const [id, f] of fb) {
    const old = fa.get(id);
    if (!old) out.push(`+ ${f.type} ${id}`);
    else if (!deepEqual(old, f)) out.push(`${f.type} ${id}: ${paramChanges(old.params, f.params).join(', ') || 'changed'}`);
  }
  for (const [id, f] of fa) if (!fb.has(id)) out.push(`− ${f.type} ${id}`);
  // Cuts its joints make (derived, so described by what sits in them).
  const cutName = (c: JointCut) => {
    const j = docB.joints[c.joint];
    return `${j?.type ?? 'joint'} cut for ${(j && docB.parts[j.parts[1]]?.name) ?? c.joint}`;
  };
  const cuts = (p: Part) => new Map((p.joinery ?? []).map((c) => [c.id, c]));
  const [ca, cb] = [cuts(a), cuts(b)];
  for (const [id, c] of cb) {
    const old = ca.get(id);
    if (!old) out.push(`+ ${cutName(c)}`);
    else if (!deepEqual(old.params, c.params)) out.push(`${cutName(c)} moved`);
  }
  for (const [id, c] of ca) if (!cb.has(id)) out.push(`− ${c.type} cut (${c.joint})`);
  out.push(...bindChanges(a.bind, b.bind));
  return out;
}

export function diffDocs(a: Doc, b: Doc): DocDiff {
  const lines: string[] = [];
  const touched = new Set<string>();
  const regenerated = new Set<string>();

  for (const [id, m] of Object.entries(b.materials)) {
    const old = a.materials[id];
    if (!old) lines.push(`+ material ${m.name} (${formatInches(m.thickness)})`);
    else if (!deepEqual(old, m)) lines.push(`~ material ${m.name}: ${changedKeys(old, m).join(', ')}`);
  }
  for (const [id, m] of Object.entries(a.materials)) if (!b.materials[id]) lines.push(`− material ${m.name}`);

  for (const [id, v] of Object.entries(b.variables)) {
    const old = a.variables[id];
    if (!old) lines.push(`+ ${v.group} › ${v.name} = ${fmtVar(v)}`);
    else if (old.value !== v.value) lines.push(`~ ${v.group} › ${v.name} ${fmtVar(old)} → ${fmtVar(v)}`);
    else if (old.name !== v.name || old.group !== v.group) lines.push(`~ ${old.group} › ${old.name} renamed ${v.group} › ${v.name}`);
  }
  for (const [id, v] of Object.entries(a.variables)) if (!b.variables[id]) lines.push(`− ${v.group} › ${v.name}`);

  for (const [id, asm] of Object.entries(b.assemblies)) {
    const old = a.assemblies[id];
    const gen = asm.generator ? ` (${asm.generator.type})` : '';
    if (!old) {
      lines.push(`+ ${asm.name}${gen}`);
      continue;
    }
    const bits: string[] = [];
    if (old.name !== asm.name) bits.push(`renamed "${asm.name}"`);
    if (!deepEqual(old.transform, asm.transform)) bits.push(`moved to ${fmt('position', asm.transform.position)}`);
    if (old.generator && asm.generator && !deepEqual(old.generator.params, asm.generator.params)) {
      regenerated.add(id);
      bits.push(...paramChanges(old.generator.params, asm.generator.params, 6));
    }
    bits.push(...bindChanges(old.bind, asm.bind));
    if (bits.length) lines.push(`~ ${asm.name}: ${bits.join('; ')}`);
  }
  for (const [id, asm] of Object.entries(a.assemblies)) if (!b.assemblies[id]) lines.push(`− ${asm.name}`);

  const parentOf = new Map<string, string>();
  for (const asm of Object.values(b.assemblies)) for (const c of asm.children) parentOf.set(c, asm.id);
  const quiet = (id: string) => {
    const p = parentOf.get(id);
    return p !== undefined && (regenerated.has(p) || !a.assemblies[p]);
  };

  for (const [id, part] of Object.entries(b.parts)) {
    const old = a.parts[id];
    if (!old) {
      touched.add(id);
      if (!quiet(id)) lines.push(`+ ${part.name}${part.block ? ' (block)' : ''}`);
    } else if (!deepEqual(old, part)) {
      touched.add(id);
      if (!quiet(id)) lines.push(`~ ${part.name}: ${partChanges(old, part, b).join('; ') || 'changed'}`);
    }
  }
  const removedParent = (id: string) => {
    for (const asm of Object.values(a.assemblies)) if (asm.children.includes(id)) return !b.assemblies[asm.id] || regenerated.has(asm.id);
    return false;
  };
  for (const [id, part] of Object.entries(a.parts)) if (!b.parts[id] && !removedParent(id)) lines.push(`− ${part.name}${part.block ? ' (block)' : ''}`);

  // User joints (generated ones follow their generator).
  const jointText = (d: Doc, j: Joint) => `${j.type} joint: ${d.parts[j.parts[1]]?.name ?? j.parts[1]} into ${d.parts[j.parts[0]]?.name ?? j.parts[0]}`;
  for (const [id, j] of Object.entries(b.joints)) {
    if (j.role !== undefined) continue;
    const old = a.joints[id];
    if (!old) lines.push(`+ ${jointText(b, j)}`);
    else if (!deepEqual(old, j)) lines.push(`~ ${jointText(b, j)}`);
  }
  for (const [id, j] of Object.entries(a.joints)) if (j.role === undefined && !b.joints[id]) lines.push(`− ${jointText(a, j)}`);

  const quote = (s: string) => `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"`;
  for (const [id, n] of Object.entries(b.annotations)) {
    const old = a.annotations[id];
    if (!old) lines.push(`+ note ${quote(n.note)}`);
    else if (!old.resolved && n.resolved) lines.push(`✓ resolves note ${quote(n.note)}`);
    else if (!deepEqual(old, n)) lines.push(`~ note ${quote(n.note)}`);
  }
  for (const [id, n] of Object.entries(a.annotations)) if (!b.annotations[id]) lines.push(`− note ${quote(n.note)}`);
  return { lines, touched };
}
