import { decorInfo, isDecor } from '../model/decor';
import { deepEqual, movingParts, parentIndex } from '../model/doc';
import { finishText, swatchOf } from '../model/finishes';
import { motionName, motionSummary } from '../model/motion';
import type { Bindings, Doc, Finish, Joint, JointCut, Lighting, Motion, Part, Variable, View } from '../model/schema';
import { formatInches } from '../model/units';

/**
 * Human-readable summary of what a proposal changes, for the preview card, plus the part
 * ids to highlight. A regenerated assembly is reported as its param changes, not as every
 * part the generator rebuilt (its animations included).
 */
export interface DocDiff {
  lines: string[];
  /** Added or changed parts (highlighted in the preview). */
  touched: Set<string>;
}

const COUNTS = new Set(['shelves', 'doors', 'grid']);
const ANGLES = new Set(['doorAngle', 'angle']);

function fmt(key: string, v: unknown): string {
  if (typeof v === 'number' && ANGLES.has(key)) return `${v}°`;
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
  // Lists of things with ids (a room's openings): matched by id, so adding one isn't the whole list again.
  const byId = (v: unknown) => (Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string') ? new Map(v.map((x) => [x.id as string, x])) : null);
  const [ia, ib] = [byId(a), byId(b)];
  if (ia && ib && (ia.size !== ib.size || [...ia.keys()].some((id) => !ib.has(id)))) {
    for (const [id, x] of ib) if (!ia.has(id)) out.push(`+ ${itemText(id, x)}`);
    for (const [id, x] of ia) if (!ib.has(id)) out.push(`− ${itemText(id, x)}`);
    for (const [id, x] of ib) if (ia.has(id)) leafChanges(`${path}[${id}]`, id, ia.get(id), x, out);
    return;
  }
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

/** An item of an id'd list: `window w1 (back wall, 36" × 48")` for a room opening, else its id. */
function itemText(id: string, x: unknown): string {
  const o = x as Record<string, unknown>;
  const size = typeof o.width === 'number' && typeof o.height === 'number' ? `, ${formatInches(o.width)} × ${formatInches(o.height)}` : '';
  return typeof o.kind === 'string' ? `${o.kind} ${id}${typeof o.wall === 'string' ? ` (${o.wall} wall${size})` : ''}` : id;
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

/** `finish → paint #1f2a44`, `finish cleared`; nothing when it didn't change. */
const finishChange = (a: Finish | undefined, b: Finish | undefined): string[] => (deepEqual(a, b) ? [] : [b ? `finish → ${finishText(b)}` : 'finish cleared']);

/** `Bar stool 1 (bar stool)`, `Base (block)`, `Left side`. */
const partLabel = (p: Part) => `${p.name}${p.block ? ' (block)' : isDecor(p) ? ` (${decorInfo(p.shape.type)!.label.toLowerCase()})` : ''}`;

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
  if (!!a.hidden !== !!b.hidden) out.push(b.hidden ? 'hidden in viewport' : 'shown in viewport');
  if (!!a.unclickable !== !!b.unclickable) out.push(b.unclickable ? 'made unclickable' : 'made clickable');
  if (a.material !== b.material) out.push(`material → ${b.material === undefined ? 'none' : (docB.materials[b.material]?.name ?? b.material)}`);
  out.push(...finishChange(a.finish, b.finish));
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
    else if (!deepEqual(old, m)) {
      // A new finish brings its swatch as the material's color (ops): that isn't a change of its own.
      const keys = changedKeys(old, m).filter((k) => k !== 'finish' && !(k === 'color' && m.finish && !deepEqual(old.finish, m.finish) && m.color === swatchOf(m.finish)));
      lines.push(`~ material ${m.name}: ${[...(keys.length ? [keys.join(', ')] : []), ...finishChange(old.finish, m.finish)].join('; ')}`);
    }
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
    if (old?.generator && asm.generator && !deepEqual(old.generator.params, asm.generator.params)) regenerated.add(id);
  }
  const parentOf = new Map<string, string>();
  for (const asm of Object.values(b.assemblies)) for (const c of asm.children) parentOf.set(c, asm.id);
  const oldParentOf = new Map<string, string>();
  for (const asm of Object.values(a.assemblies)) for (const c of asm.children) oldParentOf.set(c, asm.id);
  /** Generated folders come and go with their assembly's params, like its parts. */
  const quietFolder = (d: Doc, parents: Map<string, string>, id: string) => {
    const p = parents.get(id);
    return d.assemblies[id]?.role !== undefined && p !== undefined && (regenerated.has(p) || !a.assemblies[p] || !b.assemblies[p]);
  };

  for (const [id, asm] of Object.entries(b.assemblies)) {
    const old = a.assemblies[id];
    const gen = asm.generator ? ` (${asm.generator.type})` : '';
    if (!old) {
      if (!quietFolder(b, parentOf, id)) lines.push(`+ ${asm.name}${gen}`);
      continue;
    }
    const bits: string[] = [];
    if (old.name !== asm.name) bits.push(`renamed "${asm.name}"`);
    if (!!old.hidden !== !!asm.hidden) bits.push(asm.hidden ? 'hidden in viewport' : 'shown in viewport');
    if (!!old.unclickable !== !!asm.unclickable) bits.push(asm.unclickable ? 'made unclickable' : 'made clickable');
    bits.push(...finishChange(old.finish, asm.finish));
    if (!deepEqual(old.transform, asm.transform)) bits.push(`moved to ${fmt('position', asm.transform.position)}`);
    if (regenerated.has(id)) {
      bits.push(...paramChanges(old.generator!.params, asm.generator!.params, 6));
    }
    bits.push(...bindChanges(old.bind, asm.bind));
    if (bits.length) lines.push(`~ ${asm.name}: ${bits.join('; ')}`);
  }
  for (const [id, asm] of Object.entries(a.assemblies)) if (!b.assemblies[id] && !quietFolder(a, oldParentOf, id)) lines.push(`− ${asm.name}`);

  const quiet = (id: string) => {
    let p = parentOf.get(id);
    if (p !== undefined && b.assemblies[p]?.role !== undefined) {
      if (!a.assemblies[p]) return true;
      p = parentOf.get(p);
    }
    return p !== undefined && (regenerated.has(p) || !a.assemblies[p]);
  };

  for (const [id, part] of Object.entries(b.parts)) {
    const old = a.parts[id];
    if (!old) {
      touched.add(id);
      if (!quiet(id)) lines.push(`+ ${partLabel(part)}`);
    } else if (!deepEqual(old, part)) {
      touched.add(id);
      if (!quiet(id)) lines.push(`~ ${part.name}: ${partChanges(old, part, b).join('; ') || 'changed'}`);
    }
  }
  const removedParent = (id: string) => {
    let p = oldParentOf.get(id);
    if (p !== undefined && a.assemblies[p]?.role !== undefined) {
      if (!b.assemblies[p]) return true;
      p = oldParentOf.get(p);
    }
    return p !== undefined && (!b.assemblies[p] || regenerated.has(p));
  };
  for (const [id, part] of Object.entries(a.parts)) if (!b.parts[id] && !removedParent(id)) lines.push(`− ${partLabel(part)}`);

  const oldParents = parentIndex(a);
  for (const [id, parent] of parentIndex(b)) {
    if (!oldParents.has(id) || oldParents.get(id) === parent) continue;
    const node = (b.parts[id] ?? b.assemblies[id])!;
    lines.push(`~ ${node.name}: moved into ${parent ? b.assemblies[parent]!.name : 'Model (top level)'}`);
    if (b.parts[id]) touched.add(id);
  }

  // User joints (generated ones follow their generator).
  const jointText = (d: Doc, j: Joint) => `${j.type} joint: ${d.parts[j.parts[1]]?.name ?? j.parts[1]} into ${d.parts[j.parts[0]]?.name ?? j.parts[0]}`;
  for (const [id, j] of Object.entries(b.joints)) {
    if (j.role !== undefined) continue;
    const old = a.joints[id];
    if (!old) lines.push(`+ ${jointText(b, j)}`);
    else if (!deepEqual(old, j)) lines.push(`~ ${jointText(b, j)}`);
  }
  for (const [id, j] of Object.entries(a.joints)) if (j.role === undefined && !b.joints[id]) lines.push(`− ${jointText(a, j)}`);

  // User animations (generated ones follow their generator); what they move is highlighted.
  const motionText = (d: Doc, m: Motion) => `${motionName(d, m)} animation: ${motionSummary(m)}`;
  for (const [id, m] of Object.entries(b.motions)) {
    if (m.role !== undefined) continue;
    const old = a.motions[id];
    if (old && deepEqual(old, m)) continue;
    lines.push(`${old ? '~' : '+'} ${motionText(b, m)}`);
    for (const p of movingParts(b, m.nodes)) touched.add(p);
  }
  for (const [id, m] of Object.entries(a.motions)) if (m.role === undefined && !b.motions[id]) lines.push(`− ${motionText(a, m)}`);

  const quote = (s: string) => `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"`;
  for (const [id, n] of Object.entries(b.annotations)) {
    const old = a.annotations[id];
    if (!old) lines.push(`+ note ${quote(n.note)}`);
    else if (!old.resolved && n.resolved) lines.push(`✓ resolves note ${quote(n.note)}`);
    else if (!deepEqual(old, n)) lines.push(`~ note ${quote(n.note)}`);
  }
  for (const [id, n] of Object.entries(a.annotations)) if (!b.annotations[id]) lines.push(`− note ${quote(n.note)}`);
  lines.push(...viewChanges(a, b));
  lines.push(...lightingChanges(a.presentation?.lighting, b.presentation?.lighting));
  const [eyeA, eyeB] = [a.presentation?.eyeHeight, b.presentation?.eyeHeight];
  if (eyeA !== eyeB) lines.push(eyeB === undefined ? '~ eye height reset' : `~ eye height → ${formatInches(eyeB)}`);
  return { lines, touched };
}

/** `~ lighting → evening`, `~ lighting: brightness +0.5 EV, under-cabinet lights on`, `~ lighting reset`. */
export function lightingChanges(a: Lighting | undefined, b: Lighting | undefined): string[] {
  if (deepEqual(a, b)) return [];
  if (!b) return ['~ lighting reset'];
  const out: string[] = [];
  if ((a?.preset ?? 'auto') !== b.preset) out.push(b.preset);
  if (!deepEqual(a?.sun, b.sun)) out.push(b.sun ? `sun ${b.sun.azimuth}° / ${b.sun.elevation}° up` : 'sun automatic');
  if ((a?.exposure ?? 0) !== (b.exposure ?? 0)) out.push(`brightness ${(b.exposure ?? 0) > 0 ? '+' : ''}${b.exposure ?? 0} EV`);
  if (a?.underCabinet !== b.underCabinet) out.push(`under-cabinet lights ${b.underCabinet === undefined ? 'automatic' : b.underCabinet ? 'on' : 'off'}`);
  if (!out.length) return [];
  return [(a?.preset ?? 'auto') !== b.preset ? `~ lighting → ${out.join(', ')}` : `~ lighting: ${out.join(', ')}`];
}

/** `+ view "Island"`, `~ view "Island": camera moved; opens Drawer 1`, `− view "Sink"`, `~ views reordered: …`. */
export function viewChanges(a: Doc, b: Doc): string[] {
  const [va, vb] = [a.presentation?.views ?? [], b.presentation?.views ?? []];
  const old = new Map(va.map((v) => [v.id, v]));
  const now = new Set(vb.map((v) => v.id));
  const named = (d: Doc, id: string) => {
    const m = d.motions[id];
    return m ? motionName(d, m) : ((d.parts[id] ?? d.assemblies[id])?.name ?? id);
  };
  const list = (d: Doc, ids: string[] | undefined) => (ids?.length ? ids.map((id) => named(d, id)).join(', ') : 'nothing');
  const out: string[] = [];
  for (const v of vb) {
    const o = old.get(v.id);
    if (!o) {
      out.push(`+ view "${v.name}"`);
      continue;
    }
    if (deepEqual(o, v)) continue;
    const bits: string[] = [];
    if (o.name !== v.name) bits.push(`renamed (was "${o.name}")`);
    if (v.camera && !deepEqual(o.camera, v.camera)) bits.push('camera moved');
    if (v.frame && !deepEqual(o.frame, v.frame)) bits.push(`frames ${v.frame.nodes.length ? list(b, v.frame.nodes) : 'the whole model'} from ${v.frame.azimuth !== undefined || v.frame.elevation !== undefined ? 'its own angle' : v.frame.from}`);
    if (o.mode !== v.mode) bits.push(v.mode ? `${v.mode} mode` : 'mode as it is');
    if (!deepEqual(o.open, v.open)) bits.push(`opens ${list(b, v.open)}`);
    if (!deepEqual(o.hide, v.hide)) bits.push(`hides ${list(b, v.hide)}`);
    if (o.caption !== v.caption) bits.push(v.caption ? `caption ${JSON.stringify(v.caption.length > 48 ? `${v.caption.slice(0, 47)}…` : v.caption)}` : 'caption cleared');
    if (o.lighting !== v.lighting) bits.push(v.lighting ? `lighting → ${v.lighting}` : 'lighting as saved');
    out.push(`~ view "${v.name}": ${bits.join('; ') || 'changed'}`);
  }
  for (const v of va) if (!now.has(v.id)) out.push(`− view "${v.name}"`);
  const kept = (vs: View[], other: Set<string>) => vs.filter((v) => other.has(v.id)).map((v) => v.id);
  const order = kept(vb, new Set(old.keys()));
  if (order.join() !== kept(va, now).join()) out.push(`~ views reordered: ${vb.map((v) => `"${v.name}"`).join(', ')}`);
  return out;
}
