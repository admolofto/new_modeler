import { targetKey, type Mode, type Target } from '../edit/targets';

/** What's selected and hovered in the viewport, and at what granularity. UI state, not model data. */
export interface Selection {
  readonly mode: Mode;
  readonly targets: readonly Target[];
  readonly hover: Target | null;
  setMode(mode: Mode): void;
  set(targets: Target[]): void;
  /** Adds the target, or removes it if it's already selected. */
  toggle(t: Target): void;
  has(t: Target): boolean;
  setHover(t: Target | null): void;
  /** Drops targets whose node no longer exists. */
  prune(exists: (node: string) => boolean): void;
  subscribe(fn: () => void): void;
}

export function createSelection(): Selection {
  let mode: Mode = 'part';
  let targets: Target[] = [];
  let hover: Target | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const key = (t: Target | null) => (t ? targetKey(t) : '');

  return {
    get mode() {
      return mode;
    },
    get targets() {
      return targets;
    },
    get hover() {
      return hover;
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      hover = null;
      emit();
    },
    set(next) {
      targets = next;
      emit();
    },
    toggle(t) {
      const k = targetKey(t);
      targets = targets.some((x) => targetKey(x) === k) ? targets.filter((x) => targetKey(x) !== k) : [...targets, t];
      emit();
    },
    has: (t) => targets.some((x) => targetKey(x) === targetKey(t)),
    setHover(t) {
      if (key(t) === key(hover)) return;
      hover = t;
      emit();
    },
    prune(exists) {
      const kept = targets.filter((t) => exists(t.node));
      const hoverGone = hover && !exists(hover.node);
      if (kept.length === targets.length && !hoverGone) return;
      targets = kept;
      if (hoverGone) hover = null;
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
    },
  };
}
