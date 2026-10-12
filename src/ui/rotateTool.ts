import { arrayCopyOps, parseAngle, parseArray } from '../edit/array';
import { turnOps } from '../edit/blocks';
import { duplicateOps } from '../edit/duplicate';
import { targetsOf } from '../edit/gizmo';
import { add, angleAbout, inPlane, onPlane, scale, sub, unit } from '../edit/rays';
import type { V3 } from '../geometry/types';
import { movingParts } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { PALETTE } from '../render/palette';
import type { DraftLine } from '../render/toolDraft';
import type { Inferred } from './inference';
import { amend, arrowAxis, AXES, cursorLabel, grabNodes, selectedParts, type Axis, type ToolContext } from './toolKit';
import type { Tool } from './tools';

/**
 * Rotate (Q), as in SketchUp: click where the protractor's center goes, click a point to turn from,
 * then move and click where that point turns to. It turns the selection, else the piece under the
 * first click. The protractor lies flat (it turns about the blue, upright axis) unless an arrow key
 * stands it up: → about red, ← about green, ↑ blue again. Angles go in 15° steps (Alt: 1°), or
 * exactly onto a corner or an edge under the cursor; type an angle and Enter at any time, even
 * just after. Ctrl turns a copy instead; after a copy, `3x` makes three, each turned as far again,
 * and `/3` spaces three evenly up to it.
 */

type Dup = ReturnType<typeof duplicateOps>;

interface Turning {
  ids: string[];
  base: Doc;
  center: V3;
  copy: Dup | null;
  exclude: Set<string>;
  selected: boolean;
  /** The direction turned from (unit, in the protractor's plane); null until the second click. */
  from: V3 | null;
  deg: number;
  ops: Op[];
  error: string | null;
}

interface Done {
  before: Doc;
  after: Doc;
  ids: string[];
  center: V3;
  axis: V3;
  deg: number;
  copy: boolean;
  selected: boolean;
}

const UNIT: V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** The protractor's radius on screen. */
const RADIUS_PX = 64;
const degrees = (d: number) => `${Math.round(d * 10) / 10}°`;

export function rotateTool(ctx: ToolContext): Tool {
  const { store, selection, infer, tools, draft } = ctx;
  const label = cursorLabel();
  /** The axis turned about: blue (upright) unless an arrow key picked another. */
  let axis: Axis = 1;
  let turn: Turning | null = null;
  let last: Done | null = null;

  /** The protractor at a point: a circle across the axis with a tick every 45°, in the axis' color. */
  function protractor(center: V3): { lines: DraftLine[]; r: number } {
    const r = RADIUS_PX * infer.unitsPerPx(center);
    const [u, v] = [UNIT[(axis + 1) % 3]!, UNIT[(axis + 2) % 3]!];
    const at = (deg: number, k = 1): V3 => {
      const a = (deg * Math.PI) / 180;
      return add(center, add(scale(u, Math.cos(a) * r * k), scale(v, Math.sin(a) * r * k)));
    };
    const color = AXES[axis]!.color;
    const lines: DraftLine[] = [];
    for (let d = 0; d < 360; d += 7.5) lines.push({ a: at(d), b: at(d + 7.5), color });
    for (let d = 0; d < 360; d += 45) lines.push({ a: at(d, 0.86), b: at(d), color });
    return { lines, r };
  }

  const opsFor = (t: Pick<Turning, 'base' | 'ids' | 'copy' | 'center'>, A: V3, deg: number): Op[] => {
    const [from, ids] = t.copy ? [t.copy.doc, t.copy.copies] : [t.base, t.ids];
    return [...(t.copy?.ops ?? []), ...(deg ? turnOps(from, ids, t.center, A, deg) : [])];
  };

  function setCopy(on: boolean) {
    const t = turn!;
    if (on === !!t.copy) return;
    if (!on) {
      t.copy = null;
      t.exclude = movingParts(t.base, t.ids);
      return;
    }
    try {
      t.copy = duplicateOps(t.base, t.ids);
      t.exclude = movingParts(t.copy.doc, t.copy.copies);
    } catch (err) {
      ctx.onStatus(`Can't copy that: ${(err as Error).message}`, true);
    }
  }

  /** Where the cursor points on the protractor's plane: a corner or an edge under it, else the plane itself. */
  function aimed(e: PointerEvent, t: Turning): { at: V3; snap: Inferred | null } | null {
    infer.aim(e);
    const near = e.altKey ? null : infer.point({ exclude: t.exclude, ground: false });
    if (near && near.kind !== 'face') return { at: near.at, snap: near };
    const hit = onPlane(infer.ray(), t.center, UNIT[axis]!);
    return hit && { at: hit, snap: null };
  }

  function show(e: PointerEvent | null, deg: number, to: V3 | null, snap: Inferred | null) {
    const t = turn!;
    const A = UNIT[axis]!;
    const ops = opsFor(t, A, deg);
    const r = ops.length ? applyOps(t.base, ops) : ({ ok: true, doc: t.base } as const);
    if (r.ok) {
      t.deg = deg;
      t.ops = ops;
      t.error = null;
      ctx.setPreview(r.doc);
    } else t.error = r.error;
    const p = protractor(t.center);
    const arm = (dir: V3 | null, dashed: boolean): DraftLine[] => (dir ? [{ a: t.center, b: add(t.center, scale(dir, p.r * 1.25)), color: PALETTE.rubber, dashed }] : []);
    draft.set({
      marks: [{ at: t.center, color: AXES[axis]!.color }, ...(snap ? [{ at: snap.at, color: snap.color }] : [])],
      lines: [...p.lines, ...arm(t.from, true), ...arm(to && unit(inPlane(sub(to, t.center), A)), false)],
    });
    ctx.setSnapNode(snap?.part ?? null);
    tools.measure('Angle', degrees(t.deg));
    const text = [`${t.copy ? 'copy ' : ''}turned ${degrees(t.deg)}`, ...(snap ? [snap.label] : [])].join(' · ');
    if (e) label.show(e, r.ok ? text : `${text} — ${r.error.split('\n')[0]}`, !r.ok);
  }

  function update(e: PointerEvent) {
    const t = turn!;
    const cur = aimed(e, t);
    if (!cur) return;
    if (!t.from) {
      // Waiting for the point to turn from.
      const p = protractor(t.center);
      const dir = unit(inPlane(sub(cur.at, t.center), UNIT[axis]!));
      draft.set({
        marks: [{ at: t.center, color: AXES[axis]!.color }, ...(cur.snap ? [{ at: cur.snap.at, color: cur.snap.color }] : [])],
        lines: [...p.lines, ...(dir ? [{ a: t.center, b: add(t.center, scale(dir, p.r * 1.25)), color: PALETTE.rubber, dashed: true }] : [])],
      });
      return label.show(e, cur.snap?.label ?? '');
    }
    const raw = angleAbout(t.from, sub(cur.at, t.center), UNIT[axis]!);
    if (raw === null) return;
    const step = e.altKey ? 1 : 15;
    show(e, cur.snap ? Math.round(raw * 10) / 10 : Math.round(raw / step) * step, cur.at, cur.snap);
  }

  function end() {
    turn = null;
    label.hide();
    draft.set(null);
    ctx.setSnapNode(null);
    ctx.setPreview(null);
    tools.hint(null);
  }

  function commit() {
    const t = turn;
    if (!t) return;
    const A = UNIT[axis]!;
    end();
    const blocked = ctx.editBlocked();
    if (blocked) return ctx.onStatus(blocked, true);
    if (!t.deg || !t.ops.length) return;
    const r = store.dispatch(t.ops);
    if (!r.ok) return ctx.onStatus(r.error, true);
    last = { before: t.base, after: store.doc, ids: t.ids, center: t.center, axis: A, deg: t.deg, copy: !!t.copy, selected: t.selected };
    if (t.copy && t.selected) selection.set(targetsOf(store.doc, t.copy.copies));
    tools.hint(t.copy ? 'Type 3x for three copies, /3 to space three evenly, or an angle to change it.' : 'Type an angle to change it, or click the next center.');
    ctx.onStatus(t.error ? `Stopped at the last angle that works: ${t.error.split('\n')[0]}` : '', !!t.error);
  }

  /** A click: the center, then the point to turn from, then where it turns to. */
  function click(e: PointerEvent) {
    if (!turn) {
      const blocked = ctx.editBlocked();
      if (blocked) return ctx.onStatus(blocked, true);
      infer.aim(e);
      const p = infer.point();
      if (!p) return;
      const base = store.doc;
      const grabbed = grabNodes(base, selection.targets, p.part);
      if (!grabbed) return ctx.onStatus('Click on what to turn, or select it first.', true);
      const { ids, selected } = grabbed;
      turn = { ids, base, center: p.at, copy: null, exclude: movingParts(base, ids), selected, from: null, deg: 0, ops: [], error: null };
      if (e.ctrlKey || e.metaKey) setCopy(true);
      selection.setHover(null);
      tools.hint('Click a point to turn from.');
      return update(e);
    }
    if (!turn.from) {
      const cur = aimed(e, turn);
      const dir = cur && unit(inPlane(sub(cur.at, turn.center), UNIT[axis]!));
      if (!dir) return;
      turn.from = dir;
      tools.hint('Move and click to set the angle, or type one and Enter. Ctrl turns a copy; Alt: 1° steps.');
      return update(e);
    }
    update(e);
    commit();
  }

  /** Re-does the turn just made with what was typed: a new angle, or more copies. */
  function retype(text: string) {
    const done = last;
    if (!done) return ctx.onStatus('Click the center and a point to turn from first, then type the angle.', true);
    const turned = (ops: Op[], deg: number) => {
      const r = amend(store, done, ops);
      if (!r) return ctx.onStatus('The model has changed since: turn it again, then type the angle.', true);
      if (!r.ok) return ctx.onStatus(r.error.split('\n')[0]!, true);
      last = { ...done, after: store.doc, deg };
      return r;
    };
    try {
      const spec = parseArray(text);
      if (spec) {
        if (!done.copy) return ctx.onStatus('Rows are for copies: press Ctrl while turning to copy, then type 3x or /3.', true);
        const row = arrayCopyOps(done.before, done.ids, spec, (doc, copies, f) => turnOps(doc, copies, done.center, done.axis, done.deg * f));
        if (turned(row.ops, done.deg) && done.selected) selection.set(targetsOf(store.doc, row.copies));
        return;
      }
      const deg = parseAngle(text);
      if (deg === null) return ctx.onStatus(`"${text}" isn't an angle — try 45 or -22.5 (after a copy: 3x or /3).`, true);
      const signed = (done.deg < 0 ? -1 : 1) * deg;
      const copy = done.copy ? duplicateOps(done.before, done.ids) : null;
      if (turned(opsFor({ base: done.before, ids: done.ids, copy, center: done.center }, done.axis, signed), signed) && copy && done.selected) selection.set(targetsOf(store.doc, copy.copies));
      tools.measure('Angle', degrees(signed));
    } catch (err) {
      ctx.onStatus(`Can't copy that: ${(err as Error).message}`, true);
    }
  }

  store.subscribe((doc) => {
    if (turn && doc !== turn.base) end();
  });

  return {
    id: 'rotate',
    name: 'Rotate',
    keys: ['q'],
    icon: 'rotate',
    hint: 'Click the center to turn about (on what turns, or select it first). Arrow keys stand the protractor up.',
    cursor: 'crosshair',
    edits: true,
    down: click,
    move(e) {
      if (turn) return update(e);
      infer.aim(e);
      const p = infer.point();
      const chosen = selectedParts(store.doc, selection.targets).length > 0;
      selection.setHover(p?.part && !chosen && !ctx.editBlocked() ? { node: p.part } : null);
      draft.set(p ? { marks: p.kind === 'ground' ? [] : [{ at: p.at, color: p.color }], lines: protractor(p.at).lines } : null);
      label.show(e, p?.label ?? '');
    },
    up(e, dragged) {
      if (turn && dragged) click(e);
    },
    leave() {
      if (turn) return;
      selection.setHover(null);
      draft.set(null);
      label.hide();
    },
    key(e) {
      const k = arrowAxis(e.key);
      if (k !== null) {
        // Once the turn has started its axis is set.
        if (!turn?.from) {
          axis = k;
          tools.refresh();
        }
        return true;
      }
      if (!turn) return false;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        end();
        return true;
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        if (!e.repeat) {
          setCopy(!turn.copy);
          tools.refresh();
        }
        return true;
      }
      return false;
    },
    typed(text) {
      if (!turn?.from) return turn ? ctx.onStatus('Click a point to turn from first, then type the angle.', true) : retype(text);
      if (parseArray(text)) return ctx.onStatus('Place the copy first, then type 3x or /3.', true);
      const deg = parseAngle(text);
      if (deg === null) return ctx.onStatus(`"${text}" isn't an angle — try 45 or -22.5.`, true);
      show(null, (turn.deg < 0 ? -1 : 1) * deg, null, null);
      if (turn.error) {
        const error = turn.error.split('\n')[0]!;
        end();
        return ctx.onStatus(error, true);
      }
      commit();
    },
    cancel() {
      if (!turn) return false;
      end();
      return true;
    },
    exit() {
      if (turn) end();
      draft.set(null);
      label.hide();
      axis = 1;
      last = null;
    },
  };
}
