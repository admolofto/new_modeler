import './plugins';
import { dimensionLines, type DimLine } from './edit/dimensions';
import { handleKind, resolveTarget } from './edit/targets';
import { demoDoc } from './model/defaults';
import type { Doc } from './model/schema';
import { createStore } from './model/store';
import { hiddenNodes, isolateView, outsideOf } from './model/visibility';
import { createBlockDraft } from './render/blockDraft';
import { createBlockLabels } from './render/blockLabels';
import { createDimensionView } from './render/dimensions';
import { createGizmo } from './render/gizmo';
import { createOverlay, type OverlayItem } from './render/overlay';
import { createSceneSync } from './render/sceneSync';
import { createViewport } from './render/viewport';
import { frameNodes } from './render/frameNodes';
import { connectBridge } from './ui/aiBridge';
import { attachBlockTool } from './ui/blockTool';
import { mountChatPanel, proxySend, type Preview } from './ui/chatPanel';
import { el } from './ui/dom';
import { attachGizmo } from './ui/gizmoControl';
import { attachSplitTool } from './ui/splitTool';
import { icon } from './ui/icons';
import { mountInspector } from './ui/inspector';
import { attachInteraction } from './ui/interaction';
import { mountIsolation } from './ui/isolation';
import { mountNotes } from './ui/notes';
import { mountOutline } from './ui/outline';
import { createProposals } from './ui/proposals';
import { mountRecipesPanel } from './ui/recipesPanel';
import { browserRecipeLibrary } from './ui/recipeStorage';
import { createSelection, type Selection } from './ui/selection';
import { mountShopPanel } from './ui/shopPanel';
import { loadLocal, saveLocalSoon } from './ui/storage';
import { mountTheme } from './ui/theme';
import { mountToasts, toast } from './ui/toast';
import { mountSketchUp } from './ui/sketchup';
import { mountTopBar } from './ui/topbar';
import { fmt, units } from './ui/units';
import { mountVoicePanel } from './ui/voicePanel';

const byId = (id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
};
mountTheme();
const [app, bar, left, stage, right, container] = ['app', 'topbar', 'left', 'stage', 'right', 'viewport'].map(byId) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];

const viewport = createViewport(container);
const store = createStore(loadLocal() ?? demoDoc());
const sceneSync = createSceneSync(viewport.scene);
const overlay = createOverlay(viewport.scene, sceneSync, viewport.renderer);
const dimensions = createDimensionView(viewport.scene);
const blockLabels = createBlockLabels(viewport.scene);
const blockDraft = createBlockDraft(viewport.scene, viewport.renderer);
const gizmo = createGizmo(viewport);
const selection = createSelection();
const recipeLibrary = browserRecipeLibrary();
const proposals = createProposals(store, { recipes: () => recipeLibrary.read() });

/** On screen: a drag in progress, else a pending AI proposal, else the store's doc. */
let aiPreview: Preview | null = null;
let dragPreview: Doc | null = null;
/** What a drag snapped to, highlighted while dragging. */
let snapNode: string | null = null;
/** Dimensions of what's being drawn, shown instead of the selection's. */
let draftDims: DimLine[] | null = null;
/** Whether an AI proposal reaches outside a folder (it can't be isolated then: the change would be hidden). */
const aiOutside = (p: Preview | null, id: string) => !!p && (!p.doc.assemblies[id] || outsideOf(p.doc, id, p.highlight).length > 0);
const isolation = mountIsolation({
  viewport, store, stage, selection,
  toolActive: () => blockTool.active || splitTool.active,
  blocked: (id) => (aiOutside(aiPreview, id) ? 'The AI’s proposed change reaches outside this folder. Accept or reject it first.' : null),
});
/** The model on screen, every folder showing; `shown` is what's drawn (an isolated folder only). */
const modelShown = () => dragPreview ?? aiPreview?.doc ?? store.doc;
const view = (doc: Doc) => isolateView(doc, isolation.id);
const shown = () => view(modelShown());
const editBlocked = () => (proposals.pending ? 'Accept or reject the AI’s proposed change before editing the model directly.' : null);

/** Highlights for the hovered and selected targets. */
function overlayItems(doc: Doc, sel: Selection): OverlayItem[] {
  const items: OverlayItem[] = [];
  const add = (t: (typeof sel.targets)[number], style: OverlayItem['style']) => {
    if (!doc.parts[t.node]) return;
    if (!t.handle) return items.push({ partId: t.node, kind: 'part', style });
    const kind = handleKind(t.handle, resolveTarget(doc, t)?.handle);
    if (kind === 'face') return items.push({ partId: t.node, kind, tag: t.handle, style });
    const h = resolveTarget(doc, t)?.handle;
    if (h) items.push({ partId: t.node, kind, points: h.points, style });
  };
  if (sel.hover && !sel.has(sel.hover)) add(sel.hover, 'hover');
  if (snapNode && doc.parts[snapNode]) items.push({ partId: snapNode, kind: 'part', style: 'hover' });
  for (const t of sel.targets) add(t, 'selected');
  return items;
}

function updateDimensions(doc: Doc): void {
  dimensions.set(draftDims ?? (top.dims ? dimensionLines(doc, selection.targets) : []), fmt);
}

let ready = false; // panels call back into render while they mount
const render = () => {
  if (!ready) return;
  const doc = shown();
  sceneSync.update(doc, aiPreview && !dragPreview ? { highlight: aiPreview.highlight } : undefined);
  const hidden = hiddenNodes(doc);
  selection.prune((id) => !!(doc.parts[id] ?? doc.assemblies[id]) && !hidden.has(id));
  overlay.setPins(pins(doc));
  overlay.setItems(overlayItems(doc, selection));
  blockLabels.update(doc);
  gizmoCtl.sync();
  updateDimensions(doc);
  outline.refresh();
  notes.refresh();
  shop.refresh();
};

store.subscribe((doc) => {
  render();
  saveLocalSoon(doc);
});
mountToasts(stage);
const top = mountTopBar({ app, bar, store });
mountSketchUp({
  slot: top.file, store, selection, editBlocked,
  onImported: (doc, ids) => {
    try { frameNodes(viewport, doc, ids); } catch { /* the outline still lists it */ }
  },
});
const outline = mountOutline({ parent: left, stage, store, selection, shown, editBlocked, isolation, startBlocks: () => blockTool.toggle(true) });
const chat = mountChatPanel(
  right,
  proposals,
  proxySend,
  (p) => {
    aiPreview = p;
    if (isolation.id && aiOutside(p, isolation.id)) isolation.exit(false, 'Showing the whole model for the AI’s proposed change.');
    render();
  },
  () => viewport.capture(),
  (doc, ids) => frameNodes(viewport, doc, ids),
);
const recipes = mountRecipesPanel({
  store, selection, toolbar: top.tools,
  editBlocked: () => chat.busy ? 'Wait for the AI to finish before using recipes.' : editBlocked(),
  adaptBlocked: () => chat.recipeAttached ? 'Remove the attached recipe before choosing another.' : null,
  onAdapt: (recipe, inputs) => {
    top.showPanel('right');
    chat.attachRecipe(recipe, inputs, selection.targets);
  },
  onInserted: (doc, ids) => {
    try { frameNodes(viewport, doc, ids); } catch { toast('Recipe inserted. Select the copy in the outline to inspect it.'); }
  },
});
chat.subscribe(recipes.refresh);
proposals.subscribe(recipes.refresh);
const notes = mountNotes({ store, selection, panel: chat, shown, reveal: () => top.showPanel('right') });
connectBridge(proposals);

const setSnapNode = (id: string | null) => {
  if (id === snapNode) return;
  snapNode = id;
  overlay.setItems(overlayItems(shown(), selection));
};
const gizmoCtl = attachGizmo({
  viewport,
  gizmo,
  store,
  selection,
  shown,
  view,
  editBlocked,
  toolActive: () => blockTool.active || splitTool.active,
  setDragPreview: (doc) => {
    dragPreview = doc;
    render();
  },
  setSnapNode,
  onStatus: (msg, error) => toast(msg, error),
});
const interaction = attachInteraction({
  viewport,
  sceneSync,
  overlay,
  selection,
  store,
  shown,
  view,
  editBlocked,
  setDragPreview: (doc) => {
    dragPreview = doc;
    render();
  },
  setSnapNode,
  onPin: (id) => notes.focus(id),
  onStatus: (msg, error) => toast(msg, error),
  onHover: (t) => voice.session.hover(t),
  ignorePins: () => voice.session.recording,
  toolActive: () => blockTool.active || splitTool.active,
  gizmo: gizmoCtl,
});
const blockTool = attachBlockTool({
  viewport,
  sceneSync,
  store,
  selection,
  draft: blockDraft,
  editBlocked,
  view,
  folder: () => isolation.id,
  setPreview: (doc) => {
    dragPreview = doc;
    render();
  },
  setDims: (lines) => {
    draftDims = lines;
    updateDimensions(shown());
  },
  setSnapNode,
  onStatus: (msg, error) => toast(msg, error),
});
const splitTool = attachSplitTool({
  viewport,
  sceneSync,
  store,
  selection,
  draft: blockDraft,
  editBlocked,
  view,
  setDims: (lines) => {
    draftDims = lines;
    updateDimensions(shown());
  },
  setSnapNode,
  onStatus: (msg, error) => toast(msg, error),
});
// One tool at a time.
blockTool.subscribe(() => blockTool.active && splitTool.toggle(false));
splitTool.subscribe(() => {
  if (splitTool.active) blockTool.toggle(false);
  gizmoCtl.sync();
});
const blockBtn = el('button', { class: 'btn ghost', title: 'Draw blocks: rough placeholders you then tell the AI about (B)' }, icon('box'), el('span', { class: 't' }, 'Block'));
blockBtn.addEventListener('click', () => blockTool.toggle());
top.draw.append(blockBtn);
const syncBlockBtn = () => {
  blockBtn.setAttribute('aria-pressed', String(blockTool.active));
  gizmoCtl.sync();
};
blockTool.subscribe(syncBlockBtn);
syncBlockBtn();
mountInspector({
  parent: left,
  store,
  selection,
  shown,
  editBlocked,
  cancelDrag: interaction.cancelDrag,
  onClear: () => notes.clearActive(),
  blockTools: { split: () => splitTool.toggle(true), duplicate: () => gizmoCtl.duplicate() },
});
const shop = mountShopPanel(stage, { store, selection, shown: modelShown, toolbar: top.tools });
const voice = mountVoicePanel(stage, { store, selection, chat, shown, onPins: () => ready && overlay.setPins(pins(shown())) });
/** Note pins, then voice-note drafts numbered after them. */
const pins = (doc: Doc) => [...notes.pins(doc), ...voice.pins(doc)];
top.subscribe(() => updateDimensions(shown()));
notes.onPins(() => overlay.setPins(pins(shown())));
isolation.subscribe(render);
let dimsSig = '';
selection.subscribe(() => {
  const hidden = hiddenNodes(shown());
  if (selection.targets.some((t) => hidden.has(t.node)) || (selection.hover && hidden.has(selection.hover.node))) {
    selection.prune((id) => !hidden.has(id));
    return;
  }
  overlay.setItems(overlayItems(shown(), selection));
  gizmoCtl.sync();
  // Hover changes on every mouse move; dimensions follow the selection only.
  const sig = JSON.stringify(selection.targets.map((t) => t.node));
  if (sig !== dimsSig) {
    dimsSig = sig;
    updateDimensions(shown());
  }
});
ready = true;
render();

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea') || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) store.undo();
  else if (key === 'y' || (key === 'z' && e.shiftKey)) store.redo();
  else return;
  e.preventDefault();
});

if (import.meta.env.DEV) Object.assign(window, { __modeler: { store, scene: viewport.scene, sceneSync, selection, proposals, viewport, voice, shop, notes, units, blockTool, splitTool, gizmo: gizmoCtl, isolation } });
