import { emptyDoc } from '../model/defaults';
import type { Store } from '../model/store';
import { el } from './dom';
import { icon } from './icons';
import { downloadFile, pickFile } from './storage';
import { toast } from './toast';
import { units } from './units';

/**
 * The top bar, left to right: the model-list toggle, the File menu (new / open / save, plus what other
 * modules add: SketchUp and glTF import / export), undo / redo and the drawing tools (room, props); then
 * how the model is shown (dimension lines D, open / close Shift+O, inches ⇄ mm U), the modes (2D plan,
 * Present), the panels other modules add (recipes, cut list, references), the keyboard list (?) and the
 * side-panel toggle. View settings are per-browser preferences, not model data.
 */

const CSS = `
#topbar { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 8px; background: var(--chrome); border-bottom: 1px solid var(--line); }
#topbar .side { display: flex; align-items: center; gap: 2px; min-width: 0; }
#topbar .mark { padding: 0 8px 0 6px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
#topbar .sep { flex: none; width: 1px; height: 18px; margin: 0 6px; background: var(--line-2); }
#topbar .tools { display: flex; align-items: center; gap: 2px; }
#topbar .seg.units { margin-left: 4px; }
#topbar .seg.units button { padding: 0 8px; }
#topbar .dd { position: relative; }
#topbar .dd > .btn .caret { width: 12px; height: 12px; margin-left: -2px; transform: rotate(90deg); opacity: .7; }
#topbar .menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; display: grid; min-width: 232px; padding: 4px;
  background: var(--raised); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 10px 30px #0008; }
#topbar .menu[hidden] { display: none; }
#topbar .menu .tools { display: contents; }
#topbar .menu button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: 30px; padding: 0 10px;
  border: 0; border-radius: 6px; background: none; color: var(--fg); font-size: var(--fs); font-weight: 400; text-align: left; cursor: pointer; }
#topbar .menu button:hover:not(:disabled), #topbar .menu button:focus-visible { background: var(--hover); outline: none; }
#topbar .menu button .k { margin-left: auto; padding-left: 16px; color: var(--fg-3); font-size: var(--fs-sm); }
#topbar .menu .msep { height: 1px; margin: 4px 6px; background: var(--line-2); }
#topbar .menu .mlbl { padding: 6px 10px 2px; color: var(--fg-3); font-size: var(--fs-xs); }
@media (max-width: 1440px) { #topbar .shows .btn .t { display: none; } #topbar .shows .btn:not(.icon) { padding: 0 7px; } }
@media (max-width: 1240px) { #topbar .side.r .tools .btn .t { display: none; } #topbar .side.r .tools .btn:not(.icon) { padding: 0 7px; } }
@media (max-width: 1000px) { #topbar .side .tools .btn .t { display: none; } #topbar .side .tools .btn:not(.icon) { padding: 0 7px; } }
.help { top: 48px; right: 8px; width: 400px; max-height: calc(100vh - 64px); overflow-y: auto; font-size: var(--fs-sm); }
.help h4 { margin: 10px 0 4px; font-size: var(--fs-sm); color: var(--fg-2); font-weight: 600; }
.help h4:first-child { margin-top: 0; }
.help dl { display: grid; grid-template-columns: 118px 1fr; gap: 4px 10px; margin: 0; }
.help dt { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; color: var(--fg-2); }
.help dd { margin: 0; }
.help p { margin: 10px 0 0; color: var(--fg-2); }
`;

const HELP: [string, [string[], string][]][] = [
  [
    'Tools (SketchUp’s keys)',
    [
      [['Space'], 'Select'],
      [['M'], 'Move: click a point, then where it goes'],
      [['Q'], 'Rotate: center, a point to turn from, the angle'],
      [['P'], 'Push / Pull: click a face, move, click'],
      [['R'], 'Rectangle: draw a block — corner, corner, height (also B)'],
      [['T'], 'Tape measure: click two points'],
      [['E'], 'Eraser: click parts, or drag across them'],
      [['O', 'H', 'Z'], 'Orbit, pan, zoom with the left button'],
      [['Type'], 'A value any time, then ⏎: 24 · 3 1/2 · 45 (no need to click a box)'],
      [['→', '←', '↑'], 'Lock to the red, green or blue axis (again: let go)'],
      [['Shift'], 'Hold to stay on the axis you’re following'],
      [['Ctrl'], 'While moving or turning: a copy; then 3x for a row, /3 to space three'],
      [['Esc'], 'Back out a step, then back to Select'],
    ],
  ],
  [
    'Select',
    [
      [['Click'], 'The face, edge or corner under the cursor'],
      [['Double-click'], 'The whole part'],
      [['Triple-click'], 'The whole piece (cabinet, assembly)'],
      [['Shift', 'click'], 'Add to the selection'],
      [['Ctrl', 'A'], 'Everything showing'],
      [['Tree'], 'Ctrl click: toggle a row; Shift click: every row between; right-click: hide, unclickable, isolate'],
      [['Drag'], 'Box: left→right takes parts inside, right→left parts touched'],
      [['Esc'], 'Clear the selection, cancel a drag'],
      [['Del'], 'Delete what’s selected'],
    ],
  ],
  [
    'Blocks',
    [
      [['Type'], 'Sizes while drawing: 24, 18 ⏎'],
      [['Drag'], 'A selected block’s face to push / pull it'],
      [['S'], 'Split the selected block (Tab: axis)'],
    ],
  ],
  [
    'With the Select tool',
    [
      [['Drag'], 'The gizmo’s arrows, square or rings; a selected face or point to push / pull it'],
      [['Ctrl', 'drag'], 'Move a copy'],
      [['Ctrl', 'D'], 'Copy it alongside'],
      [[']', '['], 'Quarter turn, either way'],
      [['Alt', 'drag'], '1/64″ steps, no snapping'],
      [['↑', '↓'], 'In a length box: nudge 1/16″ (Shift: 1″)'],
      [['Ctrl', 'Z'], 'Undo (Ctrl Shift Z or Ctrl Y: redo)'],
    ],
  ],
  [
    'Notes and AI',
    [
      [['N'], 'Write a note about the selection'],
      [['V'], 'Voice notes: talk while pointing, V to stop'],
      [['Enter'], 'Send (Shift Enter: new line)'],
    ],
  ],
  [
    'View',
    [
      [['Middle-drag'], 'Orbit (Shift: pan)'],
      [['Right-drag'], 'Pan'],
      [['Wheel'], 'Zoom toward the cursor'],
      [['Shift', 'Z'], 'Zoom extents: fit the whole model'],
      [['I'], 'Isolate the folder holding the selection (again: the whole model)'],
      [['Shift', 'O'], 'Open / close the selection’s doors, drawers and lids (nothing selected: all of them)'],
      [['D'], 'Dimension lines'],
      [['U'], 'Inches ⇄ millimetres'],
      [['Shift', 'P'], 'Present: a rendered view for clients; click doors and drawers to open them (Esc leaves)'],
      [['L'], 'Cut list'],
      [['?'], 'This list'],
    ],
  ],
  [
    'Presenting (Shift+P)',
    [
      [['Click'], 'Open or close the door, drawer or appliance under the cursor'],
      [['Double-click'], 'Fly in to that spot (walking: walk to it)'],
      [['Drag'], 'Orbit (right-drag: pan, wheel: zoom)'],
      [['→', '←'], 'Next / previous saved view (PageDown / PageUp, Space, 1–9)'],
      [['V'], 'Walk at eye height: WASD or the arrows, drag to look'],
      [['O'], 'Open / close everything'],
      [['L'], 'Next lighting: Auto, Day, Evening, Night, Studio'],
      [['H'], 'Hide the controls (they also fade when the mouse rests)'],
      [['F'], 'Fullscreen'],
      [['Esc'], 'Cancel a photo, leave walking, then leave presenting'],
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
  /** File › New / Open / Save when something else owns them (design versions: every version goes in the file). */
  files?: { newModel(): void; openFile(): Promise<void>; saveFile(): void };
}

export interface TopBar {
  /** Where file actions add their buttons: the File menu, after Save (SketchUp import / export, glTF). */
  file: HTMLElement;
  /** Where tools add their buttons (cut list). */
  tools: HTMLElement;
  /** Where drawing tools add their buttons, after undo / redo (room, props). */
  draw: HTMLElement;
  /** Where view toggles add their buttons, beside Dims (open / close). */
  view: HTMLElement;
  /** Where whole-screen modes add their buttons (2D plan, Present). */
  modes: HTMLElement;
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
  const item = (title: string, label: string, key?: string) => el('button', { type: 'button', role: 'menuitem', title }, label, ...(key ? [el('span', { class: 'k' }, key)] : []));
  const newBtn = item('Start an empty model (undo brings this one back)', 'New model');
  const openBtn = item('Open a saved model file', 'Open…', 'Ctrl+O');
  const saveBtn = item('Download the model as a file', 'Save', 'Ctrl+S');
  const undoBtn = button('ghost icon', 'Undo (Ctrl+Z)', icon('undo'));
  const redoBtn = button('ghost icon', 'Redo (Ctrl+Shift+Z)', icon('redo'));
  newBtn.addEventListener('click', () => {
    if (o.files) return o.files.newModel();
    if (!store.doc.roots.length) return;
    store.replace(emptyDoc());
    toast('Started a new model. Undo brings the last one back.');
  });
  openBtn.addEventListener('click', async () => {
    if (o.files) return o.files.openFile();
    try {
      const doc = await pickFile();
      if (doc) store.replace(doc);
    } catch (err) {
      toast(`Couldn't open that file: ${(err as Error).message}`, true);
    }
  });
  const saveModel = () => (o.files ? o.files.saveFile() : downloadFile(store.doc));
  saveBtn.addEventListener('click', saveModel);
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

  // ── File menu ────────────────────────────────────────────────────────────
  const file = el('div', { class: 'tools' });
  const fileBtn = button('ghost', 'New, open, save, import and export', 'File', icon('chevron', 'caret'));
  fileBtn.setAttribute('aria-haspopup', 'menu');
  fileBtn.setAttribute('aria-expanded', 'false');
  const fileMenu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'File' }, newBtn, openBtn, saveBtn, el('div', { class: 'msep' }), el('div', { class: 'mlbl' }, 'Other apps'), file);
  fileMenu.hidden = true;
  const fileDd = el('div', { class: 'dd' }, fileBtn, fileMenu);
  const menuItems = () => [...fileMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const toggleFile = (show = fileMenu.hidden, focusFirst = false) => {
    fileMenu.hidden = !show;
    fileBtn.setAttribute('aria-expanded', String(show));
    fileBtn.setAttribute('aria-pressed', String(show));
    if (show && focusFirst) menuItems()[0]?.focus();
  };
  fileBtn.addEventListener('click', (e) => toggleFile(fileMenu.hidden, e.detail === 0));
  // Any item closes the menu (its own click handler still runs).
  fileMenu.addEventListener('click', (e) => (e.target as HTMLElement).closest('button') && toggleFile(false));
  fileMenu.addEventListener('keydown', (e) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    else if (e.key === 'Escape') (toggleFile(false), fileBtn.focus());
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('pointerdown', (e) => {
    if (!fileMenu.hidden && !fileDd.contains(e.target as Node)) toggleFile(false);
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

  const tools = el('div', { class: 'tools' });
  const draw = el('div', { class: 'tools' });
  const view = el('div', { class: 'tools' });
  const modes = el('div', { class: 'tools' });
  bar.append(
    el('div', { class: 'side' }, leftBtn, el('span', { class: 'mark' }, 'Modeler'), fileDd, el('div', { class: 'sep' }), undoBtn, redoBtn, el('div', { class: 'sep' }), draw),
    el(
      'div',
      { class: 'side r' },
      el('div', { class: 'tools shows' }, dimsBtn, view),
      el('div', { class: 'seg units', role: 'group', 'aria-label': 'Units' }, inBtn, mmBtn),
      el('div', { class: 'sep' }),
      modes,
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
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    // Ctrl+S / Ctrl+O: save and open, as in any app (even from a text box, so the browser's own dialogs never show).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (k === 's' || k === 'o')) {
      e.preventDefault();
      (k === 's' ? saveBtn : openBtn).click();
      return;
    }
    if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
    if (k === 'escape' && !fileMenu.hidden) toggleFile(false);
    else if (k === 'd') toggleDims();
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
    view,
    modes,
    showPanel: (side) => void (panels[side] || togglePanel(side)),
    get dims() {
      return dims;
    },
    subscribe: (fn) => void listeners.add(fn),
  };
}
