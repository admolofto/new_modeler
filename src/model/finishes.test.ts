import { describe, expect, it } from 'vitest';
import { emptyDoc } from './defaults';
import { FINISHES, finishDef, finishDocs, finishError, finishOf, inferFinish, swatchOf } from './finishes';
import { MATERIAL_LIBRARY } from './materialLibrary';
import { applyOps } from './ops';

describe('finish vocabulary', () => {
  it('has the v1 presets, each once, with a swatch', () => {
    const ids = FINISHES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['wood:white-oak', 'paint', 'lacquer', 'stone:quartz-white', 'tile:subway', 'floor:oak-plank', 'metal:brushed-nickel', 'glass:frosted', 'fabric:wool', 'ceramic', 'plant', 'light']));
    expect(ids).toHaveLength(32);
    for (const f of FINISHES) expect(f.swatch).toMatch(/^#[0-9a-f]{6}$/);
    expect(finishDocs()).toContain('wood:walnut');
  });

  it('infers a finish for every library material that matches the one it ships with', () => {
    for (const m of MATERIAL_LIBRARY) {
      expect(m.finish, m.id).toBeDefined();
      expect(inferFinish(m).preset, m.id).toBe(m.finish!.preset);
    }
  });

  it('infers from the name, then falls back by stock', () => {
    const m = (name: string, stock: 'sheet' | 'solid' | 'slab' = 'sheet') => inferFinish({ id: 'm1', name, color: '#123456', stock });
    expect(m('Walnut plywood').preset).toBe('wood:walnut');
    expect(m('4/4 white oak', 'solid').preset).toBe('wood:white-oak');
    expect(m('Rift oak', 'solid').preset).toBe('wood:red-oak');
    expect(m('Poplar', 'solid').preset).toBe('wood:maple');
    expect(m('3/4" MDF')).toEqual({ preset: 'paint', color: '#123456' });
    expect(m('Laminate')).toEqual({ preset: 'melamine', color: '#123456' });
    expect(m('Granite', 'slab').preset).toBe('stone:granite-black');
    expect(m('Mystery board').preset).toBe('wood:birch-ply');
    expect(m('Mystery board', 'solid').preset).toBe('wood:maple');
    expect(m('Mystery top', 'slab').preset).toBe('stone:quartz-white');
    expect(finishOf({ ...MATERIAL_LIBRARY[0]!, finish: { preset: 'paint', color: '#000000' } })).toEqual({ preset: 'paint', color: '#000000' });
  });

  it('draws paint in its color, stains over the wood, and stone and metal as they are', () => {
    expect(swatchOf({ preset: 'paint', color: '#1F2A44' })).toBe('#1f2a44');
    expect(swatchOf({ preset: 'paint' })).toBe(finishDef('paint')!.swatch);
    expect(swatchOf({ preset: 'wood:maple' })).toBe('#ecd9b0');
    // Maple × a brown stain: darker, browner.
    expect(swatchOf({ preset: 'wood:maple', color: '#8b5a2b' })).toBe('#814d1e');
    expect(swatchOf({ preset: 'stone:granite-black', color: '#ff0000' })).toBe('#2a2a2b');
  });

  it('validates presets against the vocabulary', () => {
    expect(finishError({ preset: 'wood:walnut' })).toBeNull();
    expect(finishError({ preset: 'wood:zebrawood' })).toMatch(/unknown finish preset "wood:zebrawood"/);
    const r = applyOps(emptyDoc(), [{ op: 'update', id: 'ply-3-4', patch: { finish: { preset: 'wood:zebrawood' } } }]);
    expect(r.ok ? '' : r.error).toMatch(/material "3\/4" plywood": unknown finish preset "wood:zebrawood"/);
    const shape = applyOps(emptyDoc(), [{ op: 'update', id: 'ply-3-4', patch: { finish: { preset: 'Walnut!' } } }]);
    expect(shape.ok ? '' : shape.error).toMatch(/finish preset looks like/);
  });
});
