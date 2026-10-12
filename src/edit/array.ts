import { ModelError } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { duplicateOps } from './duplicate';

/**
 * Rows of copies, typed SketchUp-style after a copy has been moved or turned: `3x` (or `*3`) repeats
 * it — three copies, each as far from the last as the first is from the original — and `/3` spreads
 * three copies evenly between the original and where the first copy landed. Pure.
 */
export interface ArraySpec {
  kind: 'times' | 'divide';
  n: number;
}

/** `3x`, `x3`, `*3`, `3*` → times; `/3`, `3/` → divide. Anything else (a length, `3/4`) is null. */
export function parseArray(text: string): ArraySpec | null {
  const s = text.trim().toLowerCase();
  const times = /^(?:[x×*]\s*(\d+)|(\d+)\s*[x×*])$/.exec(s);
  const divide = /^(?:\/\s*(\d+)|(\d+)\s*\/)$/.exec(s);
  const m = times ?? divide;
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return n >= 1 && n <= 200 ? { kind: times ? 'times' : 'divide', n } : null;
}

/** `45`, `-22.5`, `30°`, `15 deg` → degrees, or null. */
export function parseAngle(text: string): number | null {
  const m = /^\s*([-−])?\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:°|deg|degrees)?\s*$/i.exec(text);
  if (!m) return null;
  const deg = Number(m[2]) * (m[1] ? -1 : 1);
  return Number.isFinite(deg) && Math.abs(deg) <= 360 ? deg : null;
}

/**
 * The ops for `spec.n` copies of `ids`. `place(doc, copies, f)` moves one set of copies (they start
 * where the originals are) to fraction `f` of the full move: 1, 2, 3… for `times`, 1/n … 1 for
 * `divide`.
 */
export function arrayCopyOps(doc: Doc, ids: readonly string[], spec: ArraySpec, place: (doc: Doc, copies: string[], f: number) => Op[]): { ops: Op[]; copies: string[] } {
  const ops: Op[] = [];
  const copies: string[] = [];
  let scratch = doc;
  for (let i = 1; i <= spec.n; i++) {
    const dup = duplicateOps(scratch, ids);
    const placed = place(dup.doc, dup.copies, spec.kind === 'times' ? i : i / spec.n);
    const r = applyOps(dup.doc, placed);
    if (!r.ok) throw new ModelError(r.error);
    ops.push(...dup.ops, ...placed);
    copies.push(...dup.copies);
    scratch = r.doc;
  }
  return { ops, copies };
}
