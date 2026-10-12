import { length, sub } from '../edit/rays';
import type { V3 } from '../geometry/types';
import { PALETTE } from '../render/palette';
import type { DraftLine } from '../render/toolDraft';
import type { Inferred } from './inference';
import { AXES, cursorLabel, type ToolContext } from './toolKit';
import type { Tool } from './tools';
import { fmt } from './units';

/**
 * The tape measure (T): click a point, then another — corners, the middles of edges, along edges and
 * on faces all snap, as in the other tools. The distance follows the cursor in the Measurements box,
 * and the line stays, with how far it runs across, up and front to back, until the next
 * measurement. It only measures: nothing in the model changes.
 */
export function tapeTool(ctx: ToolContext): Tool {
  const { infer, tools, draft } = ctx;
  const label = cursorLabel();
  let from: V3 | null = null;
  /** The last measurement, left on screen. */
  let kept: DraftLine[] = [];

  /** The color of the axis a span runs along, else neutral. */
  const colorOf = (d: V3) => {
    const k = ([0, 1, 2] as const).find((i) => d.every((c, j) => j === i || Math.abs(c) < 0.5));
    return k === undefined ? PALETTE.rubber : AXES[k]!.color;
  };
  const span = (a: V3, b: V3): DraftLine => ({ a, b, color: colorOf(sub(b, a)) });
  const mark = (p: Inferred) => (p.kind === 'ground' ? [] : [{ at: p.at, color: p.color }]);

  function update(e: PointerEvent): Inferred | null {
    infer.aim(e);
    const p = infer.point();
    if (!p) {
      draft.set(kept.length ? { lines: kept } : null);
      label.hide();
      return null;
    }
    if (!from) {
      draft.set({ marks: mark(p), lines: kept });
      label.show(e, p.label);
      return p;
    }
    const d = Math.round(length(sub(p.at, from)));
    draft.set({ marks: [{ at: from, color: PALETTE.rubber }, ...mark(p)], lines: [span(from, p.at)] });
    tools.measure('Length', fmt(d));
    label.show(e, [fmt(d), p.label].filter(Boolean).join(' · '));
    return p;
  }

  function point(e: PointerEvent) {
    const p = update(e);
    if (!p) return;
    if (!from) {
      from = p.at;
      kept = [];
      tools.measure('Length', '');
      return tools.hint('Click the second point.');
    }
    const d = sub(p.at, from).map((c) => Math.round(Math.abs(c))) as V3;
    const total = Math.round(length(sub(p.at, from)));
    kept = [span(from, p.at)];
    from = null;
    draft.set({ lines: kept });
    label.hide();
    tools.measure('Length', fmt(total));
    tools.hint(`${fmt(total)} — ${fmt(d[0])} across, ${fmt(d[1])} up, ${fmt(d[2])} front to back. Click to measure again.`);
  }

  const reset = () => {
    from = null;
    kept = [];
    draft.set(null);
    label.hide();
    tools.hint(null);
    tools.measure('', '');
  };

  return {
    id: 'tape',
    name: 'Tape Measure',
    keys: ['t'],
    icon: 'tape',
    hint: 'Click a point to measure from.',
    cursor: 'crosshair',
    down: point,
    move: (e) => void update(e),
    up(e, dragged) {
      if (dragged && from) point(e);
    },
    leave: () => label.hide(),
    cancel() {
      if (!from && !kept.length) return false;
      reset();
      return true;
    },
    exit: reset,
  };
}
