import type { Vector3 } from 'three';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { descendants } from '../model/doc';
import { enclosingAssembly, hiddenNodes, isolationBroken } from '../model/visibility';
import { allAffines, localBox, transformBox, union, type Box3 } from '../model/world';
import { isolateGridRect } from '../render/grid';
import { frameNodes, setView } from '../render/frameNodes';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { icon } from './icons';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * Isolating a folder: a view of just that folder — everything else hidden, the camera framed on it,
 * and the floor grid cut down to a small square under it — for working on one cabinet out of a
 * whole room. A view, not an edit: nothing in the model, its undo history or what the AI sees
 * changes (model/visibility.ts `isolateView` is the doc as it's drawn). I toggles it for the folder
 * holding the selection; the tree's right-click menu too. Leaving puts the camera back where it was.
 * It ends on its own when the folder goes away or something new lands outside it, so nothing new
 * is ever invisible.
 */

const STYLE = `
.iso-pill { position: absolute; top: 12px; left: 50%; z-index: 7; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  max-width: calc(100% - 32px); padding: 4px 4px 4px 10px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px;
  box-shadow: 0 8px 24px #0008; font-size: var(--fs-sm); }
.iso-pill > svg { flex: none; width: 15px; height: 15px; color: var(--fg-2); }
.iso-pill .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); }
.iso-pill .nm b { color: var(--fg); font-weight: 600; }
`;

export interface IsolationOptions {
  viewport: Viewport;
  store: Store;
  /** The 3D view's container (the pill goes there). */
  stage: HTMLElement;
  selection: Selection;
  /** A drawing tool has the keyboard: I stays out of its way. */
  toolActive(): boolean;
  /** Why this folder can't be isolated right now (e.g. a pending AI change outside it), or null. */
  blocked(id: string): string | null;
}

export interface Isolation {
  /** The isolated folder, or null: the whole model. */
  readonly id: string | null;
  /** Shows only this folder, framed, on a small grid (or says why not). */
  enter(id: string): void;
  /** Back to the whole model. `restore`: the camera goes back to where it was; `why` is said in a toast. */
  exit(restore?: boolean, why?: string): void;
  /** Why a folder can't be isolated (gone, hidden, nothing showing in it), or null. */
  refusal(doc: Doc, id: string): string | null;
  subscribe(fn: () => void): void;
}

/** A folder's parts that are showing. */
const visibleParts = (doc: Doc, id: string) => {
  const hidden = hiddenNodes(doc);
  return descendants(doc, id).filter((n) => doc.parts[n] && !hidden.has(n));
};

export function mountIsolation(o: IsolationOptions): Isolation {
  const { viewport, store } = o;
  o.stage.append(el('style', {}, STYLE));
  const name = el('span', { class: 'nm' });
  const leave = el('button', { class: 'btn ghost sm', title: 'Show the whole model again (I)' }, 'Show whole model');
  const pill = el('div', { class: 'iso-pill', role: 'status', hidden: true }, icon('focus'), name, leave);
  o.stage.append(pill);
  leave.addEventListener('click', () => isolation.exit());

  let current: string | null = null;
  /** The camera before isolating, for coming back. */
  let saved: { position: Vector3; target: Vector3 } | null = null;
  /** The doc the last check ran on (what's new is measured from it). */
  let prev = store.doc;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  const refusal = (doc: Doc, id: string): string | null => {
    const asm = doc.assemblies[id];
    if (!asm) return 'That folder is gone.';
    if (hiddenNodes(doc).has(id)) return `Show “${asm.name}” first, then isolate it.`;
    if (!visibleParts(doc, id).length) return `Nothing in “${asm.name}” is showing.`;
    return null;
  };

  /** The grid under the folder: around its showing parts, whole feet. */
  function syncGrid(doc: Doc) {
    if (!current) return viewport.grid.setBounds(null);
    const affines = allAffines(doc);
    const boxes: Box3[] = [];
    for (const id of visibleParts(doc, current)) {
      try {
        boxes.push(transformBox(affines.get(id)!, localBox(doc, id)));
      } catch {
        // doesn't build; it's missing from the view too
      }
    }
    if (boxes.length) viewport.grid.setBounds(isolateGridRect(union(boxes)));
  }

  function syncPill(doc: Doc) {
    pill.hidden = !current;
    if (current) name.replaceChildren('Isolated: ', el('b', {}, doc.assemblies[current]?.name || 'Folder'));
  }

  const isolation: Isolation = {
    get id() {
      return current;
    },
    refusal,
    enter(id) {
      const doc = store.doc;
      const why = refusal(doc, id) ?? o.blocked(id);
      if (why) return toast(why, true);
      if (id === current) return;
      if (!current) saved = { position: viewport.camera.position.clone(), target: viewport.controls.target.clone() };
      current = id;
      prev = doc;
      try {
        frameNodes(viewport, doc, visibleParts(doc, id));
      } catch {
        // the outline still shows what's in it
      }
      syncGrid(doc);
      syncPill(doc);
      emit();
    },
    exit(restore = true, why) {
      if (!current) return;
      current = null;
      viewport.grid.setBounds(null);
      if (restore && saved) setView(viewport, saved.position, saved.target);
      saved = null;
      syncPill(store.doc);
      if (why) toast(why);
      emit();
    },
    subscribe: (fn) => void listeners.add(fn),
  };

  store.subscribe((doc) => {
    const was = prev;
    prev = doc;
    if (!current) return;
    const folder = was.assemblies[current]?.name ?? 'the folder';
    const broken = isolationBroken(was, doc, current);
    if (broken === 'gone') return isolation.exit(false, `Showing the whole model: “${folder}” is no longer showing.`);
    if (broken === 'outside') return isolation.exit(false, `Showing the whole model: something new is outside “${folder}”.`);
    syncGrid(doc);
    syncPill(doc);
  });

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'i') return;
    if (target.closest('input, select, textarea') || o.toolActive()) return;
    e.preventDefault();
    if (current) return isolation.exit();
    const nodes = o.selection.targets.map((t) => t.node).filter((n) => store.doc.parts[n] || store.doc.assemblies[n]);
    if (!nodes.length) return toast('Select a folder, or something in one, to isolate it (I).', true);
    const id = enclosingAssembly(store.doc, nodes);
    if (!id) return toast('That’s not in a folder, so there’s nothing to isolate.', true);
    isolation.enter(id);
  });

  return isolation;
}
