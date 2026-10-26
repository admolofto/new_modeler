import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import type { CarcassParams } from '../plugins/generators/carcass';
import type { ColladaMaterial, ColladaNode, ColladaScene } from './collada';
import { namedRole } from './recognizeCasework';
import { importSketchUp } from './sketchupImport';

const I = inches;
type P = [number, number, number];

const CASE: ColladaMaterial = { name: 'CB 3/4 finished', color: '#d9b98b' };
const RIFT: ColladaMaterial = { name: 'CB 1/2 rift', color: '#e2c79a' };
const FACE: ColladaMaterial = { name: 'CB 3/4 face', color: '#f2f0ea' };

/** A box from `min` to `max` (inches, model frame: Y up, front +Z), its own node. */
function board(name: string, min: P, max: P, material: ColladaMaterial | null = CASE): ColladaNode {
  const [x0, y0, z0] = min.map(I) as P;
  const [x1, y1, z1] = max.map(I) as P;
  const q = (a: P, b: P, c: P, d: P) => [...a, ...b, ...c, ...a, ...c, ...d];
  const tris = [
    ...q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    ...q([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]),
    ...q([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]),
    ...q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    ...q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]),
    ...q([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]),
  ];
  return { name, matrix: IDENT, meshes: [{ tris, material }], children: [] };
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A group turned `deg` about +Y and moved to `at` (inches). */
function group(name: string, children: ColladaNode[], deg = 0, at: P = [0, 0, 0]): ColladaNode {
  const a = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return { name, matrix: [c, 0, s, I(at[0]), 0, 1, 0, I(at[1]), -s, 0, c, I(at[2]), 0, 0, 0, 1], meshes: [], children };
}
const scene = (nodes: ColladaNode[]): ColladaScene => ({ inches: 1 / 64, up: 'Y', nodes });

/**
 * A 28" × 34" × 23" drawer base as cabinet extensions draw it: sides on the bottom, an applied back,
 * a 4" riser flush with the fronts, two drawers (an 11 3/8" one over an 18 5/16" one) with boxes.
 */
function drawerBank(name: string, deg = 0, at: P = [0, 0, 0]): ColladaNode {
  const drawer = (n: number, y0: number, y1: number) =>
    group(`${name}_drawer_${n}`, [
      board(`${name}_drawer_${n}_drawer_face`, [0.0625, y0, 23], [27.9375, y1, 23.75], FACE),
      group(`${name}_drawer_${n}_drawer_box`, [
        board(`${name}_drawer_${n}_drawer_box_left`, [1.25, y0 + 1, 1.5], [1.75, y1 - 1, 22.5], RIFT),
        board(`${name}_drawer_${n}_drawer_box_right`, [26.25, y0 + 1, 1.5], [26.75, y1 - 1, 22.5], RIFT),
        board(`${name}_drawer_${n}_drawer_box_bottom`, [1.75, y0 + 1, 2], [26.25, y0 + 1.5, 22], RIFT),
      ]),
    ]);
  return group(
    name,
    [
      board(`${name}_left_side`, [0, 4.75, 0.75], [0.75, 33.25, 23]),
      board(`${name}_right_side`, [27.25, 4.75, 0.75], [28, 33.25, 23]),
      board(`${name}_bottom`, [0, 4, 0.75], [28, 4.75, 23]),
      board(`${name}_top`, [0, 33.25, 0.75], [28, 34, 23]),
      board(`${name}_back`, [0, 4, 0], [28, 34, 0.75], RIFT),
      group(`${name}_riser`, [board(`${name}_riser_face`, [0.0625, 0, 23], [27.9375, 4, 23.75], FACE), board(`${name}_riser_back`, [0, 0, 0], [28, 3.25, 0.75])]),
      drawer(1, 4.0625, 15.4375),
      drawer(2, 15.5625, 33.9375),
    ],
    deg,
    at,
  );
}

const cabinets = (doc: Doc) =>
  Object.values(doc.assemblies)
    .filter((a) => a.generator?.type === 'carcass')
    .map((a) => ({ asm: a, p: a.generator!.params as unknown as CarcassParams }));

describe('recognizing casework in a SketchUp import', () => {
  it('reads boards by the names cabinet extensions give them', () => {
    expect(namedRole('_left_side')).toBe('side');
    expect(namedRole('_top')).toBe('top');
    expect(namedRole('_top_shelf')).toBe('shelf');
    expect(namedRole('_back')).toBe('back');
    expect(namedRole('_riser/_riser_face')).toBe('kick');
    expect(namedRole('_door_1_lh')).toBe('door');
    expect(namedRole('_drawer_2/_drawer_2_drawer_face')).toBe('drawerFront');
    expect(namedRole('_drawer_2/_drawer_2_drawer_box/_drawer_2_drawer_box_front')).toBe('drawerBox');
    expect(namedRole('_hanging_rod')).toBe('extra');
    expect(namedRole('Component#5')).toBeNull();
  });

  it('makes a cabinet group a carcass: its box, applied back, riser as a toe kick, drawers top-down, materials', () => {
    const { doc, summary } = importSketchUp(emptyDoc(), scene([drawerBank('drawer_bank_9')]), 'Kitchen', { recognize: true });
    expect(summary.recognized).toMatchObject({ cabinets: 1, counters: 0 });
    const [c] = cabinets(doc);
    expect(c!.asm.name).toBe('drawer_bank_9');
    expect(c!.p).toMatchObject({ width: I(28), height: I(34), depth: I(23), back: 'applied', toeKick: { height: I(4), depth: 0 }, shelves: 0, drawers: [I(18.375), 0], doors: 0 });
    const name = (id: string | undefined) => doc.materials[id!]!.name;
    // The back and the drawer boxes share a name at two thicknesses: two materials.
    expect([name(c!.p.material), name(c!.p.backMaterial), name(c!.p.frontMaterial), name(c!.p.drawerMaterial)]).toEqual(['CB 3/4 finished', 'CB 1/2 rift', 'CB 3/4 face', 'CB 1/2 rift 1/2"']);
    // It stands where the boards were, its drawers out front.
    const box = worldBoxes(doc).get(c!.asm.id)!;
    expect(box.min).toEqual([0, 0, 0]);
    expect(box.max[0]).toBe(I(28));
    expect(box.max[1]).toBe(I(34));
    // The raw boards are gone; the generator made its own.
    expect(Object.values(doc.parts).every((p) => p.role !== undefined)).toBe(true);
  });

  it('follows a turned cabinet: its front where its drawers face', () => {
    const { doc } = importSketchUp(emptyDoc(), scene([drawerBank('drawer_bank_1', 90, [10, 0, 50])]), 'Mudroom', { recognize: true });
    const [c] = cabinets(doc);
    expect(c!.asm.transform.rotation[1]).toBeCloseTo(90);
    expect(c!.p).toMatchObject({ width: I(28), depth: I(23), drawers: [I(18.375), 0] });
    // Its fronts face +x now.
    const front = worldBoxes(doc).get(`${c!.asm.id}.drawer-1-front`)!;
    expect(front.min[0]).toBeGreaterThan(I(10) + I(22));
  });

  it('counts doors drawn swung open, hinged as their names say, and keeps a closet rod in the cabinet', () => {
    const name = 'closet_2';
    const door = group(`${name}_door_1_rh`, [board(`${name}_door_1_rh_panel`, [0, 0, 0], [23.875, 72.25, 0.75], FACE)], -80, [23.9375, 18, 23]);
    const closet = group(name, [
      board(`${name}_left_side`, [0, 18.75, 0.75], [0.75, 89.75, 20]),
      board(`${name}_right_side`, [23.25, 18.75, 0.75], [24, 89.75, 20]),
      board(`${name}_bottom`, [0, 18, 0.75], [24, 18.75, 20]),
      board(`${name}_top`, [0, 89.75, 0.75], [24, 90.5, 20]),
      board(`${name}_back`, [0, 18, 0], [24, 90.5, 0.75], RIFT),
      board(`${name}_hanging_rod`, [11.5, 83.5, 2], [12.75, 84.75, 19], { name: 'CB Chrome' }),
      door,
    ]);
    const { doc } = importSketchUp(emptyDoc(), scene([closet]), 'Mudroom', { recognize: true });
    const [c] = cabinets(doc);
    expect(c!.p).toMatchObject({ width: I(24), height: I(72.5), depth: I(20), doors: 1, doorHinge: 'right', toeKick: null, drawers: [] });
    // Hanging 18" up, on what's under it.
    expect(worldBoxes(doc).get(c!.asm.id)!.min[1]).toBe(I(18));
    const rod = Object.values(doc.parts).find((p) => p.name === `${name}_hanging_rod`)!;
    expect(c!.asm.children).toContain(rod.id);
  });

  it('makes a slab at counter height lying on cabinets a countertop cut from slab stock', () => {
    const top = board('Component#80', [0, 34, -0.5], [56, 36, 24.5], null);
    const shelf = board('Component#98', [10, 36, 2], [40, 37, 20], null);
    const { doc, summary } = importSketchUp(emptyDoc(), scene([drawerBank('drawer_bank_6'), drawerBank('drawer_bank_7', 0, [28, 0, 0]), top, shelf]), 'Kitchen', { recognize: true });
    expect(summary.recognized).toMatchObject({ cabinets: 2, counters: 1 });
    const counter = Object.values(doc.parts).find((p) => p.name === 'Countertop')!;
    expect(doc.materials[counter.material!]).toMatchObject({ stock: 'slab', thickness: I(2), finish: { preset: 'stone:quartz-white' } });
    // A slab on the counter isn't one.
    const boxes = worldBoxes(doc);
    expect(Object.values(doc.parts).some((p) => p.role === undefined && p.name !== 'Countertop' && boxes.get(p.id)!.min[1] === I(36))).toBe(true);
    const folder = Object.values(doc.assemblies).find((a) => a.name === 'Cabinets')!;
    expect(folder.children).toHaveLength(3);
  });

  it('knows an unnamed box of boards by its shape, and leaves a table alone', () => {
    const box = group('Group#1', [
      board('Component#1', [0, 0, 0.75], [0.75, 30, 12]),
      board('Component#2', [17.25, 0, 0.75], [18, 30, 12]),
      board('Component#3', [0.75, 0, 0.75], [17.25, 0.75, 12]),
      board('Component#4', [0.75, 29.25, 0.75], [17.25, 30, 12]),
      board('Component#5', [0, 0, 0], [18, 30, 0.75]),
      board('Component#6', [0.75, 14.625, 0.75], [17.25, 15.375, 11.5]),
      board('Component#7', [0, 0, 12], [18, 30, 12.75], FACE),
    ], 0, [0, 54, 0]);
    const table = group('Table', [
      board('Component#8', [0, 29, 0], [48, 30.5, 30]),
      ...[[0, 0], [46, 0], [0, 28], [46, 28]].map(([x, z], i) => board(`Component#${9 + i}`, [x!, 0, z!], [x! + 2, 29, z! + 2])),
    ], 0, [60, 0, 0]);
    const { doc } = importSketchUp(emptyDoc(), scene([box, table]), 'Shop', { recognize: true });
    const [c] = cabinets(doc);
    expect(c!.asm.name).toBe('Wall cabinet 18"');
    expect(c!.p).toMatchObject({ width: I(18), height: I(30), depth: I(12), back: 'applied', shelves: 1, doors: 1, toeKick: null });
    expect(cabinets(doc)).toHaveLength(1);
    expect(Object.values(doc.assemblies).some((a) => a.name === 'Table' && !a.generator)).toBe(true);
  });
});
