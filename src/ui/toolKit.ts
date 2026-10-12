import { gizmoNodes } from '../edit/gizmo';
import { add, scale } from '../edit/rays';
import type { Target } from '../edit/targets';
import type { V3 } from '../geometry/types';
import type { Op, OpResult } from '../model/ops';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import type { Mat3 } from '../model/world';
import { PALETTE } from '../render/palette';
import type { ToolDraft } from '../render/toolDraft';
import { el } from './dom';
import type { Inference } from './inference';
import type { Selection } from './selection';
import type { Tools } from './tools';
import { fmt, shop } from './units';

/** What every modeling tool (move, rotate, push / pull, tape, eraser) works with. */
export interface ToolContext {
  store: Store;
  selection: Selection;
  tools: Tools;
  infer: Inference;
  draft: ToolDraft;
  /** The doc as drawn (an isolated folder only): what a tool snaps to. */
  view(doc: Doc): Doc;
  /** Why direct edits are off right now, or null. */
  editBlocked(): string | null;
  /** What the tool is doing, as a doc to show (null: the store's). */
  setPreview(doc: Doc | null): void;
  /** The part / assembly a gesture snapped to (highlighted), or null. */
  setSnapNode(id: string | null): void;
  onStatus(msg: string, error?: boolean): void;
}

export type Axis = 0 | 1 | 2;

/** The frame axes as SketchUp names and colors them: red across, blue up, green front to back. */
export const AXES: { name: string; color: number }[] = [
  { name: 'Red', color: PALETTE.axisX },
  { name: 'Blue', color: PALETTE.axisY },
  { name: 'Green', color: PALETTE.axisZ },
];

/** Arrow keys lock an axis, as in SketchUp: → red, ← green, ↑ / ↓ blue. */
export function arrowAxis(key: string): Axis | null {
  return key === 'ArrowRight' ? 0 : key === 'ArrowLeft' ? 2 : key === 'ArrowUp' || key === 'ArrowDown' ? 1 : null;
}

export const column = (m: Mat3, k: number): V3 => [m[0]![k]!, m[1]![k]!, m[2]![k]!];
export const signed = (u: number) => `${u >= 0 ? '+' : '−'}${fmt(Math.abs(u))}`;

/** The line that follows the cursor: what a tool would do, and why it snapped. */
export function cursorLabel(): { show(e: MouseEvent, text: string, bad?: boolean): void; hide(): void } {
  const label = el('div', { class: 'drag-label len' });
  label.style.display = 'none';
  document.body.append(label);
  return {
    show(e, text, bad = false) {
      if (!text) return void (label.style.display = 'none');
      label.replaceChildren(...shop(text));
      label.classList.toggle('bad', bad);
      label.style.display = '';
      label.style.left = `${e.clientX + 16}px`;
      label.style.top = `${e.clientY + 12}px`;
    },
    hide() {
      label.style.display = 'none';
    },
  };
}

/** The parts a selection is on: whole parts, or the parts its faces, edges and corners belong to. */
export function selectedParts(doc: Doc, targets: readonly Target[]): Target[] {
  return [...new Set(targets.map((t) => t.node))].filter((node) => doc.parts[node]).map((node) => ({ node }));
}

/**
 * What move and rotate act on: the selection (a selected face stands for its part), else the piece
 * under the cursor. Either way whole pieces move, like the gizmo: a generated part takes its cabinet.
 */
export function grabNodes(doc: Doc, targets: readonly Target[], under: string | null): { ids: string[]; selected: boolean } | null {
  const picked = selectedParts(doc, targets);
  const chosen = picked.length ? gizmoNodes(doc, picked) : null;
  if (chosen) return { ids: chosen, selected: true };
  const ids = under && doc.parts[under] ? gizmoNodes(doc, [{ node: under }]) : null;
  return ids && { ids, selected: false };
}

/** How near (screen pixels) the cursor must be to an axis through a point to follow it. */
const AXIS_PX = 10;

/** The axis through `from` the cursor is following on screen (SketchUp's "On Red Axis"), if any. */
export function nearAxis(infer: Inference, e: MouseEvent, from: V3, axes: readonly V3[]): Axis | null {
  const g = infer.screen(from);
  if (g.behind) return null;
  const m = { x: e.clientX - g.x, y: e.clientY - g.y };
  if (Math.hypot(m.x, m.y) < 14) return null;
  const reach = 120 * infer.unitsPerPx(from);
  let best: Axis | null = null;
  let bestD = AXIS_PX;
  for (const k of [0, 1, 2] as const) {
    const q = infer.screen(add(from, scale(axes[k]!, reach)));
    const d = { x: q.x - g.x, y: q.y - g.y };
    const len = Math.hypot(d.x, d.y);
    // Seen end on, an axis is a dot: nothing to follow.
    if (q.behind || len < 12) continue;
    const dist = Math.abs(m.x * d.y - m.y * d.x) / len;
    if (dist < bestD) {
      bestD = dist;
      best = k;
    }
  }
  return best;
}

/** A typed value's sign and the rest: `-3 1/2` → [-1, '3 1/2']. */
export function signOf(text: string): [1 | -1, string] {
  const m = /^\s*([-−])?\s*(.*)$/.exec(text)!;
  return [m[1] ? -1 : 1, m[2]!.trim()];
}

/**
 * Replaces the step a tool just committed with other ops on the same starting doc — typing a new
 * distance after the fact. It stays one undo step. Null when the model has moved on since.
 */
export function amend(store: Store, last: { before: Doc; after: Doc }, ops: Op[]): OpResult | null {
  if (store.doc !== last.after || !store.canUndo()) return null;
  store.undo();
  if (store.doc !== last.before) {
    store.redo();
    return null;
  }
  const r = store.dispatch(ops);
  if (!r.ok) store.redo();
  return r;
}
