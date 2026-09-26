import type { Axis } from '../geometry/prism';
import type { V3 } from '../geometry/types';
import type { DadoParams } from '../plugins/features/dado';
import type { EdgeProfileParams } from '../plugins/features/edgeProfile';
import type { HoleParams } from '../plugins/features/hole';
import type { PocketParams } from '../plugins/features/pocket';
import { BOX_FACES, WORDS, type BoxFaceId } from '../plugins/shapes/box';
import type { OutlineParams } from '../plugins/shapes/outline';
import { CHANNEL_JOINTS, jointContact, jointDepth } from './joinery';
import type { Doc, Feature, Material, Part } from './schema';
import { formatInches, inches, lengthCell, UNITS_PER_INCH, type UnitSystem } from './units';
import { boxSize, localBox } from './world';

/**
 * The cut list: every part at the size to cut it, joinery included (a part sitting in a 1/4" dado
 * at each end is 1/2" longer than it looks), what to machine on it, grouped by material and
 * thickness, with sheet and board-foot estimates. Pure: formats lengths with the `fmt` it's given.
 */

export interface Allowance {
  joint: string;
  /** What the part sits in, e.g. `Left side`. */
  mate: string;
  depth: number;
  along: 'length' | 'width' | 'thickness';
}

export interface CutPart {
  id: string;
  name: string;
  material: string;
  length: number;
  width: number;
  thickness: number;
  /** Grain runs along the length (false: no grain set, free to rotate). */
  grain: boolean;
  shaped: boolean;
  allowances: Allowance[];
  ops: string[];
  notes: string[];
}

export interface CutRow {
  qty: number;
  names: string[];
  ids: string[];
  length: number;
  width: number;
  thickness: number;
  grain: boolean;
  shaped: boolean;
  allowances: Allowance[];
  ops: string[];
  notes: string[];
}

export interface MaterialCuts {
  material: Material;
  rows: CutRow[];
  parts: number;
  /** Square inches of parts (cut sizes). */
  area: number;
  sheets?: { count: number; size: [number, number]; utilization: number; oversize: string[] };
  boardFeet?: { net: number; withWaste: number; nominal: number };
  cost?: number;
}

export interface JointLine {
  id: string;
  type: string;
  housing: string;
  inserted: string;
  depth?: number;
  /** null = fine. */
  problem: string | null;
}

export interface CutList {
  materials: MaterialCuts[];
  joints: JointLine[];
  problems: string[];
  cost?: number;
}

export interface CutListOptions {
  fmt?: (u: number) => string;
  /** Saw kerf between parts on a sheet. Default 1/8". */
  kerf?: number;
  /** Extra solid stock to buy for defects and milling. Default 20%. */
  waste?: number;
}

export const DEFAULT_SHEET: [number, number] = [inches(48), inches(96)];
const AXIS: Record<string, Axis> = { x: 0, y: 1, z: 2 };

/** Board feet are sold by nominal thickness: 3/4" surfaced 4/4 stock counts as 1". */
export function nominalThickness(m: Material): number {
  return m.nominal ?? Math.ceil((m.thickness + 16) / 16) * 16;
}

/** `4/4`-style name for a nominal thickness. */
export const quarters = (u: number) => `${Math.round(u / 16)}/4`;

function faceName(face: string): string {
  const f = BOX_FACES[face as BoxFaceId];
  return f ? `${WORDS[f.axis][f.max ? 1 : 0]} face` : face;
}

/** `dado 23/32" wide × 1/4" deep, 4" from bottom, stopped 7/32" from back — right face`. */
function channelText(p: DadoParams, size: V3, grain: Axis | null, fmt: (u: number) => string): string {
  const f = BOX_FACES[p.face];
  const span = (k: Axis, a: number, b: number) => [Math.max(0, Math.min(a, b)), Math.min(size[k], Math.max(a, b))] as const;
  const [u0, u1] = span(f.u, p.from[0], p.to[0]);
  const [v0, v1] = span(f.v, p.from[1], p.to[1]);
  const touches = (k: Axis, lo: number, hi: number) => [lo <= 0, hi >= size[k]] as const;
  const tu = touches(f.u, u0, u1);
  const tv = touches(f.v, v0, v1);
  const alongU = tu[0] && tu[1] ? true : tv[0] && tv[1] ? false : u1 - u0 >= v1 - v0;
  const [run, across] = alongU ? ([f.u, f.v] as const) : ([f.v, f.u] as const);
  const [r0, r1] = alongU ? [u0, u1] : [v0, v1];
  const [a0, a1] = alongU ? [v0, v1] : [u0, u1];
  const [tr, ta] = alongU ? [tu, tv] : [tv, tu];
  const kind = ta[0] || ta[1] ? 'rabbet' : run === grain ? 'groove' : 'dado';
  const bits = [`${kind} ${fmt(a1 - a0)} wide × ${fmt(p.depth)} deep`];
  if (ta[0] && ta[1]) bits.push('across the whole face');
  else if (ta[0]) bits.push(`along ${WORDS[across][0]} edge`);
  else if (ta[1]) bits.push(`along ${WORDS[across][1]} edge`);
  else bits.push(a0 <= size[across] - a1 ? `${fmt(a0)} from ${WORDS[across][0]}` : `${fmt(size[across] - a1)} from ${WORDS[across][1]}`);
  if (!tr[0] && !tr[1]) bits.push(`${fmt(r0)} to ${fmt(r1)} from ${WORDS[run][0]}`);
  else if (!tr[0]) bits.push(`stopped ${fmt(r0)} from ${WORDS[run][0]}`);
  else if (!tr[1]) bits.push(`stopped ${fmt(size[run] - r1)} from ${WORDS[run][1]}`);
  return `${bits.join(', ')} — ${faceName(p.face)}`;
}

/** One line of what to machine on a part, and the features behind it. */
export interface MachiningLine {
  text: string;
  /** Feature ids the line describes; empty for a cut a joint makes (it follows the joint). */
  features: string[];
}

/** What to machine on a part, in shop words; identical holes are one line. `size` = the part's box size. */
function machining(doc: Doc, part: Part, size: V3, grain: Axis | null, fmt: (u: number) => string): MachiningLine[] {
  const out: MachiningLine[] = [];
  const holes = new Map<string, { ids: string[]; p: HoleParams }>();
  const byType = (t: string) => part.features.filter((f) => f.type === t);
  for (const f of byType('hole')) {
    const p = f.params as unknown as HoleParams;
    const key = JSON.stringify([p.d, p.depth ?? null, p.face]);
    const hit = holes.get(key);
    if (hit) hit.ids.push(f.id);
    else holes.set(key, { ids: [f.id], p });
  }
  for (const { ids, p } of holes.values()) {
    const n = ids.length;
    const depth = p.depth === undefined ? 'through' : `${fmt(p.depth)} deep`;
    const where = n === 1 ? ` at ${fmt(p.at[0])}, ${fmt(p.at[1])}` : '';
    out.push({ text: `${n === 1 ? '' : `${n} × `}Ø${fmt(p.d)} hole${n === 1 ? '' : 's'} ${depth}${where} — ${faceName(p.face)}`, features: ids });
  }
  for (const f of byType('pocket')) {
    const p = f.params as unknown as PocketParams;
    const noun = p.depth === undefined ? 'cutout' : `pocket ${fmt(p.depth)} deep`;
    out.push({ text: `${noun} ${fmt(p.size[0])} × ${fmt(p.size[1])}${p.r ? `, r ${fmt(p.r)}` : ''} centered ${fmt(p.at[0])}, ${fmt(p.at[1])} — ${faceName(p.face)}`, features: [f.id] });
  }
  const mateOf = (cut: Feature & { joint?: string }) => {
    const j = cut.joint ? doc.joints[cut.joint] : undefined;
    const other = j && doc.parts[j.parts[1]];
    return other ? ` (for ${other.name})` : '';
  };
  for (const f of [...byType('dado'), ...(part.joinery ?? [])]) {
    out.push({ text: channelText(f.params as unknown as DadoParams, size, grain, fmt) + mateOf(f), features: 'joint' in f ? [] : [f.id] });
  }
  for (const f of byType('edgeProfile')) {
    const p = f.params as unknown as EdgeProfileParams;
    const edges = p.edges.map((e) => e.replace('edge:', ''));
    out.push({ text: `${fmt(p.r)} ${p.profile} on ${edges.length === 1 ? 'edge' : `${edges.length} edges`} ${edges.join(', ')}`, features: [f.id] });
  }
  return out;
}

/** What to machine on one part, as the cut list words it (the inspector lists these). */
export function partMachining(doc: Doc, part: Part, fmt: (u: number) => string = formatInches): MachiningLine[] {
  let size: V3;
  if (part.shape.type === 'box') {
    const s = part.shape.params as { x: number; y: number; z: number };
    size = [s.x, s.y, s.z];
  } else {
    try {
      size = boxSize(localBox(doc, part.id)).map(Math.round) as V3;
    } catch {
      return [];
    }
  }
  return machining(doc, part, size, part.grain === 'none' ? null : AXIS[part.grain]!, fmt);
}

/** Cut size of every part. */
export function cutParts(doc: Doc, opts: CutListOptions = {}): { parts: CutPart[]; joints: JointLine[] } {
  const fmt = opts.fmt ?? formatInches;
  const allowances = new Map<string, { axis: Axis; a: Omit<Allowance, 'along'> }[]>();
  const joints: JointLine[] = [];
  for (const j of Object.values(doc.joints)) {
    const [h, i] = j.parts.map((id) => doc.parts[id]);
    const line: JointLine = { id: j.id, type: j.type, housing: h?.name ?? j.parts[0], inserted: i?.name ?? j.parts[1], problem: null };
    joints.push(line);
    if (!CHANNEL_JOINTS.has(j.type)) continue;
    const c = jointContact(doc, j);
    if (typeof c === 'string') {
      line.problem = c;
      continue;
    }
    line.depth = jointDepth(doc, j, c);
    if (doc.parts[c.housing]!.shape.type !== 'box') line.problem = `"${line.housing}" is shaped, so the ${j.type} isn't cut in the model (the cut list still adds its depth)`;
    allowances.set(c.inserted, [...(allowances.get(c.inserted) ?? []), { axis: c.axis, a: { joint: j.id, mate: line.housing, depth: line.depth } }]);
  }

  const parts: CutPart[] = [];
  for (const part of Object.values(doc.parts)) {
    // Blocks are placeholders, not parts to cut.
    const mat = part.block || !part.material ? undefined : doc.materials[part.material];
    if (!mat) continue;
    let size: V3;
    let shaped = false;
    let thickAxis: Axis;
    if (part.shape.type === 'box') {
      const s = part.shape.params as { x: number; y: number; z: number };
      size = [s.x, s.y, s.z];
      const grainAxis = part.grain === 'none' ? -1 : AXIS[part.grain]!;
      const matching = ([0, 1, 2] as Axis[]).filter((k) => size[k] === mat.thickness);
      thickAxis = matching.find((k) => k !== grainAxis) ?? matching[0] ?? ([0, 1, 2] as Axis[]).reduce((m, k) => (size[k] < size[m] || (size[k] === size[m] && m === grainAxis) ? k : m), 1 as Axis);
    } else {
      try {
        size = boxSize(localBox(doc, part.id)).map(Math.round) as V3;
      } catch {
        continue;
      }
      shaped = true;
      const axis = (part.shape.params as unknown as OutlineParams).axis;
      thickAxis = axis ? AXIS[axis]! : (([0, 1, 2] as Axis[]).reduce((m, k) => (size[k] < size[m] ? k : m), 0 as Axis));
    }
    const rest = ([0, 1, 2] as Axis[]).filter((k) => k !== thickAxis);
    const grainAxis = part.grain === 'none' ? null : AXIS[part.grain]!;
    const lengthAxis = grainAxis !== null && grainAxis !== thickAxis ? grainAxis : size[rest[1]!] > size[rest[0]!] ? rest[1]! : rest[0]!;
    const widthAxis = rest.find((k) => k !== lengthAxis)!;
    const grown = [...size] as V3;
    const own: Allowance[] = [];
    for (const { axis, a } of allowances.get(part.id) ?? []) {
      grown[axis] += a.depth;
      own.push({ ...a, along: axis === lengthAxis ? 'length' : axis === widthAxis ? 'width' : 'thickness' });
    }
    const notes: string[] = [];
    if (size[thickAxis] !== mat.thickness) notes.push(`${fmt(size[thickAxis])} thick, but ${mat.name} is ${fmt(mat.thickness)}`);
    if (mat.stock === 'solid' && grainAxis === null) notes.push('no grain direction set');
    if (grainAxis !== null && grainAxis === thickAxis) notes.push('grain runs through the thickness');
    parts.push({
      id: part.id,
      name: part.name,
      material: mat.id,
      length: grown[lengthAxis],
      width: grown[widthAxis],
      thickness: grown[thickAxis],
      grain: grainAxis !== null && grainAxis !== thickAxis,
      shaped,
      allowances: own,
      ops: machining(doc, part, size, grainAxis, fmt).map((m) => m.text),
      notes,
    });
  }
  return { parts, joints };
}

/** Shelf-packs parts onto sheets (grain along the sheet's length) to estimate how many to buy. */
export function packSheets(
  items: { length: number; width: number; grain: boolean; name: string }[],
  sheet: [number, number],
  kerf: number,
): { count: number; oversize: string[] } {
  const [SW, SL] = sheet;
  const oversize: string[] = [];
  const placed: { along: number; across: number }[] = [];
  for (const it of items) {
    const fits = (along: number, across: number) => along <= SL && across <= SW;
    const [long, short] = [Math.max(it.length, it.width), Math.min(it.length, it.width)];
    if (it.grain ? fits(it.length, it.width) : fits(long, short)) placed.push(it.grain ? { along: it.length, across: it.width } : { along: long, across: short });
    else if (!it.grain && fits(short, long)) placed.push({ along: short, across: long });
    else oversize.push(it.name);
  }
  placed.sort((a, b) => b.across - a.across || b.along - a.along);
  const sheets: { used: number; shelves: { h: number; used: number }[] }[] = [];
  for (const it of placed) {
    let done = false;
    for (const s of sheets) {
      const shelf = s.shelves.find((sh) => it.across <= sh.h && sh.used + it.along <= SL);
      if (shelf) {
        shelf.used += it.along + kerf;
        done = true;
        break;
      }
    }
    if (done) continue;
    let s = sheets.find((x) => x.used + it.across <= SW);
    if (!s) sheets.push((s = { used: 0, shelves: [] }));
    s.shelves.push({ h: it.across, used: it.along + kerf });
    s.used += it.across + kerf;
  }
  return { count: sheets.length, oversize };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function cutList(doc: Doc, opts: CutListOptions = {}): CutList {
  const kerf = opts.kerf ?? inches(1 / 8);
  const waste = opts.waste ?? 0.2;
  const { parts, joints } = cutParts(doc, opts);
  const problems = joints.filter((j) => j.problem).map((j) => `${j.type} joint ${j.id} (${j.inserted} into ${j.housing}): ${j.problem}`);

  const byMat = new Map<string, CutPart[]>();
  for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p]);
  const materials: MaterialCuts[] = [];
  for (const [id, list] of byMat) {
    const material = doc.materials[id]!;
    const rows: CutRow[] = [];
    for (const p of list) {
      const row = rows.find(
        (r) =>
          r.length === p.length && r.width === p.width && r.thickness === p.thickness && r.grain === p.grain && r.shaped === p.shaped &&
          sameList(r.ops, p.ops) && sameList(r.notes, p.notes) && JSON.stringify(r.allowances.map((a) => [a.depth, a.along])) === JSON.stringify(p.allowances.map((a) => [a.depth, a.along])),
      );
      if (row) {
        row.qty++;
        row.ids.push(p.id);
        if (!row.names.includes(p.name)) row.names.push(p.name);
      } else {
        rows.push({ qty: 1, names: [p.name], ids: [p.id], length: p.length, width: p.width, thickness: p.thickness, grain: p.grain, shaped: p.shaped, allowances: p.allowances, ops: p.ops, notes: p.notes });
      }
    }
    rows.sort((a, b) => b.thickness - a.thickness || b.length - a.length || b.width - a.width);
    const sq = (u: number) => u / UNITS_PER_INCH;
    const area = list.reduce((s, p) => s + sq(p.length) * sq(p.width), 0);
    const entry: MaterialCuts = { material, rows, parts: list.length, area };
    if (material.stock === 'sheet') {
      const size = material.sheet ?? DEFAULT_SHEET;
      const packed = packSheets(list, size, kerf);
      const utilization = packed.count ? area / (packed.count * sq(size[0]) * sq(size[1])) : 0;
      entry.sheets = { count: packed.count, size, utilization, oversize: packed.oversize };
      for (const name of packed.oversize) problems.push(`${name} is bigger than a ${formatInches(size[0])} × ${formatInches(size[1])} sheet of ${material.name}`);
      if (material.price !== undefined) entry.cost = packed.count * material.price;
    } else {
      const nominal = nominalThickness(material);
      const net = list.reduce((s, p) => s + (sq(p.length) * sq(p.width) * sq(Math.max(nominal, p.thickness))) / 144, 0);
      entry.boardFeet = { net, withWaste: net * (1 + waste), nominal };
      if (material.price !== undefined) entry.cost = entry.boardFeet.withWaste * material.price;
    }
    materials.push(entry);
  }
  materials.sort((a, b) => a.material.stock.localeCompare(b.material.stock) || b.material.thickness - a.material.thickness);
  const priced = materials.filter((m) => m.cost !== undefined);
  return { materials, joints, problems, ...(priced.length && { cost: priced.reduce((s, m) => s + m.cost!, 0) }) };
}

const csvCell = (s: string | number) => {
  const t = String(s);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** One row per group of identical parts; lengths as plain numbers in the chosen units. */
export function cutListCsv(list: CutList, system: UnitSystem): string {
  const unit = system === 'mm' ? 'mm' : 'in';
  const lines = [['Material', `Thickness (${unit})`, 'Qty', 'Part', `Length (${unit})`, `Width (${unit})`, 'Grain', 'Joinery allowance', 'Operations', 'Notes']];
  for (const m of list.materials) {
    for (const r of m.rows) {
      lines.push([
        m.material.name,
        lengthCell(r.thickness, system),
        String(r.qty),
        r.names.join(' / '),
        lengthCell(r.length, system),
        lengthCell(r.width, system),
        r.grain ? 'length' : r.shaped ? 'shaped' : 'any',
        r.allowances.map((a) => `+${lengthCell(a.depth, system)} ${a.along} (${a.mate})`).join('; '),
        r.ops.join('; '),
        r.notes.join('; '),
      ]);
    }
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Plain-text cut list (inches), for the AI tool and anything else that wants it as text. */
export function cutListText(list: CutList, fmt: (u: number) => string = formatInches): string {
  const lines: string[] = [];
  for (const m of list.materials) {
    const est = m.sheets
      ? `≈ ${m.sheets.count} sheet${m.sheets.count === 1 ? '' : 's'} ${fmt(m.sheets.size[0])} × ${fmt(m.sheets.size[1])}`
      : m.boardFeet
        ? `${m.boardFeet.net.toFixed(1)} bd ft at ${quarters(m.boardFeet.nominal)} (≈ ${m.boardFeet.withWaste.toFixed(1)} with waste)`
        : '';
    lines.push(`${m.material.name} (${m.material.id}, ${fmt(m.material.thickness)}): ${m.parts} part${m.parts === 1 ? '' : 's'}${est ? `, ${est}` : ''}`);
    for (const r of m.rows) {
      const allow = r.allowances.length ? ` [includes ${r.allowances.map((a) => `+${fmt(a.depth)} ${a.along} into ${a.mate}`).join(', ')}]` : '';
      lines.push(`  ${r.qty} × ${r.names.join(' / ')}: ${fmt(r.length)} × ${fmt(r.width)} × ${fmt(r.thickness)}${r.grain ? ', grain along length' : ''}${r.shaped ? ', shaped' : ''}${allow}`);
      for (const op of r.ops) lines.push(`      - ${op}`);
      for (const n of r.notes) lines.push(`      ! ${n}`);
    }
  }
  if (list.problems.length) lines.push('Problems:', ...list.problems.map((p) => `  ! ${p}`));
  return lines.join('\n') || 'No parts.';
}
