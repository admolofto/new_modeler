import { targetKey, type Target } from '../edit/targets';
import type { V3 } from '../geometry/types';

/**
 * What the pointer was over, and when: one span per hovered target (null = nothing), with the
 * node-local points it moved through so a note's pin can land where the cursor actually rested.
 * Pure: the caller supplies timestamps.
 */

export interface HoverSpan {
  target: Target | null;
  t0: number;
  t1: number;
  /** Cursor positions within the span (node-local), at most one per `sampleMs`. */
  ats: { t: number; at: V3 }[];
}

export interface HoverLog {
  record(t: Target | null, now: number): void;
  /** All spans so far; the open one ends at `until`. */
  spans(until: number): HoverSpan[];
}

const key = (t: Target | null) => (t ? targetKey(t) : '');
const same = (a: V3, b: V3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function createHoverLog(sampleMs = 50): HoverLog {
  const done: HoverSpan[] = [];
  let open: HoverSpan | null = null;

  return {
    record(t, now) {
      if (!open || key(open.target) !== key(t)) {
        if (open) done.push({ ...open, t1: now });
        const target = t && { node: t.node, ...(t.handle && { handle: t.handle }) };
        open = { target, t0: now, t1: now, ats: t?.at ? [{ t: now, at: [...t.at] }] : [] };
        return;
      }
      if (!t?.at) return;
      const last = open.ats.at(-1);
      if (last && same(last.at, t.at)) return;
      // Within the sample window, keep the latest position (so the resting point isn't lost).
      if (last && now - last.t < sampleMs) last.at = [...t.at];
      else open.ats.push({ t: now, at: [...t.at] });
    },
    spans(until) {
      return open ? [...done, { ...open, ats: [...open.ats], t1: Math.max(open.t0, until) }] : [...done];
    },
  };
}
