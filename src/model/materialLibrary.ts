import type { Material } from './schema';
import { inches } from './units';

/**
 * Common shop materials at their *actual* thickness (nominal 3/4" plywood is 23/32"), ready to add
 * to a model, each with the finish it looks like. Sheet sizes: 4' × 8' unless noted (Baltic birch
 * comes 5' × 5'). Metric sheet goods and slabs round to the nearest 1/64".
 */
const mm = (n: number) => inches(n / 25.4);
const BALTIC: [number, number] = [inches(60), inches(60)];

export const MATERIAL_LIBRARY: Material[] = [
  { id: 'ply-3-4', name: '3/4" plywood', thickness: 46, color: '#d9b98b', stock: 'sheet', finish: { preset: 'wood:birch-ply' } },
  { id: 'ply-5-8', name: '5/8" plywood', thickness: 38, color: '#dbbc8f', stock: 'sheet', finish: { preset: 'wood:birch-ply' } },
  { id: 'ply-1-2', name: '1/2" plywood', thickness: 30, color: '#dcc095', stock: 'sheet', finish: { preset: 'wood:birch-ply' } },
  { id: 'ply-1-4', name: '1/4" plywood', thickness: 14, color: '#e6cfa6', stock: 'sheet', finish: { preset: 'wood:birch-ply' } },
  { id: 'baltic-18', name: '18mm Baltic birch', thickness: mm(18), color: '#e8d3ad', stock: 'sheet', sheet: BALTIC, finish: { preset: 'wood:birch-ply' } },
  { id: 'baltic-12', name: '12mm Baltic birch', thickness: mm(12), color: '#ead6b2', stock: 'sheet', sheet: BALTIC, finish: { preset: 'wood:birch-ply' } },
  { id: 'baltic-6', name: '6mm Baltic birch', thickness: mm(6), color: '#ecd9b7', stock: 'sheet', sheet: BALTIC, finish: { preset: 'wood:birch-ply' } },
  { id: 'mdf-3-4', name: '3/4" MDF', thickness: 48, color: '#b9a07e', stock: 'sheet', finish: { preset: 'paint', color: '#b9a07e' } },
  { id: 'mdf-1-2', name: '1/2" MDF', thickness: 32, color: '#bca483', stock: 'sheet', finish: { preset: 'paint', color: '#bca483' } },
  { id: 'melamine-3-4', name: '3/4" white melamine', thickness: 48, color: '#ecebe6', stock: 'sheet', finish: { preset: 'melamine', color: '#ecebe6' } },
  { id: 'hardboard-1-8', name: '1/8" hardboard', thickness: 8, color: '#8a6a4a', stock: 'sheet', finish: { preset: 'paint', color: '#8a6a4a' } },
  { id: 'maple-4-4', name: '4/4 maple (S4S 3/4")', thickness: 48, color: '#ecd9b0', stock: 'solid', finish: { preset: 'wood:maple' } },
  { id: 'maple-8-4', name: '8/4 maple (S4S 1 3/4")', thickness: 112, color: '#ecd9b0', stock: 'solid', finish: { preset: 'wood:maple' } },
  { id: 'red-oak-4-4', name: '4/4 red oak (S4S 3/4")', thickness: 48, color: '#d4a373', stock: 'solid', finish: { preset: 'wood:red-oak' } },
  { id: 'white-oak-4-4', name: '4/4 white oak (S4S 3/4")', thickness: 48, color: '#c9a878', stock: 'solid', finish: { preset: 'wood:white-oak' } },
  { id: 'walnut-4-4', name: '4/4 walnut (S4S 3/4")', thickness: 48, color: '#6b4a33', stock: 'solid', finish: { preset: 'wood:walnut' } },
  { id: 'walnut-8-4', name: '8/4 walnut (S4S 1 3/4")', thickness: 112, color: '#6b4a33', stock: 'solid', finish: { preset: 'wood:walnut' } },
  { id: 'cherry-4-4', name: '4/4 cherry (S4S 3/4")', thickness: 48, color: '#b76e4b', stock: 'solid', finish: { preset: 'wood:cherry' } },
  { id: 'poplar-4-4', name: '4/4 poplar (S4S 3/4")', thickness: 48, color: '#d9d3a0', stock: 'solid', finish: { preset: 'wood:maple' } },
  { id: 'pine-1x', name: '1× pine board (3/4")', thickness: 48, color: '#e8cf9a', stock: 'solid', nominal: 64, finish: { preset: 'wood:maple' } },
  { id: 'pine-2x', name: '2× construction lumber (1 1/2")', thickness: 96, color: '#e3c78e', stock: 'solid', nominal: 128, finish: { preset: 'wood:maple' } },
  { id: 'butcher-block-6-4', name: '6/4 maple butcher block (1 1/2")', thickness: 96, color: '#e6cf9f', stock: 'solid', finish: { preset: 'wood:maple' } },
  // Countertop slabs: fabricated to size, so the cut list lists their sizes (no sheets, no board feet).
  { id: 'quartz-3cm', name: '3 cm white quartz', thickness: 76, color: '#eeece8', stock: 'slab', finish: { preset: 'stone:quartz-white' } },
  { id: 'granite-3cm', name: '3 cm black granite', thickness: 76, color: '#2a2a2b', stock: 'slab', finish: { preset: 'stone:granite-black' } },
  { id: 'marble-2cm', name: '2 cm white marble', thickness: 51, color: '#e9e7e3', stock: 'slab', finish: { preset: 'stone:marble-white' } },
];

/** One line per library material for the AI prompt: `ply-3-4 = 3/4" plywood (sheet, 46)`. */
export function libraryDocs(): string {
  return MATERIAL_LIBRARY.map((m) => `${m.id} = ${m.name} (${m.stock}, ${m.thickness})`).join('; ');
}
