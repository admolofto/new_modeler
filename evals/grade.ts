import { boxSize, overlaps, union, worldBoxes, type Box3 } from '../src/model/world.ts';
import type { Assembly, Doc, Part } from '../src/model/schema.ts';
import type { CarcassParams } from '../src/plugins/generators/carcass.ts';

/** Grading helpers. Checks push readable failures instead of throwing, so one run reports everything. */

export const IN = 64;
const inch = (u: number) => `${Math.round((u / IN) * 64) / 64}"`;

export class Grader {
  failures: string[] = [];
  private boxes: Map<string, Box3>;
  constructor(readonly doc: Doc) {
    this.boxes = worldBoxes(doc);
  }

  check(cond: boolean, msg: string): boolean {
    if (!cond) this.failures.push(msg);
    return cond;
  }

  /** |actual − expected| ≤ tol, all in inches (actual in model units). */
  near(actual: number | undefined, expectedIn: number, what: string, tolIn = 1 / 8): boolean {
    return this.check(actual !== undefined && Math.abs(actual / IN - expectedIn) <= tolIn, `${what}: expected ${expectedIn}" ±${tolIn}", got ${actual === undefined ? 'nothing' : inch(actual)}`);
  }

  carcasses(): (Assembly & { params: CarcassParams })[] {
    return Object.values(this.doc.assemblies)
      .filter((a) => a.generator?.type === 'carcass')
      .map((a) => ({ ...a, params: a.generator!.params as unknown as CarcassParams }));
  }

  /** The only carcass, or a failure. */
  oneCarcass() {
    const all = this.carcasses();
    this.check(all.length === 1, `expected 1 carcass, found ${all.length}`);
    return all[0];
  }

  parts(pred: (p: Part) => boolean = () => true): Part[] {
    return Object.values(this.doc.parts).filter(pred);
  }

  named(re: RegExp): Part[] {
    return this.parts((p) => re.test(p.name));
  }

  box(id: string): Box3 | undefined {
    return this.boxes.get(id);
  }

  size(id: string) {
    const b = this.box(id);
    return b && boxSize(b);
  }

  /** World bounds of all parts (or the given ones). */
  overall(ids = Object.keys(this.doc.parts)): Box3 | undefined {
    const boxes = ids.map((id) => this.boxes.get(id)).filter((b): b is Box3 => !!b);
    return boxes.length ? union(boxes) : undefined;
  }

  /** W×H×D of the overall bounds, each within tolerance (inches). */
  overallSize(expected: [number, number, number], tolIn = 1 / 4, ids?: string[]) {
    const b = this.overall(ids);
    const s = b && boxSize(b);
    ['width', 'height', 'depth'].forEach((axis, i) => this.near(s?.[i], expected[i]!, `overall ${axis}`, tolIn));
  }

  noOverlaps(ids = Object.keys(this.doc.parts)) {
    const clash = overlaps(this.doc, ids, this.boxes);
    this.check(clash.length === 0, `parts interpenetrate: ${clash.slice(0, 4).map((c) => `${c.a}×${c.b}`).join(', ')}`);
  }

  noteResolved(id: string) {
    const n = this.doc.annotations[id];
    this.check(n?.resolved === true, `note ${id} ${n ? 'left open' : 'missing'}`);
  }

  features(part: Part | undefined, type: string) {
    return part?.features.filter((f) => f.type === type).map((f) => f.params as Record<string, unknown>) ?? [];
  }
}
