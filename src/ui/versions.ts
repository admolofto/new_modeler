import { emptyDoc } from '../model/defaults';
import { serialize, upgradeDoc } from '../model/persistence';
import type { Doc } from '../model/schema';
import type { History, Store } from '../model/store';
import {
  addVersion, deserializeVersions, findVersion, neighborOf, newVersionSet, openVersions, removeVersion, serializeVersions, updateVersion,
  versionLabel, versionMeta, versionsFromJson, versionTitle, type Version, type VersionSet,
} from '../model/versions';
import { el } from './dom';
import { icon } from './icons';
import type { AppVersions } from './proposals';
import { downloadText, pickFileText, saveLocalNow } from './storage';
import { toast } from './toast';

/**
 * Design versions in the app: tabs in the top-left of the view (v1, v2, v3…) to flip between
 * alternatives of the model, + to start one as a copy of the open one, and an archive of every
 * version, put-away ones too. The AI makes versions through new_version (ai/tools.ts) when asked
 * for alternatives. Each version keeps its own undo history while you're on another one. The open
 * version's doc is the store's; the others autosave each under their own key.
 */

export interface VersionsOptions {
  /** The 3D view's container (the tabs and the archive go there). */
  stage: HTMLElement;
  store: Store;
  /** Why the open version can't be left right now (a pending AI proposal), or null. */
  blocked(): string | null;
  /** A small picture of the view as it is now (base64 JPEG), for the archive; null if there's none. */
  capture(): string | null;
}

export interface Versions extends AppVersions {
  readonly set: VersionSet;
  /** Opens a version (an archived one comes back to the tabs). False if it can't be left now. */
  open(id: string): boolean;
  /** Starts a version as a copy of `id` (default: the open one) and opens it. */
  duplicate(id?: string): void;
  /** File › New model: one empty version (asks first when there are several). */
  newModel(): void;
  /** File › Open: the file's versions replace these. */
  openFile(): Promise<void>;
  /** File › Save: every version in one file. */
  saveFile(): void;
  subscribe(fn: () => void): void;
}

const META_KEY = 'new-modeler.versions';
const DOC_KEY = (id: string) => `new-modeler.version.${id}`;
const THUMBS_KEY = 'new-modeler.version-thumbs';

const CSS = `
.vtabs { position: absolute; top: 12px; left: 12px; z-index: 9; display: flex; align-items: center; gap: 2px; max-width: calc(50% - 60px);
  padding: 3px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 8px 24px #0008; font-size: var(--fs-sm); }
#stage:has(> .plan2d:not([style*="none"])) .vtabs { top: 50px; }
.vtabs .strip { display: flex; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.vtabs .strip::-webkit-scrollbar { display: none; }
.vtab { position: relative; flex: none; display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 0; border-radius: 7px;
  background: none; color: var(--fg-2); font: inherit; white-space: nowrap; cursor: pointer; }
.vtab:hover { background: var(--hover); color: var(--fg); }
.vtab.on { background: var(--press); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line-3); }
.vtab b { font-weight: 600; }
.vtab .nm { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.vtab svg { width: 12px; height: 12px; flex: none; }
.vtab svg.ai { color: var(--ai); }
.vtab .caret { display: grid; place-items: center; width: 16px; height: 18px; margin-right: -5px; border-radius: 4px; color: var(--fg-3); }
.vtab .caret:hover { background: var(--hover); color: var(--fg); }
.vtab .caret svg { transform: rotate(90deg); }
.vtab.unseen::after { content: ''; position: absolute; top: 4px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--ai); }
.vtab input { width: 110px; height: 20px; padding: 0 5px; border: 1px solid var(--focus); border-radius: 4px; background: var(--field); color: var(--fg); font: inherit; }
.vtabs .vbtn { flex: none; display: grid; place-items: center; position: relative; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px;
  background: none; color: var(--fg-2); cursor: pointer; }
.vtabs .vbtn:hover { background: var(--hover); color: var(--fg); }
.vtabs .vbtn svg { width: 15px; height: 15px; }
.vtabs .vbtn[data-n]::after { content: attr(data-n); position: absolute; right: 0; bottom: 1px; min-width: 12px; padding: 0 2px; border-radius: 6px;
  background: var(--line-3); color: var(--fg); font-size: 9px; line-height: 12px; text-align: center; }
.vtabs .sep { align-self: stretch; width: 1px; margin: 3px 2px; background: var(--line-2); }
.vmenu { position: fixed; z-index: 60; display: grid; min-width: 170px; padding: 4px; background: var(--raised); border: 1px solid var(--line-2);
  border-radius: 8px; box-shadow: 0 12px 32px #000a; font-size: var(--fs-sm); }
.vmenu button { display: flex; justify-content: space-between; gap: 16px; padding: 6px 10px; border: 0; border-radius: 5px; background: none; color: var(--fg);
  font: inherit; text-align: left; cursor: pointer; }
.vmenu button:hover:not(:disabled), .vmenu button:focus-visible { background: var(--hover); outline: none; }
.vmenu button:disabled { color: var(--fg-3); cursor: default; }
.vmenu .k { color: var(--fg-3); }
.vmenu .msep { height: 1px; margin: 4px 2px; background: var(--line-2); }
.varch { position: absolute; inset: 0; z-index: 12; display: flex; flex-direction: column; background: #121316f2; backdrop-filter: blur(4px); overflow: auto; }
.varch header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 16px 20px 12px; background: linear-gradient(#121316, #121316e6 70%, #12131600); }
.varch h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; }
.varch header p { flex: 1; margin: 0; color: var(--fg-2); font-size: var(--fs-sm); }
.varch h3 { margin: 8px 20px 10px; color: var(--fg-2); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.varch .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; padding: 0 20px 20px; }
.varch .card { display: flex; flex-direction: column; overflow: hidden; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; }
.varch .card.on { border-color: var(--sel); }
.varch .card.archived .pic { filter: grayscale(.7) brightness(.8); }
.varch .pic { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 10; padding: 0; border: 0; background: var(--canvas); color: var(--fg-3);
  font: 600 22px var(--font); cursor: pointer; }
.varch .pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.varch .pic .now { position: absolute; left: 8px; top: 8px; padding: 1px 7px; border-radius: 9px; background: var(--sel); color: #1b1203; font-size: var(--fs-xs); }
.varch .body { display: grid; gap: 4px; padding: 10px 12px 6px; }
.varch .ttl { display: flex; align-items: center; gap: 6px; font-size: var(--fs); }
.varch .ttl b { font-weight: 600; }
.varch .ttl svg { width: 13px; height: 13px; color: var(--ai); }
.varch .meta { color: var(--fg-3); font-size: var(--fs-xs); }
.varch .sum { margin: 2px 0 0; color: var(--fg-2); font-size: var(--fs-sm); line-height: 1.45; }
.varch .acts { display: flex; flex-wrap: wrap; gap: 2px; margin-top: auto; padding: 4px 6px 8px; }
.varch .acts .btn { padding: 3px 8px; font-size: var(--fs-sm); }
.varch .acts .btn.bad { margin-left: auto; color: var(--bad); }
.varch .empty { margin: 0 20px 20px; color: var(--fg-3); font-size: var(--fs-sm); }
`;

// ── Local autosave: the set's details, each version's doc under its own key ──

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let storageWarned = false;
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    console.warn('version autosave failed', err);
    if (!storageWarned) toast('The browser’s storage is full, so not every version autosaves. Save the model to a file (Ctrl+S) to keep them all.', true);
    storageWarned = true;
  }
}

function readDoc(id: string): Doc | null {
  const text = read(DOC_KEY(id));
  if (!text) return null;
  try {
    return upgradeDoc(JSON.parse(text));
  } catch (err) {
    console.warn(`autosaved version ${id} could not be loaded; kept as`, `${DOC_KEY(id)}.unreadable`, err);
    write(`${DOC_KEY(id)}.unreadable`, text);
    return null;
  }
}

/** The autosaved versions around `open` (the autosaved model), or just it. */
export function loadLocalVersions(open: Doc): VersionSet {
  const text = read(META_KEY);
  if (!text) return newVersionSet(open);
  try {
    const raw = JSON.parse(text) as { active?: string };
    return versionsFromJson(raw, (id) => (id === raw.active ? open : readDoc(id)));
  } catch (err) {
    console.warn('autosaved versions could not be loaded', err);
    return newVersionSet(open);
  }
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function mountVersions(o: VersionsOptions): Versions {
  const { store } = o;
  let set = loadLocalVersions(store.doc);
  /** Undo histories of the versions that aren't open (this session only). */
  const histories = new Map<string, History>();
  const thumbs = new Map<string, string>(Object.entries((() => {
    try {
      return JSON.parse(read(THUMBS_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  })()));
  const listeners = new Set<() => void>();

  const find = (id: string) => set.versions.find((v) => v.id === id);
  const docOf = (id: string): Doc | undefined => (id === set.active ? store.doc : find(id)?.doc);
  const saveDoc = (id: string) => {
    const v = find(id);
    if (v && id !== set.active) write(DOC_KEY(id), serialize(v.doc));
  };
  const saveThumbs = () => write(THUMBS_KEY, JSON.stringify(Object.fromEntries(thumbs)));
  const snap = (id: string) => {
    const pic = o.capture();
    if (!pic) return;
    thumbs.set(id, pic);
    saveThumbs();
  };
  const changed = () => {
    write(META_KEY, JSON.stringify({ active: set.active, list: set.versions.map(versionMeta) }));
    render();
    listeners.forEach((fn) => fn());
  };
  const canLeave = () => {
    const why = o.blocked();
    if (why) toast(why, true);
    return !why;
  };

  function open(id: string): boolean {
    if (id === set.active) return true;
    const target = find(id);
    if (!target || !canLeave()) return false;
    const from = set.active;
    snap(from);
    set = updateVersion(set, from, { doc: store.doc });
    // Switch the set first, so anything the store's listeners read is already the new version.
    set = updateVersion({ ...set, active: id }, id, { unseen: false, archived: false });
    saveDoc(from);
    histories.set(from, store.swap(target.doc, histories.get(id)));
    histories.delete(id);
    saveLocalNow(store.doc);
    changed();
    return true;
  }

  function duplicate(id = set.active): void {
    const src = find(id);
    const doc = docOf(id);
    if (!src || !doc || !canLeave()) return;
    const r = addVersion(set, { doc, by: 'user' });
    set = r.set;
    saveDoc(r.version.id);
    if (thumbs.has(id)) thumbs.set(r.version.id, thumbs.get(id)!);
    open(r.version.id);
    toast(`${versionLabel(r.version)} is a copy of ${versionTitle(src)}. Double-click its tab to name it.`);
  }

  function archive(id: string): void {
    const v = find(id);
    if (!v || v.archived) return;
    if (id === set.active) {
      const next = neighborOf(set, id);
      if (!next) return toast('This is the only open version. Make or restore another one before archiving it.', true);
      if (!open(next)) return;
    }
    set = updateVersion(set, id, { archived: true });
    changed();
    toast(`Archived ${versionTitle(v)}. It’s in the version archive (the box at the end of the tabs).`);
  }

  function restore(id: string): void {
    set = updateVersion(set, id, { archived: false });
    changed();
  }

  function remove(id: string): void {
    const v = find(id);
    if (!v || id === set.active) return;
    if (!confirm(`Delete ${versionTitle(v)} for good? This can’t be undone.`)) return;
    set = removeVersion(set, id);
    write(DOC_KEY(id), null);
    thumbs.delete(id);
    saveThumbs();
    histories.delete(id);
    changed();
  }

  function rename(id: string, name: string): void {
    const v = find(id);
    if (!v || v.name === name.trim()) return;
    set = updateVersion(set, id, { name: name.trim().slice(0, 40) });
    changed();
  }

  /** Replaces every version (New, Open). One version for one keeps undo (as before versions). */
  function load(next: VersionSet): void {
    const doc = next.versions.find((v) => v.id === next.active)!.doc;
    const single = set.versions.length === 1 && next.versions.length === 1;
    for (const v of set.versions) write(DOC_KEY(v.id), null);
    thumbs.clear();
    saveThumbs();
    histories.clear();
    set = next;
    for (const v of set.versions) saveDoc(v.id);
    if (single) store.replace(doc);
    else store.swap(doc);
    saveLocalNow(store.doc);
    changed();
  }

  // ── Tabs ─────────────────────────────────────────────────────────────
  const strip = el('div', { class: 'strip' });
  const addBtn = el('button', { class: 'vbtn', title: 'New version: a copy of this one, to try something different' }, icon('plus'));
  const archBtn = el('button', { class: 'vbtn', title: 'Version archive: every version, archived ones too' }, icon('archive'));
  const bar = el('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Design versions' }, strip, addBtn, el('div', { class: 'sep' }), archBtn);
  o.stage.append(el('style', {}, CSS), bar);
  addBtn.addEventListener('click', () => duplicate());
  archBtn.addEventListener('click', () => toggleArchive(true));
  let renaming: string | null = null;

  function tooltip(v: Version): string {
    const by = v.by === 'ai' ? 'Made by the AI' : 'Made by you';
    const how = v.id === set.active ? 'Double-click to rename; right-click for more' : 'Click to open; right-click for more';
    return [versionTitle(v), v.summary, `${by}, ${dateFmt.format(v.created)}`, how].filter(Boolean).join('\n');
  }

  function tab(v: Version, n: number): HTMLElement {
    const on = v.id === set.active;
    const b = el('div', { class: `vtab${on ? ' on' : ''}${v.unseen ? ' unseen' : ''}`, role: 'tab', tabindex: 0, 'aria-selected': String(on), title: `${tooltip(v)}${n < 9 ? ` (Alt+${n + 1})` : ''}` });
    if (renaming === v.id) {
      const input = el('input', { value: v.name, placeholder: versionLabel(v), 'aria-label': `Name for ${versionLabel(v)}` });
      let done = false;
      const finish = (keep: boolean) => {
        if (done) return;
        done = true;
        renaming = null;
        if (keep) rename(v.id, input.value);
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      b.append(el('b', {}, versionLabel(v)), input);
      queueMicrotask(() => (input.focus(), input.select()));
      return b;
    }
    b.append(el('b', {}, versionLabel(v)), ...(v.name ? [el('span', { class: 'nm' }, v.name)] : []), ...(v.by === 'ai' ? [icon('sparkle', 'ai')] : []));
    if (on) {
      const caret = el('span', { class: 'caret', title: 'Rename, duplicate or archive' }, icon('chevron'));
      caret.addEventListener('click', (e) => (e.stopPropagation(), showMenu(v, b)));
      b.append(caret);
    }
    b.addEventListener('click', () => open(v.id));
    b.addEventListener('dblclick', () => {
      if (v.id !== set.active) return;
      renaming = v.id;
      render();
    });
    b.addEventListener('contextmenu', (e) => (e.preventDefault(), showMenu(v, b)));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), open(v.id));
    });
    return b;
  }

  function render(): void {
    const tabs = openVersions(set);
    strip.replaceChildren(...tabs.map(tab));
    const archived = set.versions.length - tabs.length;
    if (archived) archBtn.dataset.n = String(archived);
    else delete archBtn.dataset.n;
    strip.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!panel.hidden) renderArchive();
  }

  // ── Tab menu ─────────────────────────────────────────────────────────
  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };
  function showMenu(v: Version, at: HTMLElement): void {
    closeMenu();
    const item = (label: string, run: () => void, disabled = false) => {
      const b = el('button', { type: 'button', role: 'menuitem', disabled }, label);
      b.addEventListener('click', () => (closeMenu(), run()));
      return b;
    };
    menu = el('div', { class: 'vmenu', role: 'menu', 'aria-label': versionTitle(v) },
      ...(v.id === set.active ? [] : [item('Open', () => open(v.id))]),
      item('Rename', () => {
        if (v.id !== set.active && !open(v.id)) return;
        renaming = v.id;
        render();
      }),
      item('Duplicate', () => duplicate(v.id)),
      item('Archive', () => archive(v.id), openVersions(set).length < 2),
      el('div', { class: 'msep' }),
      item('All versions…', () => toggleArchive(true)),
    );
    document.body.append(menu);
    const r = at.getBoundingClientRect();
    Object.assign(menu.style, { left: `${r.left}px`, top: `${r.bottom + 6}px` });
    (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
  }
  window.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  }, true);

  // ── Archive ──────────────────────────────────────────────────────────
  const panel = el('div', { class: 'varch', role: 'dialog', 'aria-label': 'Version archive' });
  panel.hidden = true;
  o.stage.append(panel);

  function card(v: Version): HTMLElement {
    const on = v.id === set.active;
    const pic = el('button', { class: 'pic', title: on ? 'Back to the model' : `Open ${versionTitle(v)}` });
    const shot = thumbs.get(v.id);
    pic.append(shot ? el('img', { src: `data:image/jpeg;base64,${shot}`, alt: '' }) : versionLabel(v));
    if (on) pic.append(el('span', { class: 'now' }, 'Open now'));
    pic.addEventListener('click', () => {
      if (open(v.id)) toggleArchive(false);
    });
    const btn = (label: string, title: string, run: () => void, cls = '') => {
      const b = el('button', { class: `btn ghost ${cls}`, title }, label);
      b.addEventListener('click', run);
      return b;
    };
    const acts = el('div', { class: 'acts' },
      ...(on ? [] : [btn('Open', `Open ${versionTitle(v)}`, () => open(v.id) && toggleArchive(false))]),
      btn('Duplicate', 'Start a new version as a copy of this one', () => (duplicate(v.id), toggleArchive(false))),
      ...(v.archived
        ? [btn('Restore', 'Put it back in the tabs', () => restore(v.id)), btn('Delete', 'Delete it for good', () => remove(v.id), 'bad')]
        : [btn('Archive', 'Take it out of the tabs; it stays here', () => archive(v.id))]),
    );
    const title = el('div', { class: 'ttl' }, el('b', {}, versionLabel(v)), ...(v.name ? [el('span', {}, v.name)] : []), ...(v.by === 'ai' ? [icon('sparkle')] : []));
    title.title = 'Double-click to rename';
    title.addEventListener('dblclick', () => {
      const name = prompt(`Name for ${versionLabel(v)}`, v.name);
      if (name !== null) rename(v.id, name);
    });
    return el('div', { class: `card${on ? ' on' : ''}${v.archived ? ' archived' : ''}` }, pic,
      el('div', { class: 'body' }, title,
        el('div', { class: 'meta' }, `${v.by === 'ai' ? 'Made by the AI' : 'Made by you'} · ${dateFmt.format(v.created)}`),
        ...(v.summary ? [el('p', { class: 'sum' }, v.summary)] : [])),
      acts);
  }

  function renderArchive(): void {
    const open = openVersions(set);
    const archived = set.versions.filter((v) => v.archived);
    const close = el('button', { class: 'btn ghost icon', title: 'Close (Esc)' }, icon('x'));
    close.addEventListener('click', () => toggleArchive(false));
    const scroll = panel.scrollTop;
    panel.replaceChildren(
      el('header', {}, el('h2', {}, 'Versions'), el('p', {}, 'Every version of this model. Archived ones are out of the tabs but kept here until you delete them.'), close),
      el('h3', {}, `In the tabs (${open.length})`),
      el('div', { class: 'grid' }, ...open.map(card)),
      el('h3', {}, `Archived (${archived.length})`),
      archived.length ? el('div', { class: 'grid' }, ...archived.map(card)) : el('p', { class: 'empty' }, 'Nothing archived yet. Archive a version from its tab’s menu to put it away.'),
    );
    panel.scrollTop = scroll;
  }

  function toggleArchive(on = panel.hidden): void {
    closeMenu();
    if (on) snap(set.active);
    panel.hidden = !on;
    if (on) renderArchive();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu) return void closeMenu();
    if (e.key === 'Escape' && !panel.hidden) return void toggleArchive(false);
    // Alt+1…9: the tabs in order (plain keys belong to the tools).
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
    if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
    const v = openVersions(set)[Number(e.code.slice(5)) - 1];
    if (!v) return;
    e.preventDefault();
    open(v.id);
  });

  render();

  return {
    get set() {
      return set;
    },
    open,
    duplicate,
    newModel() {
      if (set.versions.length === 1 && !store.doc.roots.length) return;
      if (set.versions.length > 1 && !confirm(`Start a new model? This closes all ${set.versions.length} versions of this one. Save it first (Ctrl+S) to keep them.`)) return;
      const undoable = set.versions.length === 1;
      load(newVersionSet(emptyDoc()));
      toast(undoable ? 'Started a new model. Undo brings the last one back.' : 'Started a new model.');
    },
    async openFile() {
      let next: VersionSet;
      try {
        const text = await pickFileText();
        if (text === null) return;
        next = deserializeVersions(text);
      } catch (err) {
        return toast(`Couldn't open that file: ${(err as Error).message}`, true);
      }
      if (set.versions.length > 1 && !confirm(`Open this file? It replaces all ${set.versions.length} versions of the model you have open. Save it first (Ctrl+S) to keep them.`)) return;
      load(next);
      if (next.versions.length > 1) toast(`Opened ${next.versions.length} versions.`);
    },
    saveFile() {
      downloadText(serializeVersions(set, store.doc), 'model.modeler.json');
    },
    subscribe(fn) {
      listeners.add(fn);
    },

    // For the AI (new_version).
    start(name, summary, from) {
      const base = from === undefined ? find(set.active) : findVersion(set, from);
      if (!base) throw new Error(`there's no version "${from}"; the versions are ${set.versions.map((v) => versionLabel(v)).join(', ')}`);
      const r = addVersion(set, { doc: docOf(base.id)!, by: 'ai', name, ...(summary && { summary }) });
      set = r.set;
      saveDoc(r.version.id);
      changed();
      return { id: r.version.id, label: versionTitle(r.version) };
    },
    doc: docOf,
    save(id, doc) {
      if (id === set.active) return void store.replace(doc);
      if (!find(id)) return;
      set = updateVersion(set, id, { doc });
      thumbs.delete(id);
      saveDoc(id);
      changed();
    },
    describe() {
      if (set.versions.length < 2) return '';
      const open = openVersions(set).map((v) => `${versionTitle(v)}${v.id === set.active ? ' (open)' : ''}${v.by === 'ai' ? ' (made by you)' : ''}`);
      const archived = set.versions.length - open.length;
      return `The user's versions of this design (tabs): ${open.join(', ')}${archived ? `; ${archived} archived` : ''}.`;
    },
  };
}
