import { el } from './dom';
import { icon, type IconName } from './icons';

/**
 * The right-hand panel: the AI chat, plus any tab docked beside it (References). With only the chat
 * there's no tab strip; once another tab docks, a strip of tabs shows above them. The panel's left
 * edge drags to make it wider (double-click: back to the default width); the width is a per-browser
 * preference.
 */

const CSS = `
#right { position: relative; }
.side-tabs { display: flex; align-items: flex-end; gap: 2px; height: 36px; padding: 0 6px; flex: none; border-bottom: 1px solid var(--line); }
.side-tabs[hidden] { display: none; }
.side-tabs .tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 10px; border: 0; border-radius: 6px 6px 0 0;
  background: none; color: var(--fg-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; box-shadow: inset 0 -2px 0 transparent; }
.side-tabs .tab:hover { color: var(--fg); background: var(--hover); }
.side-tabs .tab[aria-selected=true] { color: var(--fg); box-shadow: inset 0 -2px 0 var(--fg); }
.side-tabs .tab > svg { width: 14px; height: 14px; }
.side-tabs .tab .close { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; color: var(--fg-3); }
.side-tabs .tab .close:hover { background: var(--press); color: var(--fg); }
.side-tabs .tab .close svg { width: 12px; height: 12px; }
.side-tabs .tab.plain { padding-right: 10px; }
.side-pane { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; }
.side-pane[hidden] { display: none; }
.side-grip { position: absolute; left: -3px; top: 0; bottom: 0; z-index: 5; width: 6px; cursor: col-resize; }
.side-grip:hover, .side-grip.on { background: var(--focus); opacity: .5; }
`;

const WIDTH_KEY = 'new-modeler.right-width';
const MIN_W = 280;

export interface SideTab {
  id: string;
  label: string;
  icon: IconName;
  pane: HTMLElement;
  /** The tab's × was clicked; without it the tab has no ×. */
  onClose?: () => void;
}

export interface SidePanel {
  /** The AI chat's pane. */
  readonly chat: HTMLElement;
  /** Docks a tab beside the chat and shows it (unless `show` is false). */
  add(tab: SideTab, show?: boolean): void;
  /** Takes a tab out (its pane is detached, not destroyed); the chat shows again if it was the one showing. */
  remove(id: string): void;
  /** Shows a tab (and the panel, if it's hidden). */
  select(id: string): void;
  readonly active: string;
}

export function mountSidePanel(o: { parent: HTMLElement; app: HTMLElement; reveal: () => void }): SidePanel {
  const { parent, app } = o;
  const strip = el('div', { class: 'side-tabs', role: 'tablist', 'aria-label': 'Side panel' });
  const chat = el('div', { class: 'side-pane' });
  const grip = el('div', { class: 'side-grip', title: 'Drag to resize (double-click: default width)' });
  parent.append(el('style', {}, CSS), grip, strip, chat);

  const tabs: (SideTab & { btn: HTMLElement })[] = [];
  let active = 'ai';

  const makeTab = (t: SideTab) => {
    const btn = el('button', { class: `tab${t.onClose ? '' : ' plain'}`, type: 'button', role: 'tab' }, icon(t.icon), t.label);
    btn.addEventListener('click', () => select(t.id));
    if (t.onClose) {
      const close = el('span', { class: 'close', title: `Close ${t.label}`, role: 'button' }, icon('x'));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        t.onClose?.();
      });
      btn.append(close);
    }
    return { ...t, btn };
  };
  tabs.push(makeTab({ id: 'ai', label: 'AI', icon: 'sparkle', pane: chat }));

  const sync = () => {
    strip.hidden = tabs.length < 2;
    strip.replaceChildren(...tabs.map((t) => t.btn));
    for (const t of tabs) {
      t.pane.hidden = t.id !== active;
      t.btn.setAttribute('aria-selected', String(t.id === active));
    }
  };

  function select(id: string) {
    if (!tabs.some((t) => t.id === id)) return;
    active = id;
    sync();
    o.reveal();
  }

  // ── Width ────────────────────────────────────────────────────────────────
  const setWidth = (w: number | null) => {
    if (w === null) app.style.removeProperty('--right-w');
    else app.style.setProperty('--right-w', `${Math.round(Math.max(MIN_W, Math.min(w, window.innerWidth * 0.7)))}px`);
  };
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved) setWidth(saved);
  } catch {
    // storage unavailable: the default width
  }
  const keepWidth = (w: number | null) => {
    try {
      if (w === null) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    } catch {
      // storage unavailable: the width lasts for this session
    }
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('on');
    const right = parent.getBoundingClientRect().right;
    const move = (ev: PointerEvent) => setWidth(right - ev.clientX);
    const up = () => {
      grip.classList.remove('on');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      keepWidth(parent.getBoundingClientRect().width);
      window.dispatchEvent(new Event('resize'));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => {
    setWidth(null);
    keepWidth(null);
    window.dispatchEvent(new Event('resize'));
  });

  sync();
  return {
    chat,
    add(t, show = true) {
      if (!tabs.some((x) => x.id === t.id)) {
        t.pane.classList.add('side-pane');
        parent.append(t.pane);
        tabs.push(makeTab(t));
      }
      if (show) select(t.id);
      else sync();
    },
    remove(id) {
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 1) return;
      const [t] = tabs.splice(i, 1);
      t?.pane.classList.remove('side-pane');
      t?.pane.remove();
      if (active === id) active = 'ai';
      sync();
    },
    select,
    get active() {
      return active;
    },
  };
}
