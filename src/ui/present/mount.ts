import type { Store } from '../../model/store';
import type { Viewport } from '../../render/viewport';
import { el } from '../dom';
import { icon } from '../icons';
import type { MotionPlayer } from '../motionPlayer';
import { toast } from '../toast';
import type { PresentSession } from './session';

/**
 * "Present" (B1): a button in the top bar's view group and the P key start a presentation — the
 * session itself loads on first use, like the glTF exporter. The editor is quiesced first (tools off,
 * drags cancelled, hover cleared, voice recording cancelled).
 */

export interface PresentOptions {
  slot: HTMLElement;
  app: HTMLElement;
  stage: HTMLElement;
  /** `#viewport`. */
  container: HTMLElement;
  viewport: Viewport;
  store: Store;
  player: MotionPlayer;
  /** Puts the editor at rest: drawing tools off, drags cancelled, hover cleared, voice cancelled. */
  quiesce(): void;
  /** Presentation started or ended (main.ts shows the store's doc to the motion player meanwhile). */
  setPresenting(on: boolean): void;
}

export interface Present {
  readonly active: boolean;
  /** The running session (dev console: `__modeler.present.session.debug`). */
  readonly session: PresentSession | null;
  enter(): Promise<void>;
  exit(): void;
}

export function mountPresent(o: PresentOptions): Present {
  const btn = el(
    'button',
    { class: 'btn ghost', title: 'Present: a rendered view to walk clients through — click doors and drawers to open them (P)' },
    icon('present'),
    el('span', { class: 't' }, 'Present'),
  );
  o.slot.append(btn);

  let session: PresentSession | null = null;
  let starting = false;

  const enter = async () => {
    if (session || starting) return;
    if (!o.store.doc.roots.length) return toast('The model is empty — nothing to present yet.', true);
    starting = true;
    o.quiesce();
    toast('');
    o.setPresenting(true);
    try {
      const { startPresentation } = await import('./session');
      const s = startPresentation({
        app: o.app,
        stage: o.stage,
        container: o.container,
        viewport: o.viewport,
        store: o.store,
        player: o.player,
        onExit: () => {
          session = null;
          o.setPresenting(false);
        },
      });
      session = s;
      await s.ready;
    } catch (err) {
      session?.exit();
      session = null;
      o.setPresenting(false);
      toast(`Couldn't start the presentation: ${(err as Error).message}`, true);
    } finally {
      starting = false;
    }
  };

  btn.addEventListener('click', () => void enter());
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'p') return;
    if (t.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    void enter();
  });

  return {
    get active() {
      return !!session || starting;
    },
    get session() {
      return session;
    },
    enter,
    exit: () => session?.exit(),
  };
}
