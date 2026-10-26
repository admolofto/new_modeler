import type { Mat3 } from '../model/world';
import { cabinetFrom, isCounter } from './recognizeCasework';
import { recognizeWalls } from './recognizeWalls';
import type { Flat, IR, IRAsm, IRNative, IRPart } from './sketchupImport';

/**
 * Recognizing an imported SketchUp model: what of it is one of the app's own pieces comes out of the
 * raw tree and is made by its generator instead — walls (with their doors and windows) in a "Walls"
 * folder, cabinets and countertops in a "Cabinets" one. What isn't recognized stays as it was imported.
 */

export interface Recognized {
  walls: number;
  openings: number;
  cabinets: number;
  counters: number;
}

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const partsOf = (ir: IR): IRPart[] => (ir.kind === 'part' ? [ir] : ir.kind === 'asm' ? ir.children.flatMap(partsOf) : []);

/** The tree less the consumed parts; folders left empty go too. */
function prune(ir: IR, gone: Set<IRPart>): IR | null {
  if (ir.kind === 'part') return gone.has(ir) ? null : ir;
  if (ir.kind === 'native') return ir;
  const children = ir.children.map((c) => prune(c, gone)).filter((c): c is IR => c !== null);
  return children.length ? { ...ir, children } : null;
}

/** The tree less the groups that are cabinets (collected in `found`). */
function takeCabinets(ir: IR, found: IRNative[]): IR | null {
  if (ir.kind !== 'asm') return ir;
  const cabinet = cabinetFrom(ir);
  if (cabinet) {
    found.push(cabinet);
    return null;
  }
  const children = ir.children.map((c) => takeCabinets(c, found)).filter((c): c is IR => c !== null);
  return children.length ? { ...ir, children } : null;
}

export function recognize(roots: IR[], flats: Flat[]): { roots: IR[]; report: Recognized } {
  const walls = recognizeWalls(roots.flatMap(partsOf), flats);
  const cabinets: IRNative[] = [];
  let rest = roots
    .map((r) => prune(r, walls.consumed))
    .map((r) => r && takeCabinets(r, cabinets))
    .filter((r): r is IR => r !== null);
  const counters = rest.flatMap(partsOf).filter((p) => isCounter(p, cabinets));
  rest = rest.map((r) => prune(r, new Set(counters))).filter((r): r is IR => r !== null);
  counters.forEach((p, i) => Object.assign(p, { name: counters.length > 1 ? `Countertop ${i + 1}` : 'Countertop', slab: true }));
  const folders: IRAsm[] = [];
  if (walls.walls.length) folders.push({ kind: 'asm', name: 'Walls', R: I3, children: walls.walls });
  if (cabinets.length || counters.length) folders.push({ kind: 'asm', name: 'Cabinets', R: I3, children: [...cabinets, ...counters] });
  return { roots: [...folders, ...rest], report: { walls: walls.walls.length, openings: walls.openings, cabinets: cabinets.length, counters: counters.length } };
}
