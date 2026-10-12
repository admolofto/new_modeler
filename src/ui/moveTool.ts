import { arrayCopyOps, parseArray } from '../edit/array';
import { BLOCK_STEP, moveOps } from '../edit/blocks';
import { duplicateOps } from '../edit/duplicate';
import { gizmoPlace, targetsOf, type GizmoPlace } from '../edit/gizmo';
import { add, alongLine, dot, length, onPlane, scale, sub, unit } from '../edit/rays';
import { inferMove, type Snap } from '../edit/snap';
import type { V3 } from '../geometry/types';
import { movingParts } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { PALETTE } from '../render/palette';
import type { Inferred } from './inference';
import { SNAP_PX } from './interaction';
import { amend, arrowAxis, AXES, column, cursorLabel, grabNodes, nearAxis, selectedParts, signOf, type Axis, type ToolContext } from './toolKit';
import type { Tool } from './tools';
import { fmt, parse } from './units';

/**
 * Move (M), as in SketchUp: click a point on what should move, move, click where that point goes —
 * or press, drag and let go. It moves what's selected (a selected face stands for its part), else
 * the piece under the first click; a cabinet moves whole, like the gizmo. The point lands on
 * corners, the middles of edges and along edges of everything else; otherwise it follows the red,
 * green or blue axis when the cursor is near one, and slides across the floor when it isn't,
 * snapping against, in line with or centered on its neighbors (edit/snap.ts) or to the grid. Arrow
 * keys lock an axis (→ red, ← green, ↑ blue; again to let go), holding Shift locks the one it's
 * on, Ctrl switches to moving a copy. Type a distance and Enter at any time, even just after, to
 * set it exactly; after a copy, `3x` makes a row of three and `/3` spaces three evenly up to it.
 */

type Dup = ReturnType<typeof duplicateOps>;

interface Moving {
  ids: string[];
  base: Doc;
  place: GizmoPlace;
  /** The point that was grabbed (world model units). */
  grab: V3;
  /** A copy moves instead, starting where the original is. */
  copy: Dup | null;
  /** The parts in motion: the point is inferred on everything else. */
  exclude: Set<string>;
  /** The axis the move is following right now, locked or not. */
  axis: Axis | null;
  delta: V3;
  ops: Op[];
  error: string | null;
  /** Whether what moves was selected (else it was picked by the first click). */
  selected: boolean;
  step: number;
}

interface Done {
  before: Doc;
  after: Doc;
  ids: string[];
  delta: V3;
  copy: boolean;
  selected: boolean;
}

export function moveTool(ctx: ToolContext): Tool {
  const { store, selection, infer, tools, draft } = ctx;
  const label = cursorLabel();
  let mv: Moving | null = null;
  let last: Done | null = null;
  /** The locked axis (arrow keys; kept for the next move too), and whether Shift is holding it. */
  let lock: Axis | null = null;
  let shiftLock = false;

  const zero = (d: V3) => d.every((c) => Math.abs(c) < 0.5);

  /** The ops that put what moves (or its copy) `delta` away. */
  const opsFor = (m: Pick<Moving, 'base' | 'ids' | 'copy'>, delta: V3): Op[] =>
    m.copy ? [...m.copy.ops, ...moveOps(m.copy.doc, m.copy.copies, delta)] : moveOps(m.base, m.ids, delta);

  function setCopy(on: boolean) {
    const m = mv!;
    if (on === !!m.copy) return;
    if (!on) {
      m.copy = null;
      m.exclude = movingParts(m.base, m.ids);
      return;
    }
    try {
      m.copy = duplicateOps(m.base, m.ids);
      m.exclude = movingParts(m.copy.doc, m.copy.copies);
    } catch (err) {
      ctx.onStatus(`Can't copy that: ${(err as Error).message}`, true);
    }
  }

  function apply(e: PointerEvent | null, delta: V3, axis: Axis | null, why: string[], mark: Inferred | null, snapNode: string | null) {
    const m = mv!;
    const ops = zero(delta) ? (m.copy?.ops ?? []) : opsFor(m, delta);
    const r = ops.length ? applyOps(m.base, ops) : ({ ok: true, doc: m.base } as const);
    m.axis = axis;
    ctx.setSnapNode(snapNode);
    if (r.ok) {
      m.delta = delta;
      m.ops = ops;
      m.error = null;
      ctx.setPreview(r.doc);
    } else m.error = r.error;
    const far = Math.round(length(m.delta));
    const to = add(m.grab, m.delta);
    draft.set({
      marks: [{ at: m.grab, color: PALETTE.rubber }, ...(mark ? [{ at: mark.at, color: mark.color }] : [])],
      lines: [{ a: m.grab, b: to, color: axis === null ? PALETTE.rubber : AXES[axis]!.color }],
    });
    tools.measure('Length', fmt(far));
    const text = [`${m.copy ? 'copy ' : ''}${fmt(far)}`, ...(axis !== null ? [`On ${AXES[axis]!.name} Axis${lock === axis ? ' (locked)' : ''}`] : []), ...why.filter(Boolean)].join(' · ');
    if (e) label.show(e, r.ok ? text : `${text} — ${r.error.split('\n')[0]}`, !r.ok);
  }

  function update(e: PointerEvent) {
    const m = mv!;
    infer.aim(e);
    const F = m.place.frame.m;
    const D: V3[] = [column(F, 0), column(F, 1), column(F, 2)];
    const tol = e.altKey ? 0 : SNAP_PX * infer.unitsPerPx(m.grab);
    const step = e.altKey ? 1 : m.step;
    const ray = infer.ray();
    const boxes = m.copy ? m.place.all : m.place.others;
    const along = (k: Axis, raw: number): Snap =>
      (tol && m.place.box ? inferMove(ctx.view(m.base), k, m.place.box, raw, tol, boxes, m.place.upright ? 0 : undefined) : null) ?? { s: Math.round(raw / step) * step, label: '', node: '' };
    const near = e.altKey ? null : infer.point({ exclude: m.exclude, ground: false });
    // A corner, a midpoint or an edge of something that stays put: the grabbed point lands on it.
    const point = near && near.kind !== 'face' ? near : null;
    const onAxis = (k: Axis) => {
      if (point) return apply(e, scale(D[k]!, Math.round(dot(sub(point.at, m.grab), D[k]!))), k, [point.label], point, point.part);
      const t = alongLine(ray, m.grab, D[k]!);
      if (t === null) return; // looking straight down the axis
      const s = along(k, t);
      apply(e, scale(D[k]!, s.s), k, [s.label], null, s.node || null);
    };
    if (lock !== null) return onAxis(lock);
    if (point) {
      const d = sub(point.at, m.grab);
      const k = ([0, 1, 2] as const).find((i) => Math.abs(Math.abs(dot(d, D[i]!)) - length(d)) < 0.5 && !zero(d));
      return apply(e, d, k ?? null, [point.label], point, point.part);
    }
    const k = nearAxis(infer, e, m.grab, D);
    if (k !== null) return onAxis(k);
    // Free: across the floor plane through the grabbed point, each way snapping on its own.
    const hit = onPlane(ray, m.grab, D[1]!);
    if (!hit) return;
    const v = sub(hit, m.grab);
    const [sx, sz] = [along(0, dot(v, D[0]!)), along(2, dot(v, D[2]!))];
    apply(e, add(scale(D[0]!, sx.s), scale(D[2]!, sz.s)), null, [sx.label, sz.label], null, sx.node || sz.node || null);
  }

  function end() {
    mv = null;
    shiftLock = false;
    label.hide();
    draft.set(null);
    ctx.setSnapNode(null);
    ctx.setPreview(null);
    tools.hint(null);
  }

  function commit() {
    const m = mv;
    if (!m) return;
    end();
    lock = null;
    const blocked = ctx.editBlocked();
    if (blocked) return ctx.onStatus(blocked, true);
    if (zero(m.delta) || !m.ops.length) return;
    const r = store.dispatch(m.ops);
    if (!r.ok) return ctx.onStatus(r.error, true);
    last = { before: m.base, after: store.doc, ids: m.ids, delta: m.delta, copy: !!m.copy, selected: m.selected };
    if (m.copy && m.selected) selection.set(targetsOf(store.doc, m.copy.copies));
    tools.hint(m.copy ? 'Type 3x for a row of three, /3 to space three evenly, or a distance to change it.' : 'Type a distance to change it, or click the next thing to move.');
    ctx.onStatus(m.error ? `Stopped at the last spot that works: ${m.error.split('\n')[0]}` : '', !!m.error);
  }

  function start(e: PointerEvent) {
    const blocked = ctx.editBlocked();
    if (blocked) return ctx.onStatus(blocked, true);
    infer.aim(e);
    const base = store.doc;
    const p = infer.point();
    const grabbed = grabNodes(base, selection.targets, p?.part ?? null);
    const place = grabbed && gizmoPlace(base, grabbed.ids);
    if (!grabbed || !place) return;
    const { ids } = grabbed;
    mv = {
      ids,
      base,
      place,
      grab: p?.at ?? place.pivot,
      copy: null,
      exclude: movingParts(base, ids),
      axis: null,
      delta: [0, 0, 0],
      ops: [],
      error: null,
      selected: grabbed.selected,
      step: ids.every((id) => base.parts[id]?.block) ? BLOCK_STEP : 4,
    };
    if (e.ctrlKey || e.metaKey) setCopy(true);
    selection.setHover(null);
    tools.hint('Click where it goes. Arrow keys lock an axis, Ctrl moves a copy; or type a distance and Enter.');
    update(e);
  }

  /** Re-does the move just made with what was typed: a new distance, or a row of copies. */
  function retype(text: string) {
    const done = last;
    if (!done) return ctx.onStatus('Click what to move first, then type how far.', true);
    const moved = (ops: Op[], delta: V3) => {
      const r = amend(store, done, ops);
      if (!r) return ctx.onStatus('The model has changed since: move it again, then type the distance.', true);
      if (!r.ok) return ctx.onStatus(r.error.split('\n')[0]!, true);
      last = { ...done, after: store.doc, delta };
      return r;
    };
    const spec = parseArray(text);
    if (spec) {
      if (!done.copy) return ctx.onStatus('Rows are for copies: hold Ctrl while moving to copy, then type 3x or /3.', true);
      try {
        const row = arrayCopyOps(done.before, done.ids, spec, (doc, copies, f) => moveOps(doc, copies, scale(done.delta, f)));
        if (moved(row.ops, done.delta) && done.selected) selection.set(targetsOf(store.doc, row.copies));
      } catch (err) {
        ctx.onStatus(`Can't copy that: ${(err as Error).message}`, true);
      }
      return;
    }
    const [sign, rest] = signOf(text);
    const u = parse(rest);
    const dir = unit(done.delta);
    if (u === null || !dir) return ctx.onStatus(`"${text}" isn't a distance — try 24, 3 1/2 or 18mm (after a copy: 3x or /3).`, true);
    const delta = scale(dir, sign * u);
    try {
      const copy = done.copy ? duplicateOps(done.before, done.ids) : null;
      if (moved(opsFor({ base: done.before, ids: done.ids, copy }, delta), delta) && copy && done.selected) selection.set(targetsOf(store.doc, copy.copies));
      tools.measure('Length', fmt(u));
    } catch (err) {
      ctx.onStatus(`Can't copy that: ${(err as Error).message}`, true);
    }
  }

  store.subscribe((doc) => {
    if (mv && doc !== mv.base) end();
  });

  return {
    id: 'move',
    name: 'Move',
    keys: ['m'],
    icon: 'move',
    hint: 'Click what to move (or select it first), then where it goes. Ctrl: copy.',
    cursor: 'move',
    edits: true,
    down(e) {
      if (mv) commit();
      else start(e);
    },
    move(e) {
      if (mv) return update(e);
      infer.aim(e);
      const p = infer.point({ ground: false });
      const chosen = selectedParts(store.doc, selection.targets).length > 0;
      selection.setHover(p?.part && !chosen && !ctx.editBlocked() ? { node: p.part } : null);
      draft.set(p ? { marks: [{ at: p.at, color: p.color }] } : null);
      label.show(e, p?.label ?? '');
    },
    up(e, dragged) {
      if (mv && dragged) {
        update(e);
        commit();
      }
    },
    leave() {
      if (mv) return;
      selection.setHover(null);
      draft.set(null);
      label.hide();
    },
    key(e) {
      const k = arrowAxis(e.key);
      if (k !== null) {
        lock = lock === k ? null : k;
        shiftLock = false;
        if (mv) tools.refresh();
        else tools.hint(lock === null ? null : `Locked to the ${AXES[lock]!.name.toLowerCase()} axis. Click what to move.`);
        return true;
      }
      if (!mv) return false;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        end();
        return true;
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        if (!e.repeat) {
          setCopy(!mv.copy);
          tools.refresh();
        }
        return true;
      }
      if (e.key === 'Shift' && !e.repeat && lock === null && mv.axis !== null) {
        lock = mv.axis;
        shiftLock = true;
        tools.refresh();
        return true;
      }
      return false;
    },
    keyup(e) {
      if (e.key !== 'Shift' || !shiftLock) return;
      shiftLock = false;
      lock = null;
      if (mv) tools.refresh();
    },
    typed(text) {
      if (!mv) return retype(text);
      if (parseArray(text)) return ctx.onStatus('Place the copy first, then type 3x or /3.', true);
      const [sign, rest] = signOf(text);
      const u = parse(rest);
      if (u === null) return ctx.onStatus(`"${text}" isn't a distance — try 24, 3 1/2 or 18mm.`, true);
      const dir = unit(mv.delta) ?? (lock !== null ? column(mv.place.frame.m, lock) : null);
      if (!dir) return ctx.onStatus('Move the cursor the way it should go, then type the distance.', true);
      apply(null, scale(dir, sign * u), mv.axis, [], null, null);
      if (mv.error) {
        const error = mv.error.split('\n')[0]!;
        end();
        return ctx.onStatus(error, true);
      }
      commit();
    },
    cancel() {
      if (mv) {
        end();
        return true;
      }
      if (lock === null) return false;
      lock = null;
      tools.hint(null);
      return true;
    },
    exit() {
      if (mv) end();
      draft.set(null);
      label.hide();
      lock = null;
      last = null;
    },
  };
}
