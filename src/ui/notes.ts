import { targetPoint } from '../edit/targets';
import type { Op } from '../model/ops';
import type { Annotation, Doc } from '../model/schema';
import type { Store } from '../model/store';
import type { Pin } from '../render/overlay';
import type { ChatPanel } from './chatPanel';
import { el } from './dom';
import { icon } from './icons';
import { targetLabel } from './labels';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * Notes in the chat: notes pinned on the model (written in the left panel, or spoken as voice
 * notes), numbered like their pins in the view. New ones wait on top of the message box and go
 * with the next message; sent ones stay in that message, ticked off once the AI resolves them.
 * Which notes were sent is this conversation's, not the model's. Clicking a pin shows its note
 * and selects what it points at.
 */

const STYLE = `
.nlist { display: grid; gap: 2px; white-space: normal; }
.nrow { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 6px; align-items: start; padding: 3px 4px; border-radius: 6px; }
.nrow.active { background: var(--sel-soft); }
.nrow .num { display: grid; place-items: center; width: 20px; height: 20px; margin-top: 2px; padding: 0; border: 0; border-radius: 50%; background: var(--note);
  color: #fff; font-size: var(--fs-xs); font-weight: 700; cursor: pointer; }
.nrow.active .num { background: var(--sel); color: #1b1206; }
.nrow.done .num, .nrow.gone .num { background: var(--line-3); }
.nrow .num svg { width: 12px; height: 12px; }
.nrow textarea { display: block; width: 100%; min-height: 26px; padding: 2px 6px; border-color: transparent; background: none; }
.nrow .txt { padding-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.nrow.done .txt { color: var(--fg-2); }
.nrow.gone .txt { color: var(--fg-3); text-decoration: line-through; }
.nrow .tg { color: var(--fg-3); font-size: var(--fs-xs); }
.nrow textarea + .tg { padding-left: 7px; }
.nrow .acts { display: flex; gap: 2px; }
`;

export interface NotesOptions {
  store: Store;
  selection: Selection;
  panel: ChatPanel;
  /** The doc on screen (an AI proposal while one is pending), so the numbers match the pins. */
  shown(): Doc;
  /** Shows the AI panel (a new note arrived, or a pin was clicked). */
  reveal(): void;
}

export interface Notes {
  /** Pins for the overlay (open notes). */
  pins(doc: Doc): Pin[];
  /** Shows a note (from its pin) and selects what it points at. */
  focus(id: string): void;
  /** Drops the highlighted note (the selection was cleared). */
  clearActive(): void;
  /** Called when pins need redrawing without a doc change. */
  onPins(fn: () => void): void;
  /** Re-renders (the doc on screen changed, e.g. an AI preview). */
  refresh(): void;
}

/** A sent message's notes, with their text as sent (shown if the note is deleted later). */
interface Batch {
  notes: { id: string; text: string }[];
  host: HTMLElement;
}

const openNotes = (doc: Doc) => Object.values(doc.annotations).filter((a) => !a.resolved);

export function mountNotes(o: NotesOptions): Notes {
  const { store, selection, panel } = o;
  const slot = panel.notesSlot;
  slot.before(el('style', {}, STYLE));
  const sent = new Set<string>();
  const batches: Batch[] = [];
  let active: string | null = null;
  const pinListeners = new Set<() => void>();
  const pinsChanged = () => pinListeners.forEach((fn) => fn());
  const waiting = (doc: Doc) => openNotes(doc).filter((n) => !sent.has(n.id));
  /** Notes that have waited on the message box; a new one opens the AI panel. Seeded so a reload doesn't. */
  const seen = new Set(waiting(o.shown()).map((n) => n.id));

  const dispatch = (ops: Op[]) => {
    const r = store.dispatch(ops);
    toast(r.ok ? '' : r.error, !r.ok);
    return r.ok;
  };
  const button = (name: Parameters<typeof icon>[0], title: string, onClick: () => void) => {
    const b = el('button', { class: 'btn ghost icon sm', title }, icon(name));
    b.addEventListener('click', onClick);
    return b;
  };
  const targets = (doc: Doc, n: Annotation) => el('div', { class: 'tg' }, n.targets.map((t) => targetLabel(doc, t)).join(' → '));
  const badge = (n: Annotation, num: string) => {
    const b = el('button', { class: 'num', title: 'Select what this note points at' }, n.resolved ? icon('check') : num);
    b.addEventListener('click', () => focus(n.id));
    return b;
  };
  const row = (id: string, cls: string, ...kids: Node[]) => el('div', { class: `nrow${cls}${id === active ? ' active' : ''}`, 'data-note': id }, ...kids);

  /** A note waiting on the message box: edit it, or delete it. */
  function waitingRow(doc: Doc, n: Annotation, num: string): HTMLElement {
    const text = el('textarea', { rows: 1, 'aria-label': `Note ${num}`, 'data-edit': n.id });
    text.value = n.note;
    const fit = () => {
      text.style.height = 'auto';
      text.style.height = `${text.scrollHeight + 2}px`;
    };
    text.addEventListener('input', fit);
    requestAnimationFrame(fit);
    text.addEventListener('change', () => {
      const v = text.value.trim();
      if (v && v !== n.note) dispatch([{ op: 'update', id: n.id, patch: { note: v } }]);
    });
    const del = button('x', 'Delete note (Ctrl+Z brings it back)', () => dispatch([{ op: 'delete', id: n.id }]));
    return row(n.id, '', badge(n, num), el('div', {}, text, targets(doc, n)), el('div', { class: 'acts' }, del));
  }

  /** A note in a sent message, as it is now. */
  function sentRow(doc: Doc, s: Batch['notes'][number], num: string | undefined): HTMLElement {
    const n = doc.annotations[s.id];
    if (!n) return row(s.id, ' gone', el('span', { class: 'num' }, icon('x')), el('div', {}, el('div', { class: 'txt' }, s.text), el('div', { class: 'tg' }, 'Deleted')));
    const again = () => {
      sent.delete(n.id);
      if (n.resolved) dispatch([{ op: 'update', id: n.id, patch: { resolved: false } }]);
      else render();
    };
    const acts = [
      ...(n.resolved ? [] : [button('check', 'Mark resolved', () => dispatch([{ op: 'update', id: n.id, patch: { resolved: true } }]))]),
      ...(sent.has(n.id) ? [button('reopen', n.resolved ? 'Reopen: put it back on the message box' : 'Send again: put it back on the message box', again)] : []),
      button('trash', 'Delete note', () => dispatch([{ op: 'delete', id: n.id }])),
    ];
    return row(n.id, n.resolved ? ' done' : '', badge(n, num ?? ''), el('div', {}, el('div', { class: 'txt' }, n.note), targets(doc, n)), el('div', { class: 'acts' }, ...acts));
  }

  function render() {
    const doc = o.shown();
    const nums = new Map(openNotes(doc).map((n, i) => [n.id, String(i + 1)]));
    const wait = waiting(doc);
    // Keep a note being edited (its text and focus) across re-renders.
    const focused = document.activeElement instanceof HTMLTextAreaElement && slot.contains(document.activeElement) ? document.activeElement : null;
    const editing = focused?.dataset.edit;
    slot.replaceChildren(el('div', { class: 'nlist' }, ...wait.map((n) => waitingRow(doc, n, nums.get(n.id)!))));
    if (focused && editing) {
      const again = slot.querySelector<HTMLTextAreaElement>(`textarea[data-edit="${CSS.escape(editing)}"]`);
      if (again) {
        again.value = focused.value;
        again.focus();
      }
    }
    for (const b of batches) b.host.replaceChildren(...b.notes.map((s) => sentRow(doc, s, nums.get(s.id))));
    panel.notesChanged(wait.length);
    const fresh = wait.filter((n) => !seen.has(n.id));
    if (fresh.length) {
      fresh.forEach((n) => seen.add(n.id));
      o.reveal();
    }
  }

  function focus(id: string) {
    const n = store.doc.annotations[id];
    if (!n) return;
    active = id;
    o.reveal();
    selection.set(n.targets.filter((t) => store.doc.parts[t.node] || store.doc.assemblies[t.node]).map((t) => structuredClone(t)));
    render();
    pinsChanged();
    // On the message box if it's waiting, else in the last message that sent it.
    const find = (host: HTMLElement) => host.querySelector<HTMLElement>(`.nrow[data-note="${CSS.escape(id)}"]`);
    const at = find(slot) ?? batches.map((b) => find(b.host)).filter((r) => r !== null).at(-1);
    at?.scrollIntoView({ block: 'nearest' });
  }

  panel.setNoteAttachments({
    pending: () => waiting(o.shown()).map((n) => n.id),
    send(ids) {
      const doc = o.shown();
      const b: Batch = { notes: ids.map((id) => ({ id, text: doc.annotations[id]?.note ?? '' })), host: el('div', { class: 'nlist' }) };
      ids.forEach((id) => sent.add(id));
      batches.push(b);
      render();
      return b.host;
    },
    reset() {
      sent.clear();
      batches.length = 0;
      render();
    },
  });
  store.subscribe(() => render());
  render();

  return {
    pins(doc) {
      return openNotes(doc).flatMap((n, i): Pin[] => {
        const pts = n.targets.map((t) => targetPoint(doc, t));
        const at = pts.find((p) => p !== null);
        if (!at) return [];
        return [{ noteId: n.id, label: String(i + 1), at, links: pts.filter((p): p is NonNullable<typeof p> => p !== null && p !== at), active: n.id === active }];
      });
    },
    focus,
    clearActive() {
      if (!active) return;
      active = null;
      render();
      pinsChanged();
    },
    onPins: (fn) => void pinListeners.add(fn),
    refresh: render,
  };
}
