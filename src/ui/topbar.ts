import { emptyDoc } from '../model/defaults';
import type { Store } from '../model/store';
import { el } from './dom';
import { icon } from './icons';
import { downloadFile, pickFile } from './storage';
import { toast } from './toast';
import { units } from './units';

/**
 * The top bar: file (new / open / save, plus what other modules add: SketchUp import / export), undo / redo, the
 * drawing tools, how the model is shown (dimension lines D, inches ⇄ mm U), the tools other panels add
 * (cut list), the keyboard list (?) and the side-panel toggles. View settings are
 * per-browser preferences, not model data.
 */

const CSS = `
#topbar { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px;
  padding: 0 8px; background: var(--chrome); border-bottom: 1px solid var(--line); }
#topbar .side { display: flex; align-items: center; gap: 2px; min-width: 0; }
#topbar .side.r { justify-content: flex-end; }
#topbar .mid { display: flex; align-items: center; gap: 8px; }
#topbar .mark { padding: 0 10px 0 6px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
#topbar .sep { flex: none; width: 1px; height: 18px; margin: 0 6px; background: var(--line-2); }
#topbar .tools { display: flex; align-items: center; gap: 2px; }
#topbar .seg.units button { padding: 0 8px; }
@media (max-width: 1180px) { #topbar .side.r .btn .t { display: none; } #topbar .side.r .btn:not(.icon) { padding: 0 7px; } }
.help { top: 48px; right: 8px; width: 380px; font-size: var(--fs-sm); }
.help h4 { margin: 10px 0 4px; font-size: var(--fs-sm); color: var(--fg-2); font-weight: 600; }
.help h4:first-child { margin-top: 0; }
.help dl { display: grid; grid-template-columns: 118px 1fr; gap: 4px 10px; margin: 0; }
.help dt { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; color: var(--fg-2); }
.help dd { margin: 0; }
.help p { margin: 10px 0 0; color: var(--fg-2); }
`;

const HELP: [string, [string[], string][]][] = [
  [
    'Select',
    [
      [['Click'], 'The face, edge or corner under the cursor'],
      [['Double-click'], 'The whole part'],
      [['Triple-click'], 'The whole piece (cabinet, assembly)'],
      [['Shift', 'click'], 'Add to the selection'],
      [['Tree'], 'Ctrl click: toggle a row; Shift click: every row between; right-click: hide, unclickable, isolate'],
      [['Drag'], 'Box: left→right takes parts inside, right→left parts touched'],
      [['Esc'], 'Clear the selection, cancel a drag'],
      [['Del'], 'Delete what’s selected'],
    ],
  ],
  [
    'Blocks',
    [
      [['B'], 'Draw blocks: corner, corner, height'],
      [['Type'], 'Sizes while drawing: 24, 18 ⏎'],
      [['Drag'], 'A selected block’s face to push / pull it'],
      [['S'], 'Split the selected block (Tab: axis)'],
    ],
  ],
  [
    'Move and turn',
    [
      [['Drag'], 'The gizmo’s arrows, square or rings'],
      [['Ctrl', 'drag'], 'Move a copy'],
      [['Ctrl', 'D'], 'Copy it alongside'],
      [['R'], 'Quarter turn (Shift R: the other way)'],
    ],
  ],
  [
    'Edit',
    [
      [['Drag'], 'Push / pull a selected face or point'],
      [['Alt', 'drag'], '1/64″ steps, no snapping'],
      [['↑', '↓'], 'Nudge a length 1/16″ (Shift: 1″)'],
      [['Ctrl', 'Z'], 'Undo (Ctrl Shift Z or Ctrl Y: redo)'],
    ],
  ],
  [
    'Notes and AI',
    [
      [['N'], 'Write a note about the selection'],
      [['M'], 'Voice notes: talk while pointing, M to stop'],
      [['Enter'], 'Send (Shift Enter: new line)'],
    ],
  ],
  [
    'View',
    [
      [['Middle-drag'], 'Orbit (Shift: pan)'],
      [['Right-drag'], 'Pan'],
      [['Wheel'], 'Zoom'],
      [['I'], 'Isolate the folder holding the selection (again: the whole model)'],
      [['D'], 'Dimension lines'],
      [['U'], 'Inches ⇄ millimetres'],
      [['L'], 'Cut list'],
      [['?'], 'This list'],
    ],
  ],
];

const PANELS_KEY = 'new-modeler.panels';
const DIMS_KEY = 'new-modeler.dims';
const load = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage unavailable: the choice lasts for this session
  }
};

export interface TopBarOptions {
  /** The app shell (#app); side panels hide with its `no-left` / `no-right` classes. */
  app: HTMLElement;
  bar: HTMLElement;
  store: Store;
}

export interface TopBar {
  /** Where file actions add their buttons, after Save (SketchUp import / export). */
  file: HTMLElement;
  /** Where tools add their buttons (cut list). */
  tools: HTMLElement;
  /** Where drawing tools add their buttons, in the middle of the bar (blocks). */
  draw: HTMLElement;
  /** Shows a side panel if it's hidden. */
  showPanel(side: 'left' | 'right'): void;
  /** Show dimension lines. */
  readonly dims: boolean;
  /** Dimension lines or display units changed. */
  subscribe(fn: () => void): void;
}

export function mountTopBar(o: TopBarOptions): TopBar {
  const { app, bar, store } = o;
  bar.append(el('style', {}, CSS));
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const button = (cls: string, title: string, ...kids: (Node | string)[]) => el('button', { class: `btn ${cls}`, title }, ...kids);

  // ── Side panels ──────────────────────────────────────────────────────────
  const panels = (() => {
    try {
      return { left: true, right: true, ...JSON.parse(load(PANELS_KEY) ?? '{}') } as { left: boolean; right: boolean };
    } catch {
      return { left: true, right: true };
    }
  })();
  const leftBtn = button('ghost icon', 'Show or hide the model list and settings', icon('panelLeft'));
  const rightBtn = button('ghost icon', 'Show or hide the AI panel', icon('panelRight'));
  const syncPanels = () => {
    app.classList.toggle('no-left', !panels.left);
    app.classList.toggle('no-right', !panels.right);
    leftBtn.setAttribute('aria-pressed', String(panels.left));
    rightBtn.setAttribute('aria-pressed', String(panels.right));
  };
  const togglePanel = (side: 'left' | 'right') => {
    panels[side] = !panels[side];
    save(PANELS_KEY, JSON.stringify(panels));
    syncPanels();
  };
  leftBtn.addEventListener('click', () => togglePanel('left'));
  rightBtn.addEventListener('click', () => togglePanel('right'));

  // ── File and history ─────────────────────────────────────────────────────
  const newBtn = button('ghost', 'Start an empty model (undo brings this one back)', 'New');
  const openBtn = button('ghost', 'Open a saved model file', 'Open…');
  const saveBtn = button('ghost', 'Download the model as a file', 'Save');
  const undoBtn = button('ghost icon', 'Undo (Ctrl+Z)', icon('undo'));
  const redoBtn = button('ghost icon', 'Redo (Ctrl+Shift+Z)', icon('redo'));
  newBtn.addEventListener('click', () => {
    if (!store.doc.roots.length) return;
    store.replace(emptyDoc());
    toast('Started a new model. Undo brings the last one back.');
  });
  openBtn.addEventListener('click', async () => {
    try {
      const doc = await pickFile();
      if (doc) store.replace(doc);
    } catch (err) {
      toast(`Couldn't open that file: ${(err as Error).message}`, true);
    }
  });
  saveBtn.addEventListener('click', () => downloadFile(store.doc));
  undoBtn.addEventListener('click', () => store.undo());
  redoBtn.addEventListener('click', () => store.redo());
  const syncHistory = () => {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
  };
  store.subscribe(syncHistory);

  // ── View ─────────────────────────────────────────────────────────────────
  let dims = load(DIMS_KEY) !== 'off';
  const dimsBtn = button('ghost', 'Dimension lines: overall size of the selection, or of the whole model (D)', icon('ruler'), el('span', { class: 't' }, 'Dims'));
  const inBtn = el('button', { title: 'Show inches (U)' }, 'in');
  const mmBtn = el('button', { title: 'Show millimetres (U) — lengths are stored exactly either way' }, 'mm');
  const toggleDims = () => {
    dims = !dims;
    save(DIMS_KEY, dims ? 'on' : 'off');
    syncView();
    emit();
  };
  const toggleUnits = () => units.set(units.system === 'mm' ? 'in' : 'mm');
  dimsBtn.addEventListener('click', toggleDims);
  inBtn.addEventListener('click', () => units.set('in'));
  mmBtn.addEventListener('click', () => units.set('mm'));
  const syncView = () => {
    dimsBtn.setAttribute('aria-pressed', String(dims));
    inBtn.setAttribute('aria-pressed', String(units.system === 'in'));
    mmBtn.setAttribute('aria-pressed', String(units.system === 'mm'));
  };
  units.subscribe(() => {
    syncView();
    emit();
  });

  // ── Keyboard list ────────────────────────────────────────────────────────
  const helpBtn = button('ghost icon', 'Keyboard shortcuts (?)', icon('help'));
  const help = el(
    'div',
    { class: 'pop help', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    ...HELP.flatMap(([title, rows]) => [
      el('h4', {}, title),
      el('dl', {}, ...rows.flatMap(([keys, what]) => [el('dt', {}, ...keys.map((k) => (/^(click|drag|double-click|triple-click|middle-drag|right-drag|wheel)$/i.test(k) ? k : el('kbd', {}, k)))), el('dd', {}, what)])),
    ]),
    el('p', {}, 'Lengths: 23 1/2, 23-1/2", 2\' 6", 18mm or 1.8cm. A bare number is in the units shown.'),
  );
  help.hidden = true;
  const toggleHelp = (show = help.hidden) => {
    help.hidden = !show;
    helpBtn.setAttribute('aria-pressed', String(show));
  };
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelp();
  });
  window.addEventListener('pointerdown', (e) => {
    if (!help.hidden && !help.contains(e.target as Node) && !helpBtn.contains(e.target as Node)) toggleHelp(false);
  });

  const file = el('div', { class: 'tools' });
  const tools = el('div', { class: 'tools' });
  const draw = el('div', { class: 'tools' });
  bar.append(
    el('div', { class: 'side' }, leftBtn, el('span', { class: 'mark' }, 'Modeler'), newBtn, openBtn, saveBtn, file, el('div', { class: 'sep' }), undoBtn, redoBtn),
    el('div', { class: 'mid' }, draw),
    el(
      'div',
      { class: 'side r' },
      dimsBtn,
      el('div', { class: 'seg units', role: 'group', 'aria-label': 'Units' }, inBtn, mmBtn),
      el('div', { class: 'sep' }),
      tools,
      el('div', { class: 'sep' }),
      helpBtn,
      rightBtn,
    ),
    help,
  );

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') toggleDims();
    else if (k === 'u') toggleUnits();
    else if (k === '?') toggleHelp();
    else if (k === 'escape' && !help.hidden) toggleHelp(false);
    else return;
    e.preventDefault();
  });

  syncPanels();
  syncHistory();
  syncView();
  return {
    file,
    tools,
    draw,
    showPanel: (side) => void (panels[side] || togglePanel(side)),
    get dims() {
      return dims;
    },
    subscribe: (fn) => void listeners.add(fn),
  };
}
