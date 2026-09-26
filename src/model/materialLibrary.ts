import type { Material } from './schema';
import { inches } from './units';

/**
 * Common shop materials at their *actual* thickness (nominal 3/4" plywood is 23/32"), ready to add
 * to a model. Sheet sizes: 4' × 8' unless noted (Baltic birch comes 5' × 5'). Metric sheet goods
 * round to the nearest 1/64".
 */
const mm = (n: number) => inches(n / 25.4);
const BALTIC: [number, number] = [inches(60), inches(60)];

export const MATERIAL_LIBRARY: Material[] = [
  { id: 'ply-3-4', name: '3/4" plywood', thickness: 46, color: '#d9b98b', stock: 'sheet' },
  { id: 'ply-5-8', name: '5/8" plywood', thickness: 38, color: '#dbbc8f', stock: 'sheet' },
  { id: 'ply-1-2', name: '1/2" plywood', thickness: 30, color: '#dcc095', stock: 'sheet' },
  { id: 'ply-1-4', name: '1/4" plywood', thickness: 14, color: '#e6cfa6', stock: 'sheet' },
  { id: 'baltic-18', name: '18mm Baltic birch', thickness: mm(18), color: '#e8d3ad', stock: 'sheet', sheet: BALTIC },
  { id: 'baltic-12', name: '12mm Baltic birch', thickness: mm(12), color: '#ead6b2', stock: 'sheet', sheet: BALTIC },
  { id: 'baltic-6', name: '6mm Baltic birch', thickness: mm(6), color: '#ecd9b7', stock: 'sheet', sheet: BALTIC },
  { id: 'mdf-3-4', name: '3/4" MDF', thickness: 48, color: '#b9a07e', stock: 'sheet' },
  { id: 'mdf-1-2', name: '1/2" MDF', thickness: 32, color: '#bca483', stock: 'sheet' },
  { id: 'melamine-3-4', name: '3/4" white melamine', thickness: 48, color: '#ecebe6', stock: 'sheet' },
  { id: 'hardboard-1-8', name: '1/8" hardboard', thickness: 8, color: '#8a6a4a', stock: 'sheet' },
  { id: 'maple-4-4', name: '4/4 maple (S4S 3/4")', thickness: 48, color: '#ecd9b0', stock: 'solid' },
  { id: 'maple-8-4', name: '8/4 maple (S4S 1 3/4")', thickness: 112, color: '#ecd9b0', stock: 'solid' },
  { id: 'red-oak-4-4', name: '4/4 red oak (S4S 3/4")', thickness: 48, color: '#d4a373', stock: 'solid' },
  { id: 'white-oak-4-4', name: '4/4 white oak (S4S 3/4")', thickness: 48, color: '#c9a878', stock: 'solid' },
  { id: 'walnut-4-4', name: '4/4 walnut (S4S 3/4")', thickness: 48, color: '#6b4a33', stock: 'solid' },
  { id: 'walnut-8-4', name: '8/4 walnut (S4S 1 3/4")', thickness: 112, color: '#6b4a33', stock: 'solid' },
  { id: 'cherry-4-4', name: '4/4 cherry (S4S 3/4")', thickness: 48, color: '#b76e4b', stock: 'solid' },
  { id: 'poplar-4-4', name: '4/4 poplar (S4S 3/4")', thickness: 48, color: '#d9d3a0', stock: 'solid' },
  { id: 'pine-1x', name: '1× pine board (3/4")', thickness: 48, color: '#e8cf9a', stock: 'solid', nominal: 64 },
  { id: 'pine-2x', name: '2× construction lumber (1 1/2")', thickness: 96, color: '#e3c78e', stock: 'solid', nominal: 128 },
];

/** One line per library material for the AI prompt: `ply-3-4 = 3/4" plywood (sheet, 46)`. */
export function libraryDocs(): string {
  return MATERIAL_LIBRARY.map((m) => `${m.id} = ${m.name} (${m.stock}, ${m.thickness})`).join('; ');
}
