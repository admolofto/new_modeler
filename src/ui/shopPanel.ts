import { cutList, cutListCsv, DEFAULT_SHEET, nominalThickness, quarters, type CutList, type CutRow, type MaterialCuts } from '../model/cutlist';
import { MATERIAL_LIBRARY } from '../model/materialLibrary';
import type { Op } from '../model/ops';
import type { Doc, Material } from '../model/schema';
import type { Store } from '../model/store';
import { generators } from '../plugins';
import { el } from './dom';
import { icon } from './icons';
import type { Selection } from './selection';
import { toast } from './toast';
import { fmt, LENGTH_HINT, parse, shop, units } from './units';

/**
 * The shop sheet (L), over the 3D view: the joinery-aware cut list, grouped by material, with
 * sheet / board-foot estimates, CSV export and a print view; and the materials editor (thickness,
 * sheet size, price, add from the library). Material edits are ops through the store like every
 * other edit.
 */

const STYLE = `
.shop { position: absolute; inset: 12px; z-index: 20; display: flex; flex-direction: column; background: var(--raised); border: 1px solid var(--line-2);
  border-radius: 12px; box-shadow: 0 16px 48px #000b; overflow: hidden; }
.shop header { display: flex; align-items: center; gap: 4px; padding: 0 8px 0 0; border-bottom: 1px solid var(--line); }
.shop header .tabs { flex: 1; border-bottom: 0; padding-left: 16px; }
.shop .body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 20px; }
.shop .summary { font-size: var(--fs); }
.shop .problems { margin: 10px 0 4px; padding: 8px 12px; border: 1px solid #e5c07b4d; border-radius: 8px; background: #e5c07b12; color: var(--warn); font-size: var(--fs-sm); }
.shop .problems div::before { content: '⚠ '; }
.shop h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 22px 0 6px; font-size: var(--fs); font-weight: 600; }
.shop h3 span { color: var(--fg-2); font-size: var(--fs-sm); font-weight: 400; }
.shop table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.shop table.cuts { table-layout: fixed; }
.shop table.cuts th:nth-child(1) { width: 44px; }
.shop table.cuts th:nth-child(3), .shop table.cuts th:nth-child(4) { width: 92px; }
.shop table.cuts th:nth-child(5) { width: 68px; }
.shop table.cuts th:nth-child(6) { width: 108px; }
.shop th { padding: 6px 8px; border-bottom: 1px solid var(--line-2); color: var(--fg-3); font-size: var(--fs-xs); font-weight: 500; text-align: left; white-space: nowrap; }
.shop th.num { text-align: right; }
.shop td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.shop td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.shop td.qty { color: var(--fg-2); text-align: center; font-variant-numeric: tabular-nums; }
.shop tr.part { cursor: pointer; }
.shop tr.part:hover td { background: var(--hover); }
.shop .nm { font-weight: 500; }
.shop .ops { margin-top: 3px; color: var(--fg-2); font-size: var(--fs-xs); }
.shop .ops div::before { content: '· '; color: var(--fg-3); }
.shop .allow { margin-top: 3px; color: #b7c2ff; font-size: var(--fs-xs); }
.shop .warn { margin-top: 3px; color: var(--warn); font-size: var(--fs-xs); }
.shop .dim { color: var(--fg-3); }
.shop details { margin-top: 22px; }
.shop summary { color: var(--fg-2); cursor: pointer; }
.shop .fine { margin-top: 18px; color: var(--fg-3); font-size: var(--fs-sm); }
.shop .mats td { padding: 5px 4px; vertical-align: middle; }
.shop .mats th { padding: 6px 4px; }
.shop .mats .row { display: flex; align-items: center; gap: 4px; }
.shop .mats input[type=text] { width: 68px; }
.shop .mats input.name { width: 100%; min-width: 120px; }
.shop .mats input[type=number] { width: 72px; }
.shop .add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; }
.shop .add select { max-width: 320px; }
.shop-print { display: none; }
@media print {
  html, body { overflow: visible !important; height: auto !important; background: #fff !important; }
  body.printing > *:not(.shop-print) { display: none !important; }
  body.printing .shop-print { display: block; color: #000; font: 10pt/1.35 system-ui, sans-serif; }
  .shop-print h1 { font-size: 15pt; margin: 0 0 2pt; }
  .shop-print h2 { font-size: 12pt; margin: 12pt 0 3pt; }
  .shop-print h2 span { font-weight: 400; font-size: 9.5pt; color: #444; }
  .shop-print table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  .shop-print tr { page-break-inside: avoid; }
  .shop-print th, .shop-print td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  .shop-print td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .shop-print .ops { font-size: 8.5pt; color: #333; }
  .shop-print .warn { border: 1px solid #c60; padding: 4pt 6pt; margin: 6pt 0; }
}
`;

export interface ShopOptions {
  store: Store;
  selection: Selection;
  /** The doc on screen (an AI proposal while one is pending). */
  shown(): Doc;
  toolbar: HTMLElement;
}

export interface ShopPanel {
  toggle(tab?: 'cuts' | 'materials'): void;
  /** Re-renders (the doc on screen changed without a store change, e.g. an AI preview). */
  refresh(): void;
}

const money = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;

function materialSummary(m: MaterialCuts): string {
  const bits = [`${fmt(m.material.thickness)}`, `${m.parts} part${m.parts === 1 ? '' : 's'}`];
  if (m.sheets) {
    const [w, l] = m.sheets.size;
    bits.push(`≈ ${m.sheets.count} sheet${m.sheets.count === 1 ? '' : 's'} ${fmt(w)} × ${fmt(l)}${m.sheets.count ? ` (${Math.round(m.sheets.utilization * 100)}% used)` : ''}`);
  }
  if (m.boardFeet) {
    bits.push(`${m.boardFeet.net.toFixed(1)} bd ft at ${quarters(m.boardFeet.nominal)} — buy ≈ ${m.boardFeet.withWaste.toFixed(1)} with 20% waste`);
  }
  if (m.cost !== undefined) bits.push(money(m.cost));
  return bits.join(' · ');
}

const allowanceText = (r: CutRow) => r.allowances.map((a) => `+${fmt(a.depth)} ${a.along} into ${a.mate}`).join(', ');
const len = (u: number) => shop(fmt(u));
const lenCell = (u: number) => el('td', { class: 'num' }, ...len(u));
const grainText = (r: CutRow) => (r.grain ? 'along length' : r.shaped ? 'shaped' : 'any');

function printView(list: CutList): HTMLElement {
  const parts = list.materials.reduce((s, m) => s + m.parts, 0);
  const out = el(
    'div',
    {},
    el('h1', {}, 'Cut list'),
    el('div', {}, `${new Date().toLocaleDateString()} · ${parts} parts · ${units.system === 'mm' ? 'millimetres' : 'inches'} · sizes include joinery allowances${list.cost !== undefined ? ` · est. ${money(list.cost)}` : ''}`),
  );
  if (list.problems.length) out.append(el('div', { class: 'warn' }, ...list.problems.map((p) => el('div', {}, `⚠ ${p}`))));
  for (const m of list.materials) {
    out.append(el('h2', {}, m.material.name, el('span', {}, ` — ${materialSummary(m)}`)));
    const table = el('table', {}, el('tr', {}, ...['Qty', 'Part', 'Length', 'Width', 'Thick', 'Grain', 'Joinery / machining'].map((h) => el('th', {}, h))));
    for (const r of m.rows) {
      const ops = [allowanceText(r), ...r.ops, ...r.notes.map((n) => `⚠ ${n}`)].filter(Boolean);
      table.append(
        el(
          'tr',
          {},
          el('td', { class: 'num' }, String(r.qty)),
          el('td', {}, r.names.join(' / ')),
          lenCell(r.length),
          lenCell(r.width),
          lenCell(r.thickness),
          el('td', {}, grainText(r)),
          el('td', { class: 'ops' }, ...ops.map((t) => el('div', {}, ...shop(t)))),
        ),
      );
    }
    out.append(table);
  }
  return out;
}

export function mountShopPanel(parent: HTMLElement, o: ShopOptions): ShopPanel {
  parent.append(el('style', {}, STYLE));
  let tab: 'cuts' | 'materials' = 'cuts';
  let open = false;

  const cutsTab = el('button', { role: 'tab' }, 'Cut list');
  const matsTab = el('button', { role: 'tab' }, 'Materials');
  const csvBtn = el('button', { class: 'btn ghost', title: 'Download the cut list as CSV (opens in any spreadsheet)' }, 'CSV');
  const printBtn = el('button', { class: 'btn ghost', title: 'Print the cut list' }, 'Print');
  const close = el('button', { class: 'btn ghost icon', title: 'Close (L)' }, icon('x'));
  const body = el('div', { class: 'body' });
  const panel = el('div', { class: 'shop', role: 'dialog', 'aria-label': 'Cut list and materials' }, el('header', {}, el('div', { class: 'tabs', role: 'tablist' }, cutsTab, matsTab), csvBtn, printBtn, close), body);
  panel.hidden = true;
  const printBox = el('div', { class: 'shop-print' });
  parent.append(panel);
  document.body.append(printBox);

  const toolbarBtn = el('button', { class: 'btn ghost', title: 'Cut list and materials (L)', 'aria-pressed': 'false' }, icon('list'), el('span', { class: 't' }, 'Cut list'));
  o.toolbar.append(toolbarBtn);

  cutsTab.addEventListener('click', () => ((tab = 'cuts'), render()));
  matsTab.addEventListener('click', () => ((tab = 'materials'), render()));
  close.addEventListener('click', () => toggle());
  toolbarBtn.addEventListener('click', () => toggle());

  const list = () => cutList(o.shown(), { fmt });

  csvBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([cutListCsv(list(), units.system)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'cut-list.csv' });
    a.click();
    URL.revokeObjectURL(url);
  });
  printBtn.addEventListener('click', () => {
    printBox.replaceChildren(printView(list()));
    document.body.classList.add('printing');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

  // ── Cut list ──────────────────────────────────────────────────────────────
  function cutsBody(doc: Doc): HTMLElement[] {
    const cl = cutList(doc, { fmt });
    const parts = cl.materials.reduce((s, m) => s + m.parts, 0);
    const out: HTMLElement[] = [];
    const preview = doc !== o.store.doc ? ' · includes the AI’s proposed change' : '';
    out.push(
      el(
        'div',
        { class: 'summary' },
        `${parts} part${parts === 1 ? '' : 's'} in ${cl.materials.length} material${cl.materials.length === 1 ? '' : 's'}${cl.cost !== undefined ? ` · est. ${money(cl.cost)}` : ''}${preview}`,
      ),
      el('div', { class: 'hint' }, 'Sizes to cut, joinery included. Click a row to select those parts.'),
    );
    if (cl.problems.length) out.push(el('div', { class: 'problems' }, ...cl.problems.map((p) => el('div', {}, p))));
    const heads = ['Qty', 'Part', 'Length', 'Width', 'Thick', 'Grain'];
    for (const m of cl.materials) {
      out.push(el('h3', {}, el('b', {}, ...shop(m.material.name)), el('span', { class: 'len' }, ...shop(materialSummary(m)))));
      const table = el('table', { class: 'cuts' }, el('tr', {}, ...heads.map((h, i) => el('th', { class: i >= 2 && i <= 4 ? 'num' : '' }, h))));
      for (const r of m.rows) {
        const detail = el('div', { class: 'len' });
        if (r.allowances.length) detail.append(el('div', { class: 'allow' }, ...shop(allowanceText(r))));
        if (r.ops.length) detail.append(el('div', { class: 'ops' }, ...r.ops.map((t) => el('div', {}, ...shop(t)))));
        for (const n of r.notes) detail.append(el('div', { class: 'warn' }, '⚠ ', ...shop(n)));
        const tr = el(
          'tr',
          { class: 'part', title: 'Select in the view' },
          el('td', { class: 'qty' }, String(r.qty)),
          el('td', {}, el('div', { class: 'nm' }, r.names.join(' / ')), detail),
          lenCell(r.length),
          lenCell(r.width),
          lenCell(r.thickness),
          el('td', { class: 'dim' }, grainText(r)),
        );
        tr.addEventListener('click', () => {
          o.selection.setMode('part');
          o.selection.set(r.ids.filter((id) => o.shown().parts[id]).map((node) => ({ node })));
        });
        table.append(tr);
      }
      out.push(table);
    }
    if (cl.joints.length) {
      const rows = cl.joints.map((j) =>
        el(
          'tr',
          {},
          el('td', {}, j.type.charAt(0).toUpperCase() + j.type.slice(1)),
          el('td', {}, `${j.inserted} → ${j.housing}`),
          j.depth === undefined ? el('td', {}) : lenCell(j.depth),
          el('td', { class: j.problem ? 'warn' : 'dim' }, j.problem ?? (j.depth === undefined ? 'no cut' : 'cut in the model')),
        ),
      );
      out.push(
        el(
          'details',
          {},
          el('summary', {}, `Joinery (${cl.joints.length} joint${cl.joints.length === 1 ? '' : 's'})`),
          el('table', {}, el('tr', {}, ...['Type', 'Part → into', 'Depth', ''].map((h, i) => el('th', { class: i === 2 ? 'num' : '' }, h))), ...rows),
        ),
      );
    }
    out.push(el('div', { class: 'fine' }, ...shop('Sheet counts are a quick shelf-packing estimate (1/8" kerf, grain along the sheet) — nest before you buy.')));
    return out;
  }

  // ── Materials ─────────────────────────────────────────────────────────────
  const dispatch = (ops: Op[], coalesce?: string) => {
    const r = o.store.dispatch(ops, coalesce ? { coalesce } : undefined);
    toast(r.ok ? '' : r.error, !r.ok);
    return r.ok;
  };
  const patch = (m: Material, p: Record<string, unknown>, key?: string) => dispatch([{ op: 'update', id: m.id, patch: p }], key && `mat.${m.id}.${key}`);

  function lengthIn(value: number, commit: (u: number) => boolean): HTMLInputElement {
    const input = el('input', { type: 'text', value: fmt(value), title: LENGTH_HINT });
    input.addEventListener('input', () => {
      const u = parse(input.value);
      input.classList.toggle('bad', u === null || u <= 0 || !commit(u));
    });
    return input;
  }

  function usage(doc: Doc, id: string): number {
    const parts = Object.values(doc.parts).filter((p) => p.material === id).length;
    const gens = Object.values(doc.assemblies).filter((a) => a.generator && generators.get(a.generator.type).materialRefs(a.generator.params).includes(id)).length;
    return parts + gens;
  }

  function materialRow(doc: Doc, m: Material): HTMLElement {
    const color = el('input', { type: 'color', value: m.color, title: 'Color in the viewport' });
    color.addEventListener('input', () => patch(m, { color: color.value }, 'color'));
    const name = el('input', { type: 'text', class: 'name', value: m.name });
    name.addEventListener('change', () => name.value.trim() && patch(m, { name: name.value.trim() }));
    const stock = el('select', {}, el('option', { value: 'sheet' }, 'Sheet'), el('option', { value: 'solid' }, 'Solid'));
    stock.value = m.stock;
    stock.addEventListener('change', () => patch(m, { stock: stock.value }));
    const thick = lengthIn(m.thickness, (u) => patch(m, { thickness: u }, 'thickness'));
    thick.title = `Actual thickness (parts and generators size from it). ${LENGTH_HINT}`;
    const size = el('div', { class: 'row' });
    if (m.stock === 'sheet') {
      const [w, l] = m.sheet ?? DEFAULT_SHEET;
      size.append(
        lengthIn(w, (u) => patch(m, { sheet: [u, (o.store.doc.materials[m.id]?.sheet ?? DEFAULT_SHEET)[1]] }, 'sheetW')),
        el('span', { class: 'dim' }, '×'),
        lengthIn(l, (u) => patch(m, { sheet: [(o.store.doc.materials[m.id]?.sheet ?? DEFAULT_SHEET)[0], u] }, 'sheetL')),
      );
    } else {
      const nominal = el('select', { title: 'Nominal (rough) thickness board feet are counted at' });
      const auto = nominalThickness({ ...m, nominal: undefined });
      nominal.append(el('option', { value: '' }, `auto (${quarters(auto)})`), ...[4, 5, 6, 8, 10, 12, 16].map((q) => el('option', { value: String(q * 16) }, `${q}/4`)));
      nominal.value = m.nominal === undefined ? '' : String(m.nominal);
      nominal.addEventListener('change', () => patch(m, { nominal: nominal.value ? Number(nominal.value) : undefined }));
      size.append(nominal);
    }
    const price = el('input', { type: 'number', min: 0, step: 'any', value: m.price === undefined ? '' : String(m.price), placeholder: '—' });
    price.title = m.stock === 'sheet' ? 'Price per sheet' : 'Price per board foot';
    price.addEventListener('input', () => {
      const v = price.value.trim();
      const n = Number(v);
      price.classList.toggle('bad', v !== '' && !(n >= 0));
      if (v === '' || n >= 0) patch(m, { price: v === '' ? undefined : n }, 'price');
    });
    const used = usage(doc, m.id);
    const del = el('button', { class: 'btn ghost icon sm', disabled: used > 0, title: used ? `In use by ${used} part${used === 1 ? '' : 's'} or cabinet${used === 1 ? '' : 's'}` : 'Delete material' }, icon('trash'));
    del.addEventListener('click', () => dispatch([{ op: 'delete', id: m.id }]));
    return el(
      'tr',
      {},
      el('td', {}, color),
      el('td', {}, name),
      el('td', {}, stock),
      el('td', {}, thick),
      el('td', {}, size),
      el('td', {}, price),
      el('td', { class: 'num dim' }, String(used)),
      el('td', {}, del),
    );
  }

  function materialsBody(doc: Doc): HTMLElement[] {
    const table = el(
      'table',
      { class: 'mats' },
      el('tr', {}, ...['', 'Name', 'Stock', 'Thickness', 'Sheet W × L / nominal', 'Price', 'Used by', ''].map((h, i) => el('th', { class: i === 6 ? 'num' : '' }, h))),
      ...Object.values(doc.materials).map((m) => materialRow(doc, m)),
    );
    const lib = el('select');
    const missing = MATERIAL_LIBRARY.filter((m) => !doc.materials[m.id]);
    lib.append(...missing.map((m) => el('option', { value: m.id }, `${m.name} — ${fmt(m.thickness)}`)));
    const addLib = el('button', { class: 'btn', disabled: !missing.length }, 'Add from library');
    addLib.addEventListener('click', () => {
      const m = MATERIAL_LIBRARY.find((x) => x.id === lib.value);
      if (m) dispatch([{ op: 'add', entity: { kind: 'material', ...structuredClone(m) } }]);
    });
    const addNew = el('button', { class: 'btn ghost' }, icon('plus'), 'New material');
    addNew.addEventListener('click', () => dispatch([{ op: 'add', entity: { kind: 'material', name: 'New material', thickness: 48, color: '#c8b089', stock: 'sheet' } }]));
    return [
      el('div', { class: 'hint', style: 'margin-bottom:10px' }, ...shop('Thickness is the actual thickness (3/4" plywood is 23/32"); changing it resizes cabinets made from it. Prices feed the cost estimate.')),
      table,
      el('div', { class: 'add' }, lib, addLib, addNew),
    ];
  }

  function render() {
    if (!open) return;
    cutsTab.setAttribute('aria-selected', String(tab === 'cuts'));
    matsTab.setAttribute('aria-selected', String(tab === 'materials'));
    csvBtn.hidden = printBtn.hidden = tab !== 'cuts';
    // Keep the field being typed in across re-renders (materials edits re-render on every keystroke).
    const active = document.activeElement;
    const focusIndex = active instanceof HTMLInputElement && body.contains(active) ? [...body.querySelectorAll('input')].indexOf(active) : -1;
    const typed = focusIndex >= 0 ? (active as HTMLInputElement).value : null;
    const scroll = body.scrollTop;
    const doc = tab === 'cuts' ? o.shown() : o.store.doc;
    body.replaceChildren(...(tab === 'cuts' ? cutsBody(doc) : materialsBody(doc)));
    body.scrollTop = scroll;
    if (focusIndex >= 0) {
      const again = body.querySelectorAll('input')[focusIndex];
      if (again && typed !== null) {
        if (again.type !== 'color') again.value = typed;
        again.focus();
      }
    }
  }

  function toggle(next?: 'cuts' | 'materials') {
    open = next ? !(open && tab === next) : !open;
    if (next) tab = next;
    panel.hidden = !open;
    toolbarBtn.setAttribute('aria-pressed', String(open));
    render();
  }

  o.store.subscribe(render);
  units.subscribe(render);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === 'l') {
      toggle();
      e.preventDefault();
    }
  });
  return { toggle, refresh: render };
}
