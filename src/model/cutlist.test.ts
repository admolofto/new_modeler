import { describe, expect, it } from 'vitest';
import { cutList, cutListText } from './cutlist';
import { emptyDoc } from './defaults';
import { MATERIAL_LIBRARY } from './materialLibrary';
import { applyOps } from './ops';

describe('slab stock', () => {
  it('lists stone tops by size: no sheets, no board feet, no cost', () => {
    const quartz = MATERIAL_LIBRARY.find((m) => m.id === 'quartz-3cm')!;
    const r = applyOps(emptyDoc(), [
      { op: 'add', entity: { kind: 'material', ...structuredClone(quartz), price: 90 } },
      { op: 'add', entity: { kind: 'part', name: 'Countertop', material: 'quartz-3cm', shape: { type: 'box', params: { x: 96 * 64, y: 76, z: 25.5 * 64 } } } },
      { op: 'add', entity: { kind: 'part', name: 'Island top', material: 'quartz-3cm', transform: { position: [0, 0, 3000] }, shape: { type: 'box', params: { x: 72 * 64, y: 76, z: 36 * 64 } } } },
    ]);
    if (!r.ok) throw new Error(r.error);
    const list = cutList(r.doc);
    const slab = list.materials.find((m) => m.material.id === 'quartz-3cm')!;
    expect(slab.rows.map((row) => [row.names[0], row.length, row.width, row.thickness])).toEqual([
      ['Countertop', 96 * 64, 25.5 * 64, 76],
      ['Island top', 72 * 64, 36 * 64, 76],
    ]);
    expect([slab.sheets, slab.boardFeet, slab.cost]).toEqual([undefined, undefined, undefined]);
    expect(list.cost).toBeUndefined();
    expect(list.problems).toEqual([]);
    expect(cutListText(list)).toContain('3 cm white quartz (quartz-3cm, 1 3/16"): 2 parts, slab, 35.0 sq ft — fabricated to these sizes');
  });
});
