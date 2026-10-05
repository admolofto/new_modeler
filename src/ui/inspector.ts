import { actionsFor, type Action } from '../edit/actions';
import { blockSize, setRotationOps, splitEvenOps } from '../edit/blocks';
import { handleDrives, setDriveOps, type Drive } from '../edit/drives';
import { handleKind, targetKey, type Target } from '../edit/targets';
import { clashesOf, clashText } from '../model/clearance';
import { partMachining } from '../model/cutlist';
import { DEFAULT_CARCASS } from '../model/defaults';
import { descendants, parentIndex } from '../model/doc';
import { generatedOwner, genPartId } from '../model/generate';
import { motionBasis, motionIndex, motionName, motionOf, motionSummary } from '../model/motion';
import type { Op } from '../model/ops';
import type { Assembly, Doc, Grain, Motion, Part } from '../model/schema';
import type { Store } from '../model/store';
import { variablesOf } from '../model/variables';
import { boxSize, localBox } from '../model/world';
import { motions } from '../plugins';
import type { CarcassParams } from '../plugins/generators/carcass';
import { towardOf } from '../plugins/motions/hinge';
import { SIDES, type Side } from '../plugins/motions/sides';
import { slideDistance, type SlideParams } from '../plugins/motions/slide';
import { el } from './dom';
import { icon } from './icons';
import { handleLabel, targetLabel } from './labels';
import type { MotionPlayer } from './motionPlayer';
import type { Selection } from './selection';
import { toast } from './toast';
import { fmt, LENGTH_HINT, parse, shop, units } from './units';

/**
 * Left panel, bottom: what's selected and what you can change about it — the cabinet it belongs
 * to (its generator's settings), its material, grain, position and rotation, what's machined on it,
 * the sizes a selected face / edge / point drives, actions (drill, pocket, round over, join two
 * parts…), how it opens (its animation, with play and an open-amount slider) and a note for the AI.
 * A block gets "What is it?" (its name, which the AI builds from), its size and placement instead.
 * Every change is an op through the store; direct edits wait while an AI proposal is pending.
 * Playing and the slider are a view (ui/motionPlayer.ts), so they work any time.
 */

const STYLE = `
.insp { flex: 1 1 0; min-height: 140px; overflow-y: auto; border-top: 1px solid var(--line); }
.insp .empty { padding: 14px; color: var(--fg-3); font-size: var(--fs-sm); }
.insp .head { display: flex; align-items: flex-start; gap: 2px; padding: 12px 8px 10px 14px; }
.insp .head .t { flex: 1; min-width: 0; }
.insp .head h3 { margin: 0; font-size: var(--fs-lg); font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.insp .head .sub { margin-top: 2px; color: var(--fg-2); font-size: var(--fs-sm); }
.insp .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: -2px; padding: 0 14px 10px; }
.insp .chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; height: 22px; padding: 0 2px 0 8px; border-radius: 11px;
  background: var(--sel-soft); font-size: var(--fs-xs); }
.insp .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.insp .chip button { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 9px; background: none;
  color: var(--fg-2); cursor: pointer; }
.insp .chip button:hover { background: var(--press); color: var(--fg); }
.insp .chip svg { width: 12px; height: 12px; }
.insp .sec { padding: 10px 14px 12px; }
.insp .info { margin: 0 0 6px; color: var(--fg-2); font-size: var(--fs-sm); }
.insp .info .btn { margin-left: 4px; vertical-align: middle; }
.insp .foot { margin-top: 6px; color: var(--fg-3); font-size: var(--fs-xs); }
.insp .stack { display: grid; gap: 4px; margin: 4px 0 2px; }
.insp .stack > .lbl { color: var(--fg-2); font-size: var(--fs-sm); }
.insp .xyz { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.insp .xyz input { width: 100%; }
.insp .drive .lbl { width: auto; flex: 1; white-space: normal; }
.insp .drive input { width: 84px; }
.insp .mach { display: flex; align-items: flex-start; gap: 6px; padding: 3px 0; font-size: var(--fs-sm); }
.insp .mach > span { flex: 1; min-width: 0; padding-top: 3px; }
.insp .mach.joint > span { color: var(--fg-3); }
.insp .mach-note { margin-top: 4px; color: var(--fg-3); font-size: var(--fs-xs); }
.insp .act { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; padding: 6px 0; }
.insp .act + .act { padding-top: 8px; border-top: 1px solid var(--line); }
.insp .act label { display: grid; gap: 2px; color: var(--fg-3); font-size: var(--fs-xs); }
.insp .act input { width: 76px; }
.insp .note-in { display: block; width: 100%; min-height: 54px; }
.insp .what { display: block; width: 100%; }
.insp .turn { display: flex; gap: 4px; margin-top: 4px; }
.insp .note-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
.insp .play { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.insp .play input[type=range] { flex: 1; min-width: 0; accent-color: var(--fg-2); }
.insp .play .btn.open { min-width: 76px; }
.insp .warn { color: var(--warn); }
`;

export interface InspectorOptions {
  /** The left panel. */
  parent: HTMLElement;
  store: Store;
  selection: Selection;
  /** The doc on screen (an AI proposal while one is pending). */
  shown(): Doc;
  editBlocked(): string | null;
  cancelDrag(): boolean;
  /** Esc cleared the selection (notes drop their highlight). */
  onClear(): void;
  /** The split tool and copy-alongside, for a selected block's buttons. */
  blockTools?: { split(): void; duplicate(): void };
  /** How far things are open: the Animation section's play button and slider. */
  player?: MotionPlayer;
}

const HINGE_SIDES: [Side, string][] = [
  ['left', 'Left'],
  ['right', 'Right'],
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['back', 'Back'],
  ['front', 'Front'],
];
const SLIDE_WAYS: [Side, string][] = [
  ['front', 'Out (front)'],
  ['back', 'In (back)'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['top', 'Up'],
  ['bottom', 'Down'],
];

/** The nodes an animation added for this selection would move: a folder picked whole, else the whole parts picked. */
function animationNodes(doc: Doc, targets: readonly Target[], whole: Assembly | null): string[] | null {
  if (targets.some((t) => t.handle || doc.parts[t.node]?.block)) return null;
  return whole ? [whole.id] : targets.map((t) => t.node);
}

const GRAINS: [Grain, string][] = [
  ['x', 'Left–right (x)'],
  ['y', 'Up–down (y)'],
  ['z', 'Front–back (z)'],
  ['none', 'None'],
];

const AXES = ['x (left–right)', 'y (up)', 'z (front–back)'];
const SIZES: [string, 'x' | 'y' | 'z'][] = [
  ['Width', 'x'],
  ['Height', 'y'],
  ['Depth', 'z'],
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every part under an assembly, if these whole parts are exactly that (e.g. a cabinet picked from the list). */
function wholeAssembly(doc: Doc, targets: readonly Target[]): Assembly | null {
  if (targets.some((t) => t.handle || !doc.parts[t.node])) return null;
  const ids = new Set(targets.map((t) => t.node));
  if (ids.size < 2) return null;
  const parents = parentIndex(doc);
  for (let p = parents.get(targets[0]!.node); p; p = parents.get(p)) {
    const parts = descendants(doc, p).filter((id) => doc.parts[id]);
    if (parts.length === ids.size && parts.every((id) => ids.has(id))) return doc.assemblies[p] ?? null;
    if (parts.length > ids.size) return null;
  }
  return null;
}

/** The cabinet whose settings apply to these whole parts: the one they all belong to. */
function cabinetOf(doc: Doc, targets: readonly Target[], whole: Assembly | null): Assembly | null {
  if (whole?.generator?.type === 'carcass') return whole;
  if (targets.length === 1 && doc.assemblies[targets[0]!.node]?.generator?.type === 'carcass') return doc.assemblies[targets[0]!.node]!;
  if (targets.some((t) => t.handle)) return null;
  const owners = new Set(targets.map((t) => generatedOwner(doc, t.node)?.id ?? null));
  const [only] = owners;
  return owners.size === 1 && only && doc.assemblies[only]!.generator!.type === 'carcass' ? doc.assemblies[only]! : null;
}

export function mountInspector(o: InspectorOptions): { focusNote(): void } {
  const { store, selection } = o;
  o.parent.append(el('style', {}, STYLE));
  const body = el('div', { class: 'insp', 'aria-label': 'Selection' });
  o.parent.append(body);

  const dispatch = (ops: Op[], coalesce?: string) => {
    const r = store.dispatch(ops, coalesce ? { coalesce } : undefined);
    toast(r.ok ? '' : r.error, !r.ok);
    return r.ok;
  };
  const editOps = (ops: Op[], coalesce?: string) => {
    const blocked = o.editBlocked();
    if (blocked) return toast(blocked, true), false;
    return dispatch(ops, coalesce);
  };

  /** Length field in the display units; ↑/↓ step 1/16" (Shift 1"). `key` keeps it focused across re-renders. */
  function lengthField(value: number | null, onCommit: ((u: number) => void) | null, key?: string, placeholder = ''): HTMLInputElement {
    const input = el('input', { type: 'text', placeholder, value: value === null ? '' : fmt(value), title: LENGTH_HINT });
    if (key) input.dataset.key = key;
    const read = () => (input.value.trim() === '' ? null : parse(input.value));
    input.addEventListener('input', () => {
      const u = read();
      input.classList.toggle('bad', u === null && input.value.trim() !== '');
      if (onCommit && u !== null) onCommit(u);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const next = (read() ?? 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 64 : 4);
      input.value = fmt(next);
      onCommit?.(next);
    });
    return input;
  }

  function selectField(key: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const select = el('select', { 'data-key': key }, ...options.map(([v, label]) => el('option', { value: v }, label)));
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  /** Degrees; ↑/↓ step 1° (Shift 15°). */
  function angleField(value: number, onCommit: (deg: number) => void, key: string, label: string): HTMLInputElement {
    const input = el('input', { type: 'text', value: `${value}°`, 'data-key': key, 'aria-label': label, title: `${label}, in degrees` });
    const read = () => {
      const t = input.value.trim().replace(/°$/, '');
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? n : null;
    };
    input.addEventListener('input', () => {
      const d = read();
      input.classList.toggle('bad', d === null && input.value.trim() !== '');
      if (d !== null) onCommit(d);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const next = (read() ?? 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 15 : 1);
      input.value = `${next}°`;
      onCommit(next);
    });
    return input;
  }

  /** Position (its origin corner, in its parent's frame) and rotation (about its center) of a part, block or assembly. */
  function placement(id: string, position: readonly number[], rot: readonly number[], turn: boolean): HTMLElement[] {
    const node = () => store.doc.parts[id] ?? store.doc.assemblies[id];
    const move = (k: number, u: number) => {
      const n = node();
      if (!n) return;
      const to = [...n.transform.position] as [number, number, number];
      to[k] = u;
      editOps([{ op: 'move', id, to }], `move:${id}:${k}`);
    };
    const spin = (k: number, deg: number, coalesce?: string) => {
      const n = node();
      if (!n) return;
      const r = [...n.transform.rotation] as [number, number, number];
      r[k] = k === 1 && coalesce === undefined ? r[k] + deg : deg;
      editOps(setRotationOps(store.doc, id, r), coalesce);
    };
    const turns = turn
      ? [
          el(
            'div',
            { class: 'turn' },
            ...([90, -90] as const).map((deg) => {
              const b = el('button', { class: 'btn sm', title: `A quarter turn ${deg > 0 ? 'to the left' : 'to the right'} (${deg > 0 ? 'R' : 'Shift+R'})` }, deg > 0 ? '↺ 90°' : '↻ 90°');
              b.addEventListener('click', () => spin(1, deg));
              return b;
            }),
          ),
        ]
      : [];
    return [
      el(
        'div',
        { class: 'stack' },
        el('span', { class: 'lbl' }, 'Position'),
        el(
          'div',
          { class: 'xyz' },
          ...[0, 1, 2].map((k) => {
            const input = lengthField(position[k]!, (u) => move(k, u), `move:${id}:${k}`);
            input.title = `${AXES[k]} of its lower-left-back corner. ${LENGTH_HINT}`;
            input.setAttribute('aria-label', `Position ${AXES[k]}`);
            return input;
          }),
        ),
      ),
      el(
        'div',
        { class: 'stack' },
        el('span', { class: 'lbl' }, 'Rotation (about its center)'),
        el('div', { class: 'xyz' }, ...[0, 1, 2].map((k) => angleField(rot[k]!, (d) => spin(k, d, `rot:${id}:${k}`), `rot:${id}:${k}`, `Rotation about ${'xyz'[k]}`))),
        ...turns,
      ),
    ];
  }

  const row = (label: string, ...kids: (Node | string)[]) => el('div', { class: 'frow' }, el('span', { class: 'lbl', title: label }, label), ...kids);
  const section = (title: string, ...kids: (Node | string)[]) => el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, title), ...kids);
  /** Sections that fold; each remembers whether it's open for the session. */
  const folded = new Set<string>();
  const foldable = (title: string, ...kids: (Node | string)[]) => {
    const box = el('details', { class: 'sec', open: !folded.has(title) }, el('summary', { class: 'sec-h' }, title, el('span', { class: 'sp' }), icon('chevron', 'chev')), ...kids);
    box.addEventListener('toggle', () => (box.open ? folded.delete(title) : folded.add(title)));
    return box;
  };

  // ── Header ────────────────────────────────────────────────────────────────
  function header(doc: Doc, targets: readonly Target[], whole: Assembly | null, remove: Op[] | null, removeLabel: string): HTMLElement[] {
    let title: string;
    let sub = '';
    const t = targets[0]!;
    const part = doc.parts[t.node];
    if (whole) {
      title = whole.name;
      sub = `${whole.generator?.type === 'carcass' ? 'Cabinet' : 'Assembly'} · ${plural(targets.length, 'part')}`;
    } else if (targets.length > 1) {
      const kinds = new Set(targets.map((x) => (x.handle ? handleKind(x.handle) : 'part')));
      const kind = kinds.size === 1 ? [...kinds][0]! : 'item';
      title = plural(targets.length, kind === 'vertex' ? 'corner' : kind);
    } else if (t.handle) {
      title = handleLabel(doc, t);
      sub = part?.name ?? '';
    } else if (part) {
      title = part.name;
      const mat = part.block ? 'Block' : part.material ? (doc.materials[part.material]?.name ?? part.material) : 'No material';
      let size = '';
      try {
        size = ` · ${boxSize(localBox(doc, part.id)).map(fmt).join(' × ')}`;
      } catch {
        // doesn't build; the part shows as missing in the view too
      }
      sub = `${mat}${size}`;
    } else {
      title = targetLabel(doc, t);
    }
    const del = el('button', { class: 'btn ghost icon', title: `${removeLabel} (Del)` }, icon('trash'));
    del.hidden = !remove;
    del.addEventListener('click', () => remove && editOps(remove) && selection.set([]));
    const clear = el('button', { class: 'btn ghost icon', title: 'Clear the selection (Esc)' }, icon('x'));
    clear.addEventListener('click', () => selection.set([]));
    const out = [el('div', { class: 'head' }, el('div', { class: 't' }, el('h3', { class: 'len' }, ...shop(title)), ...(sub ? [el('div', { class: 'sub len' }, ...shop(sub))] : [])), del, clear)];
    if (targets.length > 1 && !whole) {
      out.push(
        el(
          'div',
          { class: 'chips' },
          ...targets.map((x) => {
            const drop = el('button', { title: 'Deselect' }, icon('x'));
            drop.addEventListener('click', () => selection.toggle(x));
            return el('span', { class: 'chip' }, el('span', {}, targetLabel(doc, x)), drop);
          }),
        ),
      );
    }
    return out;
  }

  // ── Cabinet (carcass generator settings) ──────────────────────────────────
  function cabinetSection(doc: Doc, asm: Assembly): HTMLElement {
    const p = asm.generator!.params as unknown as CarcassParams;
    const set = (params: Partial<CarcassParams>, key?: string) => editOps([{ op: 'update', id: asm.id, patch: { params } }], key && `gen:${asm.id}:${key}`);
    const k = (name: string) => `gen:${asm.id}:${name}`;
    const materials = Object.values(doc.materials).map((m): [string, string] => [m.id, m.name]);
    const size = (label: string, name: 'width' | 'height' | 'depth') => row(label, lengthField(p[name], (u) => set({ [name]: u }, name), k(name)));

    const kick = el('input', { type: 'checkbox', checked: !!p.toeKick, 'data-key': k('kick') });
    kick.addEventListener('change', () => set({ toeKick: kick.checked ? { ...DEFAULT_CARCASS.toeKick } : null }));
    const shelves = el('input', { type: 'number', min: 0, max: 12, value: String(p.shelves), 'data-key': k('shelves'), style: 'width:72px' });
    shelves.addEventListener('input', () => {
      const n = Number(shelves.value);
      if (shelves.value.trim() !== '' && Number.isInteger(n)) set({ shelves: n }, 'shelves');
    });

    const edited: string[] = [];
    const removed: string[] = [];
    for (const [role, ov] of Object.entries(asm.generator!.overrides)) {
      if (ov.deleted) removed.push(role.replace(/-/g, ' '));
      else edited.push(doc.parts[genPartId(asm.id, role)]?.name ?? role);
    }
    const foot = [edited.length ? `Changed by hand, kept when the cabinet changes: ${edited.join(', ')}.` : '', removed.length ? `Removed: ${removed.join(', ')}.` : '']
      .filter(Boolean)
      .join(' ');

    return foldable(
      'Cabinet',
      size('Width', 'width'),
      size('Height', 'height'),
      size('Depth', 'depth'),
      row('Material', selectField(k('mat'), materials, p.material, (v) => set({ material: v }))),
      row(
        'Back',
        selectField(k('back'), [['inset', 'Inset'], ['applied', 'Applied'], ['none', 'None']], p.back, (v) => set({ back: v as CarcassParams['back'] })),
      ),
      ...(p.back === 'none' ? [] : [row('Back material', selectField(k('backMat'), materials, p.backMaterial ?? p.material, (v) => set({ backMaterial: v })))]),
      row('Toe kick', el('label', { class: 'check' }, kick)),
      ...(p.toeKick
        ? [
            row('Kick height', lengthField(p.toeKick.height, (u) => set({ toeKick: { ...p.toeKick!, height: u } }, 'kickH'), k('kickH'))),
            row('Kick depth', lengthField(p.toeKick.depth, (u) => set({ toeKick: { ...p.toeKick!, depth: u } }, 'kickD'), k('kickD'))),
          ]
        : []),
      row('Shelves', shelves),
      row('Doors', selectField(k('doors'), [['0', 'None'], ['1', 'One'], ['2', 'A pair']], String(p.doors ?? 0), (v) => set({ doors: Number(v) }))),
      ...(p.doors === 1
        ? [row('Hinge side', selectField(k('doorHinge'), [['left', 'Left'], ['right', 'Right']], p.doorHinge ?? 'left', (v) => set({ doorHinge: v as 'left' | 'right' })))]
        : []),
      ...(p.doors ? [row('Door swing', angleField(p.doorAngle ?? 105, (d) => d > 0 && d <= 180 && set({ doorAngle: d }, 'doorAngle'), k('doorAngle'), 'How far the doors open'))] : []),
      row('Joinery', selectField(k('joinery'), [['dado', 'Dado'], ['butt', 'Butt']], p.joinery, (v) => set({ joinery: v as CarcassParams['joinery'] }))),
      ...(foot ? [el('div', { class: 'foot' }, foot)] : []),
    );
  }

  // ── Animation (how it opens) ──────────────────────────────────────────────
  /** Updates the shown play button and slider in place as things open and close (a re-render would drop a slider mid-drag). */
  let live: (() => void) | null = null;
  o.player?.subscribe(() => live?.());
  o.player?.onMove(() => live?.());

  /** ▶ Open / Close and how far open: a view, so they work any time (even with an AI proposal pending). */
  function playRow(m: Motion, ...extra: HTMLElement[]): HTMLElement {
    const player = o.player;
    if (!player) return el('div', { class: 'play' }, ...extra);
    const label = el('span', {}, 'Open');
    const btn = el('button', { class: 'btn sm open', title: 'Open or close it (O)' }, icon('play'), label);
    btn.addEventListener('click', () => player.toggle([m.id]));
    const slider = el('input', { type: 'range', min: 0, max: 100, step: 1, value: '0', 'aria-label': 'How far open', title: 'How far open — just the view; the model stays closed' });
    slider.addEventListener('input', () => player.scrub(m.id, Number(slider.value) / 100));
    // Let go of the slider and the keyboard shortcuts work again.
    slider.addEventListener('change', () => slider.blur());
    live = () => {
      label.textContent = player.isOpen(m.id) ? 'Close' : 'Open';
      slider.value = String(Math.round(player.amount(m.id) * 100));
    };
    live();
    return el('div', { class: 'play' }, btn, slider, ...extra);
  }

  /** Whether it opens clear, else what it hits and how far open (and `fix`: what to try). */
  function clearLines(doc: Doc, m: Motion, fix: string): HTMLElement[] {
    let clashes;
    try {
      clashes = clashesOf(doc, m.id);
    } catch {
      return [];
    }
    if (!clashes.length) return [el('div', { class: 'foot' }, 'Opens clear.')];
    return clashes.map((c) => el('div', { class: 'info warn len' }, ...shop(`${clashText(doc, c, fmt)}.${c.with ? '' : ` ${fix}`}`)));
  }

  function addAnimation(doc: Doc, nodes: string[]): HTMLElement {
    const parents = parentIndex(doc);
    if (new Set(nodes.map((id) => parents.get(id) ?? null)).size > 1) {
      return foldable('Animation', el('div', { class: 'info' }, 'To animate things together, pick things in one folder — or the folder itself, in the list.'));
    }
    const presets = motions.all().flatMap((d) => d.presets.map((p, i) => ({ key: `${d.type}:${i}`, type: d.type, label: p.label, params: p.params as Record<string, unknown> })));
    const pick = selectField('motion:add', [['', 'Choose…'], ...presets.map((p): [string, string] => [p.key, p.label])], '', (v) => {
      const p = presets.find((x) => x.key === v);
      if (!p || !editOps([{ op: 'add', entity: { kind: 'motion', nodes, type: p.type, params: { ...p.params } } }])) return;
      // Show it working; tune it while it's open.
      const added = motionIndex(store.doc).get(nodes[0]!);
      if (added) o.player?.toggle([added.id]);
    });
    const parent = parents.get(nodes[0]!);
    const folder = nodes.length === 1 && doc.parts[nodes[0]!] && parent && !doc.assemblies[parent]?.generator && !generatedOwner(doc, nodes[0]!) ? doc.assemblies[parent] : undefined;
    const hint = folder ? `Moves just this part. To move all of “${folder.name}”, click it in the list first.` : 'Pick how it opens; fine-tune it after.';
    return foldable('Animation', row('Opens like', pick), el('div', { class: 'foot' }, hint));
  }

  function motionControls(doc: Doc, m: Motion, nodes: string[]): HTMLElement {
    const rides = m.nodes.some((id) => nodes.includes(id)) ? [] : [el('div', { class: 'info' }, `Opens with “${motionName(doc, m)}”.`)];
    if (m.role !== undefined) {
      const owner = generatedOwner(doc, m.nodes[0]!);
      const how = m.type === 'hinge' ? 'change it with Doors, Hinge side and Door swing under Cabinet' : 'it comes out as far as its box goes';
      const fix = m.type === 'hinge' ? 'Try the other hinge side, a filler, or less Door swing.' : 'Move what’s in the way.';
      return foldable('Animation', ...rides, el('div', { class: 'info len' }, ...shop(`${cap(motionSummary(m))}. It comes with “${owner?.name ?? 'the cabinet'}”: ${how}.`)), ...clearLines(doc, m, fix), playRow(m));
    }
    const k = (name: string) => `motion:${m.id}:${name}`;
    const set = (patch: Record<string, unknown>, key?: string) => editOps([{ op: 'update', id: m.id, patch }], key && k(key));
    const params = (patch: Record<string, unknown>, key?: string) => set({ params: patch }, key);
    const rows: HTMLElement[] = [
      row('Kind', selectField(k('type'), [['hinge', 'Hinged (swings)'], ['slide', 'Sliding']], m.type, (v) => set({ type: v, params: v === 'hinge' ? { side: 'left' } : {} }))),
    ];
    if (m.type === 'hinge') {
      const p = m.params as { side: Side; toward?: Side; angle: number };
      const across = HINGE_SIDES.filter(([s]) => SIDES[s].axis !== SIDES[p.side].axis);
      rows.push(
        row(
          'Hinges on',
          selectField(k('side'), HINGE_SIDES, p.side, (v) => params({ side: v, ...(p.toward && SIDES[p.toward].axis === SIDES[v as Side].axis && { toward: null }) })),
        ),
        row('Swings out', selectField(k('toward'), across, towardOf(p), (v) => params({ toward: v }))),
        row('Opens to', angleField(p.angle, (d) => d > 0 && d <= 180 && params({ angle: d }, 'angle'), k('angle'), 'How far it opens')),
      );
    } else {
      const p = m.params as unknown as SlideParams;
      let auto = '';
      try {
        auto = fmt(slideDistance({ ...p, distance: undefined }, motionBasis(doc, m)));
      } catch {
        // doesn't build: plain "auto"
      }
      const distance = lengthField(p.distance ?? null, (u) => u > 0 && params({ distance: u }, 'distance'), k('distance'), auto ? `auto · ${auto}` : 'auto');
      distance.title = `How far it slides. Leave it empty to go 90% of its depth. ${LENGTH_HINT}`;
      distance.addEventListener('change', () => distance.value.trim() === '' && p.distance !== undefined && params({ distance: null }));
      rows.push(row('Moves', selectField(k('toward'), SLIDE_WAYS, p.toward, (v) => params({ toward: v }))), row('Distance', distance));
    }
    const secs = el('input', { type: 'number', min: 0.1, max: 10, step: 0.1, value: String(m.params.seconds ?? ''), 'data-key': k('seconds'), style: 'width:72px', title: 'Seconds to open all the way' });
    secs.addEventListener('input', () => {
      const n = Number(secs.value);
      if (secs.value.trim() !== '' && n >= 0.1 && n <= 10) params({ seconds: n }, 'seconds');
    });
    rows.push(row('Time (s)', secs));
    const remove = el('button', { class: 'btn ghost icon sm', title: 'Remove this animation' }, icon('trash'));
    remove.addEventListener('click', () => editOps([{ op: 'delete', id: m.id }]));
    const fix = m.type === 'hinge' ? 'Try the other hinge side, a filler, or opening it less.' : 'Try a shorter distance, or move what’s in the way.';
    return foldable('Animation', ...rides, ...rows, ...clearLines(doc, m, fix), playRow(m, remove));
  }

  function animationSection(doc: Doc, targets: readonly Target[], whole: Assembly | null): HTMLElement | null {
    // A whole cabinet: its doors and drawers come with their own (O opens them).
    if (whole?.generator) return null;
    const nodes = animationNodes(doc, targets, whole);
    if (!nodes?.length) return null;
    const found = [...new Set(nodes.map((id) => motionOf(doc, id)))];
    if (found.length > 1) return foldable('Animation', el('div', { class: 'info' }, 'These open separately: pick one to change how it opens (O opens them all).'));
    return found[0] ? motionControls(doc, found[0], nodes) : addAnimation(doc, nodes);
  }

  // ── One whole part ────────────────────────────────────────────────────────
  function partSections(doc: Doc, part: Part, actions: Action[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    const owner = generatedOwner(doc, part.id);
    const linked = [...new Set([...variablesOf(doc, part.id), ...(owner ? variablesOf(doc, owner.id) : [])])];
    const unlink = actions.find((a) => a.id === 'unlink');
    const info: HTMLElement[] = [];
    if (linked.length) {
      const names = linked.map((v) => v.name).join(', ');
      const btn = unlink && el('button', { class: 'btn sm', title: 'Keep the current sizes and stop following the variables' }, 'Unlink');
      btn?.addEventListener('click', () => editOps(unlink!.run({})));
      info.push(el('div', { class: 'info' }, `Follows ${names} — change ${linked.length === 1 ? 'it' : 'them'} under Variables.`, ...(btn ? [btn] : [])));
    }
    const materials = Object.values(doc.materials).map((m): [string, string] => [m.id, m.name]);
    out.push(
      section(
        'Part',
        ...info,
        row('Material', selectField(`mat:${part.id}`, materials, part.material ?? '', (v) => editOps([{ op: 'update', id: part.id, patch: { material: v } }]))),
        row('Grain', selectField(`grain:${part.id}`, GRAINS, part.grain, (v) => editOps([{ op: 'update', id: part.id, patch: { grain: v } }]))),
        ...placement(part.id, part.transform.position, part.transform.rotation, false),
      ),
    );

    const lines = partMachining(doc, part, fmt);
    if (lines.length) {
      out.push(
        section(
          'Machining',
          ...lines.map((l) => {
            const text = el('span', { class: 'len' }, ...shop(cap(l.text)));
            if (!l.features.length) return el('div', { class: 'mach joint', title: 'Cut by a joint: it follows the parts it joins' }, text);
            const x = el('button', { class: 'btn ghost icon sm', title: l.features.length === 1 ? 'Remove it' : `Remove all ${l.features.length}` }, icon('trash'));
            x.addEventListener('click', () => editOps(l.features.map((f): Op => ({ op: 'removeFeature', part: part.id, feature: f }))));
            return el('div', { class: 'mach' }, text, x);
          }),
          ...(lines.some((l) => !l.features.length) ? [el('div', { class: 'mach-note' }, 'Dimmed cuts come from joints and follow the parts they join.')] : []),
        ),
      );
    }
    return out;
  }

  // ── One block ─────────────────────────────────────────────────────────────
  function blockSections(part: Part): HTMLElement[] {
    const what = el('input', { type: 'text', class: 'what', value: part.name, placeholder: 'e.g. sink base, two false fronts', 'data-key': `name:${part.id}`, 'aria-label': 'What is it?' });
    what.addEventListener('input', () => editOps([{ op: 'update', id: part.id, patch: { name: what.value } }], `name:${part.id}`));
    const size = blockSize(part);
    return [
      section('What is it?', what, el('div', { class: 'foot' }, 'The AI builds it from this and any notes on it — or point at it and talk (M).')),
      section(
        'Block',
        ...SIZES.map(([label, param], k) =>
          row(
            label,
            lengthField(size[k]!, (u) => u > 0 && editOps([{ op: 'update', id: part.id, patch: { shape: { params: { [param]: u } } } }], `size:${part.id}:${k}`), `size:${part.id}:${k}`),
          ),
        ),
        ...placement(part.id, part.transform.position, part.transform.rotation, true),
        el('div', { class: 'foot' }, 'Drag a face in the view to push or pull it; the arrow on top points to its front.'),
      ),
      splitSection(part),
    ];
  }

  function splitSection(part: Part): HTMLElement {
    const tools = o.blockTools;
    const buttons: HTMLElement[] = [];
    if (tools) {
      const split = el('button', { class: 'btn', title: 'Click where to cut, as many times as you like (S)' }, 'Split…');
      split.addEventListener('click', () => tools.split());
      const dup = el('button', { class: 'btn', title: 'A copy flush to its right; repeat for a row (Ctrl+D)' }, 'Duplicate');
      dup.addEventListener('click', () => tools.duplicate());
      buttons.push(el('div', { class: 'act' }, split, dup));
    }
    const n = el('input', { type: 'number', min: 2, max: 24, value: '2', 'data-key': `splitN:${part.id}`, style: 'width:56px', 'aria-label': 'Pieces' });
    const axis = selectField(`splitAxis:${part.id}`, [['0', 'across its width'], ['1', 'across its height'], ['2', 'across its depth']], '0', () => {});
    const even = el('button', { class: 'btn' }, 'Split');
    even.addEventListener('click', () => {
      const count = Number(n.value);
      if (!Number.isInteger(count) || count < 2) return toast('Split into 2 or more pieces.', true);
      if (editOps(splitEvenOps(store.doc, part.id, Number(axis.value) as 0 | 1 | 2, count))) toast(`Split into ${count}.`);
    });
    return section('Split and copy', ...buttons, el('div', { class: 'act' }, el('label', {}, 'Pieces', n), el('label', {}, 'Direction', axis), even));
  }

  // ── Handle sizes ──────────────────────────────────────────────────────────
  function driveRow(doc: Doc, t: Target, drive: Drive): HTMLElement {
    const key = `${targetKey(t)}:${drive.path}`;
    const input = lengthField(
      drive.value,
      (u) => {
        const hd = handleDrives(store.doc, t);
        const d = hd?.drives.find((x) => x.path === drive.path && JSON.stringify(x.owner) === JSON.stringify(drive.owner));
        if (hd && d) editOps(setDriveOps(store.doc, hd, d, u), key);
      },
      key,
    );
    const label = drive.owner.kind === 'generator' ? `${doc.assemblies[drive.owner.asm]?.name ?? 'Cabinet'} ${drive.label}` : cap(drive.label);
    return el('div', { class: 'frow drive' }, el('span', { class: 'lbl' }, label), input);
  }

  function sizeSection(doc: Doc, t: Target): HTMLElement | null {
    const hd = handleDrives(doc, t);
    if (hd?.drives.length) {
      return section('Size', ...(hd.constraint ? [el('div', { class: 'info' }, 'Drag it in the view, or type a size.')] : []), ...hd.drives.map((d) => driveRow(doc, t, d)));
    }
    const cut = doc.parts[t.node]?.joinery?.find((c) => c.id === t.handle!.split(':')[0]);
    if (cut) {
      const owner = generatedOwner(doc, t.node);
      const how = doc.joints[cut.joint]?.role !== undefined && owner ? `${owner.name}’s joinery setting` : 'the joint';
      return el('div', { class: 'sec' }, el('div', { class: 'info' }, `Cut by a ${doc.joints[cut.joint]?.type ?? 'joint'} joint, so it follows the parts it joins. Change ${how} to change it.`));
    }
    return null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  /** Values typed into action fields, kept across re-renders until the selection changes. */
  const typed = new Map<string, string>();
  function actionRow(a: Action): HTMLElement {
    const inputs = a.fields.map((f) => {
      const key = `${a.id}:${f.key}`;
      const input = lengthField(f.value, null, `act:${key}`, f.placeholder ?? '');
      if (typed.has(key)) input.value = typed.get(key)!;
      input.addEventListener('input', () => typed.set(key, input.value));
      return [f, input] as const;
    });
    const go = el('button', { class: 'btn' }, el('span', { class: 'len' }, ...shop(a.label)));
    go.addEventListener('click', () => {
      const values: Record<string, number | null> = {};
      for (const [f, input] of inputs) {
        const u = input.value.trim() === '' ? null : parse(input.value);
        if (u === null && (!f.optional || input.value.trim() !== '')) return toast(`${f.label} must be a length like 1/2, 3 1/4 or 12mm.`, true);
        values[f.key] = u;
      }
      if (editOps(a.run(values))) toast(`${a.label}: done.`);
    });
    return el('div', { class: 'act' }, ...inputs.map(([f, input]) => el('label', {}, f.label, input)), go);
  }

  // ── Note ──────────────────────────────────────────────────────────────────
  const noteInput = el('textarea', { class: 'note-in', rows: 2, placeholder: 'Tell the AI what to change here — e.g. “this should overhang that by 1 1/2″”' });
  noteInput.dataset.key = 'note';
  const pinBtn = el('button', { class: 'btn' }, icon('pin'), 'Pin note');
  const addNote = () => {
    const text = noteInput.value.trim();
    if (!text) return noteInput.focus();
    if (!selection.targets.length) return toast('Select what the note is about first (Shift-click to pick several).', true);
    const targets = selection.targets.map((t) => structuredClone(t));
    if (dispatch([{ op: 'add', entity: { kind: 'annotation', note: text, targets } }])) {
      noteInput.value = '';
      const n = Object.values(store.doc.annotations).filter((a) => !a.resolved).length;
      toast(`Pinned note ${n}. It's on the AI's message box; Send when you're ready.`);
    }
  };
  pinBtn.addEventListener('click', addNote);
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addNote();
    }
  });
  const noteSection = section('Note for the AI', noteInput, el('div', { class: 'note-row' }, el('span', { class: 'hint' }, 'Enter pins it'), pinBtn));

  // ── Render ────────────────────────────────────────────────────────────────
  function content(doc: Doc): HTMLElement[] {
    const targets = selection.targets.filter((t) => doc.parts[t.node] || doc.assemblies[t.node]);
    if (!targets.length) return [el('div', { class: 'empty' }, 'Click a face, edge or corner in the view to select it. Double-click for the whole part, or pick one in the list above.')];
    const whole = wholeAssembly(doc, targets);
    const actions = actionsFor(doc, [...targets], fmt);
    const del = actions.find((a) => a.id === 'delete');
    const remove = whole ? [{ op: 'delete', id: whole.id } as Op] : del ? del.run({}) : null;
    const out = header(doc, targets, whole, remove, whole ? `Delete ${whole.name}` : (del?.label ?? 'Delete'));
    const t = targets[0]!;
    const part = doc.parts[t.node];
    const rest = actions.filter((a) => a.id !== 'delete' && a.id !== 'unlink');
    // The part's own settings first, then the cabinet it belongs to.
    if (targets.length === 1 && part && !t.handle) out.push(...(part.block ? blockSections(part) : partSections(doc, part, actions)));
    if (whole) out.push(section('Placement', ...placement(whole.id, whole.transform.position, whole.transform.rotation, true)));
    if (targets.length === 1 && t.handle) {
      const size = sizeSection(doc, t);
      if (size) out.push(size);
    }
    const cabinet = cabinetOf(doc, targets, whole);
    if (cabinet) out.push(cabinetSection(doc, cabinet));
    const animation = animationSection(doc, targets, whole);
    if (animation) out.push(animation);
    if (rest.length) out.push(section('Actions', ...rest.map(actionRow)));
    out.push(noteSection);
    return out;
  }

  function render() {
    // Keep the control being typed in (value, caret and focus) across re-renders.
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
    const key = focused?.dataset.key;
    const text = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
    const caret: [number | null, number | null] | null = text && text.type !== 'number' ? [text.selectionStart, text.selectionEnd] : null;
    const scroll = body.scrollTop;
    live = null;
    body.replaceChildren(...content(o.shown()));
    body.scrollTop = scroll;
    if (!key) return;
    const again = body.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!again) return;
    if (text && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) {
      again.value = text.value;
      again.classList.toggle('bad', text.classList.contains('bad'));
    }
    again.focus();
    if (caret && again instanceof HTMLInputElement && caret[0] !== null) again.setSelectionRange(caret[0], caret[1]);
  }

  // Hover changes on every mouse move over the model; only a new selection re-renders.
  let selSig = '';
  selection.subscribe(() => {
    const sig = JSON.stringify(selection.targets);
    if (sig === selSig) return;
    selSig = sig;
    typed.clear();
    render();
  });
  store.subscribe(() => render());
  units.subscribe(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    render();
  });
  render();

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.defaultPrevented || target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') {
      if (!selection.targets.length) return toast('Select what the note is about first.', true);
      noteInput.focus();
    } else if (k === 'escape') {
      if (!o.cancelDrag()) {
        selection.set([]);
        o.onClear();
      }
    } else if (k === 'delete' || k === 'backspace') {
      const doc = store.doc;
      const targets = [...selection.targets];
      const whole = wholeAssembly(doc, targets);
      const a = whole ? null : actionsFor(doc, targets).find((x) => x.id === 'delete' || x.id === 'remove-feature');
      const ops = whole ? [{ op: 'delete', id: whole.id } as Op] : a?.run({});
      if (!ops) return targets.some((t) => t.handle) ? toast('Double-click a part to select all of it, then Delete.') : undefined;
      if (editOps(ops)) selection.set([]);
    } else return;
    e.preventDefault();
  });

  return {
    focusNote: () => noteInput.focus(),
  };
}
