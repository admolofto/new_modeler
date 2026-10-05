import { easeInOut as ease, motionSeconds } from '../model/motion';
import type { Doc } from '../model/schema';
import type { Viewport } from '../render/viewport';

/**
 * How far each door, drawer and lid is open: a view, like isolation — never saved, never undone, and
 * not part of the model the AI edits (its screenshots do show it). Opening and closing ease in and out
 * over each motion's seconds (instantly when the system asks for reduced motion); several at once
 * start a beat apart. Keyed by motion id, so undo, AI proposals and accept / reject keep what's open;
 * motions that disappear drop out.
 */

export interface MotionPlayer {
  /** How far a motion is open right now, 0 … 1. */
  amount(id: string): number;
  /** Whether it's open or opening (vs closed or closing). */
  isOpen(id: string): boolean;
  /** Something is drawn away from where the model has it (open, opening or closing). */
  readonly anyOpen: boolean;
  /** Opens them if any is closed, else closes them — animated, a beat apart. */
  toggle(ids: readonly string[]): void;
  /** Sets how far one is open, right away (the open-amount slider). */
  scrub(id: string, amount: number): void;
  /** Closes everything at once (before editing in the view). */
  closeAll(): void;
  /** The doc on screen changed: motions no longer in it drop out. */
  sync(doc: Doc): void;
  /** Open / closed changed (not every frame). */
  subscribe(fn: () => void): void;
  /** Something moved (every frame of an animation, every scrub). */
  onMove(fn: () => void): void;
}

interface Run {
  from: number;
  to: number;
  /** performance.now() when it starts moving (later for the ones staggered after it). */
  start: number;
  ms: number;
  amount: number;
}

/** Time between the starts when several open at once, and the most the whole spread may take. */
const STAGGER_MS = 60;
const SPREAD_MS = 600;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createMotionPlayer(o: { viewport: Viewport; doc(): Doc }): MotionPlayer {
  const runs = new Map<string, Run>();
  const changeFns = new Set<() => void>();
  const moveFns = new Set<() => void>();
  const changed = () => changeFns.forEach((fn) => fn());
  const moved = () => moveFns.forEach((fn) => fn());
  let animating = false;

  const isOpen = (id: string) => (runs.get(id)?.to ?? 0) > 0;

  o.viewport.onFrame(() => {
    if (!animating) return;
    const now = performance.now();
    let moving = false;
    let closed = false;
    let any = false;
    for (const [id, r] of runs) {
      if (r.amount === r.to) continue;
      const k = r.ms <= 0 ? 1 : Math.min(1, Math.max(0, (now - r.start) / r.ms));
      const amount = k >= 1 ? r.to : r.from + (r.to - r.from) * ease(k);
      if (amount !== r.amount) any = true;
      r.amount = amount;
      if (amount !== r.to) moving = true;
      else if (amount === 0) {
        runs.delete(id);
        closed = true;
      }
    }
    animating = moving;
    if (any) moved();
    if (closed) changed();
  });

  const player: MotionPlayer = {
    amount: (id) => runs.get(id)?.amount ?? 0,
    isOpen,
    get anyOpen() {
      return runs.size > 0;
    },
    toggle(ids) {
      const doc = o.doc();
      const live = ids.filter((id) => doc.motions[id]);
      if (!live.length) return;
      const open = live.some((id) => !isOpen(id));
      const order = open ? live : [...live].reverse();
      const now = performance.now();
      const step = Math.min(STAGGER_MS, SPREAD_MS / order.length);
      const reduced = reducedMotion();
      order.forEach((id, i) => {
        const to = open ? 1 : 0;
        const r = runs.get(id);
        if (r ? r.amount === to && r.to === to : to === 0) return; // already there
        const from = r?.amount ?? 0;
        const ms = reduced ? 0 : motionSeconds(doc.motions[id]!) * 1000 * Math.abs(to - from);
        runs.set(id, { from, to, start: now + i * step, ms, amount: from });
      });
      animating = true;
      changed();
    },
    scrub(id, amount) {
      const a = Math.min(1, Math.max(0, amount));
      const wasOpen = isOpen(id);
      if (a === 0) runs.delete(id);
      else runs.set(id, { from: a, to: a, start: 0, ms: 0, amount: a });
      moved();
      if (wasOpen !== a > 0) changed();
    },
    closeAll() {
      if (!runs.size) return;
      runs.clear();
      animating = false;
      moved();
      changed();
    },
    sync(doc) {
      let dropped = false;
      for (const id of runs.keys()) {
        if (doc.motions[id]) continue;
        runs.delete(id);
        dropped = true;
      }
      if (dropped) changed();
    },
    subscribe: (fn) => void changeFns.add(fn),
    onMove: (fn) => void moveFns.add(fn),
  };
  return player;
}
