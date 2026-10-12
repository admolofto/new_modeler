import { describe, expect, it } from 'vitest';
import '../plugins/testDecor';
import { buildPart } from '../plugins/pipeline';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { BLOCK_CLAY, BLOCK_CLAY_FRONT, editorColors, effectiveFinish, partLook, sceneLights } from './look';
import { applyOps, type Op } from './ops';
import type { Doc } from './schema';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** A plywood carcass with a drawer, a loose shelf in a folder, and a part of a material with no finish of its own. */
function shop(): Doc {
  return ok(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [384], shelves: 0 } } } },
    { op: 'add', entity: { kind: 'material', id: 'oak', name: '4/4 white oak', thickness: 48, color: '#c9a878', stock: 'solid' } },
    { op: 'add', entity: { kind: 'assembly', id: 'shelves', name: 'Shelves', transform: { position: [0, 0, 3000] } } },
    { op: 'add', parent: 'shelves', entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'oak', grain: 'x', shape: { type: 'box', params: { x: 1280, y: 48, z: 640 } } } },
  ]);
}

describe('effectiveFinish', () => {
  it('goes part, nearest folder, material; explicit only when someone set it', () => {
    let d = shop();
    // The library's plywood ships with a finish; a material added without one is inferred.
    expect(effectiveFinish(d, 'a1.side-left')).toEqual({ finish: { preset: 'wood:birch-ply' }, explicit: true, node: false });
    expect(effectiveFinish(d, 'shelf')).toEqual({ finish: { preset: 'wood:white-oak' }, explicit: false, node: false });
    d = ok(d, [{ op: 'update', id: 'shelves', patch: { finish: { preset: 'paint', color: '#ffffff' } } }]);
    expect(effectiveFinish(d, 'shelf')).toEqual({ finish: { preset: 'paint', color: '#ffffff' }, explicit: true, node: true });
    d = ok(d, [{ op: 'update', id: 'shelf', patch: { finish: { preset: 'wood:walnut' } } }]);
    expect(effectiveFinish(d, 'shelf').finish).toEqual({ preset: 'wood:walnut' });
    d = ok(d, [{ op: 'update', id: 'shelf', patch: { finish: null } }, { op: 'update', id: 'shelves', patch: { finish: null } }]);
    expect(effectiveFinish(d, 'shelf')).toEqual({ finish: { preset: 'wood:white-oak' }, explicit: false, node: false });
  });

  it('keeps library materials in their own colors in the editor; a new material finish brings its swatch', () => {
    let d = shop();
    const side = d.parts['a1.side-left']!;
    const color = d.materials[side.material!]!.color;
    expect(editorColors(d, side, partLook(d, side, []))).toEqual([color]);
    d = ok(d, [{ op: 'update', id: side.material!, patch: { finish: { preset: 'paint', color: '#1f2a44' } } }]);
    expect(d.materials[side.material!]!.color).toBe('#1f2a44');
    expect(editorColors(d, d.parts['a1.side-left']!, partLook(d, d.parts['a1.side-left']!, []))).toEqual(['#1f2a44']);
    // A color sent with the finish wins.
    d = ok(d, [{ op: 'update', id: side.material!, patch: { finish: { preset: 'wood:walnut' }, color: '#123456' } }]);
    expect(d.materials[side.material!]!.color).toBe('#123456');
  });

  it('inherits through a cabinet and its generated folders, and keeps overrides through a regenerate', () => {
    let d = ok(shop(), [
      { op: 'update', id: 'a1', patch: { finish: { preset: 'paint', color: '#1f2a44' } } },
      { op: 'update', id: 'a1.drawer-1', patch: { finish: { preset: 'wood:walnut' } } },
      { op: 'update', id: 'a1.top', patch: { finish: { preset: 'lacquer', color: '#ffffff' } } },
    ]);
    d = ok(d, [{ op: 'update', id: 'a1', patch: { params: { width: 30 * 64 } } }]);
    expect(effectiveFinish(d, 'a1.side-left').finish).toEqual({ preset: 'paint', color: '#1f2a44' });
    expect(effectiveFinish(d, 'a1.drawer-1-front').finish).toEqual({ preset: 'wood:walnut' });
    expect(effectiveFinish(d, 'a1.top').finish).toEqual({ preset: 'lacquer', color: '#ffffff' });
    expect(d.assemblies.a1!.generator!.overrides).toEqual({ 'drawer-1': { finish: { preset: 'wood:walnut' } }, top: { finish: { preset: 'lacquer', color: '#ffffff' } } });
  });
});

describe('partLook', () => {
  const tags = ['face:left', 'face:right', 'face:bottom', 'face:top', 'face:back', 'face:front', 'f1:wall'];

  it('finds each tag\'s surface: exact tag, then the longest prefix, then the base', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'decor', shape: { type: 'testStool', params: { x: 960, y: 1920, z: 960 } } } }]);
    const look = partLook(d, d.parts.p1!, tags);
    expect(look.kind).toBe('decor');
    expect(look.explicit).toBe(true);
    expect(look.slots.map((s) => s.finish.preset)).toEqual(['metal:matte-black', 'metal:brass', 'fabric:leather', 'glass:clear']);
    const preset = (tag: string) => look.slots[look.tagSlots[tags.indexOf(tag)]!]!.finish.preset;
    expect(preset('face:top')).toBe('fabric:leather'); // exact
    expect(preset('face:front')).toBe('glass:clear'); // longest prefix (face:fr over face:)
    expect(preset('face:back')).toBe('metal:brass'); // prefix
    expect(preset('f1:wall')).toBe('metal:matte-black'); // base
    expect(editorColors(d, d.parts.p1!, look)).toEqual(['#2b2b2c', '#c9a55c', '#7a4e32', '#dfeef0']);
  });

  it('draws stock parts in one slot: the material\'s color unless a finish was set', () => {
    const d = ok(shop(), [{ op: 'update', id: 'a1.top', patch: { finish: { preset: 'paint', color: '#1f2a44' } } }]);
    const shelf = partLook(d, d.parts.shelf!, buildPart(d.parts.shelf!).mesh.tags);
    expect(shelf).toMatchObject({ kind: 'stock', explicit: false, node: false, slots: [{ finish: { preset: 'wood:white-oak' } }] });
    expect(new Set(shelf.tagSlots)).toEqual(new Set([0]));
    expect(editorColors(d, d.parts.shelf!, shelf)).toEqual(['#c9a878']);
    expect(editorColors(d, d.parts['a1.top']!, partLook(d, d.parts['a1.top']!, []))).toEqual(['#1f2a44']);
  });

  it('draws blocks in clay with a lighter front', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'block', size: [640, 640, 640] } }]);
    const look = partLook(d, d.parts.b1!, tags);
    expect(look.kind).toBe('block');
    expect(look.tagSlots).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(editorColors(d, d.parts.b1!, look)).toEqual([BLOCK_CLAY, BLOCK_CLAY_FRONT]);
  });
});

describe('sceneLights', () => {
  it('puts fixtures\' lights in world space, and none for hidden ones', () => {
    let d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'island', name: 'Island', transform: { position: [1000, 2000, 0], rotation: [0, 90, 0] } } },
      { op: 'add', parent: 'island', entity: { kind: 'decor', id: 'lamp', shape: { type: 'testLamp', params: { x: 640, y: 320, z: 640 } } } },
    ]);
    expect(sceneLights(emptyDoc())).toEqual([]);
    const [light] = sceneLights(d);
    expect(light!.part).toBe('lamp');
    // (320, 320, 320) turned a quarter about y lands at (320, 320, −320), then the island's offset.
    expect(light!.at.map(Math.round)).toEqual([1320, 2320, -320]);
    expect(light!.dir!.map((v) => Math.round(v))).toEqual([0, -1, 0]);
    expect(light!.spec).toMatchObject({ kind: 'spot', lumens: 800, kelvin: 2700 });
    d = ok(d, [{ op: 'update', id: 'island', patch: { hidden: true } }]);
    expect(sceneLights(d)).toEqual([]);
  });
});
