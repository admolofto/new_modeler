import { UNITS_PER_INCH } from './units';

/**
 * Sheet layouts for the cut list: which sheet each part comes from and where it sits. Every cut runs
 * edge to edge of the piece it's made in (a guillotine layout), so a table saw or track saw can break
 * the sheet down: rip strips, crosscut them, rip what's left. Parts with grain keep their length
 * along the sheet's length; the rest may turn. Several part orders × fitting rules × cut orders run
 * and the layout with the fewest sheets wins, then the one whose leftovers are the biggest pieces.
 * Pure and deterministic; lengths in model units.
 */

export interface NestItem {
  id: string;
  name: string;
  length: number;
  width: number;
  /** Grain along the length: the length has to run along the sheet's length. */
  grain: boolean;
}

/** A part on a sheet. Sheet coordinates from one corner: x across the width, y along the length (the grain). */
export interface Placement {
  id: string;
  name: string;
  x: number;
  y: number;
  /** Size on the sheet: `w` across, `h` along. */
  w: number;
  h: number;
  /** Turned a quarter: the part's length runs across the sheet. */
  turned: boolean;
}

export interface SheetLayout {
  parts: Placement[];
}

export interface Nesting {
  sheets: SheetLayout[];
  /** Names of parts too big for the sheet whichever way they may lie. */
  oversize: string[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Bin {
  parts: Placement[];
  /** Pieces still free, between cuts; disjoint. */
  free: Rect[];
}

/** How snugly a `w` × `h` part fits a free piece; lower is better, the second number breaks ties. */
type Fit = (r: Rect, w: number, h: number) => [number, number];

const FITS: Fit[] = [
  (r, w, h) => [Math.min(r.w - w, r.h - h), Math.max(r.w - w, r.h - h)],
  (r, w, h) => [r.w * r.h - w * h, Math.min(r.w - w, r.h - h)],
  (r, w, h) => [Math.max(r.w - w, r.h - h), Math.min(r.w - w, r.h - h)],
];

/**
 * After a part goes in a piece's corner, which cut comes first: true = crosscut (the rest past the
 * part keeps the piece's full width), false = rip (the rest beside it keeps the full length).
 */
type Split = (r: Rect, w: number, h: number) => boolean;

const SPLITS: Split[] = [
  () => false,
  () => true,
  (r, w, h) => r.w - w <= r.h - h,
  (r, w, h) => r.w - w > r.h - h,
  (r, w, h) => w * (r.h - h) > (r.w - w) * h,
  (r, w, h) => w * (r.h - h) <= (r.w - w) * h,
];

const long = (it: NestItem) => Math.max(it.length, it.width);
const short = (it: NestItem) => Math.min(it.length, it.width);

const ORDERS: ((a: NestItem, b: NestItem) => number)[] = [
  (a, b) => b.length * b.width - a.length * a.width,
  (a, b) => long(b) - long(a) || short(b) - short(a),
  (a, b) => short(b) - short(a) || long(b) - long(a),
  (a, b) => long(b) + short(b) - long(a) - short(a),
];

/** Ways a part may lie on the sheet: [across, along, turned]. */
function shapes(it: NestItem): [number, number, boolean][] {
  const upright: [number, number, boolean] = [it.width, it.length, false];
  return it.grain || it.length === it.width ? [upright] : [upright, [it.length, it.width, true]];
}

/** The pieces left when a `w` × `h` part is cut from `r`'s corner; the saw takes `kerf` at each cut. */
function cut(r: Rect, w: number, h: number, kerf: number, crossFirst: boolean): Rect[] {
  const beside = r.w - w - kerf;
  const past = r.h - h - kerf;
  const out: Rect[] = [];
  if (past > 0) out.push({ x: r.x, y: r.y + h + kerf, w: crossFirst ? r.w : w, h: past });
  if (beside > 0) out.push({ x: r.x + w + kerf, y: r.y, w: beside, h: crossFirst ? h : r.h });
  return out;
}

interface Spot {
  bin: Bin;
  i: number;
  w: number;
  h: number;
  turned: boolean;
  score: [number, number];
}

/** The snuggest free piece `it` fits in, earliest sheet first on a tie. */
function bestSpot(bins: Bin[], it: NestItem, fit: Fit): Spot | null {
  let best: Spot | null = null;
  for (const bin of bins) {
    for (let i = 0; i < bin.free.length; i++) {
      const r = bin.free[i]!;
      for (const [w, h, turned] of shapes(it)) {
        if (w > r.w || h > r.h) continue;
        const score = fit(r, w, h);
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { bin, i, w, h, turned, score };
      }
    }
  }
  return best;
}

function pack(items: NestItem[], sheet: Rect, kerf: number, fit: Fit, split: Split): Bin[] {
  const bins: Bin[] = [];
  for (const it of items) {
    let spot = bestSpot(bins, it, fit);
    if (!spot) {
      bins.push({ parts: [], free: [{ ...sheet }] });
      spot = bestSpot(bins.slice(-1), it, fit)!;
    }
    const { bin, i, w, h, turned } = spot;
    const r = bin.free[i]!;
    bin.parts.push({ id: it.id, name: it.name, x: r.x, y: r.y, w, h, turned });
    bin.free.splice(i, 1, ...cut(r, w, h, kerf, split(r, w, h)));
  }
  return bins;
}

/** Sum of squared leftover areas (in²): bigger when the waste is a few pieces big enough to use. */
function leftovers(bins: Bin[]): number {
  let sum = 0;
  for (const b of bins) for (const r of b.free) sum += ((r.w / UNITS_PER_INCH) * (r.h / UNITS_PER_INCH)) ** 2;
  return sum;
}

/** Lays parts out on `sheet` ([width, length]) sheets, `kerf` apart. */
export function nestSheets(items: NestItem[], sheet: [number, number], kerf: number): Nesting {
  const [w, h] = sheet;
  const fits = (it: NestItem) => shapes(it).some(([a, b]) => a <= w && b <= h);
  const placeable = items.filter(fits);
  let best: { bins: Bin[]; left: number } | null = null;
  for (const order of ORDERS) {
    const sorted = [...placeable].sort(order);
    for (const fit of FITS) {
      for (const split of SPLITS) {
        const bins = pack(sorted, { x: 0, y: 0, w, h }, kerf, fit, split);
        const left = leftovers(bins);
        if (!best || bins.length < best.bins.length || (bins.length === best.bins.length && left > best.left)) best = { bins, left };
      }
    }
  }
  return {
    sheets: (best?.bins ?? []).map((b) => ({ parts: b.parts })),
    oversize: items.filter((it) => !fits(it)).map((it) => it.name),
  };
}
