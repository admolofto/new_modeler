import { blockPlacement, facingToward, moveOps, turnOps } from '../edit/blocks';
import { openingEdges, resizeOpening, slideOpening, withOpening } from '../edit/openings';
import { planGrips, planResizeOps, type PlanSide } from '../edit/planResize';
import type { Target } from '../edit/targets';
import type { V3 } from '../geometry/types';
import { nextId, parentIndex } from '../model/doc';
import { genPartId } from '../model/generate';
import { applyOps, type Op } from '../model/ops';
import { floorPlan, type P2, type Plan, type PlanItem, type PlanOpening, type PlanRoom, type PlanWallOpening } from '../model/plan';
import { alongWall, placeOpening, roomAround, roomOf, roomParams } from '../model/room';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { inches } from '../model/units';
import { IDENTITY } from '../model/world';
import { openingLabel, ROOM_SIDES, type OpeningKind, type RoomParams, type RoomSide } from '../plugins/generators/room';
import { el } from './dom';
import { icon } from './icons';
import { claimKeys } from './present/keys';
import type { Selection } from './selection';
import { toast } from './toast';
import { fmt } from './units';

/**
 * The 2D plan (sketch) view: the model from straight above, drawn like an architect's pencil
 * sketch on paper — hatched walls broken at the openings, doors with their swing, windows,
 * cabinets and furniture as footprints (uppers dashed, talls crossed), names and sizes. It's for
 * blocking a layout out fast: drag pieces around (they snap to walls and each other), draw base,
 * upper and tall blocks, add windows and doors and slide them along their walls, turn pieces a
 * quarter (Q), delete them. Grips on the selection resize it: a piece's sides (pushed like Push /
 * Pull: a cabinet gets wider or deeper), an opening's jambs, and the room's walls. Every change is an op through the store, like anywhere else, so undo,
 * the 3D view and the AI all see it. A button in the view group and Shift+2 open and close it.
 */

export interface PlanViewOptions {
  /** The top bar's view group (the button goes there). */
  slot: HTMLElement;
  stage: HTMLElement;
  store: Store;
  selection: Selection;
  /** The doc on screen (a drag or an AI proposal in progress included). */
  shown(): Doc;
  editBlocked(): string | null;
  /** Shows a doc while dragging (null: back to the store's). */
  setPreview(doc: Doc | null): void;
  /** Puts the 3D editor at rest before the plan takes over (tools off, drags cancelled). */
  quiesce(): void;
}

export interface PlanView {
  readonly active: boolean;
  toggle(on?: boolean): void;
  /** Redraws from the doc on screen (no-op while closed). */
  refresh(): void;
}

type Mode = 'select' | 'base' | 'upper' | 'tall';

/** Blocks drawn in the plan: bottom and top, world y. */
const BLOCK_SPANS: Record<Exclude<Mode, 'select'>, { bottom: number; top: number; label: string; key: string }> = {
  base: { bottom: 0, top: inches(34.5), label: 'Base', key: 'B' },
  upper: { bottom: inches(54), top: inches(84), label: 'Upper', key: 'U' },
  tall: { bottom: 0, top: inches(84), label: 'Tall', key: 'T' },
};

const STEP = inches(1 / 2);
const SNAP_PX = 8;
const CLICK_PX = 4;

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Architects+Daughter&display=swap');
.plan2d { position: absolute; inset: 0; z-index: 8; background: #f6f1e6; cursor: default; user-select: none; }
.plan2d svg.sheet { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.plan2d.drawing svg.sheet { cursor: crosshair; }
.plan2d.panning svg.sheet { cursor: grabbing; }
.plan2d .sk-text { font-family: "Architects Daughter", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive; fill: #2c2a26;
  paint-order: stroke; stroke: #f6f1e6; stroke-width: 3px; stroke-linejoin: round; }
.plan2d .plan-bar { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
  padding: 4px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 8px 24px #0006; white-space: nowrap; }
.plan2d .plan-bar .sep { align-self: stretch; width: 1px; margin: 2px 4px; background: var(--line-2); }
.plan2d .plan-bar .btn { gap: 5px; }
.plan2d .plan-bar kbd { font: 10px var(--font); opacity: .6; }
.plan2d .plan-tag { position: absolute; left: 14px; top: 12px; padding: 3px 10px; border: 1.5px solid #2c2a26; border-radius: 4px;
  font: 15px "Architects Daughter", "Segoe Print", "Comic Sans MS", cursive; color: #2c2a26; background: #f6f1e6; transform: rotate(-1.2deg); }
.plan2d .plan-hint { position: absolute; right: 14px; top: 12px; max-width: 46%; padding: 4px 10px; border-radius: 8px; background: #2c2a26d9; color: #f6f1e6;
  font-size: var(--fs-sm); }
`;

const INK = '#2c2a26';
const ACCENT = '#2f6fdb';
const WASH: Record<PlanItem['kind'], string> = {
  cabinet: '#e8d5b5',
  appliance: '#d3dbe2',
  furniture: '#d9e3cf',
  accessory: '#eadfd0',
  block: '#e2ddd3',
  part: '#ead9bf',
  wall: '#efe7d6',
};

// ── sketchy strokes ──────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** A small seeded random source, so a line wobbles the same way every redraw. */
function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n: number) => n.toFixed(1);

/**
 * A hand-drawn line from a to b (screen px): two slightly different passes that run a little past
 * the ends, with a faint bow — what makes it read as a pencil sketch.
 */
function sketchLine(a: P2, b: P2, seed: string, passes = 2, overshoot = true): string {
  const r = rng(seed);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return '';
  const [ux, uy] = [dx / len, dy / len];
  const [nx, ny] = [-uy, ux];
  let d = '';
  for (let k = 0; k < passes; k++) {
    const over = overshoot ? Math.min(7, len * 0.07) : 0;
    const o0 = over * (0.2 + r() * 0.8);
    const o1 = over * (0.2 + r() * 0.8);
    const j = () => (r() - 0.5) * Math.min(1.6, 0.4 + len * 0.004);
    const p0: P2 = [a[0] - ux * o0 + nx * j(), a[1] - uy * o0 + ny * j()];
    const p1: P2 = [b[0] + ux * o1 + nx * j(), b[1] + uy * o1 + ny * j()];
    const bow = (r() - 0.5) * Math.min(2.2, len * 0.012);
    const m: P2 = [(p0[0] + p1[0]) / 2 + nx * bow, (p0[1] + p1[1]) / 2 + ny * bow];
    d += `M${f1(p0[0])},${f1(p0[1])}Q${f1(m[0])},${f1(m[1])} ${f1(p1[0])},${f1(p1[1])}`;
  }
  return d;
}

/** A closed outline, each edge drawn by hand. */
const sketchPoly = (pts: P2[], seed: string, passes = 2) => pts.map((p, i) => sketchLine(p, pts[(i + 1) % pts.length]!, `${seed}:${i}`, passes)).join('');

/** A polyline (a door's swing), one wobbly pass. */
function sketchCurve(pts: P2[], seed: string): string {
  const r = rng(seed);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0] + (r() - 0.5) * 0.8)},${f1(p[1] + (r() - 0.5) * 0.8)}`).join('');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const shopText = (s: string) => s.replace(/(\d)"/g, '$1″');

// ── geometry helpers ─────────────────────────────────────────────────────────

function inPoly(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const boxOf = (pts: P2[]) => ({
  min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as P2,
  max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as P2,
});
/** An opening's footprint through its wall. */
const openingQuad = (o: PlanOpening): P2[] => [o.inside[0], o.inside[1], o.outside[1], o.outside[0]];

/** Lines to snap to along x and along z: the rooms' inside faces and the pieces' edges (`skip`: the ones moving). */
function snapLines(plan: Plan, skip: ReadonlySet<string>): { xs: number[]; zs: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const r of plan.rooms) {
    xs.push(r.min[0], r.max[0]);
    zs.push(r.min[1], r.max[1]);
  }
  for (const i of plan.items) {
    if (skip.has(i.id)) continue;
    const b = boxOf(i.corners);
    xs.push(b.min[0], b.max[0]);
    zs.push(b.min[1], b.max[1]);
  }
  return { xs, zs };
}

/** The smallest shift (within tol) that puts one of `edges` on one of `lines`, or null. */
function snapShift(edges: number[], lines: number[], tol: number): number | null {
  let best: number | null = null;
  for (const e of edges) for (const l of lines) if (Math.abs(l - e) <= tol && (best === null || Math.abs(l - e) < Math.abs(best))) best = l - e;
  return best;
}

// ── the view ─────────────────────────────────────────────────────────────────

export function mountPlanView(o: PlanViewOptions): PlanView {
  const { store, selection } = o;
  const btn = el('button', { class: 'btn ghost', title: '2D plan: the room from above as a sketch, to block out a layout fast (Shift+2)', 'aria-pressed': 'false' }, icon('plan'), el('span', { class: 't' }, '2D'));
  o.slot.append(btn);

  const root = el('div', { class: 'plan2d' });
  root.style.display = 'none';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sheet');
  const tag = el('div', { class: 'plan-tag' }, 'PLAN');
  const hint = el('div', { class: 'plan-hint' });
  hint.style.display = 'none';
  const bar = el('div', { class: 'plan-bar', role: 'toolbar', 'aria-label': '2D plan' });
  root.append(svg, tag, hint, bar);
  o.stage.append(el('style', {}, STYLE), root);

  let active = false;
  let mode: Mode = 'select';
  let releaseKeys: (() => void) | null = null;
  /** The view: world point at the middle of the sheet and px per model unit. */
  let cx = 0;
  let cz = 0;
  let scale = 0;
  let fitted = false;
  let size: P2 = [1, 1];

  type Gesture =
    | { kind: 'pan'; x: number; y: number; cx: number; cz: number; moved: boolean; clear: boolean }
    /** Moving, sliding or resizing: `solve` turns the pointer's world point into ops on the store's doc. */
    | { kind: 'edit'; x: number; y: number; moved: boolean; ops: Op[]; solve: (w: P2) => Op[]; cursor: string }
    | { kind: 'draw'; a: P2; b: P2 };
  /** A grip drawn on the selection this redraw: where (screen), its cursor, and the edit it starts. */
  interface Grip {
    at: P2;
    cursor: string;
    start(w: P2): (w: P2) => Op[];
  }
  let grips: Grip[] = [];
  let gesture: Gesture | null = null;
  let hover: string | null = null;

  const toScreen = (p: P2): P2 => [(p[0] - cx) * scale + size[0] / 2, (p[1] - cz) * scale + size[1] / 2];
  const toWorld = (x: number, y: number): P2 => [(x - size[0] / 2) / scale + cx, (y - size[1] / 2) / scale + cz];
  const local = (e: { clientX: number; clientY: number }): P2 => {
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function fit() {
    const plan = floorPlan(o.shown());
    const b = plan.bounds ?? { min: [0, 0] as P2, max: [inches(144), inches(144)] as P2 };
    const pad = 70;
    const w = Math.max(b.max[0] - b.min[0], inches(24));
    const h = Math.max(b.max[1] - b.min[1], inches(24));
    scale = Math.min((size[0] - pad * 2) / w, (size[1] - pad * 2 - 50) / h);
    cx = (b.min[0] + b.max[0]) / 2;
    cz = (b.min[1] + b.max[1]) / 2 + 25 / scale;
    fitted = true;
  }

  // ── what's selected ──

  /** The plan piece a node belongs to (itself or the nearest one above it). */
  function itemOf(plan: Plan, doc: Doc, node: string): string | null {
    const ids = new Set(plan.items.map((i) => i.id));
    const parents = parentIndex(doc);
    for (let id: string | null | undefined = node; id; id = parents.get(id)) if (ids.has(id)) return id;
    return null;
  }
  const selectedItems = (plan: Plan, doc: Doc) => new Set(selection.targets.flatMap((t) => itemOf(plan, doc, t.node) ?? []));
  /** An opening's selection: its window or door leaf, else its jamb in the wall (as the room bar does). */
  function openingTarget(doc: Doc, op: PlanOpening): Target {
    const node = [`window-${op.id}`, `door-${op.id}-leaf`].map((role) => genPartId(op.room, role)).find((id) => doc.parts[id]);
    return node ? { node } : { node: genPartId(op.room, `wall-${op.wall}`), handle: `${op.id}:jamb-left` };
  }
  const openingSelected = (op: PlanOpening) =>
    selection.targets.some(
      (t) => t.node === genPartId(op.room, `window-${op.id}`) || t.node.startsWith(genPartId(op.room, `door-${op.id}`)) || (t.handle?.startsWith(`${op.id}:`) && t.node === genPartId(op.room, `wall-${op.wall}`)),
    );
  const selectedOpenings = (plan: Plan) => plan.rooms.flatMap((r) => r.openings.filter(openingSelected));
  /** Rooms whose walls show their grips: the room, or one of its walls (not an opening's jamb), is selected. */
  const roomSelected = (r: PlanRoom) =>
    selection.targets.some((t) => t.node === r.id || (!t.handle && ROOM_SIDES.some((side) => t.node === genPartId(r.id, `wall-${side}`))));

  // ── drawing ──

  function render() {
    if (!active) return;
    const doc = o.shown();
    const plan = floorPlan(doc);
    if (!fitted) fit();
    const sel = selectedItems(plan, doc);
    labels = [];
    const S = (p: P2) => toScreen(p);
    const out: string[] = [];
    out.push(`<defs>
      <pattern id="pv-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${INK}" stroke-width="0.9" stroke-opacity="0.55"/></pattern>
      <filter id="pv-pencil"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.1"/></filter>
    </defs>`);
    out.push(grid());

    // The rooms.
    for (const r of plan.rooms) out.push(roomMarkup(r, S));

    // The pieces: wall pieces like the room's walls, then footprints, uppers dashed over the rest.
    for (const i of plan.items) {
      const pts = i.corners.map(S);
      const on = sel.has(i.id);
      const hot = hover === i.id;
      if (i.wall) {
        out.push(wallMarkup(i.id, i.wall.pieces, on ? ACCENT : INK, S));
        if (hot && !on) out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="#0000000d"/>`);
        for (const op of i.wall.openings) out.push(openingMarkup(op, on ? ACCENT : INK, S));
        continue;
      }
      const stroke = on ? ACCENT : INK;
      const wash = on ? '#cfe0ff' : WASH[i.kind];
      if (i.level === 'upper') {
        out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="${on ? '#cfe0ff88' : hot ? '#00000008' : 'none'}"/>`);
        out.push(`<path d="${sketchPoly(pts, i.id, 1)}" fill="none" stroke="${stroke}" stroke-width="${on ? 1.8 : 1.3}" stroke-dasharray="7 5" stroke-linecap="round"/>`);
      } else {
        out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="${wash}" fill-opacity="${hot ? 1 : 0.85}"/>`);
        out.push(`<path d="${sketchPoly(pts, i.id)}" fill="none" stroke="${stroke}" stroke-width="${on ? 1.9 : 1.3}" stroke-linecap="round"/>`);
        if (i.level === 'tall') out.push(`<path d="${sketchLine(pts[0]!, pts[2]!, `${i.id}x1`, 1, false)}${sketchLine(pts[1]!, pts[3]!, `${i.id}x2`, 1, false)}" stroke="${stroke}" stroke-width="0.8" fill="none" opacity="0.7"/>`);
      }
      // Its front: a heavier stroke just inside the front edge (where the doors are).
      const [fr, fl] = [pts[2]!, pts[3]!];
      const inset = Math.min(3, Math.hypot(pts[3]![0] - pts[0]![0], pts[3]![1] - pts[0]![1]) * 0.08);
      const back = [(pts[0]![0] - fl[0]), (pts[0]![1] - fl[1])];
      const bl = Math.hypot(back[0]!, back[1]!) || 1;
      const sh = (p: P2): P2 => [p[0] + (back[0]! / bl) * inset, p[1] + (back[1]! / bl) * inset];
      out.push(`<path d="${sketchLine(sh(fl), sh(fr), `${i.id}f`, 1, false)}" stroke="${stroke}" stroke-width="${i.level === 'upper' ? 1 : 2.2}" fill="none" stroke-linecap="round"${i.level === 'upper' ? ' stroke-dasharray="7 5"' : ''}/>`);
      out.push(itemLabel(i, pts));
    }

    // The selection's clearances to the walls, and its grips.
    out.push(clearances(plan, sel));
    grips = gesture?.kind === 'draw' ? [] : selectionGrips(plan, doc, sel);
    for (const g of grips) out.push(`<rect x="${f1(g.at[0] - 5)}" y="${f1(g.at[1] - 5)}" width="10" height="10" rx="1.5" fill="#fff" stroke="${ACCENT}" stroke-width="1.6"/>`);

    // A block being drawn.
    if (gesture?.kind === 'draw') {
      const { a, b } = gesture;
      const pts = [a, [b[0], a[1]] as P2, b, [a[0], b[1]] as P2].map(S);
      out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="${ACCENT}" fill-opacity="0.12"/>`);
      out.push(`<path d="${sketchPoly(pts, 'draft', 1)}" fill="none" stroke="${ACCENT}" stroke-width="1.6"${mode === 'upper' ? ' stroke-dasharray="7 5"' : ''}/>`);
      const w = Math.abs(b[0] - a[0]);
      const d = Math.abs(b[1] - a[1]);
      const c = S([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      out.push(`<text class="sk-text" x="${f1(c[0])}" y="${f1(c[1] + 5)}" text-anchor="middle" font-size="14" fill="${ACCENT}">${esc(shopText(`${fmt(w)} × ${fmt(d)}`))}</text>`);
    }

    out.push(northArrow());
    svg.innerHTML = out.join('');
  }

  /** Screen cursor for dragging along a world direction. */
  const cursorFor = (n: P2) => (Math.abs(n[0]) >= Math.abs(n[1]) ? 'ew-resize' : 'ns-resize');
  /** A room coordinate along a wall from a world point: x on the back and front walls, z on the sides. */
  const coordOn = (side: RoomSide, w: P2) => (side === 'back' || side === 'front' ? w[0] : w[1]);

  /**
   * The grips for what's selected: one piece's four sides, each selected opening's two jambs, and a
   * selected room's walls. Each starts an edit on the store's doc as it is when the drag starts.
   */
  function selectionGrips(plan: Plan, doc: Doc, sel: Set<string>): Grip[] {
    const out: Grip[] = [];
    const tol = () => SNAP_PX / scale;
    const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // A piece: push or pull a side.
    const item = sel.size === 1 ? plan.items.find((i) => sel.has(i.id)) : undefined;
    if (item) {
      const edge: Record<PlanSide, [number, number]> = { left: [0, 3], right: [1, 2], back: [0, 1], front: [2, 3] };
      for (const g of planGrips(doc, item.id)) {
        const [a, b] = edge[g.side];
        const at = mid(item.corners[a]!, item.corners[b]!);
        out.push({
          at: toScreen(at),
          cursor: cursorFor(g.normal),
          start: (from) => {
            const base = store.doc;
            const basePlan = floorPlan(base);
            const k = Math.abs(g.normal[0]) > 0.999 ? 0 : Math.abs(g.normal[1]) > 0.999 ? 1 : null;
            const { xs, zs } = snapLines(basePlan, new Set([item.id]));
            return (w) => {
              let s = (w[0] - from[0]) * g.normal[0] + (w[1] - from[1]) * g.normal[1];
              // The side's new place snaps to walls and other pieces' edges, else the 1/2" grid.
              const snap = k === null ? null : snapShift([at[k] + s * g.normal[k]!], k === 0 ? xs : zs, tol());
              s = snap !== null && k !== null ? s + snap * g.normal[k]! : Math.round(s / STEP) * STEP;
              return planResizeOps(base, g, Math.round(s));
            };
          },
        });
      }
    }
    // An opening: pull a jamb along its wall.
    for (const op of selectedOpenings(plan)) {
      for (const [k, grip] of [[0, 'left'], [1, 'right']] as const) {
        out.push({
          at: toScreen(mid(op.inside[k], op.outside[k])),
          cursor: cursorFor([op.inside[1][0] - op.inside[0][0], op.inside[1][1] - op.inside[0][1]]),
          start: () => {
            const base = store.doc;
            const asm = base.assemblies[op.room];
            if (!asm) return () => [];
            const p = roomParams(asm);
            return (w) => {
              const next = resizeOpening(p, op.id, grip, alongWall(p, op.wall, coordOn(op.wall, w)), STEP);
              return next ? [openingsOp(op.room, withOpening(p, next))] : [];
            };
          },
        });
      }
    }
    // A room: move a wall.
    for (const r of plan.rooms) {
      if (!roomSelected(r)) continue;
      const asm = doc.assemblies[r.id];
      if (!asm) continue;
      const p = roomParams(asm);
      const spots: Record<RoomSide, P2> = {
        back: [(r.min[0] + r.max[0]) / 2, r.min[1]],
        front: [(r.min[0] + r.max[0]) / 2, r.max[1]],
        left: [r.min[0], (r.min[1] + r.max[1]) / 2],
        right: [r.max[0], (r.min[1] + r.max[1]) / 2],
      };
      for (const side of p.walls) {
        const across = side === 'left' || side === 'right' ? 0 : 1;
        out.push({
          at: toScreen(spots[side]),
          cursor: across === 0 ? 'ew-resize' : 'ns-resize',
          start: () => {
            const base = store.doc;
            const { xs, zs } = snapLines(floorPlan(base), new Set());
            const lines = (across === 0 ? xs : zs).filter((l) => l !== spots[side][across]);
            return (w) => {
              const raw = w[across]!;
              const snap = snapShift([raw], lines, tol());
              const value = Math.round(snap !== null ? raw + snap : Math.round(raw / STEP) * STEP);
              return value === p[side] ? [] : [{ op: 'update', id: r.id, patch: { params: { [side]: value } } }];
            };
          },
        });
      }
    }
    return out;
  }

  function grid(): string {
    // A faint foot grid (4' when zoomed out), heavier every 4'.
    const foot = inches(12);
    const step = foot * scale >= 12 ? foot : foot * 4;
    const a = toWorld(0, 0);
    const b = toWorld(size[0], size[1]);
    let d = '';
    let dm = '';
    for (let x = Math.ceil(a[0] / step) * step; x <= b[0]; x += step) {
      const sx = f1(toScreen([x, 0])[0]);
      const line = `M${sx},0V${f1(size[1])}`;
      if (Math.round(x / (foot * 4)) * foot * 4 === x) dm += line;
      else d += line;
    }
    for (let z = Math.ceil(a[1] / step) * step; z <= b[1]; z += step) {
      const sy = f1(toScreen([0, z])[1]);
      const line = `M0,${sy}H${f1(size[0])}`;
      if (Math.round(z / (foot * 4)) * foot * 4 === z) dm += line;
      else d += line;
    }
    return `<path d="${d}" stroke="#d9cfbb" stroke-width="0.6" fill="none"/><path d="${dm}" stroke="#cdbfa4" stroke-width="0.9" fill="none"/>`;
  }

  function roomMarkup(r: PlanRoom, S: (p: P2) => P2): string {
    const out: string[] = [];
    const picked = roomSelected(r);
    for (const w of r.walls) out.push(wallMarkup(`${r.id}:${w.side}`, w.pieces, picked ? ACCENT : INK, S));
    for (const op of r.openings) {
      const on = openingSelected(op);
      const hot = hover === `${op.room}:${op.id}`;
      const [i0, i1] = op.inside.map(S) as [P2, P2];
      const [o0, o1] = op.outside.map(S) as [P2, P2];
      if (on || hot) out.push(`<path d="M${[i0, i1, o1, o0].map((p) => p.map(f1).join(',')).join('L')}Z" fill="${on ? '#cfe0ff' : '#0000000d'}"/>`);
      out.push(openingMarkup(op, on ? ACCENT : INK, S));
    }
    // A room with walls gets its size; one without (a space in an imported plan) its name and area.
    out.push(r.walls.length ? roomDims(r, S) : roomName(r, S));
    return out.join('');
  }

  /** A room's name and floor area in the middle of its biggest rectangle, as an architect labels one. */
  function roomName(r: PlanRoom, S: (p: P2) => P2): string {
    const rects = [{ min: r.min, max: r.max }, ...r.annexes];
    const big = rects.reduce((a, b) => ((b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) > (a.max[0] - a.min[0]) * (a.max[1] - a.min[1]) ? b : a));
    const c = S([(big.min[0] + big.max[0]) / 2, (big.min[1] + big.max[1]) / 2]);
    const feet = Math.round(r.area / (inches(12) * inches(12)));
    return (
      `<text class="sk-text" x="${f1(c[0])}" y="${f1(c[1] - 2)}" text-anchor="middle" font-size="14" opacity="0.85">${esc(r.name)}</text>` +
      `<text class="sk-text" x="${f1(c[0])}" y="${f1(c[1] + 13)}" text-anchor="middle" font-size="10.5" opacity="0.6">${feet} sq ft</text>`
    );
  }

  /** Stretches of wall, hatched (a room's side, or a wall piece). */
  function wallMarkup(key: string, pieces: P2[][], stroke: string, S: (p: P2) => P2): string {
    const out: string[] = [];
    for (const [k, piece] of pieces.entries()) {
      const pts = piece.map(S);
      out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="#efe7d6"/>`);
      out.push(`<path d="M${pts.map((p) => p.map(f1).join(',')).join('L')}Z" fill="url(#pv-hatch)"/>`);
      out.push(`<path d="${sketchPoly(pts, `${key}:${k}`)}" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round"/>`);
    }
    return out.join('');
  }

  /** A window (sills and glass), a door (its leaf and swing) or a cased opening, and its width when there's room. */
  function openingMarkup(op: PlanWallOpening, stroke: string, S: (p: P2) => P2): string {
    const out: string[] = [];
    const [i0, i1] = op.inside.map(S) as [P2, P2];
    const [o0, o1] = op.outside.map(S) as [P2, P2];
    if (op.kind === 'window') {
      // Sill lines on both faces and the glass between them.
      const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [m0, m1] = [mid(i0, o0), mid(i1, o1)];
      const off = (p: P2, q: P2, t: number): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      out.push(
        `<path d="${sketchLine(i0, i1, `${op.id}w1`, 1, false)}${sketchLine(o0, o1, `${op.id}w2`, 1, false)}" stroke="${stroke}" stroke-width="1.2" fill="none"/>`,
        `<path d="${sketchLine(off(m0, i0, 0.25), off(m1, i1, 0.25), `${op.id}g1`, 1, false)}${sketchLine(off(m0, o0, 0.25), off(m1, o1, 0.25), `${op.id}g2`, 1, false)}" stroke="${stroke}" stroke-width="0.9" fill="none"/>`,
      );
    } else if (op.door) {
      const h = S(op.door.hinge);
      const leaf = S(op.door.leaf);
      out.push(
        `<path d="${sketchCurve(op.door.arc.map(S), `${op.id}arc`)}" stroke="${stroke}" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/>`,
        `<path d="${sketchLine(h, leaf, `${op.id}leaf`, 2, false)}" stroke="${stroke}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
      );
    } else {
      // A cased opening (or a door with no leaf): the head above, dashed.
      out.push(`<path d="${sketchLine(i0, i1, `${op.id}h1`, 1, false)}${sketchLine(o0, o1, `${op.id}h2`, 1, false)}" stroke="${stroke}" stroke-width="0.9" fill="none" stroke-dasharray="6 4"/>`);
    }
    // Its width, outside the wall.
    const out0 = S(op.outside[0]);
    const out1 = S(op.outside[1]);
    const ins = S(op.inside[0]);
    const away = [out0[0] - ins[0], out0[1] - ins[1]];
    const al = Math.hypot(away[0]!, away[1]!) || 1;
    const tx = (out0[0] + out1[0]) / 2 + (away[0]! / al) * 12;
    const ty = (out0[1] + out1[1]) / 2 + (away[1]! / al) * 12 + 4;
    if (Math.hypot(out1[0] - out0[0], out1[1] - out0[1]) > 26) out.push(`<text class="sk-text" x="${f1(tx)}" y="${f1(ty)}" text-anchor="middle" font-size="11" opacity="0.8">${esc(shopText(fmt(op.width)))}</text>`);
    return out.join('');
  }

  /** The room's inside width above it and depth down its left side, as dimension strings with ticks. */
  function roomDims(r: PlanRoom, S: (p: P2) => P2): string {
    const outer = boxOf(r.walls.flatMap((w) => w.pieces.flat()).concat([r.min, r.max]));
    const gap = 26;
    const top = S([r.min[0], outer.min[1]])[1] - gap;
    const left = S([outer.min[0], r.min[1]])[0] - gap;
    const [x0, x1] = [S(r.min)[0], S(r.max)[0]];
    const [z0, z1] = [S(r.min)[1], S(r.max)[1]];
    const tick = (x: number, y: number) => `M${f1(x - 5)},${f1(y + 5)}L${f1(x + 5)},${f1(y - 5)}`;
    const d =
      sketchLine([x0, top], [x1, top], `${r.id}dw`, 1) +
      sketchLine([left, z0], [left, z1], `${r.id}dd`, 1) +
      tick(x0, top) + tick(x1, top) + tick(left, z0) + tick(left, z1) +
      `M${f1(x0)},${f1(top - 6)}V${f1(top + 10)}M${f1(x1)},${f1(top - 6)}V${f1(top + 10)}M${f1(left - 6)},${f1(z0)}H${f1(left + 10)}M${f1(left - 6)},${f1(z1)}H${f1(left + 10)}`;
    const w = shopText(fmt(r.max[0] - r.min[0]));
    const dd = shopText(fmt(r.max[1] - r.min[1]));
    const zm = (z0 + z1) / 2;
    return (
      `<path d="${d}" stroke="${INK}" stroke-width="0.9" fill="none" opacity="0.85"/>` +
      `<text class="sk-text" x="${f1((x0 + x1) / 2)}" y="${f1(top - 6)}" text-anchor="middle" font-size="14">${esc(w)}</text>` +
      `<text class="sk-text" x="${f1(left - 6)}" y="${f1(zm)}" text-anchor="middle" font-size="14" transform="rotate(-90 ${f1(left - 6)} ${f1(zm)})">${esc(dd)}</text>`
    );
  }

  /** Labels placed this redraw (screen boxes), so one piece's name never prints over another's. */
  let labels: { min: P2; max: P2 }[] = [];
  function itemLabel(i: PlanItem, pts: P2[]): string {
    const b = boxOf(pts);
    const [w, h] = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
    const c: P2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
    // Along the piece's long side on screen; a narrow upright piece gets it turned.
    const turned = h > w * 1.4 && w < 90;
    const room = turned ? h : w;
    const name = i.name.length * 6.6 < room - 8 ? i.name : room > 40 ? `${i.name.slice(0, Math.max(3, Math.floor((room - 14) / 6.6)))}…` : '';
    const dims = shopText(`${fmt(i.width)} × ${fmt(i.depth)}`);
    const showDims = dims.length * 5.6 < room - 6 && (turned ? w : h) > 30;
    if (!name) return '';
    const half: P2 = turned ? [8, Math.min(room, name.length * 6.6) / 2] : [Math.min(room, name.length * 6.6) / 2, showDims ? 12 : 8];
    const box = { min: [c[0] - half[0], c[1] - half[1]] as P2, max: [c[0] + half[0], c[1] + half[1]] as P2 };
    if (labels.some((l) => l.min[0] < box.max[0] && box.min[0] < l.max[0] && l.min[1] < box.max[1] && box.min[1] < l.max[1])) return '';
    labels.push(box);
    const rot = turned ? ` transform="rotate(-90 ${f1(c[0])} ${f1(c[1])})"` : '';
    return (
      `<g${rot}>` +
      `<text class="sk-text" x="${f1(c[0])}" y="${f1(c[1] + (showDims ? -2 : 4))}" text-anchor="middle" font-size="12.5">${esc(name)}</text>` +
      (showDims ? `<text class="sk-text" x="${f1(c[0])}" y="${f1(c[1] + 12)}" text-anchor="middle" font-size="10.5" opacity="0.75">${esc(dims)}</text>` : '') +
      `</g>`
    );
  }

  /** With one piece selected in a room: how far it is from each wall (dimension strings, in the accent). */
  function clearances(plan: Plan, sel: Set<string>): string {
    if (sel.size !== 1 || gesture?.kind === 'draw') return '';
    const item = plan.items.find((i) => sel.has(i.id));
    const b = item && boxOf(item.corners);
    const r = b && plan.rooms.find((q) => b.min[0] >= q.min[0] - 1 && b.max[0] <= q.max[0] + 1 && b.min[1] >= q.min[1] - 1 && b.max[1] <= q.max[1] + 1);
    if (!b || !r) return '';
    const out: string[] = [];
    const mz = (b.min[1] + b.max[1]) / 2;
    const mx = (b.min[0] + b.max[0]) / 2;
    const dim = (a: P2, c: P2, n: number, key: string) => {
      if (n < STEP) return;
      const [p, q] = [toScreen(a), toScreen(c)];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 14) return;
      out.push(`<path d="${sketchLine(p, q, key, 1, false)}" stroke="${ACCENT}" stroke-width="1" fill="none"/>`);
      const vertical = Math.abs(q[1] - p[1]) > Math.abs(q[0] - p[0]);
      const m: P2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const t = esc(shopText(fmt(n)));
      out.push(
        vertical
          ? `<text class="sk-text" x="${f1(m[0] + 5)}" y="${f1(m[1] + 4)}" font-size="11.5" fill="${ACCENT}">${t}</text>`
          : `<text class="sk-text" x="${f1(m[0])}" y="${f1(m[1] - 4)}" text-anchor="middle" font-size="11.5" fill="${ACCENT}">${t}</text>`,
      );
    };
    dim([r.min[0], mz], [b.min[0], mz], b.min[0] - r.min[0], 'cl');
    dim([b.max[0], mz], [r.max[0], mz], r.max[0] - b.max[0], 'cr');
    dim([mx, r.min[1]], [mx, b.min[1]], b.min[1] - r.min[1], 'cb');
    dim([mx, b.max[1]], [mx, r.max[1]], r.max[1] - b.max[1], 'cf');
    return out.join('');
  }

  function northArrow(): string {
    // Which way is the back wall: an arrow pointing up the sheet.
    const x = size[0] - 40;
    const y = size[1] - 78;
    return (
      `<g opacity="0.75"><circle cx="${x}" cy="${y}" r="15" fill="none" stroke="${INK}" stroke-width="1"/>` +
      `<path d="M${x},${y - 20}L${x - 6},${y + 6}L${x},${y + 1}L${x + 6},${y + 6}Z" fill="${INK}"/>` +
      `<text class="sk-text" x="${x}" y="${y + 30}" text-anchor="middle" font-size="10">BACK</text></g>`
    );
  }

  // ── hits ──

  type Hit = { kind: 'item'; item: PlanItem } | { kind: 'opening'; opening: PlanOpening } | { kind: 'wall'; room: string; side: RoomSide } | null;
  function hitAt(plan: Plan, w: P2): Hit {
    const pad = 4 / scale;
    for (const r of plan.rooms) {
      for (const op of r.openings) {
        const b = boxOf(openingQuad(op));
        if (w[0] >= b.min[0] - pad && w[0] <= b.max[0] + pad && w[1] >= b.min[1] - pad && w[1] <= b.max[1] + pad) return { kind: 'opening', opening: op };
      }
    }
    // Topmost first: uppers draw last.
    for (let k = plan.items.length - 1; k >= 0; k--) {
      const item = plan.items[k]!;
      if (inPoly(w, item.corners)) return { kind: 'item', item };
    }
    for (const r of plan.rooms) for (const wall of r.walls) if (wall.pieces.some((piece) => inPoly(w, piece))) return { kind: 'wall', room: r.id, side: wall.side };
    return null;
  }
  const hitKey = (h: Hit) => (!h ? null : h.kind === 'item' ? h.item.id : h.kind === 'wall' ? `${h.room}:wall` : `${h.opening.room}:${h.opening.id}`);
  const gripAt = (x: number, y: number) => grips.find((g) => Math.abs(g.at[0] - x) <= 7 && Math.abs(g.at[1] - y) <= 7);

  // ── edits ──

  function dispatch(ops: Op[]): boolean {
    if (!ops.length) return true;
    const blocked = o.editBlocked();
    if (blocked) {
      toast(blocked, true);
      return false;
    }
    const r = store.dispatch(ops);
    if (!r.ok) toast(r.error, true);
    return r.ok;
  }

  const openingsOp = (room: string, p: RoomParams): Op => ({ op: 'update', id: room, patch: { params: { openings: p.openings } } });

  /** Sliding an opening along its wall from where it was grabbed (stopping against its neighbors, as in 3D). */
  function slideSolver(op: PlanOpening, from: P2): (w: P2) => Op[] {
    const base = store.doc;
    const asm = base.assemblies[op.room];
    const o0 = asm && roomParams(asm).openings.find((q) => q.id === op.id);
    if (!asm || !o0) return () => [];
    const p = roomParams(asm);
    const grab = alongWall(p, op.wall, coordOn(op.wall, from)) - openingEdges(p, o0)[0];
    return (w) => {
      const slid = slideOpening(p, op.id, op.wall, alongWall(p, op.wall, coordOn(op.wall, w)) - grab, inches(1), inches(2));
      return slid && slid.opening.at !== o0.at ? [openingsOp(op.room, withOpening(p, slid.opening))] : [];
    };
  }

  /** Moving pieces: their edges snap to the walls and the other pieces, else to the 1/2" grid. */
  function moveSolver(ids: string[], from: P2): (w: P2) => Op[] {
    const base = store.doc;
    const plan = floorPlan(base);
    const moving = new Set(ids);
    const b = boxOf(plan.items.filter((i) => moving.has(i.id)).flatMap((i) => i.corners));
    const { xs, zs } = snapLines(plan, moving);
    return (w) => {
      let dx = w[0] - from[0];
      let dz = w[1] - from[1];
      const tol = SNAP_PX / scale;
      const sx = snapShift([b.min[0] + dx, b.max[0] + dx], xs, tol);
      const sz = snapShift([b.min[1] + dz, b.max[1] + dz], zs, tol);
      dx = sx !== null ? dx + sx : Math.round(dx / STEP) * STEP;
      dz = sz !== null ? dz + sz : Math.round(dz / STEP) * STEP;
      return moveOps(base, ids, [Math.round(dx), 0, Math.round(dz)]);
    };
  }

  function addBlock(a: P2, b: P2) {
    if (mode === 'select') return;
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [z0, z1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    if (x1 - x0 < inches(1) || z1 - z0 < inches(1)) return;
    const span = BLOCK_SPANS[mode];
    // Its back to the nearest wall, its front to the room.
    const plan = floorPlan(store.doc);
    const r = plan.rooms.find((q) => (x0 + x1) / 2 >= q.min[0] && (x0 + x1) / 2 <= q.max[0] && (z0 + z1) / 2 >= q.min[1] && (z0 + z1) / 2 <= q.max[1]);
    let dir: V3 = [0, 0, 1];
    if (r) {
      const gaps: [number, V3][] = [
        [z0 - r.min[1], [0, 0, 1]],
        [x0 - r.min[0], [1, 0, 0]],
        [r.max[0] - x1, [-1, 0, 0]],
        [r.max[1] - z1, [0, 0, -1]],
      ];
      dir = gaps.reduce((m, g) => (g[0] < m[0] ? g : m))[1];
    }
    // A long thin block faces across its length, whatever the walls say.
    if ((dir[0] !== 0 && x1 - x0 > (z1 - z0) * 2.5) || (dir[2] !== 0 && z1 - z0 > (x1 - x0) * 2.5)) dir = dir[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
    const { transform, size: sz } = blockPlacement(IDENTITY, { min: [x0, span.bottom, z0], max: [x1, span.top, z1] }, facingToward(IDENTITY, dir));
    const id = nextId(store.doc, 'b');
    if (dispatch([{ op: 'add', entity: { kind: 'block', id, transform, size: sz } }])) selection.set([{ node: id }]);
  }

  function addOpening(kind: OpeningKind) {
    const doc = store.doc;
    const room = roomOf(doc);
    if (!room) return toast('Add a room first.', true);
    const p = roomParams(room);
    const plan = floorPlan(doc);
    const wall = selectedOpenings(plan)[0]?.wall;
    const next = (wall && placeOpening(p, kind, wall)) ?? placeOpening(p, kind);
    if (!next) return toast(`No wall has room for a ${kind}.`, true);
    if (!dispatch([{ op: 'update', id: room.id, patch: { params: { openings: [...p.openings, next] } } }])) return;
    const op = floorPlan(store.doc).rooms.flatMap((r) => r.openings).find((q) => q.room === room.id && q.id === next.id);
    if (op) selection.set([openingTarget(store.doc, op)]);
    toast(`Added ${openingLabel(next)} on the ${next.wall} wall. Drag it along the wall to place it.`);
  }

  function addRoom() {
    const doc = store.doc;
    if (roomOf(doc)) return;
    if (dispatch([{ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: roomAround(doc).params } } }])) {
      fit();
      toast('Room added around the model. Add windows and doors from the bar below.');
    }
  }

  function removeSelected() {
    const doc = store.doc;
    const plan = floorPlan(doc);
    const items = [...selectedItems(plan, doc)];
    const ops: Op[] = items.map((id) => ({ op: 'delete', id }));
    const gone = selectedOpenings(plan);
    for (const room of new Set(gone.map((g) => g.room))) {
      const asm = doc.assemblies[room];
      if (!asm) continue;
      const drop = new Set(gone.filter((g) => g.room === room).map((g) => g.id));
      ops.push({ op: 'update', id: room, patch: { params: { openings: roomParams(asm).openings.filter((q) => !drop.has(q.id)) } } });
    }
    if (ops.length && dispatch(ops)) selection.set([]);
  }

  function turnSelected() {
    const doc = store.doc;
    const plan = floorPlan(doc);
    const ids = [...selectedItems(plan, doc)];
    if (!ids.length) return toast('Select a piece to turn first.', true);
    const b = boxOf(plan.items.filter((i) => ids.includes(i.id)).flatMap((i) => i.corners));
    const pivot: V3 = [Math.round((b.min[0] + b.max[0]) / 2), 0, Math.round((b.min[1] + b.max[1]) / 2)];
    dispatch(turnOps(doc, ids, pivot, [0, 1, 0], -90));
  }

  // ── pointer ──

  function snapPoint(w: P2, plan: Plan): P2 {
    const { xs, zs } = snapLines(plan, new Set());
    const tol = SNAP_PX / scale;
    const sx = snapShift([w[0]], xs, tol);
    const sz = snapShift([w[1]], zs, tol);
    return [sx !== null ? w[0] + sx : Math.round(w[0] / STEP) * STEP, sz !== null ? w[1] + sz : Math.round(w[1] / STEP) * STEP];
  }

  svg.addEventListener('pointerdown', (e) => {
    if (gesture) return;
    svg.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    const w = toWorld(x, y);
    const doc = store.doc;
    const plan = floorPlan(doc);
    if (e.button === 1 || e.button === 2) {
      gesture = { kind: 'pan', x, y, cx, cz, moved: false, clear: false };
      root.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    if (mode !== 'select') {
      const a = snapPoint(w, plan);
      gesture = { kind: 'draw', a, b: a };
      return render();
    }
    const grip = gripAt(x, y);
    if (grip) {
      gesture = { kind: 'edit', x, y, moved: false, ops: [], solve: grip.start(w), cursor: grip.cursor };
      return;
    }
    const hit = hitAt(plan, w);
    if (!hit) {
      gesture = { kind: 'pan', x, y, cx, cz, moved: false, clear: !e.shiftKey };
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit.kind === 'opening') {
      const t = openingTarget(doc, hit.opening);
      if (additive) selection.toggle(t);
      else if (!openingSelected(hit.opening)) selection.set([t]);
      gesture = { kind: 'edit', x, y, moved: false, ops: [], solve: slideSolver(hit.opening, w), cursor: 'grabbing' };
      return;
    }
    if (hit.kind === 'wall') {
      const t = { node: genPartId(hit.room, `wall-${hit.side}`) };
      if (additive) selection.toggle(t);
      else selection.set([t]);
      return;
    }
    const id = hit.item.id;
    const sel = selectedItems(plan, doc);
    if (additive) selection.toggle({ node: id });
    else if (!sel.has(id)) selection.set([{ node: id }]);
    const ids = [...selectedItems(plan, doc)];
    gesture = { kind: 'edit', x, y, moved: false, ops: [], solve: moveSolver(ids.includes(id) ? ids : [id], w), cursor: 'grabbing' };
  });

  svg.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    const w = toWorld(x, y);
    if (!gesture) {
      const grip = mode === 'select' ? gripAt(x, y) : undefined;
      svg.style.cursor = grip ? grip.cursor : '';
      const next = mode === 'select' && !grip ? hitKey(hitAt(floorPlan(o.shown()), w)) : null;
      if (next !== hover) {
        hover = next;
        render();
      }
      return;
    }
    const doc = store.doc;
    if (gesture.kind === 'pan') {
      if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < CLICK_PX) return;
      gesture.moved = true;
      cx = gesture.cx - (x - gesture.x) / scale;
      cz = gesture.cz - (y - gesture.y) / scale;
      root.classList.add('panning');
      return render();
    }
    if (gesture.kind === 'draw') {
      gesture.b = snapPoint(w, floorPlan(doc));
      return render();
    }
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < CLICK_PX) return;
    if (!gesture.moved && o.editBlocked()) {
      toast(o.editBlocked()!, true);
      gesture = null;
      return;
    }
    gesture.moved = true;
    svg.style.cursor = gesture.cursor;
    const ops = gesture.solve(w);
    const r = ops.length ? applyOps(doc, ops) : null;
    // A step the model refuses (a wall past an opening, a room too small) keeps the last good one.
    if (r && !r.ok) return;
    gesture.ops = ops;
    o.setPreview(r?.ok ? r.doc : null);
  });

  const finish = (e: PointerEvent, cancel = false) => {
    const g = gesture;
    if (!g) return;
    gesture = null;
    root.classList.remove('panning');
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    if (g.kind === 'pan') {
      if (!g.moved && g.clear && !cancel) selection.set([]);
      return render();
    }
    if (g.kind === 'draw') {
      if (!cancel) addBlock(g.a, g.b);
      return render();
    }
    o.setPreview(null);
    svg.style.cursor = '';
    if (g.moved && !cancel) dispatch(g.ops);
  };
  svg.addEventListener('pointerup', (e) => finish(e));
  svg.addEventListener('pointercancel', (e) => finish(e, true));
  svg.addEventListener('contextmenu', (e) => e.preventDefault());
  svg.addEventListener('pointerleave', () => {
    if (hover && !gesture) {
      hover = null;
      render();
    }
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const before = toWorld(x, y);
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      scale = Math.min(Math.max(scale * k, 0.02), 6);
      const after = toWorld(x, y);
      cx += before[0] - after[0];
      cz += before[1] - after[1];
      render();
    },
    { passive: false },
  );
  new ResizeObserver(() => {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    size = [r.width, r.height];
    render();
  }).observe(root);

  // ── the bar ──

  const HINTS: Record<Mode, string> = {
    select: 'Drag pieces, windows and doors to move them, and the blue grips to resize (click a wall for the room’s). Drag the paper to pan, scroll to zoom. Q turns, Del deletes.',
    base: 'Drag out a base block (34 ½″ high). Its back goes to the nearest wall.',
    upper: 'Drag out an upper (54″ to 84″ off the floor), drawn dashed.',
    tall: 'Drag out a tall block (floor to 84″).',
  };
  const modeBtns = new Map<Mode, HTMLButtonElement>();
  function setMode(next: Mode) {
    mode = next;
    gesture = null;
    root.classList.toggle('drawing', mode !== 'select');
    for (const [m, b] of modeBtns) b.setAttribute('aria-pressed', String(m === mode));
    hint.textContent = HINTS[mode];
    hint.style.display = '';
    render();
  }
  const mk = (label: string, title: string, run: () => void, ic?: Parameters<typeof icon>[0], key?: string) => {
    const b = el('button', { class: 'btn ghost sm', title }, ...(ic ? [icon(ic)] : []), label, ...(key ? [el('kbd', {}, key)] : []));
    b.addEventListener('click', () => {
      run();
      b.blur();
    });
    return b;
  };
  function paintBar() {
    const doc = store.doc;
    modeBtns.clear();
    const select = mk('Select', 'Select and move (Space)', () => setMode('select'), 'pointer');
    modeBtns.set('select', select);
    const blocks = (['base', 'upper', 'tall'] as const).map((m) => {
      const s = BLOCK_SPANS[m];
      const b = mk(s.label, `Draw a ${s.label.toLowerCase()} block (${s.key})`, () => setMode(m), 'box', s.key);
      modeBtns.set(m, b);
      return b;
    });
    const room = roomOf(doc);
    const openings = room
      ? [mk('Window', 'Add a window (on the selected one’s wall, else where there’s room)', () => addOpening('window'), 'plus'), mk('Door', 'Add a door', () => addOpening('door'), 'plus'), mk('Opening', 'Add a cased opening', () => addOpening('opening'), 'plus')]
      : [mk('Room', 'Put a room around the model', addRoom, 'room')];
    bar.replaceChildren(
      select,
      el('span', { class: 'sep' }),
      ...blocks,
      el('span', { class: 'sep' }),
      ...openings,
      el('span', { class: 'sep' }),
      mk('', 'Turn the selection a quarter (Q)', turnSelected, 'rotate'),
      mk('', 'Fit the plan to the view (F)', () => (fit(), render()), 'extents'),
      mk('', 'Back to 3D (Shift+2, Esc)', () => toggle(false), 'x'),
    );
    for (const [m, b] of modeBtns) b.setAttribute('aria-pressed', String(m === mode));
  }
  let hasRoom: boolean | null = null;

  // ── keys and toggling ──

  function onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z' && !e.shiftKey) store.undo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) store.redo();
      else return false;
      return true;
    }
    if (e.altKey) return false;
    if (e.shiftKey && e.code === 'Digit2') return toggle(false), true;
    if (e.shiftKey) return false;
    if (k === 'escape') {
      if (gesture?.kind === 'draw') gesture = null;
      else if (mode !== 'select') setMode('select');
      else if (selection.targets.length) selection.set([]);
      else toggle(false);
      render();
      return true;
    }
    if (k === 'delete' || k === 'backspace') return removeSelected(), true;
    if (k === ' ') return setMode('select'), true;
    if (k === 'b' || k === 'r') return setMode('base'), true;
    if (k === 'u') return setMode('upper'), true;
    if (k === 't') return setMode('tall'), true;
    if (k === 'q') return turnSelected(), true;
    if (k === 'f') return fit(), render(), true;
    return false;
  }

  function toggle(on = !active): void {
    if (on === active) return;
    active = on;
    btn.setAttribute('aria-pressed', String(on));
    root.style.display = on ? '' : 'none';
    if (on) {
      o.quiesce();
      const r = root.getBoundingClientRect();
      size = [r.width || 1, r.height || 1];
      fitted = false;
      hasRoom = null;
      releaseKeys = claimKeys({ keydown: onKey });
      setMode('select');
      refresh();
    } else {
      gesture = null;
      hover = null;
      o.setPreview(null);
      releaseKeys?.();
      releaseKeys = null;
    }
  }

  function refresh() {
    if (!active) return;
    const room = !!roomOf(store.doc);
    if (room !== hasRoom) {
      hasRoom = room;
      paintBar();
    }
    render();
  }

  btn.addEventListener('click', () => toggle());
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (active || e.defaultPrevented || e.repeat || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'Digit2') return;
    if (t.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    toggle(true);
  });
  selection.subscribe(() => active && render());

  return {
    get active() {
      return active;
    },
    toggle,
    refresh,
  };
}
