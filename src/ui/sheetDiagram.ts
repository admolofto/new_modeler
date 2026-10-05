import type { SheetLayout } from '../model/nesting';
import { lengthCell, toInches, UNITS_PER_INCH } from '../model/units';
import { fmt, units } from './units';

/**
 * One sheet drawn to scale with its parts on it, for the cut list and its print view. Landscape:
 * the sheet's length — its grain — runs left to right from the corner the layout starts in. Each
 * part shows its name and length × width when they fit, else its cut-list number (the tooltip has
 * the rest); the hatched rest is offcut. Text is sized in sheet units, so it scales with the drawing.
 */

const NS = 'http://www.w3.org/2000/svg';
/** On screen a 4' × 8' sheet is 576 px wide. */
const PX_PER_INCH = 6;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Label text size and padding, px at PX_PER_INCH; parts too small for that get smaller text, then just their number. */
const SIZE = 11;
const PAD = 3;
const TINY = 8;
const GAP = '  ';

export interface DiagramOptions {
  /** Sheet [width, length]. */
  size: [number, number];
  color: string;
  /** The part's cut-list number, shown when its name doesn't fit. */
  key?: (id: string) => string | undefined;
  /** Print: as wide as the page allows (a 96" sheet fills it). Screen: PX_PER_INCH. */
  print?: boolean;
  pick?: (id: string) => void;
  hover?: (id: string | null) => void;
}

type Attrs = Record<string, string | number>;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}

interface Run {
  text: string;
  bold: boolean;
}

/** Lines of text at a font size (px). */
interface Label {
  lines: Run[][];
  size: number;
}

let ctx: CanvasRenderingContext2D | null | undefined;
function measure(r: Run, size: number): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return r.text.length * size * 0.6;
  ctx.font = `${r.bold ? 600 : 400} ${size}px ${FONT}`;
  return ctx.measureText(r.text).width;
}
const lineWidth = (line: Run[], size: number) => line.reduce((s, r) => s + measure(r, size), 0) + (line.length - 1) * measure({ text: GAP, bold: false }, size);
const lineHeight = (size: number) => size * 1.27;

/** The first label that fits a `w` × `h` px box, upright or turned to read along a tall box. */
function fitLabel(w: number, h: number, options: Label[]): (Label & { turn: boolean }) | null {
  for (const o of options) {
    const pad = o.size < SIZE ? 1 : PAD;
    for (const turn of h > w ? [false, true] : [false]) {
      const [across, up] = turn ? [h, w] : [w, h];
      const tall = o.size + (o.lines.length - 1) * lineHeight(o.size);
      if (tall <= up - 2 * pad && Math.max(...o.lines.map((l) => lineWidth(l, o.size))) <= across - 2 * pad) return { ...o, turn };
    }
  }
  return null;
}

/** A run as SVG text, fractions drawn stacked like `shop()` does: `34 1/2` → `34 ½`. */
function runNodes(r: Run): SVGTSpanElement {
  const t = svg('tspan', r.bold ? { 'font-weight': 600 } : { 'fill-opacity': 0.8 });
  const s = r.text.replace(/(\d) (?=\d+\/\d+)/g, '$1\u2009');
  let last = 0;
  for (const m of s.matchAll(/\d+\/\d+/g)) {
    t.append(s.slice(last, m.index), svg('tspan', { class: 'frac' }, m[0]));
    last = m.index + m[0].length;
  }
  t.append(s.slice(last));
  return t;
}

const channels = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const darken = (hex: string, k: number) => `#${channels(hex).map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('')}`;
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

let seq = 0;

export function sheetDiagram(layout: SheetLayout, o: DiagramOptions): SVGSVGElement {
  const [W, L] = o.size;
  const u = UNITS_PER_INCH / PX_PER_INCH; // sheet units per screen px
  const ink = luminance(o.color) > 0.3 ? '#1f1a14' : '#fbf7f0';
  const hatch = `sheet-hatch-${++seq}`;
  const step = UNITS_PER_INCH * 1.5;
  const root = svg('svg', {
    viewBox: `0 0 ${L} ${W}`,
    width: Math.round(toInches(L) * PX_PER_INCH),
    height: Math.round(toInches(W) * PX_PER_INCH),
    role: 'img',
    'aria-label': `${layout.parts.length} part${layout.parts.length === 1 ? '' : 's'} on a ${fmt(W)} × ${fmt(L)} sheet: ${layout.parts.map((p) => p.name).join(', ')}`,
    'font-family': FONT,
    'font-size': SIZE * u,
  });
  if (o.print) root.style.width = `${Math.min(100, (toInches(L) / 96) * 100)}%`;
  root.append(
    svg(
      'defs',
      {},
      svg(
        'pattern',
        { id: hatch, patternUnits: 'userSpaceOnUse', width: step, height: step, patternTransform: 'rotate(45)' },
        svg('rect', { width: step, height: step, fill: darken(o.color, 0.3) }),
        svg('line', { x1: step / 2, y1: 0, x2: step / 2, y2: step, stroke: darken(o.color, 0.48), 'stroke-width': UNITS_PER_INCH / 5 }),
      ),
    ),
    svg('rect', { width: L, height: W, fill: `url(#${hatch})`, stroke: '#0009', 'vector-effect': 'non-scaling-stroke' }),
  );

  for (const p of layout.parts) {
    // Landscape: the sheet's length (y) runs left to right.
    const [x, y, w, h] = [p.y, p.x, p.h, p.w];
    const [length, width] = p.turned ? [p.w, p.h] : [p.h, p.w];
    const name: Run = { text: p.name, bold: true };
    const dims: Run = { text: `${lengthCell(length, units.system)} × ${lengthCell(width, units.system)}`, bold: false };
    const key = o.key?.(p.id);
    const at = (size: number) => (lines: Run[][]): Label => ({ lines, size });
    const options = [...[[[name], [dims]], [[name, dims]], [[name]]].map(at(SIZE)), ...[[[name, dims]], [[name]]].map(at(TINY))];
    if (key) {
      const k: Run = { text: key, bold: true };
      options.push(...[[[k], [dims]], [[k, dims]], [[k]]].map(at(SIZE)), at(TINY)([[k]]));
    }
    const g = svg(
      'g',
      { class: 'part', 'data-part': p.id },
      svg('title', {}, `${p.name}\n${fmt(length)} × ${fmt(width)}${p.turned ? '\nTurned: its length runs across the sheet' : ''}`),
      svg('rect', { x, y, width: w, height: h, fill: o.color, stroke: '#000a', 'vector-effect': 'non-scaling-stroke' }),
    );
    const fitted = fitLabel(w / u, h / u, options);
    if (fitted) {
      const [cx, cy] = [x + w / 2, y + h / 2];
      const text = svg('text', {
        'text-anchor': 'middle',
        fill: ink,
        ...(fitted.size !== SIZE && { 'font-size': fitted.size * u }),
        ...(fitted.turn && { transform: `rotate(-90 ${cx} ${cy})` }),
      });
      fitted.lines.forEach((line, i) => {
        // Baseline a little below each line's center, so the block of lines sits centered.
        const tl = svg('tspan', { x: cx, y: cy + ((i - (fitted.lines.length - 1) / 2) * lineHeight(fitted.size) + fitted.size * 0.36) * u });
        line.forEach((r, j) => tl.append(...(j ? [GAP] : []), runNodes(r)));
        text.append(tl);
      });
      // Clipped to the part, in case the font measures wider than the canvas thought.
      g.append(svg('svg', { x, y, width: w, height: h, viewBox: `${x} ${y} ${w} ${h}`, overflow: 'hidden' }, text));
    }
    if (o.pick) g.addEventListener('click', () => o.pick!(p.id));
    if (o.hover) {
      g.addEventListener('pointerenter', () => o.hover!(p.id));
      g.addEventListener('pointerleave', () => o.hover!(null));
    }
    root.append(g);
  }
  return root;
}
