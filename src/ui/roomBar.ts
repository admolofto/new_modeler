import { roomPick } from '../edit/openings';
import type { Target } from '../edit/targets';
import { genPartId } from '../model/generate';
import { placeOpening, roomParams } from '../model/room';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { openingLabel, type OpeningKind, type RoomOpening } from '../plugins/generators/room';
import { el } from './dom';
import { icon } from './icons';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * The room's toolbar: while the room or anything of it (a wall, a window, a door) is selected, a
 * pill over the view adds a window, a door or a cased opening — on the selected wall, else wherever
 * there's the most room — and removes the selected one. New ones come selected, ready to drag into
 * place and resize by their grips (ui/openingDrag.ts).
 */

export interface RoomBarOptions {
  /** The 3D view's container (the pill goes there). */
  stage: HTMLElement;
  store: Store;
  selection: Selection;
  /** The doc on screen. */
  shown(): Doc;
  /** Why direct edits are off right now, or null. */
  editBlocked(): string | null;
}

const STYLE = `
.room-bar { position: absolute; top: 12px; left: 50%; z-index: 6; transform: translateX(-50%); display: flex; align-items: center; gap: 4px;
  max-width: calc(100% - 32px); padding: 4px 4px 4px 10px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px;
  box-shadow: 0 8px 24px #0008; font-size: var(--fs-sm); white-space: nowrap; }
.room-bar.low { top: 56px; }
.room-bar > svg { flex: none; width: 15px; height: 15px; color: var(--fg-2); }
.room-bar .nm { margin-right: 4px; color: var(--fg-2); }
.room-bar .sep { align-self: stretch; width: 1px; margin: 2px; background: var(--line-2); }
`;

const KINDS: { kind: OpeningKind; label: string; title: string }[] = [
  { kind: 'window', label: 'Window', title: 'Add a window' },
  { kind: 'door', label: 'Door', title: 'Add a door' },
  { kind: 'opening', label: 'Opening', title: 'Add a cased opening (a doorway with no door)' },
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function mountRoomBar(o: RoomBarOptions): { sync(): void } {
  const { store, selection } = o;
  const bar = el('div', { class: 'room-bar', role: 'toolbar', 'aria-label': 'Room' });
  bar.style.display = 'none';
  o.stage.append(el('style', {}, STYLE), bar);
  let sig = '';

  /** What to select for an opening: its window, its door, else (a bare opening) its jamb in the wall. */
  function targetOf(doc: Doc, room: string, op: RoomOpening): Target | null {
    const node = [`window-${op.id}`, `door-${op.id}-leaf`].map((role) => genPartId(room, role)).find((id) => doc.parts[id]);
    if (node) return { node };
    const wall = genPartId(room, `wall-${op.wall}`);
    return doc.parts[wall] ? { node: wall, handle: `${op.id}:jamb-left` } : null;
  }

  function edit(room: string, openings: RoomOpening[]): boolean {
    const blocked = o.editBlocked();
    if (blocked) {
      toast(blocked, true);
      return false;
    }
    const r = store.dispatch([{ op: 'update', id: room, patch: { params: { openings } } }]);
    if (!r.ok) toast(r.error, true);
    return r.ok;
  }

  function add(kind: OpeningKind) {
    const pick = roomPick(store.doc, selection.targets);
    const asm = pick && store.doc.assemblies[pick.room];
    if (!pick || !asm) return;
    const p = roomParams(asm);
    const wall = pick.wall && p.walls.includes(pick.wall) ? pick.wall : null;
    const next = (wall && placeOpening(p, kind, wall)) ?? placeOpening(p, kind);
    if (!next) return toast(`No wall has room for a ${kind}.`, true);
    if (!edit(pick.room, [...p.openings, next])) return;
    const target = targetOf(store.doc, pick.room, next);
    if (target) selection.set([target]);
    toast(`Added ${openingLabel(next)} on the ${next.wall} wall${wall && next.wall !== wall ? ` (the ${wall} wall has no room for it)` : ''}. Drag it where it goes.`);
  }

  function remove() {
    const pick = roomPick(store.doc, selection.targets);
    const asm = pick?.opening && store.doc.assemblies[pick.room];
    if (!pick?.opening || !asm) return;
    const gone = pick.opening;
    if (!edit(pick.room, roomParams(asm).openings.filter((q) => q.id !== gone.id))) return;
    selection.set([{ node: pick.room }]);
    toast(`Removed ${openingLabel(gone)}.`);
  }

  function sync() {
    const pick = roomPick(o.shown(), selection.targets);
    const low = !!o.stage.querySelector('.iso-pill');
    const next = pick ? `${pick.room}|${pick.wall}|${pick.opening && openingLabel(pick.opening)}|${low}` : '';
    if (next === sig) return;
    sig = next;
    bar.style.display = pick ? '' : 'none';
    if (!pick) return;
    bar.classList.toggle('low', low);
    const where = pick.wall ? `on the ${pick.wall} wall` : 'where there is the most room';
    const buttons = KINDS.map(({ kind, label, title }) => {
      const b = el('button', { class: 'btn sm', title: `${title} ${where}` }, icon('plus'), label);
      b.addEventListener('click', () => add(kind));
      return b;
    });
    const drop = pick.opening ? el('button', { class: 'btn sm ghost', title: `Remove ${openingLabel(pick.opening)}` }, icon('trash'), cap(openingLabel(pick.opening))) : null;
    drop?.addEventListener('click', remove);
    bar.replaceChildren(icon('room'), el('span', { class: 'nm' }, pick.wall ? `${cap(pick.wall)} wall` : 'Room'), ...buttons, ...(drop ? [el('span', { class: 'sep' }), drop] : []));
  }

  selection.subscribe(sync);
  return { sync };
}
