import { DEFAULT_CARCASS, demoDoc } from '../model/defaults';
import { descendants, parentIndex } from '../model/doc';
import type { Doc, Variable } from '../model/schema';
import type { Store } from '../model/store';
import { dependents, fieldLabel } from '../model/variables';
import { el } from './dom';
import { icon } from './icons';
import type { Selection } from './selection';
import { toast } from './toast';
import { fmt, LENGTH_HINT, parse, units } from './units';

/**
 * Left panel, top: the model's parts grouped by assembly — hover a row to find the part in the
 * view, click to select it (Shift adds; an assembly row selects all its parts) — and the variables
 * the AI made for what it built, one section per group. An empty model gets a start screen in the
 * 3D view instead.
 */

const STYLE = `
.outline { flex: 0 1 auto; max-height: 48%; overflow-y: auto; }
.outline .sec { padding: 8px 8px 10px; }
.outline .sec-h { padding: 0 6px; }
.outline .sec-h .ct { color: var(--fg-3); font-weight: 400; }
.tree .row { position: relative; display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 6px 0 calc(8px + var(--d, 0) * 16px);
  border-radius: 5px; cursor: pointer; user-select: none; }
.tree .row:hover { background: var(--hover); }
.tree .row.on { background: var(--sel-soft); }
.tree .row.on::before { content: ''; position: absolute; left: 0; top: 5px; bottom: 5px; width: 2px; border-radius: 1px; background: var(--sel); }
.tree .sw { flex: none; width: 10px; height: 10px; border-radius: 3px; box-shadow: inset 0 0 0 1px #0000004d; }
.tree .sw.block { background: none; box-shadow: none; border: 1.5px dashed var(--fg-3); }
.tree .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree .ct { color: var(--fg-3); font-size: var(--fs-xs); }
.tree .chev { display: grid; place-items: center; width: 16px; height: 16px; margin: 0 -2px 0 -4px; padding: 0; border: 0; border-radius: 4px;
  background: none; color: var(--fg-3); cursor: pointer; }
.tree .chev:hover { color: var(--fg); background: var(--hover); }
.tree .chev svg { width: 14px; height: 14px; transition: transform .12s; }
.tree .row.open .chev svg { transform: rotate(90deg); }
.tree .none { padding: 2px 8px; color: var(--fg-3); font-size: var(--fs-sm); }
.vars details.grp > summary { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 6px 0 4px; list-style: none; cursor: pointer;
  color: var(--fg-2); font-size: var(--fs-sm); border-radius: 5px; user-select: none; }
.vars details.grp > summary::-webkit-details-marker { display: none; }
.vars details.grp > summary:hover { background: var(--hover); color: var(--fg); }
.vars details.grp > summary svg { width: 14px; height: 14px; color: var(--fg-3); transition: transform .12s; }
.vars details.grp[open] > summary svg { transform: rotate(90deg); }
.vars .var { display: grid; grid-template-columns: minmax(0, 1fr) 84px 24px; align-items: center; gap: 6px; min-height: 30px; padding-left: 24px; }
.vars .var > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vars .var input { width: 100%; }
.vars .var .btn { opacity: 0; }
.vars .var:hover .btn, .vars .var .btn:focus-visible { opacity: 1; }
.start { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; pointer-events: none; }
.start > div { position: relative; display: grid; justify-items: center; gap: 8px; max-width: 420px; padding: 22px 26px; border-radius: 14px; background: #1d1f23e0;
  text-align: center; pointer-events: auto; }
.start .close { position: absolute; top: 8px; right: 8px; }
.start h2 { margin: 0; font-size: 17px; font-weight: 600; }
.start p { margin: 0; max-width: 340px; color: var(--fg-2); }
.start .acts { display: flex; gap: 8px; margin-top: 6px; }
`;

export interface OutlineOptions {
  /** The left panel. */
  parent: HTMLElement;
  /** The 3D view's container (the start screen goes there). */
  stage: HTMLElement;
  /** Starts the block tool (the start screen's "Block it out"). */
  startBlocks(): void;
  store: Store;
  selection: Selection;
  /** The doc on screen (an AI proposal while one is pending). */
  shown(): Doc;
}

export interface Outline {
  /** Re-renders (the doc on screen changed, e.g. an AI preview). */
  refresh(): void;
}

export function mountOutline(o: OutlineOptions): Outline {
  const { store, selection } = o;
  o.parent.append(el('style', {}, STYLE));
  const root = el('div', { class: 'outline' });
  o.parent.append(root);

  // ── Parts ─────────────────────────────────────────────────────────────────
  const count = el('span', { class: 'ct' });
  const tree = el('div', { class: 'tree', role: 'tree', 'aria-label': 'Parts' });
  root.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, 'Model', el('span', { class: 'sp' }), count), tree));

  const expanded = new Set<string>();
  const partsOf = (doc: Doc, asmId: string) => descendants(doc, asmId).filter((id) => doc.parts[id]);

  const select = (ids: string[], additive: boolean) => {
    selection.setMode('part');
    if (!additive) return selection.set(ids.map((node) => ({ node })));
    const all = ids.every((id) => selection.has({ node: id }));
    const rest = selection.targets.filter((t) => t.handle || !ids.includes(t.node));
    selection.set(all ? rest : [...rest, ...ids.map((node) => ({ node }))]);
  };

  function partRow(doc: Doc, id: string, depth: number, on: boolean): HTMLElement {
    const part = doc.parts[id]!;
    const mat = part.material ? doc.materials[part.material] : undefined;
    const row = el(
      'div',
      { class: `row${on ? ' on' : ''}`, role: 'treeitem', tabindex: 0, style: `--d:${depth}`, 'data-id': id, 'aria-selected': String(on), title: part.block ? 'Block — a placeholder' : (mat?.name ?? '') },
      part.block ? el('span', { class: 'sw block' }) : el('span', { class: 'sw', style: `background:${mat?.color ?? '#888'}` }),
      el('span', { class: 'nm' }, part.name || 'Block'),
    );
    const pick = (e: MouseEvent | KeyboardEvent) => select([id], e.shiftKey || e.ctrlKey || e.metaKey);
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(e);
      }
    });
    row.addEventListener('pointerenter', () => selection.setHover({ node: id }));
    row.addEventListener('pointerleave', () => selection.setHover(null));
    return row;
  }

  function assemblyRows(doc: Doc, id: string, depth: number, selected: Set<string>, out: HTMLElement[]): void {
    const asm = doc.assemblies[id]!;
    const open = expanded.has(id);
    const parts = partsOf(doc, id);
    const chev = el('button', { class: 'chev', tabindex: -1, title: open ? 'Collapse' : 'Expand', 'aria-label': open ? 'Collapse' : 'Expand' }, icon('chevron'));
    const on = parts.length > 0 && parts.every((p) => selected.has(p));
    const row = el(
      'div',
      { class: `row${open ? ' open' : ''}${on ? ' on' : ''}`, role: 'treeitem', tabindex: 0, style: `--d:${depth}`, 'aria-expanded': String(open), title: 'Select all its parts' },
      chev,
      el('span', { class: 'nm' }, asm.name),
      el('span', { class: 'ct' }, String(parts.length)),
    );
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) expanded.delete(id);
      else expanded.add(id);
      render();
    });
    row.addEventListener('click', (e) => select(parts, e.shiftKey || e.ctrlKey || e.metaKey));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(parts, e.shiftKey || e.ctrlKey || e.metaKey);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.key === 'ArrowRight') expanded.add(id);
        else expanded.delete(id);
        render();
      }
    });
    out.push(row);
    if (!open) return;
    for (const c of asm.children) {
      if (doc.parts[c]) out.push(partRow(doc, c, depth + 1, selected.has(c)));
      else if (doc.assemblies[c]) assemblyRows(doc, c, depth + 1, selected, out);
    }
  }

  // ── Variables ─────────────────────────────────────────────────────────────
  // One collapsible group each, in doc order. Rows rebuild only when the set of variables changes,
  // so a field keeps focus while it's typed in; values re-sync after every change.
  const varGroups = el('div');
  const vars = el('details', { class: 'sec vars', open: true }, el('summary', { class: 'sec-h' }, 'Variables', el('span', { class: 'sp' }), icon('chevron', 'chev')), varGroups);
  root.append(vars);
  const collapsed = new Set<string>();
  const varInputs = new Map<string, { input: HTMLInputElement; label: HTMLElement }>();
  const varText = (v: Variable) => (v.unit === 'length' ? fmt(v.value) : String(v.value));

  function setVariable(id: string, value: number, input: HTMLInputElement) {
    const r = store.dispatch([{ op: 'update', id, patch: { value } }], { coalesce: `var.${id}` });
    input.classList.toggle('bad', !r.ok);
    toast(r.ok ? '' : r.error, !r.ok);
  }

  function variableRow(v: Variable): HTMLElement {
    const input = el('input', { type: 'text', value: varText(v), title: v.unit === 'length' ? LENGTH_HINT : 'A number' });
    const read = () => {
      const unit = store.doc.variables[v.id]?.unit ?? v.unit;
      if (unit === 'length') return parse(input.value);
      const n = Number(input.value.trim());
      return input.value.trim() !== '' && Number.isFinite(n) ? n : null;
    };
    input.addEventListener('input', () => {
      const u = read();
      if (u === null) input.classList.add('bad');
      else setVariable(v.id, u, input);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const cur = store.doc.variables[v.id];
      if (!cur) return;
      const step = cur.unit === 'length' ? (e.shiftKey ? 64 : 4) : e.shiftKey ? 10 : 1;
      const next = (read() ?? cur.value) + (e.key === 'ArrowUp' ? step : -step);
      input.value = varText({ ...cur, value: next });
      setVariable(v.id, next, input);
    });
    input.addEventListener('blur', () => syncVariables(store.doc));
    const label = el('span', {}, v.name);
    const del = el('button', { class: 'btn ghost icon sm', title: `Delete "${v.name}" (what it drives keeps its current size)` }, icon('x'));
    del.addEventListener('click', () => {
      const r = store.dispatch([{ op: 'delete', id: v.id }]);
      toast(r.ok ? '' : r.error, !r.ok);
    });
    varInputs.set(v.id, { input, label });
    return el('div', { class: 'var' }, label, input, del);
  }

  function syncVariables(doc: Doc) {
    const list = Object.values(doc.variables);
    vars.hidden = !list.length;
    const sig = JSON.stringify(list.map((v) => [v.id, v.name, v.group]));
    if (varGroups.dataset.sig !== sig) {
      varGroups.dataset.sig = sig;
      varInputs.clear();
      const groups = new Map<string, Variable[]>();
      for (const v of list) groups.set(v.group, [...(groups.get(v.group) ?? []), v]);
      varGroups.replaceChildren(
        ...[...groups].map(([group, vs]) => {
          const box = el('details', { class: 'grp', open: !collapsed.has(group) }, el('summary', {}, icon('chevron'), group), ...vs.map(variableRow));
          box.addEventListener('toggle', () => (box.open ? collapsed.delete(group) : collapsed.add(group)));
          return box;
        }),
      );
    }
    for (const v of list) {
      const row = varInputs.get(v.id);
      if (!row) continue;
      const drives = dependents(doc, v.id).map((b) => fieldLabel(doc, b.node, b.path));
      row.label.title = `${v.name}\n${drives.length ? `Drives: ${drives.join(', ')}` : 'Not linked to anything yet'}`;
      if (document.activeElement !== row.input) {
        row.input.value = varText(v);
        row.input.classList.remove('bad');
      }
    }
  }

  // ── Start screen ──────────────────────────────────────────────────────────
  const addCabinet = el('button', { class: 'btn' }, 'Add a base cabinet');
  const blockOut = el('button', { class: 'btn' }, 'Block it out');
  blockOut.addEventListener('click', () => {
    startDismissed = true;
    start.hidden = true;
    o.startBlocks();
  });
  const loadExample = el('button', { class: 'btn ghost' }, 'Load the example');
  addCabinet.addEventListener('click', () => {
    const r = store.dispatch([{ op: 'add', entity: { kind: 'assembly', name: 'Base cabinet', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    toast(r.ok ? '' : r.error, !r.ok);
  });
  loadExample.addEventListener('click', () => store.replace(demoDoc()));
  // Once closed, stays closed for the session even if the doc empties again.
  let startDismissed = false;
  const closeStart = el('button', { class: 'btn ghost icon sm close', title: 'Close' }, icon('x'));
  closeStart.addEventListener('click', () => {
    startDismissed = true;
    start.hidden = true;
  });
  const start = el(
    'div',
    { class: 'start' },
    el(
      'div',
      {},
      closeStart,
      el('h2', {}, 'Start a piece'),
      el('p', {}, 'Describe what you want to build to the AI — for example “36″ base cabinet, two drawers, 3/4 ply” — or sketch rough blocks (B) and tell the AI what each one is.'),
      el('div', { class: 'acts' }, blockOut, addCabinet, loadExample),
    ),
  );
  o.stage.append(start);

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const doc = o.shown();
    const selected = new Set(selection.targets.map((t) => t.node));
    const all = Object.values(doc.parts);
    const blocks = all.filter((p) => p.block).length;
    const n = all.length - blocks;
    count.textContent = [n ? `${n} part${n === 1 ? '' : 's'}` : '', blocks ? `${blocks} block${blocks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const rows: HTMLElement[] = [];
    for (const id of doc.roots) {
      if (doc.parts[id]) rows.push(partRow(doc, id, 0, selected.has(id)));
      else if (doc.assemblies[id]) assemblyRows(doc, id, 0, selected, rows);
    }
    tree.replaceChildren(...(rows.length ? rows : [el('div', { class: 'none' }, 'No parts yet.')]));
    start.hidden = startDismissed || doc.roots.length > 0;
    syncVariables(store.doc);
  }

  // A new selection opens the assemblies it's in and scrolls its first row into view.
  let selSig = '';
  selection.subscribe(() => {
    const sig = JSON.stringify(selection.targets.map((t) => t.node));
    if (sig === selSig) return;
    selSig = sig;
    const doc = o.shown();
    const parents = parentIndex(doc);
    for (const t of selection.targets) for (let p = parents.get(t.node); p; p = parents.get(p)) expanded.add(p);
    render();
    const first = selection.targets[0];
    if (first) tree.querySelector<HTMLElement>(`[data-id="${CSS.escape(first.node)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  units.subscribe(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    syncVariables(store.doc);
  });
  render();
  return { refresh: render };
}
