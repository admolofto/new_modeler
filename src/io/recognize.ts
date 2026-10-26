import type { Mat3 } from '../model/world';
import { recognizeWalls } from './recognizeWalls';
import type { Flat, IR, IRAsm, IRPart } from './sketchupImport';

/**
 * Recognizing an imported SketchUp model: what of it is one of the app's own pieces — walls, with
 * their doors and windows — comes out of the raw tree and is made by its generator instead (in a
 * "Walls" folder). What isn't recognized stays as it was imported.
 */

export interface Recognized {
  walls: number;
  openings: number;
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

export function recognize(roots: IR[], flats: Flat[]): { roots: IR[]; report: Recognized } {
  const walls = recognizeWalls(roots.flatMap(partsOf), flats);
  const rest = roots.map((r) => prune(r, walls.consumed)).filter((r): r is IR => r !== null);
  const folder: IRAsm[] = walls.walls.length ? [{ kind: 'asm', name: 'Walls', R: I3, children: walls.walls }] : [];
  return { roots: [...folder, ...rest], report: { walls: walls.walls.length, openings: walls.openings } };
}
