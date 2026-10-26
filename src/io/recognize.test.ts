import { describe, expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import type { Doc, Part } from '../model/schema';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import type { WallPieceParams } from '../plugins/generators/wall';
import { buildPart } from '../plugins/pipeline';
import { shapes } from '../plugins/registry';
import type { ColladaNode, ColladaScene } from './collada';
import { outlineGaps } from './recognizeWalls';
import { importSketchUp } from './sketchupImport';

const I = inches;
type P = [number, number, number];

/** A node holding a part's triangles, moved to `at` (model units, Y up). */
function node(name: string, part: Omit<Part, 'id' | 'name' | 'grain' | 'transform' | 'features'>, at: P = [0, 0, 0], children: ColladaNode[] = []): ColladaNode {
  const mesh = buildPart({ id: 'x', name, grain: 'none', transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, features: [], ...part }).mesh;
  const tris: number[] = [];
  for (const i of mesh.indices) tris.push(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
  return { name, matrix: [1, 0, 0, at[0], 0, 1, 0, at[1], 0, 0, 1, at[2], 0, 0, 0, 1], meshes: [{ tris, material: null }], children };
}
const box = (name: string, size: P, at: P) => node(name, { material: 'ply-3-4', shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } } }, at);
/** A wall board along x, `t` deep along z, with holes cut through it. */
const wallBoard = (name: string, length: number, t: number, at: P, holes: { x: number; y: number; w: number; h: number }[] = []) =>
  node(name, { shape: { type: 'wall', params: shapes.parse('wall', { x: length, y: I(96), z: t, openings: holes.map((h, i) => ({ id: `h${i}`, ...h })) }) } }, at);
/** A flat rectangle in the plane z = `z`, from (x0, y0) to (x1, y1). */
function rect(name: string, x0: number, y0: number, x1: number, y1: number, z: number): ColladaNode {
  const q = (x: number, y: number) => [x, y, z];
  return { name, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], meshes: [{ tris: [...q(x0, y0), ...q(x1, y0), ...q(x1, y1), ...q(x0, y0), ...q(x1, y1), ...q(x0, y1)], material: null }], children: [] };
}
/** Model units, Y up: what the importer works in. */
const scene = (nodes: ColladaNode[]): ColladaScene => ({ inches: 1 / 64, up: 'Y', nodes });

const walls = (doc: Doc) =>
  Object.values(doc.assemblies)
    .filter((a) => a.generator?.type === 'wall')
    .map((a) => ({ asm: a, p: a.generator!.params as unknown as WallPieceParams, box: worldBoxes(doc).get(`${a.id}.wall`)! }));

describe('recognizing walls in a SketchUp import', () => {
  it('finds openings in a face outline: holes and notches up from the bottom, not ones from the top or at an end', () => {
    const outer = [[0, 0], [100, 0], [100, 50], [0, 50]] as [number, number][];
    const hole = [[10, 20], [30, 20], [30, 40], [10, 40]] as [number, number][];
    expect(outlineGaps([outer, hole], 100, 50)).toEqual([{ u0: 10, u1: 30, v0: 20, v1: 40 }]);
    // A doorway notched up from the floor.
    const notched = [[0, 0], [40, 0], [40, 30], [60, 30], [60, 0], [100, 0], [100, 50], [0, 50]] as [number, number][];
    expect(outlineGaps([notched], 100, 50)).toEqual([{ u0: 40, u1: 60, v0: 0, v1: 30 }]);
    // Notches from the top or at an end aren't openings.
    const top = [[0, 0], [100, 0], [100, 50], [60, 50], [60, 40], [40, 40], [40, 50], [0, 50]] as [number, number][];
    expect(outlineGaps([top], 100, 50)).toEqual([]);
    const end = [[0, 0], [90, 0], [90, 30], [100, 30], [100, 50], [0, 50]] as [number, number][];
    expect(outlineGaps([end], 100, 50)).toEqual([]);
  });

  it('turns wall boards into wall pieces, with their cut holes and the outlines drawn on them as openings', () => {
    const T = I(4);
    const s = scene([
      // An exterior wall along x (front z = T), a window cut through it.
      wallBoard('Component#1', I(144), T, [0, 0, 0], [{ x: I(20), y: I(36), w: I(30), h: I(40) }]),
      // A door's casing and leaf drawn on its room face, one inside the other.
      rect('Component#2', I(80), 0, I(120), I(84), T),
      rect('Component#3', I(86), 0, I(114), I(80), T),
      // A full-height patch of paint is no opening.
      rect('paint', I(0), 0, I(60), I(96), T),
      // A wall across the room from it: its room side faces the first one's.
      box('Component#4', [I(144), I(96), I(6)], [0, 0, I(120)]),
      // Not walls: a 2"-thick tall panel, a 48"-tall bench back, a cabinet.
      box('frameside', [I(2), I(88), I(21)], [I(40), 0, I(20)]),
      box('bench back', [I(52), I(48), I(10)], [I(60), 0, I(20)]),
      box('cabinet', [I(30), I(34), I(24)], [I(100), 0, I(96)]),
    ]);
    const { doc, summary } = importSketchUp(emptyDoc(), s, 'House', { recognize: true });
    expect(summary.recognized).toEqual({ walls: 2, openings: 2 });
    const [a, b] = walls(doc).sort((x, y) => x.box.min[2] - y.box.min[2]);
    // The first faces +z (toward the other wall); the window from its hole, the door from the inner outline.
    expect(a!.asm.transform.rotation).toEqual([0, 0, 0]);
    expect(a!.p).toMatchObject({ length: I(144), height: I(96), thickness: T });
    expect(a!.p.openings).toEqual([
      expect.objectContaining({ id: 'w1', kind: 'window', at: I(35), width: I(30), height: I(40), sill: I(36) }),
      expect.objectContaining({ id: 'd1', kind: 'door', at: I(100), width: I(28), height: I(80) }),
    ]);
    expect(a!.box.min).toEqual([0, 0, 0]);
    // The second, turned half round, faces −z; it runs from x 144" back to 0.
    expect(b!.asm.transform.rotation[1]).toBe(180);
    expect(b!.p).toMatchObject({ length: I(144), thickness: I(6), openings: [] });
    expect(b!.box.min).toEqual([0, 0, I(120)]);
    expect(b!.box.max).toEqual([I(144), I(96), I(126)]);
    // Both in a Walls folder; the boards that stayed boards are imported as before.
    const folder = Object.values(doc.assemblies).find((x) => x.name === 'Walls')!;
    expect(folder.children).toHaveLength(2);
    expect(Object.values(doc.parts).filter((p) => !p.role).map((p) => p.name).sort()).toEqual(['bench back', 'cabinet', 'frameside']);
  });

  it('takes the room side from what stands in front of an inside wall', () => {
    const s = scene([
      // Three outside walls round a room, and one wall inside it with a cabinet on its −z side.
      box('Component#1', [I(200), I(96), I(6)], [0, 0, 0]),
      box('Component#2', [I(200), I(96), I(6)], [0, 0, I(200)]),
      box('Component#3', [I(6), I(96), I(194)], [0, 0, I(6)]),
      box('Component#4', [I(100), I(96), I(4)], [I(6), 0, I(100)]),
      box('cabinet', [I(30), I(34), I(24)], [I(20), 0, I(76)]),
    ]);
    const { doc } = importSketchUp(emptyDoc(), s, 'House', { recognize: true });
    const inner = walls(doc).find((w) => w.p.thickness === I(4))!;
    expect(inner.asm.transform.rotation[1]).toBe(180);
    // The side wall's room is to its +x.
    const side = walls(doc).find((w) => w.p.length === I(194))!;
    expect(side.asm.transform.rotation[1]).toBe(90);
  });

  it('leaves the import alone without being asked', () => {
    const s = scene([box('Component#1', [I(144), I(96), I(4)], [0, 0, 0]), rect('Component#2', I(86), 0, I(114), I(80), I(4))]);
    const { doc, summary } = importSketchUp(emptyDoc(), s, 'House');
    expect(summary.recognized).toBeUndefined();
    expect(walls(doc)).toEqual([]);
    expect(summary).toMatchObject({ boxes: 1, skipped: 1 });
  });
});
