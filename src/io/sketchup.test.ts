import { describe, expect, it } from 'vitest';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { boxSize, union, worldBoxes } from '../model/world';
import { exportCollada, parseCollada } from './collada';
import { importSketchUp } from './sketchupImport';
import { parseXml } from './xml';

const byName = (doc: Doc, name: string) => Object.values(doc.parts).find((p) => p.name === name)!;
const roundTrip = (doc: Doc) => importSketchUp(emptyDoc(), parseCollada(exportCollada(doc)), 'Round trip');

function sample(): Doc {
  const r = applyOps(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'cab', name: 'Cabinet', transform: { position: [inches(10), 0, inches(5)], rotation: [0, 90, 0] } } },
    { op: 'add', entity: { kind: 'part', id: 'side', name: 'Side', material: 'ply-3-4', grain: 'y', shape: { type: 'box', params: { x: 46, y: inches(30), z: inches(24) } } }, parent: 'cab' },
    {
      op: 'add',
      entity: { kind: 'part', id: 'shelf', name: 'Shelf', material: 'ply-1-2', grain: 'x', transform: { position: [46, inches(10), 0], rotation: [0, 0, 0] }, shape: { type: 'box', params: { x: inches(20), y: 30, z: inches(23) } } },
      parent: 'cab',
    },
    {
      op: 'add',
      entity: {
        kind: 'part',
        id: 'notched',
        name: 'Notched side',
        material: 'ply-3-4',
        grain: 'y',
        transform: { position: [inches(40), 0, 0], rotation: [0, 0, 0] },
        shape: { type: 'outline', params: { axis: 'x', thickness: 46, points: [{ at: [0, inches(4)] }, { at: [inches(3), inches(4)] }, { at: [inches(3), 0] }, { at: [inches(24), 0] }, { at: [inches(24), inches(34)] }, { at: [0, inches(34)] }] } },
      },
    },
    { op: 'add', entity: { kind: 'block', id: 'fridge', name: 'Fridge', transform: { position: [inches(60), 0, 0], rotation: [0, 30, 0] }, size: [inches(36), inches(70), inches(30)] } },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

describe('COLLADA export', () => {
  it('writes well-formed Z-up inch COLLADA with one node per part', () => {
    const text = exportCollada(sample());
    const root = parseXml(text);
    expect(root.tag).toBe('COLLADA');
    expect(text).toContain('<up_axis>Z_UP</up_axis>');
    expect(text).toContain('meter="0.0254"');
    const scene = parseCollada(text);
    expect(scene.nodes.map((n) => n.name)).toEqual(['Cabinet', 'Notched side', 'Fridge']);
    expect(scene.nodes[0]!.children.map((n) => n.name)).toEqual(['Side', 'Shelf']);
  });

  it('maps model height to SketchUp blue (Z) and the front to −Y', () => {
    const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'part', id: 'p', name: 'P', material: 'ply-3-4', shape: { type: 'box', params: { x: 64, y: 128, z: 192 } } } }]);
    if (!r.ok) throw new Error(r.error);
    const tris = parseCollada(exportCollada(r.doc)).nodes[0]!.meshes[0]!.tris;
    const [xs, ys, zs] = [0, 1, 2].map((k) => tris.filter((_, i) => i % 3 === k));
    expect([Math.min(...xs!), Math.max(...xs!)]).toEqual([0, 1]);
    expect([Math.min(...zs!), Math.max(...zs!)]).toEqual([0, 2]);
    expect([Math.min(...ys!), Math.max(...ys!)]).toEqual([-3, 0]);
  });
});

describe('SketchUp import', () => {
  it('round-trips boxes, outlines, blocks, rotation and nesting', () => {
    const src = sample();
    const { doc, summary, wrapperId } = roundTrip(src);
    expect(summary).toMatchObject({ boxes: 2, outlines: 1, blocks: 1, simplified: 0, skipped: 0, materialsAdded: [] });
    const before = worldBoxes(src);
    const after = worldBoxes(doc);
    for (const name of ['Side', 'Shelf', 'Notched side', 'Fridge']) {
      const a = before.get(Object.values(src.parts).find((p) => p.name === name)!.id)!;
      const b = after.get(byName(doc, name).id)!;
      for (const k of [0, 1, 2]) {
        expect(Math.abs(a.min[k]! - b.min[k]!), `${name} min ${k}`).toBeLessThanOrEqual(1);
        expect(Math.abs(a.max[k]! - b.max[k]!), `${name} max ${k}`).toBeLessThanOrEqual(1);
      }
    }
    expect(byName(doc, 'Side').material).toBe('ply-3-4');
    expect(byName(doc, 'Shelf').material).toBe('ply-1-2');
    expect(byName(doc, 'Notched side').shape.type).toBe('outline');
    expect(byName(doc, 'Fridge').block).toBe(true);
    // Square parts keep exact quarter turns.
    expect(byName(doc, 'Side').transform.rotation.map((r) => ((r % 90) + 90) % 90)).toEqual([0, 0, 0]);
    const cab = Object.values(doc.assemblies).find((a) => a.name === 'Cabinet')!;
    expect(cab.children.map((id) => doc.parts[id]!.name)).toEqual(['Side', 'Shelf']);
    expect(doc.roots).toEqual([wrapperId]);
  });

  it('places an import beside an existing model, keeping its shape', () => {
    const src = sample();
    const { doc, wrapperId } = importSketchUp(src, parseCollada(exportCollada(src)));
    const boxes = worldBoxes(doc);
    const old = union(src.roots.map((id) => boxes.get(id)!));
    const added = boxes.get(wrapperId)!;
    expect(added.min[0]).toBe(old.max[0] + inches(12));
    expect([added.min[1], added.min[2]]).toEqual([old.min[1], old.min[2]]);
    expect(boxSize(added)).toEqual(boxSize(old));
  });

  it('imports the demo model, simplifying drilled parts and blocking out profiled ones', () => {
    const src = demoDoc();
    const { summary, doc } = roundTrip(src);
    expect(summary.boxes + summary.outlines + summary.blocks).toBe(Object.keys(src.parts).length);
    expect(summary.simplified).toBeGreaterThanOrEqual(2); // sides with shelf-pin holes
    expect(Object.values(doc.parts).filter((p) => !p.block).every((p) => p.material && doc.materials[p.material])).toBe(true);
  });

  it('reads SketchUp-style files: components, quads, two-sided faces, loose geometry', () => {
    const scene = parseCollada(SKETCHUP_FILE);
    const { doc, summary } = importSketchUp(emptyDoc(), scene, 'Shop');
    // Two placed component instances, two loose boards at the top level, a pyramid; the flat face is skipped.
    expect(summary).toMatchObject({ boxes: 4, outlines: 0, blocks: 1, skipped: 1 });
    expect(summary.materialsAdded).toEqual(['Walnut']);
    const legs = Object.values(doc.parts).filter((p) => p.name === 'Leg');
    expect(legs).toHaveLength(2);
    const boxes = worldBoxes(doc);
    // SketchUp (10, 20, 0) → model (10, 0, −20); a 2 × 3 × 30 leg stands 30" tall.
    const leg = boxes.get(legs[1]!.id)!;
    expect(leg.min).toEqual([inches(10), 0, inches(-23)]);
    expect(leg.max).toEqual([inches(12), inches(30), inches(-20)]);
    const walnut = Object.values(doc.materials).find((m) => m.name === 'Walnut')!;
    expect(walnut).toMatchObject({ thickness: inches(2), color: '#6b4a33' });
    expect(legs[0]!.material).toBe(walnut.id);
    // An unnamed 23/32" board picks up the model's 3/4" plywood.
    expect(Object.values(doc.parts).some((p) => p.material === 'ply-3-4')).toBe(true);
  });
});

/** Quads of an axis-aligned box from `o` with size `s` (SketchUp coordinates). */
function boxQuads(o: number[], s: number[]): number[][][] {
  const [x0, y0, z0] = o as [number, number, number];
  const [x1, y1, z1] = [x0 + s[0]!, y0 + s[1]!, z0 + s[2]!];
  return [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
}

function polylist(id: string, faces: number[][][], material: string, twoSided = false): string {
  const all = twoSided ? [...faces, ...faces.map((f) => [...f].reverse())] : faces;
  const pts = all.flat();
  return `<geometry id="${id}"><mesh><source id="${id}-p"><float_array id="${id}-a" count="${pts.length * 3}">${pts.flat().join(' ')}</float_array>
<technique_common><accessor source="#${id}-a" count="${pts.length}" stride="3"/></technique_common></source>
<vertices id="${id}-v"><input semantic="POSITION" source="#${id}-p"/></vertices>
<polylist material="${material}" count="${all.length}"><input semantic="VERTEX" source="#${id}-v" offset="0"/>
<vcount>${all.map((f) => f.length).join(' ')}</vcount><p>${pts.map((_, i) => i).join(' ')}</p></polylist></mesh></geometry>`;
}

const PYRAMID = [
  [[0, 0, 0], [10, 0, 0], [5, 5, 8]],
  [[10, 0, 0], [10, 10, 0], [5, 5, 8]],
  [[10, 10, 0], [0, 10, 0], [5, 5, 8]],
  [[0, 10, 0], [0, 0, 0], [5, 5, 8]],
  [[0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]],
].map((f) => f.map(([x, y, z]) => [x! + 100, y!, z!]));

const SKETCHUP_FILE = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit meter="0.0254" name="inch"/><up_axis>Z_UP</up_axis></asset>
<library_effects>
<effect id="walnut-fx"><profile_COMMON><technique sid="COMMON"><lambert><diffuse><color>0.4196 0.2902 0.2 1</color></diffuse></lambert></technique></profile_COMMON></effect>
<effect id="default-fx"><profile_COMMON><technique sid="COMMON"><lambert><diffuse><color>1 1 1 1</color></diffuse></lambert></technique></profile_COMMON></effect>
</library_effects>
<library_materials>
<material id="walnutID" name="Walnut"><instance_effect url="#walnut-fx"/></material>
<material id="defaultID" name="material"><instance_effect url="#default-fx"/></material>
</library_materials>
<library_geometries>
${polylist('legGeo', boxQuads([0, 0, 0], [2, 3, 30]), 'Mat1', true)}
${polylist('looseGeo', [...boxQuads([0, 50, 0], [23 / 32, 20, 30]), ...boxQuads([5, 50, 0], [23 / 32, 20, 30]), [[0, 90, 0], [10, 90, 0], [10, 95, 0], [0, 95, 0]]], 'Mat2')}
${polylist('pyrGeo', PYRAMID, 'Mat2')}
</library_geometries>
<library_nodes>
<node id="legDef" name="Leg"><instance_geometry url="#legGeo"><bind_material><technique_common><instance_material symbol="Mat1" target="#walnutID"/></technique_common></bind_material></instance_geometry></node>
</library_nodes>
<library_visual_scenes><visual_scene id="scene">
<node name="SketchUp">
<instance_geometry url="#looseGeo"><bind_material><technique_common><instance_material symbol="Mat2" target="#defaultID"/></technique_common></bind_material></instance_geometry>
<node id="i1" name="instance_0"><matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix><instance_node url="#legDef"/></node>
<node id="i2" name="instance_1"><matrix>1 0 0 10 0 1 0 20 0 0 1 0 0 0 0 1</matrix><instance_node url="#legDef"/></node>
<node id="g1" name="Pyramid"><instance_geometry url="#pyrGeo"><bind_material><technique_common><instance_material symbol="Mat2" target="#defaultID"/></technique_common></bind_material></instance_geometry></node>
</node>
</visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`;
