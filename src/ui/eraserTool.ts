import { eraseOps } from '../edit/erase';
import type { Target } from '../edit/targets';
import type { ToolContext } from './toolKit';
import type { Tool } from './tools';

/**
 * The eraser (E): click a part to delete it, or hold the button and sweep across several — they
 * light up as you pass over them and go together when you let go, as one undo step. Esc mid-sweep
 * keeps them all.
 */
export function eraserTool(ctx: ToolContext): Tool {
  const { store, selection, infer, tools } = ctx;
  /** Parts swept so far while the button is down. */
  let sweep: string[] | null = null;
  let before: Target[] = [];

  const under = (e: PointerEvent) => {
    infer.aim(e);
    return infer.face()?.part ?? null;
  };
  const take = (id: string | null) => {
    if (!sweep || !id || sweep.includes(id)) return;
    sweep.push(id);
    selection.set(sweep.map((node) => ({ node })));
    tools.hint(`Let go to erase ${sweep.length === 1 ? (store.doc.parts[id]?.name ?? 'it') : `${sweep.length} parts`}. Esc keeps ${sweep.length === 1 ? 'it' : 'them'}.`);
  };
  const stop = () => {
    sweep = null;
    tools.hint(null);
  };

  return {
    id: 'eraser',
    name: 'Eraser',
    keys: ['e'],
    icon: 'eraser',
    hint: 'Click a part to erase it, or drag across several.',
    cursor: 'crosshair',
    edits: true,
    down(e) {
      const blocked = ctx.editBlocked();
      if (blocked) return ctx.onStatus(blocked, true);
      before = [...selection.targets];
      sweep = [];
      selection.setHover(null);
      take(under(e));
    },
    move(e) {
      const id = under(e);
      if (sweep) take(id);
      else selection.setHover(id ? { node: id } : null);
    },
    up() {
      const ids = sweep;
      stop();
      if (!ids?.length) return;
      const r = store.dispatch(eraseOps(store.doc, ids));
      if (!r.ok) {
        selection.set(before);
        return ctx.onStatus(r.error, true);
      }
      selection.set([]);
    },
    leave() {
      if (!sweep) selection.setHover(null);
    },
    cancel() {
      if (!sweep) return false;
      stop();
      selection.set(before);
      return true;
    },
    exit() {
      if (sweep) selection.set(before);
      stop();
    },
  };
}
