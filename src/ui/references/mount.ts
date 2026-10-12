import { el } from '../dom';
import { icon } from '../icons';
import { claimKeys } from '../present/keys';
import type { SidePanel } from '../sidePanel';
import { fitView, focusView, hit, layoutWall, zoomAt, type Rect, type View } from './layout';
import { deleteImage, loadImages, saveImage, type RefImage } from './library';

/**
 * References (Shift+R): a screen of its own for inspiration photos. Drop picture files on it or
 * paste them (Ctrl+V) and they fall into a photo wall by themselves; drag to pan, wheel to zoom,
 * double-click a picture to zoom to it (double-click the background: everything). The pictures stay
 * in this browser (library.ts). It opens full screen, owning the keyboard so tool keys don't fire behind
 * it; Dock moves it into the side panel as a tab beside the AI chat, where it only takes keys and pastes
 * while it has focus (click it), and stays docked next time.
 */

const CSS = `
.refs { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; background: var(--canvas); }
.refs[hidden] { display: none; }
.refs:not(.docked) .full-btn, .refs.docked .dock-btn { display: none; }
.refs.docked { position: relative; inset: auto; z-index: auto; flex: 1; min-height: 0; }
.refs.docked header { height: 40px; padding: 0 4px 0 10px; }
.refs.docked header h2 { display: none; }
.refs.docked header .btn .t { display: none; }
.refs.docked header .btn:not(.icon) { padding: 0 7px; }
.refs .board:focus { outline: none; }
.refs.docked .board:focus-visible { box-shadow: inset 0 0 0 2px var(--focus); }
.refs header { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 8px 0 16px; background: var(--chrome); border-bottom: 1px solid var(--line); }
.refs header h2 { margin: 0 10px 0 0; font-size: var(--fs-lg); font-weight: 650; letter-spacing: -.01em; }
.refs header .hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.refs .board { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; }
.refs .board.panning { cursor: grabbing; }
.refs .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.refs figure { position: absolute; margin: 0; border-radius: 4px; overflow: hidden; background: var(--raised); box-shadow: 0 2px 10px #0006; }
.refs figure img { display: block; width: 100%; height: 100%; object-fit: cover; pointer-events: none; -webkit-user-drag: none; }
.refs figure.sel { outline: calc(3px / var(--s, 1)) solid var(--sel); }
.refs figure .del { position: absolute; top: 0; right: 0; display: none; transform-origin: 100% 0; transform: scale(calc(1 / var(--s, 1))); margin: 0; }
.refs figure:hover .del, .refs figure.sel .del { display: inline-flex; }
.refs figure .del.btn { background: #000a; color: #fff; border-radius: 0 0 0 6px; }
.refs .empty { position: absolute; inset: 0; display: grid; place-content: center; gap: 10px; text-align: center; color: var(--fg-2); pointer-events: none; }
.refs .empty b { color: var(--fg); font-size: var(--fs-lg); font-weight: 600; }
.refs .drop { position: absolute; inset: 10px; display: none; place-items: center; border: 2px dashed var(--focus); border-radius: 12px;
  background: #8fb4ff14; color: var(--fg); font-size: var(--fs-lg); pointer-events: none; }
.refs.dragging .drop { display: grid; }
.refs .zoom { min-width: 48px; color: var(--fg-2); font-size: var(--fs-sm); text-align: center; font-variant-numeric: tabular-nums; }
`;

interface Shown extends RefImage {
  url: string;
  fig: HTMLElement;
}

export interface References {
  /** Full screen when closed, closed when full screen; docked: shows its tab, or the chat if it's already showing. */
  toggle(open?: boolean): void;
  readonly open: boolean;
}

type Mode = 'closed' | 'full' | 'docked';
const DOCKED_KEY = 'new-modeler.refs-docked';

export function mountReferences(o: { toolbar: HTMLElement; parent?: HTMLElement; side?: SidePanel }): References {
  const parent = o.parent ?? document.body;
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const addBtn = el('button', { class: 'btn ghost', title: 'Add pictures from files' }, icon('plus'), el('span', { class: 't' }, 'Add pictures…'));
  const fitBtn = el('button', { class: 'btn ghost', title: 'Show every picture (F, or double-click the background)' }, icon('extents'), el('span', { class: 't' }, 'Fit'));
  const zoomLbl = el('span', { class: 'zoom' });
  const closeBtn = el('button', { class: 'btn ghost icon', title: 'Back to the model (Esc)' }, icon('x'));
  const dockBtn = el('button', { class: 'btn ghost dock-btn', title: 'Dock as a tab in the side panel, beside the AI chat' }, icon('panelRight'), el('span', { class: 't' }, 'Dock'));
  const fullBtn = el('button', { class: 'btn ghost icon full-btn', title: 'Full screen' }, icon('maximize'));
  const hint = el('span', { class: 'hint' });
  const world = el('div', { class: 'world' });
  const empty = el(
    'div',
    { class: 'empty' },
    el('b', {}, 'Drop pictures here, or paste them (Ctrl+V)'),
    el('span', {}, 'They line up on their own. Drag to move around, scroll to zoom.'),
  );
  const board = el('div', { class: 'board', tabindex: '0' }, world, empty, el('div', { class: 'drop' }, 'Drop to add'));
  const screen = el(
    'div',
    { class: 'refs', role: 'dialog', 'aria-label': 'References' },
    el('style', {}, CSS),
    el('header', {}, el('h2', {}, 'References'), hint, addBtn, fitBtn, zoomLbl, ...(o.side ? [dockBtn, fullBtn] : []), closeBtn),
    board,
    fileInput,
  );
  screen.hidden = true;
  parent.append(screen);

  const toolbarBtn = el('button', { class: 'btn ghost', title: 'References: a wall of inspiration photos (Shift+R)', 'aria-pressed': 'false' }, icon('image'), el('span', { class: 't' }, 'References'));
  o.toolbar.append(toolbarBtn);

  let mode: Mode = 'closed';
  let images: Shown[] = [];
  let rects: Rect[] = [];
  let view: View = { x: 0, y: 0, scale: 1 };
  /** The view shows everything (and keeps doing so as the window or the wall changes) until the user pans or zooms. */
  let fitted = true;
  let selected: string | null = null;
  let release: (() => void) | null = null;
  let status = '';
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  const size = () => ({ w: board.clientWidth || window.innerWidth, h: board.clientHeight || window.innerHeight - 44 });

  const say = (msg: string) => {
    status = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => ((status = ''), syncHint()), 4000);
    syncHint();
  };
  const syncHint = () => {
    const n = images.length;
    hint.textContent = status || (n ? `${n} picture${n === 1 ? '' : 's'} · drop or paste to add · double-click one to zoom to it` : '');
    hint.classList.toggle('muted', !!status);
  };

  const applyView = () => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    world.style.setProperty('--s', String(view.scale));
    zoomLbl.textContent = images.length ? `${Math.round(view.scale * 100)}%` : '';
  };
  const setView = (v: View, fit = false) => {
    view = v;
    fitted = fit;
    applyView();
  };
  const fit = () => {
    const s = size();
    setView(fitView(layoutWall(images, { screenAspect: s.w / s.h }), s), true);
  };

  const relayout = () => {
    const s = size();
    const wall = layoutWall(images, { screenAspect: s.w / Math.max(1, s.h) });
    rects = wall.rects;
    images.forEach((img, i) => {
      const r = rects[i];
      if (!r) return;
      Object.assign(img.fig.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      img.fig.classList.toggle('sel', img.id === selected);
    });
    empty.hidden = images.length > 0;
    if (fitted) setView(fitView(wall, s), true);
    else applyView();
    syncHint();
  };

  const show = (img: RefImage): Shown => {
    const url = URL.createObjectURL(img.blob);
    const del = el('button', { class: 'btn icon del', title: 'Remove this picture (Delete)' }, icon('x'));
    const fig = el('figure', { title: img.name }, el('img', { src: url, alt: img.name, draggable: false }), del);
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => remove(img.id));
    world.append(fig);
    return { ...img, url, fig };
  };

  const remove = (id: string) => {
    const img = images.find((i) => i.id === id);
    if (!img) return;
    img.fig.remove();
    URL.revokeObjectURL(img.url);
    images = images.filter((i) => i !== img);
    if (selected === id) selected = null;
    void deleteImage(id);
    relayout();
  };

  const measure = (blob: Blob) =>
    new Promise<{ w: number; h: number } | null>((resolve) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        resolve({ w: im.naturalWidth, h: im.naturalHeight });
        URL.revokeObjectURL(url);
      };
      im.onerror = () => {
        resolve(null);
        URL.revokeObjectURL(url);
      };
      im.src = url;
    });

  let seq = 0;
  const add = async (blobs: { blob: Blob; name: string }[]) => {
    let added = 0;
    let unsaved = 0;
    let bad = 0;
    const measured = await Promise.all(blobs.map(({ blob }) => (blob.type.startsWith('image/') ? measure(blob) : null)));
    const saves: Promise<boolean>[] = [];
    for (const [i, { blob, name }] of blobs.entries()) {
      const dims = measured[i];
      if (!dims) {
        bad++;
        continue;
      }
      const img: RefImage = { id: crypto.randomUUID(), blob, name, ...dims, added: Date.now() + seq++ / 1000 };
      images.push(show(img));
      added++;
      saves.push(saveImage(img));
    }
    if (added) {
      fitted = true;
      relayout();
    }
    unsaved = (await Promise.all(saves)).filter((ok) => !ok).length;
    const parts = [
      added ? `Added ${added} picture${added === 1 ? '' : 's'}.` : '',
      bad ? `${bad} wasn’t a picture this browser can show.` : '',
      unsaved ? 'This browser wouldn’t store them, so they last until you close the tab.' : '',
    ].filter(Boolean);
    if (parts.length) say(parts.join(' '));
  };

  /** Picture files, else a picture dragged from a web page (its address), from a drop or a paste. */
  const fromTransfer = async (dt: DataTransfer | null) => {
    if (!dt) return;
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) return add(files.map((f) => ({ blob: f, name: f.name || 'Pasted picture' })));
    const html = dt.getData('text/html');
    const src = (html && /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1]) || dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || '';
    if (!/^(https?:|data:image\/)/i.test(src.trim())) {
      if (dt.files.length || src) say('Only pictures can go on the wall.');
      return;
    }
    try {
      const res = await fetch(src.trim());
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('not a picture');
      await add([{ blob, name: decodeURIComponent((src.split(/[?#]/)[0] ?? '').split('/').pop() || 'Picture') }]);
    } catch {
      say('That site won’t hand the picture over. Save it to a file and drop the file here, or copy the image itself and paste.');
    }
  };

  // ── Pan, zoom, select ────────────────────────────────────────────────────
  let drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  const local = (e: { clientX: number; clientY: number }) => {
    const b = board.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  board.addEventListener('pointerdown', (e) => {
    if (drag) return;
    board.focus({ preventScroll: true });
    board.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    e.preventDefault();
  });
  board.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    board.classList.add('panning');
    setView({ ...view, x: drag.vx + dx, y: drag.vy + dy });
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const click = !drag.moved && e.type === 'pointerup' && e.button === 0;
    drag = null;
    board.classList.remove('panning');
    if (click) {
      const p = local(e);
      const i = hit(rects, view, p.x, p.y);
      selected = images[i]?.id ?? null;
      images.forEach((img) => img.fig.classList.toggle('sel', img.id === selected));
    }
  };
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);
  board.addEventListener('contextmenu', (e) => e.preventDefault());
  board.addEventListener('dblclick', (e) => {
    const p = local(e);
    const i = hit(rects, view, p.x, p.y);
    const r = rects[i];
    if (!r) return fit();
    setView(focusView(r, size()));
  });
  board.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      // Pixels from a wheel, lines or pages from some mice; a trackpad pinch arrives as Ctrl + wheel.
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      setView(zoomAt(view, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y));
    },
    { passive: false },
  );

  // ── Adding ───────────────────────────────────────────────────────────────
  let depth = 0;
  board.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    screen.classList.add('dragging');
  });
  board.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  board.addEventListener('dragleave', () => {
    if (--depth <= 0) ((depth = 0), screen.classList.remove('dragging'));
  });
  board.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    screen.classList.remove('dragging');
    void fromTransfer(e.dataTransfer);
  });
  window.addEventListener('paste', (e) => {
    // Docked, the chat beside it takes its own pastes: only a paste while the wall has focus is a picture for it.
    if (mode === 'closed' || (mode === 'docked' && !screen.contains(document.activeElement))) return;
    e.preventDefault();
    void fromTransfer(e.clipboardData);
  });
  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void add(files.map((f) => ({ blob: f, name: f.name })));
  });
  fitBtn.addEventListener('click', fit);
  closeBtn.addEventListener('click', () => setMode('closed'));
  dockBtn.addEventListener('click', () => setMode('docked'));
  fullBtn.addEventListener('click', () => setMode('full'));
  toolbarBtn.addEventListener('click', () => toggle());
  new ResizeObserver(() => mode !== 'closed' && board.clientWidth > 0 && relayout()).observe(board);

  // ── Keys ─────────────────────────────────────────────────────────────────
  const keydown = (e: KeyboardEvent): boolean => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) return false; // Ctrl+V pastes; browser shortcuts still work
    if (k === 'escape') {
      if (selected) {
        selected = null;
        relayout();
      } else if (mode === 'docked') board.blur();
      else setMode('closed');
      return true;
    }
    if (k === 'r' && e.shiftKey) return (toggle(), true);
    if ((k === 'delete' || k === 'backspace') && selected) return (remove(selected), true);
    if (k === 'f' || k === 'home' || k === '0') return (fit(), true);
    const s = size();
    if (k === '+' || k === '=') return (setView(zoomAt(view, 1.25, s.w / 2, s.h / 2)), true);
    if (k === '-' || k === '_') return (setView(zoomAt(view, 0.8, s.w / 2, s.h / 2)), true);
    return false;
  };
  // Docked, the wall owns the keyboard only while it has focus (click it); the tools behind don't see those keys.
  board.addEventListener('focus', () => {
    if (mode === 'docked' && !release) release = claimKeys({ keydown });
  });
  board.addEventListener('blur', () => {
    if (mode !== 'docked') return;
    release?.();
    release = null;
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (mode === 'full' || screen.contains(t) || t.closest('input, select, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && e.key.toLowerCase() === 'r') {
      toggle();
      e.preventDefault();
    }
  });

  const showing = () => screen.getClientRects().length > 0;
  function toggle(next?: boolean) {
    if (mode === 'docked' && o.side) {
      if (next === false) return setMode('closed');
      // Docked: the button flips the side panel between References and the chat.
      const to = next || o.side.active !== 'refs' || !showing() ? 'refs' : 'ai';
      if (to === 'ai') board.blur();
      o.side.select(to);
      return;
    }
    setMode((next ?? mode === 'closed') ? 'full' : 'closed');
  }

  let loaded = false;
  function setMode(next: Mode, reveal = true) {
    if (next === mode) return;
    if (next === 'docked' && !o.side) next = 'full';
    const was = mode;
    mode = next;
    release?.();
    release = null;
    if (was === 'docked') o.side?.remove('refs');
    drag = null;
    screen.classList.toggle('docked', mode === 'docked');
    toolbarBtn.setAttribute('aria-pressed', String(mode !== 'closed'));
    try {
      if (mode === 'docked') localStorage.setItem(DOCKED_KEY, '1');
      else localStorage.removeItem(DOCKED_KEY);
    } catch {
      // storage unavailable: it opens full screen next time
    }
    if (mode === 'docked') {
      screen.hidden = false;
      o.side?.add({ id: 'refs', label: 'References', icon: 'image', pane: screen, onClose: () => setMode('closed') }, reveal);
    } else {
      if (screen.parentElement !== parent) parent.append(screen);
      screen.hidden = mode === 'closed';
    }
    if (mode === 'full') release = claimKeys({ keydown });
    if (mode !== 'closed') {
      fitted = true;
      relayout();
      if (!loaded) {
        loaded = true;
        void loadImages().then((saved) => {
          const have = new Set(images.map((i) => i.id));
          images = [...saved.filter((i) => !have.has(i.id)).map(show), ...images];
          fitted = true;
          relayout();
        });
      }
    }
  }

  syncHint();
  try {
    if (o.side && localStorage.getItem(DOCKED_KEY)) {
      setMode('docked', false);
    }
  } catch {
    // storage unavailable: it starts closed
  }
  return {
    toggle,
    get open() {
      return mode !== 'closed';
    },
  };
}
