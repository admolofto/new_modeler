import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { icon, type IconName } from './icons';
import type { Selection } from './selection';
import { shop } from './units';

/**
 * One tool at a time, picked SketchUp-style: from the palette down the left of the 3D view or by
 * SketchUp's own keys (Space select, M move, Q rotate, P push / pull, R rectangle, T tape measure,
 * E eraser, O orbit, H pan, Z zoom). The manager owns what every tool shares: the pointer (a press,
 * the moves, the release and whether it was a drag — so click-move-click and press-drag-release
 * both work), the keyboard (tool keys, Esc backing out a step and then to Select, and typing a
 * value at any time, no click needed), the status line bottom left and the Measurements box bottom
 * right. Tools with their own pointer handling (blocks, split) only report when they turn on or off.
 */

export type ToolId = 'select' | 'eraser' | 'rectangle' | 'pushpull' | 'move' | 'rotate' | 'tape' | 'orbit' | 'pan' | 'zoom' | 'split';

export interface Tool {
  id: ToolId;
  name: string;
  /** Shortcut keys, lowercase (' ' is Space). */
  keys: string[];
  /** Its palette button; a tool without one is reached another way (split). */
  icon?: IconName;
  /** What the palette button says it does. */
  title?: string;
  /** The status line while it waits for a first click. */
  hint: string;
  cursor?: string;
  /** It changes the model: doors and drawers close first. */
  edits?: boolean;
  /** It handles the pointer and keyboard itself and reports on / off (`Tools.report`). */
  external?: boolean;
  /** Turns it on; false refuses (it says why itself). */
  enter?(): boolean | void;
  exit?(): void;
  down?(e: PointerEvent): void;
  move?(e: PointerEvent): void;
  /** `dragged`: the pointer moved since the press, so the release is a second point. */
  up?(e: PointerEvent, dragged: boolean): void;
  leave?(): void;
  /** A key it takes (axis locks, copy); true = handled. */
  key?(e: KeyboardEvent): boolean;
  keyup?(e: KeyboardEvent): void;
  /** Enter on what was typed into the Measurements box. */
  typed?(text: string): void;
  /** Esc backs out one step; false when there was nothing to back out of (the tool then ends). */
  cancel?(): boolean;
}

export interface Tools {
  readonly active: ToolId;
  /** The active tool changes the model (drawing, moving, erasing…). */
  readonly editing: boolean;
  add(...tools: Tool[]): void;
  set(id: ToolId): void;
  /** A tool with its own on / off (blocks, split) says it changed. */
  report(id: ToolId, on: boolean): void;
  /** The status line (null: the tool's own hint). */
  hint(text: string | null): void;
  /** The Measurements box: what the value is, and the value. */
  measure(label: string, value: string): void;
  /** Runs the active tool's `move` again where the pointer is (after a key changed what it shows). */
  refresh(): void;
  /** A palette button that isn't a tool (zoom extents). */
  action(a: { icon: IconName; title: string; run(): void }): void;
  subscribe(fn: () => void): void;
}

const STYLE = `
.toolbar { position: absolute; left: 10px; top: 50%; z-index: 6; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; padding: 4px;
  background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 8px 24px #0008; }
.toolbar .btn { width: 32px; height: 32px; padding: 0; }
.toolbar .btn svg { width: 18px; height: 18px; }
.toolbar .btn[aria-pressed=true] { background: var(--sel-soft); color: var(--sel); box-shadow: inset 0 0 0 1px #ff9f2e59; }
.toolbar .sep { height: 1px; margin: 3px 4px; background: var(--line-2); }
.statusbar { position: absolute; left: 10px; bottom: 12px; z-index: 6; max-width: calc(50% - 110px); padding: 4px 10px; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  background: #141518d9; border: 1px solid var(--line); border-radius: 8px; color: var(--fg-2); font-size: var(--fs-sm); pointer-events: none; }
.statusbar b { color: var(--fg); font-weight: 600; }
.vcb { position: absolute; right: 10px; bottom: 12px; z-index: 6; display: flex; align-items: center; gap: 8px; max-width: calc(50% - 110px); padding: 4px 6px 4px 10px;
  background: #141518d9; border: 1px solid var(--line); border-radius: 8px; font-size: var(--fs-sm); pointer-events: none; }
.vcb .k { color: var(--fg-2); white-space: nowrap; }
.vcb .v { min-width: 84px; height: 22px; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--field); border: 1px solid var(--line-2);
  border-radius: 5px; color: var(--fg); line-height: 20px; }
.vcb.typing .v { border-color: var(--sel); }
@media (max-height: 520px) { .toolbar { top: 8px; transform: none; } }
`;

/** Palette order; `null` is a divider. */
const ORDER: (ToolId | null)[] = ['select', 'eraser', null, 'rectangle', 'pushpull', null, 'move', 'rotate', null, 'tape', null, 'orbit', 'pan', 'zoom'];

/** A press that moves less than this is a click. */
const CLICK_PX = 5;

const keyName = (k: string) => (k === ' ' ? 'Space' : k.toUpperCase());

export function mountTools(o: { stage: HTMLElement; viewport: Viewport; selection: Selection }): Tools {
  const canvas = o.viewport.renderer.domElement;
  const container = canvas.parentElement!;
  const bar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' });
  const status = el('div', { class: 'statusbar', role: 'status' });
  const vcbLabel = el('span', { class: 'k' });
  const vcbValue = el('span', { class: 'v len' });
  const vcb = el('div', { class: 'vcb', 'aria-label': 'Measurements' }, vcbLabel, vcbValue);
  o.stage.append(el('style', {}, STYLE), bar, status, vcb);

  const tools = new Map<ToolId, Tool>();
  const buttons = new Map<ToolId, HTMLButtonElement>();
  const actions: HTMLButtonElement[] = [];
  const listeners = new Set<() => void>();
  let active: ToolId = 'select';
  /** Inside `set`: tools turning each other off don't start another switch. */
  let switching = false;
  let hint: string | null = null;
  let measured = { label: '', value: '' };
  let typed = '';
  let down: { x: number; y: number; dragged: boolean } | null = null;
  let last: PointerEvent | null = null;

  const current = () => tools.get(active);

  function paint() {
    const t = current();
    status.replaceChildren(el('b', {}, t?.name ?? ''), ...(hint ?? t?.hint ? [' — ', ...shop(hint ?? t!.hint)] : []));
    vcbLabel.textContent = measured.label || 'Measurements';
    vcbValue.replaceChildren(...(typed ? [`${typed}▌`] : shop(measured.value)));
    vcb.classList.toggle('typing', !!typed);
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === active));
  }

  function layout() {
    const kids: HTMLElement[] = [];
    for (const id of ORDER) {
      const b = id && buttons.get(id);
      if (b) kids.push(b);
      else if (id === null && kids.length && !kids[kids.length - 1]!.classList.contains('sep')) kids.push(el('div', { class: 'sep' }));
    }
    kids.push(...actions);
    while (kids[kids.length - 1]?.classList.contains('sep')) kids.pop();
    bar.replaceChildren(...kids);
  }

  /** Keeps keyboard focus off the palette, so Space and the tool keys keep going to the view. */
  const noFocus = (b: HTMLButtonElement) => b.addEventListener('mousedown', (e) => e.preventDefault());

  function set(id: ToolId) {
    if (id === active || switching) return;
    const next = tools.get(id);
    if (!next) return;
    switching = true;
    try {
      current()?.exit?.();
      down = null;
      typed = '';
      hint = null;
      measured = { label: '', value: '' };
      o.selection.setHover(null);
      active = next.enter?.() === false ? 'select' : id;
      // A refused tool leaves Select on, which never refuses.
      if (active !== id) tools.get('select')?.enter?.();
    } finally {
      switching = false;
    }
    canvas.style.cursor = current()?.external ? canvas.style.cursor : (current()?.cursor ?? '');
    paint();
    listeners.forEach((fn) => fn());
    if (last && !current()?.external) current()?.move?.(last);
  }

  const api: Tools = {
    get active() {
      return active;
    },
    get editing() {
      return !!current()?.edits;
    },
    add(...list) {
      for (const t of list) {
        tools.set(t.id, t);
        if (!t.icon) continue;
        const keys = t.keys.length ? ` (${keyName(t.keys[0]!)})` : '';
        const b = el('button', { class: 'btn ghost', title: `${t.title ?? t.name}${keys}`, 'aria-label': t.name }, icon(t.icon));
        b.addEventListener('click', () => set(t.id));
        noFocus(b);
        buttons.set(t.id, b);
      }
      layout();
      paint();
    },
    set,
    report(id, on) {
      if (switching) return;
      if (on) set(id);
      else if (active === id) set('select');
    },
    hint(text) {
      if (text === hint) return;
      hint = text;
      paint();
    },
    measure(label, value) {
      if (label === measured.label && value === measured.value) return;
      measured = { label, value };
      paint();
    },
    refresh() {
      if (last && !current()?.external) current()?.move?.(last);
    },
    action(a) {
      const b = el('button', { class: 'btn ghost', title: a.title, 'aria-label': a.title }, icon(a.icon));
      b.addEventListener('click', a.run);
      noFocus(b);
      actions.push(b);
      layout();
    },
    subscribe: (fn) => void listeners.add(fn),
  };

  // ── Pointer ───────────────────────────────────────────────────────────────────
  container.addEventListener(
    'pointerdown',
    (e) => {
      const t = current();
      if (!t || t.external || e.button !== 0 || !(t.down || t.up)) return;
      down = { x: e.clientX, y: e.clientY, dragged: false };
      last = e;
      t.down?.(e);
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (e) => {
    last = e;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) down.dragged = true;
    const t = current();
    if (t && !t.external) t.move?.(e);
  });
  canvas.addEventListener('pointerleave', () => {
    const t = current();
    if (t && !t.external && !down) t.leave?.();
  });
  window.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    const t = current();
    if (t && !t.external) t.up?.(e, d.dragged);
  });

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  const consume = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const inField = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest?.('input, select, textarea, [contenteditable]');
  window.addEventListener(
    'keydown',
    (e) => {
      if (inField(e)) return;
      const t = current();
      // Blocks and split take their own keys first (they listen ahead of this); what's left are tool keys.
      if (t && !t.external) {
        if (t.key?.(e)) return consume(e);
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.key === 'Escape') {
            if (typed) typed = '';
            else if (!t.cancel?.()) {
              if (active === 'select') return; // the selection clears (ui/inspector.ts)
              set('select');
            }
            consume(e);
            return paint();
          }
          if (t.typed) {
            if (e.key === 'Enter' && typed) {
              const text = typed;
              typed = '';
              consume(e);
              paint();
              return t.typed(text);
            }
            if (e.key === 'Backspace' && typed) {
              typed = typed.slice(0, -1);
              consume(e);
              return paint();
            }
            // A value starts with a figure (or - * / for "the other way" and rows of copies); then units and fractions.
            if (e.key.length === 1 && (/^[\d.]$/.test(e.key) || (!typed && /^[-*/]$/.test(e.key)) || (typed && /^[\d.,/ '"x×*a-z-]$/i.test(e.key)))) {
              typed += e.key;
              consume(e);
              return paint();
            }
          }
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      const k = e.key.toLowerCase();
      const next = [...tools.values()].find((x) => x.keys.includes(k));
      if (!next) return;
      // Space on a focused button or row presses it, as everywhere.
      if (k === ' ' && (e.target as HTMLElement).closest?.('button, a, summary, [role=button], [role=treeitem], [tabindex]')) return;
      consume(e);
      set(next.id);
    },
    { capture: true },
  );
  window.addEventListener('keyup', (e) => {
    const t = current();
    if (t && !t.external) t.keyup?.(e);
  });

  paint();
  return api;
}
