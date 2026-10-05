import { captureRecipe, placeRecipe, recipeInputs, type Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { worldBoxes } from '../model/world';
import { el } from './dom';
import { icon } from './icons';
import { browserRecipeLibrary, RECIPE_LIBRARY_KEY } from './recipeStorage';
import type { Selection } from './selection';
import { toast } from './toast';
import { fmt, LENGTH_HINT, parse } from './units';

const CSS = `
.recipes-dialog { padding: 0; width: min(900px, calc(100vw - 24px)); max-width: none; height: min(760px, calc(100dvh - 32px)); max-height: none; color: var(--fg); background: var(--raised); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: 0 16px 48px #000b; }
.recipes-dialog::backdrop { background: #0008; }
.recipes-dialog[open] { display: flex; flex-direction: column; }
.recipes-dialog header { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
.recipes-dialog header h2 { margin: 0; flex: 1; font-size: 18px; }
.recipes-dialog .recipes-body { overflow: auto; min-height: 0; padding: 18px; }
.recipes-dialog .btn, .recipes-dialog input, .recipes-dialog select { min-height: 44px; }
.recipes-dialog .btn { white-space: normal; height: auto; }
.recipes-dialog label { display: grid; gap: 6px; margin-bottom: 14px; color: var(--fg-2); }
.recipes-dialog input, .recipes-dialog textarea, .recipes-dialog select { width: 100%; box-sizing: border-box; }
.recipes-dialog input[type=search] { padding: 0 10px; background: var(--field); border: 1px solid var(--line-2); border-radius: var(--r); margin-bottom: 14px; }
.recipes-dialog input[type=search]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.recipes-dialog textarea { min-height: 96px; resize: vertical; }
.recipes-dialog .recipe-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(190px,1fr)); gap: 12px; }
.recipes-dialog .recipe-card { display: flex; flex-direction: column; align-items: stretch; text-align: left; gap: 10px; padding: 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--chrome); color: var(--fg); cursor: pointer; }
.recipes-dialog .recipe-card:hover { background: var(--hover); }
.recipes-dialog .recipe-thumb { display: block; width: 100%; height: 130px; background: var(--chrome); border-radius: 6px; }
.recipes-dialog .recipe-detail-preview .recipe-thumb { height: 190px; }
.recipes-dialog .recipe-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.recipes-dialog .recipe-inputs { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 0 16px; }
.recipes-dialog .recipe-muted { color: var(--fg-2); font-size: var(--fs-sm); }
.recipes-dialog .recipe-description { white-space: pre-wrap; }
.recipes-dialog .recipe-warning { padding: 10px 12px; margin: 10px 0; border: 1px solid #e5c07b4d; border-radius: 6px; color: var(--warn); }
.recipes-dialog .recipe-status:empty { display: none; }
.recipes-dialog .recipe-status { padding: 10px 18px; border-bottom: 1px solid var(--line); color: var(--warn); }
`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const button = (name: string, action: () => void, cls = '') => {
  const b = el('button', { class: `btn ${cls}`, type: 'button' }, name);
  b.onclick = action;
  return b;
};

/** Deliberately approximate: each captured part's world bounds, never the source viewport. */
function thumbnail(recipe: Recipe): HTMLElement {
  const box = el('div');
  try {
    const boxes = worldBoxes(recipe.doc);
    const project = ([x, y, z]: number[]) => [(x! - z!) * .866, (x! + z!) * .5 - y!];
    const parts = Object.keys(recipe.doc.parts).flatMap((id) => {
      const b = boxes.get(id);
      if (!b) return [];
      return [{ b, points: [
          [b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.min[0], b.min[1], b.max[2]],
          [b.min[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]],
        ].map(project) }];
    }).sort((a, b) => (a.b.min[0] + a.b.min[2]) - (b.b.min[0] + b.b.min[2]));
    const points = parts.flatMap((p) => p.points);
    const x = Math.min(...points.map((p) => p[0]!)), y = Math.min(...points.map((p) => p[1]!));
    const w = Math.max(1, ...points.map((p) => p[0]! - x)), h = Math.max(1, ...points.map((p) => p[1]! - y));
    const pad = Math.max(w, h) * .1;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'recipe-thumb');
    svg.setAttribute('viewBox', points.length ? `${x-pad} ${y-pad} ${w+pad*2} ${h+pad*2}` : '0 0 100 100');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${recipe.name}: approximate part-bounds preview`);
    for (const part of parts) for (const [i, face] of [[4,5,6,7], [0,1,5,4], [1,2,6,5]].entries()) {
      const polygon = document.createElementNS(ns, 'polygon');
      polygon.setAttribute('points', face.map((v) => part.points[v]!.join(',')).join(' '));
      polygon.setAttribute('fill', ['#aa9270', '#806c53', '#645846'][i]!);
      polygon.setAttribute('stroke', '#d6c3a5');
      polygon.setAttribute('stroke-width', '1');
      polygon.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(polygon);
    }
    box.append(svg);
  } catch { box.append(el('p', { class: 'recipe-muted' }, 'Preview unavailable.')); }
  return box;
}

export interface RecipesPanelOptions {
  store: Store;
  selection: Selection;
  toolbar: HTMLElement;
  editBlocked?(): string | null;
  onAdapt?(recipe: Recipe, inputs: Readonly<Record<string, number>>): boolean | void;
  adaptBlocked?(): string | null;
  onInserted?(doc: Doc, rootIds: string[]): void;
}

export function mountRecipesPanel(options: RecipesPanelOptions) {
  const { store, selection } = options;
  document.head.append(el('style', {}, CSS));
  const library = browserRecipeLibrary();
  const dialog = el('dialog', { class: 'recipes-dialog', 'aria-labelledby': 'recipes-heading' });
  const body = el('div', { class: 'recipes-body' });
  const status = el('div', { class: 'recipe-status', role: 'status', 'aria-live': 'polite' });
  let previousFocus: HTMLElement | null = null;
  let busy = false;
  let loadFailed = false;
  let page: 'library' | 'save' | 'detail' = 'library';
  let saveSource: Doc | null = null;
  let saveSelection = '';
  let actionButtons: HTMLButtonElement[] = [];
  const selectionKey = () => JSON.stringify(selection.targets);
  const close = () => { if (!busy) dialog.close(); };
  const closeButton = button('Close', close);
  dialog.append(el('header', {}, el('h2', { id: 'recipes-heading' }, 'Recipes'), closeButton), status, body);
  document.body.append(dialog);
  const launch = el('button', { class: 'btn', type: 'button', title: 'Recipes', 'aria-label': 'Recipes', 'aria-haspopup': 'dialog' }, icon('box'), el('span', { class: 't' }, 'Recipes'));
  options.toolbar.append(launch);
  function refresh() {
    const stale = page === 'save' && (saveSource !== store.doc || saveSelection !== selectionKey());
    const blocked = options.editBlocked?.();
    status.textContent = busy ? 'Working…' : blocked ?? (stale ? 'The model or selection changed. Refresh the save scope before saving; your name and description will be kept.' : '');
    for (const b of actionButtons) b.disabled = busy || !!blocked || !!stale || loadFailed;
    closeButton.disabled = busy;
  }
  const warn = (warnings: readonly string[]) => el('div', {}, ...warnings.map((w) => el('p', { class: 'recipe-warning' }, w)));
  function libraryView() {
    page = 'library'; actionButtons = []; loadFailed = false;
    const save = button('Save as recipe', saveView);
    actionButtons.push(save);
    const search = el('input', { type: 'search', placeholder: 'Search recipes', 'aria-label': 'Search recipes' });
    const grid = el('div', { class: 'recipe-grid' });
    let recipes: Recipe[] = [];
    const error = el('div', { role: 'alert' });
    try { recipes = library.read(); } catch (e) { loadFailed = true; error.append(el('p', { class: 'recipe-warning' }, errorText(e))); }
    const renderCards = () => {
      grid.replaceChildren();
      const matches = recipes.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(search.value.toLowerCase()));
      for (const recipe of matches) {
        const card = el('button', { class: 'recipe-card', type: 'button', 'aria-label': `Open recipe ${recipe.name}` }, thumbnail(recipe), el('strong', {}, recipe.name), el('span', { class: 'recipe-muted' }, `${Object.keys(recipe.doc.parts).length} parts · ${recipe.scope === 'model' ? 'Whole model' : 'Component'}`));
        card.onclick = () => detailView(recipe);
        grid.append(card);
      }
      if (!matches.length && !loadFailed) grid.append(el('p', { class: 'recipe-muted' }, recipes.length ? 'No matching recipes.' : 'Your construction library starts here. Save a whole model or a component to reuse it in another project.'));
    };
    search.oninput = renderCards;
    body.replaceChildren(el('p', { class: 'recipe-muted' }, 'Saved in this browser, independently of your model. Previews show approximate part bounds.'), el('div', { class: 'recipe-actions' }, save), search, error, grid);
    renderCards(); refresh();
  }
  function saveView() {
    page = 'save'; actionButtons = [];
    const name = el('input', { type: 'text', maxlength: 120, required: true, value: '' });
    const description = el('textarea', { maxlength: 8000, placeholder: 'Describe how this is built and what should stay consistent when reused.' });
    const scope = el('select', { 'aria-label': 'Recipe scope' });
    const preview = el('div');
    const error = el('div', { role: 'alert' });
    let candidate: Recipe | null = null;
    let nodes: string[] = [];
    let hasHandles = false;
    let suggested = '';
    function capture() {
      candidate = null; error.replaceChildren(); preview.replaceChildren();
      try {
        if (scope.value === 'selection' && hasHandles) throw new Error('Select whole parts or choose a named assembly below; faces and edges cannot be saved separately.');
        const nodeIds = scope.value === 'model' ? undefined : scope.value === 'selection' ? nodes : [scope.value.slice(4)];
        candidate = captureRecipe(saveSource!, { name: name.value.trim() || 'Untitled recipe', description: description.value, nodeIds });
        preview.append(thumbnail(candidate), el('p', { class: 'recipe-muted' }, `${Object.keys(candidate.doc.parts).length} captured parts, including hidden descendants. Approximate bounds preview.`), warn(candidate.warnings));
      } catch (e) { error.append(el('p', { class: 'recipe-warning' }, errorText(e))); }
      refresh();
    }
    function resetScope() {
      saveSource = store.doc; saveSelection = selectionKey();
      nodes = [...new Set(selection.targets.map((t) => t.node))];
      hasHandles = selection.targets.some((t) => !!t.handle);
      // The outline represents an assembly as all its parts. Collapse only exact selections;
      // unlike moving a generated part, saving one must not silently save its whole cabinet.
      const collapsed = gizmoNodes(saveSource, selection.targets);
      const picked = new Set(nodes);
      if (collapsed && collapsed.every((id) => !saveSource!.assemblies[id] || descendants(saveSource!, id).filter((child) => saveSource!.parts[child]).every((child) => picked.has(child)))) nodes = collapsed;
      const oldScope = scope.value;
      scope.replaceChildren(el('option', { value: 'model' }, 'Whole model'), el('option', { value: 'selection' }, `Current selection (${nodes.length})`), ...Object.values(saveSource.assemblies).map((a) => el('option', { value: `asm:${a.id}` }, `Assembly: ${a.name}`)));
      scope.value = [...scope.options].some((o) => o.value === oldScope) ? oldScope : nodes.length && !hasHandles ? 'selection' : 'model';
      suggestName(); capture();
    }
    function suggestName() {
      const id = scope.value.startsWith('asm:') ? scope.value.slice(4) : scope.value === 'selection' && nodes.length === 1 ? nodes[0] : undefined;
      const next = id ? (saveSource!.parts[id] ?? saveSource!.assemblies[id])?.name ?? 'Component recipe' : scope.value === 'model' ? 'Model recipe' : 'Component recipe';
      if (!name.value || name.value === suggested) name.value = next;
      suggested = next;
    }
    scope.onchange = () => { suggestName(); capture(); };
    const save = button('Save recipe', () => { void (async () => {
      refresh(); if (save.disabled) return;
      capture(); if (!candidate) return;
      if (!name.value.trim()) { error.textContent = 'Give your recipe a name.'; name.focus(); return; }
      busy = true; refresh();
      try {
        const saved = { ...candidate, name: name.value.trim(), description: description.value };
        await library.save(saved);
        busy = false; detailView(saved); toast(`Saved recipe “${saved.name}”.`);
      } catch (e) { error.textContent = errorText(e); }
      finally { busy = false; refresh(); }
    })(); }, 'primary');
    actionButtons.push(save);
    body.replaceChildren(button('Back to recipes', libraryView), el('h3', {}, 'Save as recipe'), el('label', {}, 'Scope', scope), button('Refresh save scope', resetScope), el('label', {}, 'Recipe name', name), el('label', {}, 'Construction description', description), preview, error, el('div', { class: 'recipe-actions' }, save));
    resetScope();
  }
  function detailView(recipe: Recipe) {
    page = 'detail'; actionButtons = [];
    const fields = recipeInputs(recipe).map((input) => ({ input, field: el('input', { type: 'text', value: input.unit === 'length' ? fmt(input.value) : input.value, title: input.unit === 'length' ? LENGTH_HINT : 'Number' }) }));
    const error = el('div', { role: 'alert' });
    const values = () => Object.fromEntries(fields.map(({ input, field }) => {
      const n = input.unit === 'length' ? parse(field.value) : field.value.trim() ? Number(field.value) : NaN;
      if (n === null || !Number.isFinite(n)) { field.focus(); throw new Error(`Enter a valid value for ${input.label}.`); }
      return [input.key, n];
    }));
    const use = button('Use recipe', () => {
      refresh(); if (use.disabled) return;
      try {
        const insertion = placeRecipe(store.doc, recipe, { inputs: values() });
        const result = store.dispatch(insertion.ops);
        if (!result.ok) throw new Error(result.error);
        selection.set(targetsOf(result.doc, [insertion.wrapperId]));
        options.onInserted?.(result.doc, [insertion.wrapperId]);
        close(); toast(`Inserted “${recipe.name}”. Undo removes this copy.`);
      } catch (e) { error.textContent = errorText(e); }
    }, 'primary');
    actionButtons.push(use);
    const actions = el('div', { class: 'recipe-actions' }, use);
    if (options.onAdapt) {
      const adapt = button('Adapt with AI', () => {
        refresh(); if (adapt.disabled) return;
        try {
          const blocked = options.adaptBlocked?.();
          if (blocked) throw new Error(blocked);
          if (options.onAdapt!(recipe, values()) !== false) close();
        } catch (e) { error.textContent = errorText(e); }
      });
      actionButtons.push(adapt); actions.append(adapt);
    }
    body.replaceChildren(button('Back to recipes', libraryView), el('h3', {}, recipe.name), el('div', { class: 'recipe-detail-preview' }, thumbnail(recipe)), el('p', { class: 'recipe-muted' }, 'Approximate part bounds of the saved design. Inputs below are applied when used.'), el('p', { class: 'recipe-description' }, recipe.description || 'No construction description saved.'), warn(recipe.warnings), el('h3', {}, 'Size and construction'), el('p', { class: 'recipe-muted' }, fields.length ? 'Change these values for this copy. Other dimensions follow the saved design.' : 'This recipe has no adjustable size fields yet. You can edit its parts after insertion or adapt it with AI.'), el('div', { class: 'recipe-inputs' }, ...fields.map(({ input, field }) => el('label', {}, `${input.group ? `${input.group} · ` : ''}${input.label}`, field))), error, actions);
    refresh();
  }
  function open() { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : launch; libraryView(); dialog.showModal(); }
  launch.onclick = open;
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => previousFocus?.focus());
  store.subscribe(refresh); selection.subscribe(refresh);
  window.addEventListener('storage', (event) => { if (event.key === RECIPE_LIBRARY_KEY && dialog.open && page === 'library') libraryView(); });
  return { open, refresh, setBusy(value: boolean) { busy = value; refresh(); } };
}
import { gizmoNodes, targetsOf } from '../edit/gizmo';
import { descendants } from '../model/doc';
