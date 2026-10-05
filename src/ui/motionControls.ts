import { motionOf } from '../model/motion';
import type { Doc } from '../model/schema';
import { el } from './dom';
import { icon } from './icons';
import type { MotionPlayer } from './motionPlayer';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * Opening and closing from the top bar and the keyboard: "Open" opens / closes every door, drawer
 * and lid; O does the selection's (what it is, or the door it's part of), else everything.
 */

export interface MotionControlsOptions {
  slot: HTMLElement;
  player: MotionPlayer;
  /** The model on screen (an AI proposal while one is pending). */
  shown(): Doc;
  selection: Selection;
  /** A drawing tool has the view: opening waits. */
  toolActive(): boolean;
}

export interface MotionControls {
  /** Re-reads what can open (after the model changes). */
  sync(): void;
}

export function mountMotionControls(o: MotionControlsOptions): MotionControls {
  const { player } = o;
  const btn = el('button', { class: 'btn ghost', title: 'Open or close every door, drawer and lid (O)' }, icon('doorOpen'), el('span', { class: 't' }, 'Open'));
  o.slot.append(btn);

  const all = () => Object.keys(o.shown().motions);
  const toggle = (ids: string[]) => {
    if (o.toolActive()) return toast('Finish drawing first (Esc), then open things.', true);
    if (!ids.length) return toast('Nothing opens yet: select a door, drawer or lid and add an animation in its settings.', true);
    player.toggle(ids);
  };
  btn.addEventListener('click', () => toggle(all()));

  const sync = () => {
    const ids = all();
    btn.setAttribute('aria-pressed', String(ids.length > 0 && ids.every((id) => player.isOpen(id))));
    btn.title = ids.length ? 'Open or close every door, drawer and lid (O)' : 'Nothing opens yet: add an animation in a door’s, drawer’s or lid’s settings';
  };
  player.subscribe(sync);

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'o') return;
    if (target.closest('input, select, textarea')) return;
    e.preventDefault();
    const doc = o.shown();
    const picked = [...new Set(o.selection.targets.flatMap((t) => motionOf(doc, t.node)?.id ?? []))];
    toggle(picked.length ? picked : all());
  });

  sync();
  return { sync };
}
