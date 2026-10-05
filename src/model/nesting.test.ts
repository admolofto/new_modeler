import { describe, expect, it } from 'vitest';
import '../plugins';
import { cutList } from './cutlist';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from './defaults';
import { nestSheets, type NestItem, type Placement } from './nesting';
import { applyOps } from './ops';
import { inches } from './units';

const SHEET: [number, number] = [inches(48), inches(96)];
const KERF = inches(1 / 8);
let n = 0;
const part = (length: number, width: number, grain = true): NestItem => ({ id: `p${++n}`, name: `p${n}`, length, width, grain });

/** Can the parts be cut apart with edge-to-edge cuts, each `kerf` wide? */
function guillotine(parts: Placement[], kerf: number): boolean {
  if (parts.length <= 1) return true;
  for (const [at, size] of [['x', 'w'], ['y', 'h']] as const) {
    for (const p of parts) {
      const e = p[at] + p[size];
      const a = parts.filter((q) => q[at] + q[size] <= e);
      const b = parts.filter((q) => q[at] >= e + kerf);
      if (a.length && b.length && a.length + b.length === parts.length) return guillotine(a, kerf) && guillotine(b, kerf);
    }
  }
  return false;
}

/** Every part placed once, inside its sheet, `kerf` clear of the others, grain along the sheet, and the sheet cuttable. */
function expectValid(items: NestItem[], sheet: [number, number], kerf: number) {
  const nest = nestSheets(items, sheet, kerf);
  const placed = nest.sheets.flatMap((s) => s.parts);
  expect(placed.map((p) => p.id).sort()).toEqual(items.filter((it) => !nest.oversize.includes(it.name)).map((it) => it.id).sort());
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const s of nest.sheets) {
    expect(s.parts.length).toBeGreaterThan(0);
    for (const p of s.parts) {
      const it = byId.get(p.id)!;
      expect(p.turned ? [p.w, p.h] : [p.h, p.w]).toEqual([it.length, it.width]);
      if (it.grain) expect(p.turned).toBe(false);
      expect(p.x >= 0 && p.y >= 0 && p.x + p.w <= sheet[0] && p.y + p.h <= sheet[1]).toBe(true);
    }
    for (const [i, a] of s.parts.entries()) {
      for (const b of s.parts.slice(i + 1)) {
        const apart = a.x + a.w + kerf <= b.x || b.x + b.w + kerf <= a.x || a.y + a.h + kerf <= b.y || b.y + b.h + kerf <= a.y;
        expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
      }
    }
    expect(guillotine(s.parts, kerf)).toBe(true);
  }
  return nest;
}

describe('sheet nesting', () => {
  it('counts sheets with the kerf, keeps grain along the sheet and turns grainless parts', () => {
    expect(nestSheets([part(inches(96), inches(24)), part(inches(96), inches(24))], SHEET, 0).sheets).toHaveLength(1);
    expect(nestSheets([part(inches(96), inches(24)), part(inches(96), inches(24))], SHEET, KERF).sheets).toHaveLength(2);
    expect(nestSheets([part(inches(40), inches(90))], SHEET, KERF).oversize).toEqual([`p${n}`]);
    const turned = nestSheets([part(inches(40), inches(90), false)], SHEET, KERF);
    expect(turned.sheets).toHaveLength(1);
    expect(turned.sheets[0]!.parts[0]).toMatchObject({ x: 0, y: 0, w: inches(40), h: inches(90), turned: true });
    expect(nestSheets([], SHEET, KERF)).toEqual({ sheets: [], oversize: [] });
  });

  it('fills the space beside shorter parts, not just whole strips', () => {
    // Exactly one sheet of parts; shelf packing needed two.
    const items = [part(inches(60), inches(24)), part(inches(36), inches(12)), part(inches(36), inches(12)), part(inches(96), inches(24))];
    expect(expectValid(items, SHEET, 0).sheets).toHaveLength(1);
  });

  it('makes valid, repeatable layouts for a mixed bag of parts', () => {
    const at = (x: number, y: number, w: number, h: number) => ({ id: '', name: '', x, y, w, h, turned: false });
    expect(guillotine([at(0, 0, 2, 1), at(2, 0, 1, 2), at(1, 2, 2, 1), at(0, 1, 1, 2)], 0)).toBe(false);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 12; run++) {
      const items = Array.from({ length: 10 + run * 4 }, () => part(inches(3 + Math.floor(rand() * 90)), inches(2 + Math.floor(rand() * 44)), rand() < 0.7));
      const nest = expectValid(items, SHEET, KERF);
      expect(nestSheets(items, SHEET, KERF)).toEqual(nest);
    }
    expectValid([part(inches(30), inches(20), false), part(inches(58), inches(10)), part(inches(12), inches(12))], [inches(60), inches(60)], KERF);
  });

  it('lays out every sheet part in the cut list', () => {
    const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, shelves: 2 } } } }]);
    if (!r.ok) throw new Error(r.error);
    for (const doc of [r.doc, demoDoc()]) {
      for (const m of cutList(doc).materials) {
        if (!m.sheets) continue;
        expect(m.sheets.layouts).toHaveLength(m.sheets.count);
        const ids = m.rows.flatMap((row) => row.ids).sort();
        expect(m.sheets.layouts.flatMap((s) => s.parts.map((p) => p.id)).sort()).toEqual(ids);
        expect(m.sheets.utilization).toBeGreaterThan(0);
        expect(m.sheets.utilization).toBeLessThanOrEqual(1);
      }
    }
  });
});
