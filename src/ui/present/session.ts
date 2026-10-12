import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { V3 } from '../../geometry/types';
import { modelPartIds } from '../../model/decor';
import { roomShell } from '../../model/room';
import { deepEqual, movingParts, nextId } from '../../model/doc';
import { motionName, motionOf } from '../../model/motion';
import type { Op } from '../../model/ops';
import type { Doc, Lighting as SavedLighting, LightingPreset, View } from '../../model/schema';
import type { Store } from '../../model/store';
import { eyeHeightOf, motionPlan, viewCamera, viewMotions } from '../../model/views';
import { hiddenNodes } from '../../model/visibility';
import { union, worldBoxes } from '../../model/world';
import { cutaway, sameCut } from '../../render/cutaway';
import { createCut } from '../../render/present/cut';
import { cameraToPose, flight, poseToCamera, type Flight, type Pose } from '../../render/present/flight';
import { focusPose } from '../../render/present/focus';
import { nearestWalkable } from '../../render/present/occupancy';
import { BACKGROUND, createLighting, type Lighting } from '../../render/present/lighting';
import { underCabinetOn, underCabinetStrips, type Bounds } from '../../render/present/lightPlan';
import { presentLook, usedTextureSets, type PresentLook } from '../../render/present/look';
import type { Photo } from '../../render/present/photo';
import { photoFileName, photoSamples, photoSize, type PhotoLevel } from '../../render/present/photoPlan';
import { createPipeline, savedQuality, stillSize, TIERS, type Pipeline, type Quality } from '../../render/present/pipeline';
import { createTextures } from '../../render/present/textures';
import { createSceneSync } from '../../render/sceneSync';
import type { Viewport } from '../../render/viewport';
import { el } from '../dom';
import { CLICK_PX } from '../interaction';
import type { MotionPlayer } from '../motionPlayer';
import { toast } from '../toast';
import { LIGHTING_CHOICES, mountHud, type ViewAction } from './hud';
import { claimKeys, presentAction } from './keys';
import { mountPhotoPanel } from './photoPanel';
import { createWalk, LOOK_AHEAD, sceneGrid, WALK_FOV, WALK_NEAR, type Walk } from './walk';

/**
 * A presentation (B1, B5; loaded on first use): the model drawn on its own — its own scene (a second
 * scene sync with the present look), camera and orbit controls, sharing the editor's renderer — so the
 * editor's scene, camera and controls are never touched. It shows the store's doc (never AI or drag
 * previews; isolation ignored; hidden parts stay hidden). Clicking a door, drawer or lid opens or
 * closes it; double-clicking focuses the point clicked.
 *
 * Phase 4 draws it through `render/present/pipeline.ts` (on demand: nothing is drawn once the image
 * has settled), textured, in the studio look (`render/present/lighting.ts`), and saves images.
 *
 * Phase 6 brings the room in: the lighting presets (saved with `setPresentation`, one undo step per
 * change; `L` cycles them), the sky and the sun through the windows, and the cutaway — walls and
 * ceilings between the camera and the room drawn shadow-only (`render/present/cut.ts`), so they still
 * shape the sunlight, and out of hover and clicks.
 *
 * Phase 8 adds the views tour and walk mode (B6). Going to a view flies there (`render/present/flight.ts`):
 * what the view doesn't open closes as it leaves, what it opens opens halfway, its hidden parts hide
 * and its lighting shows (neither saved). The HUD's strip saves the pose as a view (one undo step) and
 * edits the tour. Walk mode (`V`) flies down to the eye height and walks the occupancy grid; leaving it
 * flies back to the orbit pose it left.
 *
 * Phase 9 adds path-traced photo stills (B8): the HUD's Photo button freezes the camera and renders the
 * scene as it is drawn now with three-gpu-pathtracer (`render/present/photo.ts`, loaded on first use),
 * fading the photo in over the raster image as samples arrive; its panel saves a PNG or cancels. Any
 * click, wheel or key on the view (Esc first of all) cancels and the live view comes back.
 */

export interface SessionOptions {
  app: HTMLElement;
  stage: HTMLElement;
  /** `#viewport`, which the transparent input surface covers. */
  container: HTMLElement;
  viewport: Viewport;
  store: Store;
  player: MotionPlayer;
  /** After everything is put back. */
  onExit(): void;
}

export interface PresentSession {
  /** Resolves once the first presentation frame is up (or the session ended first). */
  ready: Promise<void>;
  exit(): void;
  /** Internals, for the dev console (`__modeler.present.session.debug`). */
  debug: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    pipeline: Pipeline;
    look: PresentLook;
    lighting: Lighting;
    walk: Walk;
    /** The tour and walk mode, for the console: go to view i, save the view on screen, toggle walking, the pose now. */
    tour: { goToView(i: number): void; saveView(): void; toggleWalk(): void; readonly mode: 'orbit' | 'walk'; pose(): Pose };
    /** Path-traced photos: start one (at a level), cancel it, read it as a PNG; the adapter once loaded. */
    photo: { start(level?: PhotoLevel): Promise<void>; cancel(): void; saveBlob(): Promise<Blob>; readonly on: boolean; readonly adapter: Photo | null };
  };
}

/** The camera stays this far above the floor (inches). */
const FLOOR_CLEARANCE = 6;
/** The room probe is taken again this long after the lighting or the model last changed (ms). */
const PROBE_DELAY = 500;
const NOTHING: ReadonlySet<string> = new Set();
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const CSS = `
.pr-surface { position: absolute; inset: 0; z-index: 5; touch-action: none; outline: none; }
.pr-veil { position: absolute; inset: 0; z-index: 40; display: grid; place-items: center; background: ${BACKGROUND}; color: #55575c;
  font-size: var(--fs-lg); letter-spacing: .01em; transition: opacity .35s; }
.pr-veil.off { opacity: 0; pointer-events: none; }
.pr-tip { position: absolute; z-index: 15; padding: 4px 10px; background: #16171bdd; color: #f4f4f2; border-radius: 6px; font-size: var(--fs-sm);
  white-space: nowrap; pointer-events: none; box-shadow: 0 4px 14px #0003; }
`;

/** The model's visible extent in inches (everything but the room; hidden parts left out). */
function modelBounds(doc: Doc): Bounds {
  const hidden = hiddenNodes(doc);
  const boxes = worldBoxes(doc);
  const all = modelPartIds(doc).filter((id) => !hidden.has(id)).map((id) => boxes.get(id)).filter((b) => !!b);
  if (!all.length) return { min: [0, 0, 0], max: [36, 36, 24] };
  const b = union(all);
  return { min: b.min.map((v) => v / 64) as V3, max: b.max.map((v) => v / 64) as V3 };
}

/** The model's name: its only top-level node's, else "model". */
function modelName(doc: Doc): string {
  const only = doc.roots.length === 1 ? (doc.parts[doc.roots[0]!] ?? doc.assemblies[doc.roots[0]!])?.name : undefined;
  return only ?? 'model';
}

/** A saved image's name: the model's, then "presentation". */
function imageName(doc: Doc): string {
  const name = modelName(doc).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'model';
  return `${name} – presentation.png`;
}

export function startPresentation(o: SessionOptions): PresentSession {
  const { viewport, store, player, app, stage, container } = o;
  const { renderer } = viewport;
  let done = false;
  const cleanups: (() => void)[] = [];
  /** Orbiting or walking (walking from the start of the flight down to the eye height). */
  let mode: 'orbit' | 'walk' = 'orbit';
  /** The view last gone to (the tour steps on from it), what it hides and its lighting (null: the saved one). */
  let currentView: string | null = null;
  let viewHidden: ReadonlySet<string> = new Set();
  let viewLighting: LightingPreset | null = null;
  /** Bumped whenever what's drawn changes (the model, poses, the cut, hidden parts, the lighting): a photo of an unchanged scene reuses its stand-in. */
  let sceneVersion = 0;
  /** A photo is up (rendering, or done and still shown); the path tracer once loaded. */
  let photoOn = false;
  let photo: Photo | null = null;

  // 1. Which motions were open, to put back afterwards.
  const openBefore = new Map<string, number>();
  for (const id of Object.keys(store.doc.motions)) if (player.isOpen(id) || player.amount(id) > 0) openBefore.set(id, player.amount(id));

  // 2. Hide the editor, cover the view with an input surface, take the keyboard.
  const style = el('style', {}, CSS);
  const surface = el('div', { class: 'pr-surface', tabindex: -1 });
  const tip = el('div', { class: 'pr-tip' });
  tip.hidden = true;
  const veil = el('div', { class: 'pr-veil' }, 'Preparing…');
  app.classList.add('presenting');
  stage.append(style, surface, tip, veil);
  const hud = mountHud(stage, {
    openAll,
    closeAll,
    saveImage: () => void saveImage(),
    photo: () => void startPhoto(),
    setQuality,
    setLighting: pickLighting,
    setBrightness,
    setUnderCabinet,
    goToView,
    saveView,
    viewAction,
    setMode: (m) => (m === 'walk' ? enterWalk() : exitWalk()),
    exit,
  });
  // Nothing in the hidden panels keeps the keyboard.
  surface.focus({ preventScroll: true });
  cleanups.push(
    claimKeys({
      keydown(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        // A photo renders: any key (Esc first of all) cancels it, and does nothing else.
        if (photoOn) {
          cancelPhoto();
          return true;
        }
        const action = presentAction(e.key, mode === 'walk');
        if (!action) return false;
        if (action === 'move') return walk.key(e, true);
        if (action === 'escape') {
          // (Cancel a photo, above.) Leave walk, else close a popover, else leave presentation.
          if (mode === 'walk') exitWalk();
          else if (!hud.closePopover()) exit();
          return true;
        }
        if (e.repeat) return true;
        if (action === 'next') stepView(1);
        else if (action === 'prev') stepView(-1);
        else if (action === 'walk') toggleWalk();
        else if (action === 'openAll') toggleAll();
        else if (action === 'lighting') cycleLighting();
        else if (action === 'hud') hud.toggleHidden();
        else if (action === 'fullscreen') hud.toggleFullscreen();
        else goToView(action.view);
        return true;
      },
      keyup: (e) => walk.key(e, false),
    }),
  );

  // 3. The scene: the model in its present look, in the studio, drawn by the pipeline.
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, renderer);
  const camera = new THREE.PerspectiveCamera(viewport.camera.fov, Math.max(1e-3, container.clientWidth / Math.max(1, container.clientHeight)), 1, 2000);
  camera.position.copy(viewport.camera.position);

  /** Textures are loaded and the first frame is up: late textures redo the materials. */
  let prepared = false;
  let look: PresentLook | null = null;
  const quality = savedQuality();
  // A tier change (Auto stepping down, or picked) swaps physical and standard materials.
  const pipeline: Pipeline = createPipeline({
    renderer,
    scene,
    camera,
    width: container.clientWidth,
    height: container.clientHeight,
    dpr: window.devicePixelRatio,
    quality,
    onTier(tier, spec) {
      hud.setQuality(look ? pipeline.quality : quality, tier);
      if (!look) return;
      if (look.appearance.physical !== spec.physical) look.appearance.setPhysical(spec.physical);
      // The fixture budget and the spot shadow go with the tier.
      if (prepared) draw(store.doc);
    },
  });

  const textures = createTextures(renderer, {
    small: pipeline.tier === 'fast',
    onLoad() {
      if (!prepared || done) return;
      look!.appearance.refresh();
      draw(store.doc);
    },
  });
  look = presentLook({ textures, physical: pipeline.tier !== 'fast' });
  const present = look;
  const sync = createSceneSync(scene, present);

  let floorY = 0;
  /** The walls and ceilings cut away now (ids), drawn shadow-only. */
  let cutIds: ReadonlySet<string> = NOTHING;
  const cut = createCut(present.appearance.shadowOnly);
  /** Draws what's cut away now shadow-only (again after a repaint); true when that changed. */
  const applyCut = () => cut.set([...cutIds].map((id) => sync.objectOf(id)).filter((o) => !!o));
  /** The cutaway for where the camera is now (nothing in the studio: the room isn't drawn there). */
  const updateCut = () => {
    const shell = roomShell(store.doc);
    const eye: V3 = [camera.position.x * 64, camera.position.y * 64, camera.position.z * 64];
    // Walking never cuts (flying in, the cut follows the eye as orbiting does).
    const next = lighting.showRoom ? cutaway(shell.walls, shell.ceilings, eye, walk.active ? 'walk' : 'orbit', cutIds) : NOTHING;
    if (sameCut(next, cutIds)) return;
    cutIds = next;
    sceneVersion++;
    applyCut();
    pipeline.invalidate();
  };

  /** Fits AO, the far plane and the floor clamp to the model (and the room when it shows). */
  const fit = (doc: Doc, model: Bounds) => {
    const shell = roomShell(doc).bounds;
    const b: Bounds = lighting.showRoom && shell ? { min: shell.min.map((v) => v / 64) as V3, max: shell.max.map((v) => v / 64) as V3 } : model;
    floorY = model.min[1];
    const span = Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    // AO reaches the floor around the model, and what swings open.
    pipeline.setBounds([b.min[0] - 36, b.min[1] - 1, b.min[2] - 36], [b.max[0] + 36, b.max[1] + 12, b.max[2] + 36]);
    camera.far = Math.max(2000, span * 20);
    camera.updateProjectionMatrix();
  };

  // ── Lighting ────────────────────────────────────────────────────────────
  /** The brightness while its slider moves (not saved yet). */
  let previewEv: number | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  const captureProbe = () => {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    if (done || !lighting.usesProbe) return;
    cut.lifted(() => lighting.captureProbe());
    pipeline.invalidate();
  };
  const scheduleProbe = () => {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(captureProbe, PROBE_DELAY);
  };
  cleanups.push(() => probeTimer && clearTimeout(probeTimer));
  /** The doc's lighting, rigged: presets, the sun, the fixtures; the room shown or not. */
  const relight = (doc: Doc, model: Bounds): boolean => {
    // A view's own lighting shows while it's on (not saved).
    const saved = doc.presentation?.lighting;
    const lit: Doc = viewLighting ? { ...doc, presentation: { views: [], ...doc.presentation, lighting: { ...saved, preset: viewLighting } } } : doc;
    const change = lighting.update({ doc: lit, model, budget: TIERS[pipeline.tier].fixtures, spotShadow: pipeline.tier === 'high' });
    applyHidden(doc);
    renderer.toneMappingExposure = previewEv === null ? lighting.exposure : lighting.exposureAt(previewEv);
    pipeline.setBloom(lighting.bloom);
    present.appearance.setFixtureLevel(lighting.fixtureLevel);
    hud.setLighting({
      preset: viewLighting ?? saved?.preset ?? 'auto',
      drawn: lighting.preset,
      ev: saved?.exposure ?? 0,
      underCabinet: { available: lighting.preset !== 'studio' && underCabinetStrips(doc).length > 0, on: underCabinetOn(lighting.preset, saved) },
    });
    return change.probe;
  };
  /** Takes out of the view what isn't drawn: the room in the studio, and what the view on screen hides. */
  function applyHidden(doc: Doc) {
    const out = new Set(viewHidden);
    if (!lighting.showRoom) for (const id of roomShell(doc).shellIds) out.add(id);
    sync.setCutaway(out);
  }
  /** A lighting preset picked in the HUD: saved, and the view's own lighting no longer shows. */
  function pickLighting(preset: LightingPreset) {
    const was = viewLighting;
    viewLighting = null;
    if (was && (store.doc.presentation?.lighting?.preset ?? 'auto') === preset) draw(store.doc);
    else saveLighting({ preset });
  }
  /** Saves a lighting change (one undo step); `auto` with nothing else set clears it. */
  function saveLighting(patch: Partial<SavedLighting>) {
    const cur: SavedLighting = store.doc.presentation?.lighting ?? { preset: 'auto' };
    const next = { ...cur, ...patch } as SavedLighting;
    for (const k of Object.keys(next) as (keyof SavedLighting)[]) if (next[k] === undefined) delete next[k];
    if (deepEqual(next, cur)) return;
    const bare = next.preset === 'auto' && Object.keys(next).length === 1;
    store.dispatch([{ op: 'setPresentation', lighting: bare ? null : next }]);
  }
  function setBrightness(ev: number, final: boolean) {
    previewEv = final ? null : ev;
    if (final) saveLighting({ exposure: Math.abs(ev) < 1e-6 ? undefined : Math.round(ev * 10) / 10 });
    renderer.toneMappingExposure = lighting.exposureAt(ev);
    pipeline.invalidate();
  }
  function setUnderCabinet(on: boolean) {
    // Back to automatic when it matches the preset's default.
    saveLighting({ underCabinet: on === underCabinetOn(lighting.preset, undefined) ? undefined : on });
  }
  function cycleLighting() {
    const ids: LightingPreset[] = LIGHTING_CHOICES.map((c) => c.id);
    const cur = viewLighting ?? store.doc.presentation?.lighting?.preset ?? 'auto';
    pickLighting(ids[(ids.indexOf(cur) + 1) % ids.length]!);
  }

  // The camera starts where the editor's is.
  const controls = new OrbitControls(camera, surface);
  controls.target.copy(viewport.controls.target);
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = true;
  controls.minDistance = 6;
  controls.update();
  cleanups.push(() => controls.dispose());
  const walk = createWalk({ camera, surface, eyeHeight: () => eyeHeightOf(store.doc) / 64, onMove: () => (hoverDirty = true) });
  cleanups.push(() => walk.dispose());
  cleanups.push(
    viewport.onResize((w, h) => {
      cancelPhoto();
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      pipeline.setSize(w, h, window.devicePixelRatio);
    }),
  );

  /** The doc last drawn: a change to anything but its lighting re-takes the probe. */
  let drawnDoc: Doc | null = null;
  const modelChanged = (a: Doc | null, b: Doc) => {
    if (!a) return true;
    if (a === b) return false;
    if (deepEqual(a.presentation, b.presentation)) return true;
    return JSON.stringify({ ...a, presentation: null }) !== JSON.stringify({ ...b, presentation: null });
  };
  const draw = (doc: Doc) => {
    sceneVersion++;
    sync.update(doc, { amount: player.amount });
    const model = modelBounds(doc);
    const probe = relight(doc, model);
    fit(doc, model);
    paintHover();
    updateCut();
    applyCut();
    pipeline.invalidate({ shadows: true });
    if (prepared && lighting.usesProbe && (probe || modelChanged(drawnDoc, doc))) scheduleProbe();
    if (drawnDoc !== doc) scheduleGrid();
    drawnDoc = doc;
    syncViews();
  };

  // ── Hover and click (B5) ────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  let pointer: { x: number; y: number } | null = null;
  let hoverDirty = false;
  let dragging = false;
  let hovered: string | null = null;
  /** The parts a motion moves (each drawn with the hover look while it's hovered). */
  const partsOf = (doc: Doc, motionId: string) => {
    const m = doc.motions[motionId];
    return m ? [...movingParts(doc, m.nodes)] : [];
  };
  const unpaintHover = (id: string) => {
    const doc = store.doc;
    for (const pid of partsOf(doc, id)) {
      const mesh = sync.meshOf(pid);
      const part = doc.parts[pid];
      if (mesh && part) present.paint(mesh, doc, part, null);
    }
  };
  function paintHover() {
    const doc = store.doc;
    if (hovered && !doc.motions[hovered]) setHovered(null);
    if (!hovered) return;
    for (const pid of partsOf(doc, hovered)) {
      const mesh = sync.meshOf(pid);
      if (mesh) present.paintHover(mesh);
    }
  }
  const tipText = () => {
    const m = hovered ? store.doc.motions[hovered] : undefined;
    if (!m) return;
    tip.textContent = `${player.isOpen(m.id) ? 'Close' : 'Open'} — ${motionName(store.doc, m)}`;
  };
  function setHovered(id: string | null) {
    if (id !== hovered) {
      if (hovered) unpaintHover(hovered);
      hovered = id;
      paintHover();
      applyCut();
      pipeline.invalidate();
    }
    surface.style.cursor = hovered ? 'pointer' : '';
    tip.hidden = !hovered || dragging || !pointer;
    if (!tip.hidden && pointer) {
      tipText();
      tip.style.left = `${pointer.x + 14}px`;
      tip.style.top = `${pointer.y + 18}px`;
    }
  }
  /** What's under the pointer: the hit point (inches), the face's world normal, and the motion that would move it. */
  const pick = (): { point: THREE.Vector3; normal: THREE.Vector3 | null; motion: string | null } | null => {
    if (!pointer) return null;
    const r = surface.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((pointer.x / r.width) * 2 - 1, -(pointer.y / r.height) * 2 + 1), camera);
    for (const hit of raycaster.intersectObjects(sync.meshes(), true)) {
      if (cut.isCut(hit.object)) continue;
      let obj: THREE.Object3D | null = hit.object;
      while (obj && !obj.userData.partId) obj = obj.parent;
      const partId = obj?.userData.partId as string | undefined;
      if (!partId) continue;
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      return { point: hit.point, normal, motion: motionOf(store.doc, partId)?.id ?? null };
    }
    return null;
  };
  const at = (e: PointerEvent | MouseEvent) => {
    const r = surface.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let down: { x: number; y: number } | null = null;
  const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    surface.addEventListener(type, fn);
    cleanups.push(() => surface.removeEventListener(type, fn));
  };
  listen('pointermove', (e) => {
    pointer = at(e);
    dragging = e.buttons !== 0;
    hoverDirty = true;
  });
  listen('pointerleave', () => {
    pointer = null;
    setHovered(null);
  });
  listen('pointerdown', (e) => {
    // A photo renders: the click cancels it (and opens nothing).
    if (photoOn) {
      down = null;
      return cancelPhoto();
    }
    down = at(e);
    cancelFlight();
  });
  listen('pointerup', () => {
    dragging = false;
    hoverDirty = true;
  });
  listen('wheel', () => {
    if (photoOn) return cancelPhoto();
    cancelFlight();
  });
  listen('click', (e) => {
    const p = at(e);
    if (e.button !== 0 || !down || Math.hypot(p.x - down.x, p.y - down.y) > CLICK_PX) return;
    pointer = p;
    const hit = pick();
    if (e.detail === 2 && mode === 'walk') return walkToFloor(hit);
    if (!hit) return;
    if (e.detail === 1 && hit.motion) player.toggle([hit.motion]);
    else if (e.detail === 2) focus(hit.point);
  });

  // ── Opening and closing ────────────────────────────────────────────────
  const allIds = () => Object.keys(store.doc.motions);
  function openAll() {
    const closed = allIds().filter((id) => !player.isOpen(id));
    if (closed.length) player.toggle(closed);
  }
  function closeAll() {
    const open = allIds().filter((id) => player.isOpen(id));
    if (open.length) player.toggle(open);
  }
  const toggleAll = () => player.toggle(allIds());
  const syncHud = () => {
    const ids = allIds();
    const open = ids.filter((id) => player.isOpen(id)).length;
    hud.sync({ any: ids.length > 0, allOpen: open === ids.length, noneOpen: open === 0 });
  };
  cleanups.push(
    player.onMove(() => {
      sceneVersion++;
      // A door still finishing its swing as a photo starts: the photo starts over with it where it is.
      if (photoOn) photo?.sceneChanged();
      sync.pose(store.doc, player.amount);
      pipeline.invalidate({ shadows: true });
      hoverDirty = true;
      scheduleGrid();
    }),
    player.subscribe(() => {
      syncHud();
      if (hovered && !tip.hidden) tipText();
    }),
    store.subscribe((doc) => {
      if (!prepared) return;
      cancelPhoto();
      void textures.preload(usedTextureSets(doc));
      draw(doc);
      syncHud();
    }),
  );

  // ── Quality and saving images ───────────────────────────────────────────
  function setQuality(q: Quality) {
    pipeline.setQuality(q);
    hud.setQuality(pipeline.quality, pipeline.tier);
  }
  let saving = false;
  /** Saves the raster image (`note` leads the message: why it's the raster image, when it stands in for a photo). */
  async function saveImage(note = '') {
    if (saving || !prepared) return;
    saving = true;
    hud.setSaving(true);
    const name = imageName(store.doc);
    try {
      const [w, h] = stillSize(container.clientWidth, container.clientHeight, renderer.capabilities.maxTextureSize);
      const blob = await pipeline.still({ width: w, height: h, samples: pipeline.tier === 'fast' ? 16 : 32 });
      if (done) return;
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`${note}Saved ${name} (${w} × ${h}).`, !!note);
    } catch (err) {
      if (!done) toast(`Couldn't save the image: ${(err as Error).message}`, true);
    } finally {
      saving = false;
      if (!done) hud.setSaving(false);
    }
  }

  // ── Flights (B6) ────────────────────────────────────────────────────────
  /** A flight under way: `half` runs halfway (a view's motions open then), `settle` takes over at the end. */
  let flying: { f: Flight; t: number; half?: (() => void) | undefined } | null = null;
  /** The orbit pose walk mode was entered from (it flies back there). */
  let orbitPose: Pose | null = null;
  const orbitNow = (): Pose => ({ position: camera.position.toArray() as V3, target: controls.target.toArray() as V3, fov: camera.fov });
  /** Where the camera is and looks now. */
  const currentPose = (): Pose => (flying ? flying.f.at(flying.f.seconds ? flying.t / flying.f.seconds : 1) : walk.active ? walk.pose() : orbitNow());
  const applyPose = (p: Pose) => {
    camera.position.set(...p.position);
    if (camera.fov !== p.fov) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(...p.target);
  };
  const setNear = (near: number) => {
    if (camera.near === near) return;
    camera.near = near;
    camera.updateProjectionMatrix();
  };
  /** The end of a flight (or one cut short): walking starts there, or orbiting resumes around its target. */
  const settle = (p: Pose) => {
    if (mode === 'walk') {
      setNear(WALK_NEAR);
      walk.start(p);
      scheduleGrid();
    } else {
      setNear(1);
      controls.target.set(...p.target);
      controls.enabled = true;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
    }
    hoverDirty = true;
  };
  /** Flies the camera to `to` (walk: slide and turn, else orbit), replacing any flight under way. */
  function fly(to: Pose, o: { walk: boolean; seconds?: number; half?: () => void }) {
    const from = currentPose();
    walk.stop();
    // Orbiting stops for the flight, so no momentum carries on underneath it.
    controls.enabled = false;
    const f = flight(from, to, { walk: o.walk, reduced: reducedMotion() });
    if (o.seconds !== undefined && f.seconds > 0) f.seconds = o.seconds;
    flying = { f, t: 0, half: o.half };
    pipeline.invalidate();
  }
  /** Input cuts an orbit flight short where it is (its halfway work still happens); flights into walking finish. */
  function cancelFlight() {
    if (!flying || mode === 'walk') return;
    const p = currentPose();
    const half = flying.half;
    flying = null;
    half?.();
    settle(p);
  }
  const stepFlight = (dt: number) => {
    if (!flying) return;
    flying.t += dt;
    const u = flying.f.seconds ? Math.min(1, flying.t / flying.f.seconds) : 1;
    if (u >= 0.5 && flying.half) {
      const half = flying.half;
      flying.half = undefined;
      half();
    }
    const p = flying.f.at(u);
    applyPose(p);
    if (u >= 1) {
      flying = null;
      settle(p);
    }
  };

  /** Double-click focus: orbit the point clicked, closer. */
  function focus(point: THREE.Vector3) {
    const pose = focusPose(camera.position.toArray() as V3, point.toArray() as V3);
    pose.position[1] = Math.max(pose.position[1], floorY + FLOOR_CLEARANCE);
    fly({ ...pose, fov: camera.fov }, { walk: false });
  }

  // ── Walk mode (B6) ──────────────────────────────────────────────────────
  let gridTimer: ReturnType<typeof setTimeout> | null = null;
  const rebuildGrid = () => {
    if (gridTimer) clearTimeout(gridTimer);
    gridTimer = null;
    if (done || mode !== 'walk') return;
    scene.updateMatrixWorld();
    walk.setGrid(sceneGrid(store.doc, sync.meshes(), modelBounds(store.doc)));
  };
  /** The grid again once things stop moving (an open door blocks where it stands). */
  function scheduleGrid() {
    if (mode !== 'walk') return;
    if (gridTimer) clearTimeout(gridTimer);
    gridTimer = setTimeout(rebuildGrid, 300);
  }
  cleanups.push(() => gridTimer && clearTimeout(gridTimer));
  const eyeIn = () => eyeHeightOf(store.doc) / 64;
  /** A walking pose at `p`'s spot (moved to the nearest free one unless `snap` is off), at the eye height, looking where `p` looks. */
  function standAt(p: Pose, snap = true): Pose {
    const grid = walk.grid;
    const spot = (snap && grid && nearestWalkable(grid, [p.position[0], p.position[2]])) || [p.position[0], p.position[2]];
    const eye = eyeIn();
    const d: V3 = [p.target[0] - p.position[0], p.target[1] - p.position[1], p.target[2] - p.position[2]];
    const l = Math.hypot(...d) || 1;
    return { position: [spot[0], eye, spot[1]], target: [spot[0] + (d[0] / l) * LOOK_AHEAD, eye + (d[1] / l) * LOOK_AHEAD, spot[1] + (d[2] / l) * LOOK_AHEAD], fov: WALK_FOV };
  }
  /** Starts walking: the grid now, so the spot under the orbit target is known. */
  function beginWalk() {
    orbitPose = orbitNow();
    mode = 'walk';
    controls.enabled = false;
    rebuildGrid();
    hud.setMode('walk');
  }
  function enterWalk() {
    if (mode === 'walk' || !prepared) return;
    const from = orbitNow();
    beginWalk();
    // Down to the floor under where it looked, facing the way it looked (level).
    const d: V3 = [from.target[0] - from.position[0], 0, from.target[2] - from.position[2]];
    if (Math.hypot(d[0], d[2]) < 1e-6) d[2] = -1;
    fly(standAt({ position: from.target, target: [from.target[0] + d[0], from.target[1], from.target[2] + d[2]], fov: WALK_FOV }), { walk: true, seconds: 1 });
  }
  function exitWalk() {
    if (mode === 'orbit') return;
    mode = 'orbit';
    hud.setMode('orbit');
    const back = orbitPose ?? cameraToPose(viewCamera(store.doc, { id: 'model', name: 'Model', frame: { nodes: [], from: 'front-left' } }, camera.aspect));
    orbitPose = null;
    fly(back, { walk: true, seconds: 1 });
  }
  const toggleWalk = () => (mode === 'walk' ? exitWalk() : enterWalk());
  /** Double-clicking the floor walks there (a floor face, or the floor plane when nothing's hit). */
  function walkToFloor(hit: { point: THREE.Vector3; normal: THREE.Vector3 | null } | null) {
    let point = hit?.point ?? null;
    if (hit && (!hit.normal || hit.normal.y < 0.7 || hit.point.y > floorY + 3)) return;
    if (!point) {
      point = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY), new THREE.Vector3());
      if (!point) return;
    }
    const from = currentPose();
    const d: V3 = [from.target[0] - from.position[0], from.target[1] - from.position[1], from.target[2] - from.position[2]];
    const to = standAt({ position: point.toArray() as V3, target: [point.x + d[0], point.y + d[1], point.z + d[2]], fov: WALK_FOV });
    fly(to, { walk: true });
  }

  // ── The views tour (A9, B6) ─────────────────────────────────────────────
  const views = (): View[] => store.doc.presentation?.views ?? [];
  function syncViews() {
    if (currentView && !views().some((v) => v.id === currentView)) currentView = null;
    hud.setViews(
      views().map((v) => ({ id: v.id, name: v.name, ...(v.caption && { caption: v.caption }) })),
      currentView,
    );
  }
  /** Hides what a view hides (presentation-only), and redraws when that changed. */
  function setViewHidden(ids: readonly string[]) {
    const next = new Set(ids);
    if (sameCut(next, viewHidden)) return;
    viewHidden = next;
    sceneVersion++;
    applyHidden(store.doc);
    applyCut();
    pipeline.invalidate({ shadows: true });
    hoverDirty = true;
    scheduleGrid();
  }
  /**
   * Flies to view `i`: what it doesn't open closes now, what it opens opens halfway; its hidden parts
   * hide and its lighting shows now (neither is saved). A walk view walks there.
   */
  function goToView(i: number) {
    const view = views()[i];
    if (!view || !prepared) return;
    const doc = store.doc;
    currentView = view.id;
    syncViews();
    const plan = motionPlan(allIds().filter((id) => player.isOpen(id)), viewMotions(doc, view));
    if (plan.close.length) player.toggle(plan.close);
    setViewHidden(view.hide ?? []);
    if ((view.lighting ?? null) !== viewLighting) {
      viewLighting = view.lighting ?? null;
      draw(store.doc);
    }
    const half = plan.open.length ? () => player.toggle(plan.open.filter((id) => !player.isOpen(id))) : undefined;
    let to = cameraToPose(viewCamera(doc, view, camera.aspect));
    const wasWalking = mode === 'walk';
    if (view.mode === 'walk') {
      if (!wasWalking) beginWalk();
      // A saved walk camera stood somewhere free when it was saved (a door it opens may still be shut now).
      to = standAt(to, !view.camera);
      fly(to, { walk: true, ...(half && { half }) });
    } else {
      if (wasWalking) {
        mode = 'orbit';
        orbitPose = null;
        hud.setMode('orbit');
      }
      fly(to, { walk: wasWalking, ...(half && { half }) });
    }
  }
  /** The next or previous view (from the one last gone to; the first or last when none was). */
  function stepView(by: 1 | -1) {
    const n = views().length;
    if (!n) return toast('No views yet: “+ Save view” keeps this one.');
    const i = views().findIndex((v) => v.id === currentView);
    goToView(i < 0 ? (by > 0 ? 0 : n - 1) : (i + by + n) % n);
  }
  /** The pose, mode, open motions, hidden parts and shown lighting as a view's fields (null = none). */
  function viewState() {
    const open = allIds().filter((id) => player.isOpen(id));
    const saved = store.doc.presentation?.lighting?.preset ?? 'auto';
    return {
      camera: poseToCamera(currentPose()),
      mode,
      open: open.length ? open : null,
      hide: viewHidden.size ? [...viewHidden] : null,
      lighting: viewLighting && viewLighting !== saved ? viewLighting : null,
    };
  }
  function saveView() {
    const doc = store.doc;
    const id = nextId(doc, 'view');
    const names = new Set(views().map((v) => v.name));
    let n = views().length + 1;
    while (names.has(`View ${n}`)) n++;
    const s = viewState();
    const entity = {
      kind: 'view' as const,
      id,
      name: `View ${n}`,
      camera: s.camera,
      mode: s.mode,
      ...(s.open && { open: s.open }),
      ...(s.hide && { hide: s.hide }),
      ...(s.lighting && { lighting: s.lighting }),
    };
    const r = store.dispatch([{ op: 'add', entity }]);
    if (!r.ok) return toast(`Couldn't save the view: ${r.error}`, true);
    currentView = id;
    syncViews();
  }
  /** The views strip's menu: rename, update to the view on screen, delete, or move along the tour. */
  function viewAction(a: ViewAction) {
    const i = views().findIndex((v) => v.id === a.id);
    if (i < 0) return;
    let op: Op;
    if (a.kind === 'rename') op = { op: 'update', id: a.id, patch: { name: a.name } };
    else if (a.kind === 'update') op = { op: 'update', id: a.id, patch: viewState() };
    else if (a.kind === 'delete') op = { op: 'delete', id: a.id };
    else {
      const to = i + a.by;
      if (to < 0 || to >= views().length) return;
      op = { op: 'move', id: a.id, index: to };
    }
    const r = store.dispatch([op]);
    if (!r.ok) return toast(r.error, true);
    if (a.kind === 'update') {
      currentView = a.id;
      syncViews();
    }
  }

  // ── Photos (B8) ─────────────────────────────────────────────────────────
  let photoLevel: PhotoLevel = 'draft';
  /** The pose the photo froze (walking or orbiting resumes there). */
  let photoPose: Pose | null = null;
  let photoLoading: Promise<Photo> | null = null;
  let photoPanelAt = 0;
  let savingPhoto = false;
  const photoPanel = mountPhotoPanel(stage, {
    setLevel(level) {
      photoLevel = level;
      photo?.setTarget(photoSamples(level));
    },
    save: () => void savePhoto(),
    cancel: () => cancelPhoto(),
  });
  cleanups.push(() => photoPanel.dispose());
  /** The path tracer, loaded and made on the first photo (one per session: its shader compiles once). */
  const loadPhoto = (): Promise<Photo> =>
    (photoLoading ??= import('../../render/present/photo').then(({ createPhoto }) => {
      if (done) throw new Error('the presentation ended');
      photo = createPhoto(renderer, { onError: photoFailed });
      return photo;
    }));
  /** Lands a flight under way at its end (its halfway work done), so the camera holds still. */
  function landFlight() {
    if (!flying) return;
    const f = flying;
    flying = null;
    const p = f.f.at(1);
    f.half?.();
    applyPose(p);
    settle(p);
  }
  /** Freezes the camera and starts a path-traced photo of the view as it is drawn now. */
  async function startPhoto(level: PhotoLevel = photoLevel) {
    if (!prepared || photoOn || done) return;
    photoLevel = level;
    landFlight();
    if (walk.active) walk.stop();
    else {
      // Orbiting's momentum lands now, so the photo's pose is where the view comes to rest.
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      if (camera.position.y < floorY + FLOOR_CLEARANCE) camera.position.y = floorY + FLOOR_CLEARANCE;
    }
    controls.enabled = false;
    photoPose = currentPose();
    pointer = null;
    setHovered(null);
    tip.hidden = true;
    photoOn = true;
    hud.setPhoto(true);
    photoPanel.show(photoLevel);
    surface.focus({ preventScroll: true });
    let p: Photo;
    try {
      p = await loadPhoto();
    } catch (err) {
      if (!done && photoOn) photoFailed(err as Error);
      return;
    }
    if (done || !photoOn) return;
    try {
      p.start({
        camera,
        scene: () => {
          const rig = lighting.photo(modelBounds(store.doc));
          return { live: scene, skip: new Set(rig.skip), isCut: (o) => cut.isCut(o), env: rig.env, background: rig.background, floor: rig.floor, softboxes: rig.softboxes };
        },
        version: sceneVersion,
        target: photoSamples(photoLevel),
        size: photoSize(container.clientWidth, container.clientHeight, pipeline.tier, renderer.capabilities.maxTextureSize),
        raster: () => pipeline.image,
      });
    } catch (err) {
      photoFailed(err as Error);
    }
  }
  /** Back to the live view: the camera moves again from where the photo froze it. */
  function cancelPhoto() {
    if (!photoOn) return;
    photoOn = false;
    photo?.cancel();
    photoPanel.hide();
    hud.setPhoto(false);
    if (done) return;
    settle(photoPose ?? currentPose());
    photoPose = null;
    // The photo is on the canvas: the raster view draws again.
    pipeline.invalidate();
    hoverDirty = true;
  }
  /** The path tracer failed (no compile, a throw, the GPU reset): the raster image is saved instead. */
  function photoFailed(err: Error) {
    console.warn('photo: path tracing failed', err);
    const was = photoOn;
    cancelPhoto();
    if (!was || done) return;
    void saveImage(`Path tracing didn't work here (${err.message}), so this is the rendered image instead. `);
  }
  async function savePhoto() {
    if (!photo || savingPhoto) return;
    savingPhoto = true;
    photoPanel.setSaving(true);
    const name = photoFileName(modelName(store.doc));
    try {
      const blob = await photo.saveBlob();
      if (done) return;
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Saved ${name} (${photo.progress.samples} samples).`);
    } catch (err) {
      if (!done) toast(`Couldn't save the photo: ${(err as Error).message}`, true);
    } finally {
      savingPhoto = false;
      if (!done) photoPanel.setSaving(false);
    }
  }
  /** The GPU reset: a photo can't go on (the path tracer is made again for the next one). */
  const contextLost = () => {
    const had = photoOn;
    cancelPhoto();
    photo?.dispose();
    photo = null;
    photoLoading = null;
    if (had) toast('The graphics card reset, so the photo stopped.', true);
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  cleanups.push(() => {
    renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    photo?.dispose();
    photo = null;
  });
  /** A photo's frame: the raster image until the photo shows, the path tracer's samples, the panel. */
  const photoFrame = (dt: number) => {
    if (!photo?.showing) pipeline.frame(dt);
    if (!photo) return;
    photo.frame(dt);
    const now = performance.now();
    if (now - photoPanelAt > 200) {
      photoPanelAt = now;
      const state = photo.state;
      if (state !== 'idle') photoPanel.update(state, photo.progress);
    }
  };

  // ── The frame ───────────────────────────────────────────────────────────
  // The pipeline notices the camera moving on its own; it draws only when something changed.
  const frame = (dt: number) => {
    // A photo holds the camera still and has the frame to itself.
    if (photoOn) return photoFrame(dt);
    stepFlight(dt);
    if (!flying) {
      if (walk.active) walk.frame(dt);
      else if (mode === 'orbit') {
        controls.update(dt);
        if (camera.position.y < floorY + FLOOR_CLEARANCE) camera.position.y = floorY + FLOOR_CLEARANCE;
      }
    }
    updateCut();
    lighting.follow(camera);
    if (hoverDirty) {
      hoverDirty = false;
      setHovered(dragging || !pointer ? null : (pick()?.motion ?? null));
    }
    pipeline.frame(dt);
  };

  function exit() {
    if (done) return;
    done = true;
    viewport.setFrame(null);
    for (const fn of cleanups.splice(0)) fn();
    hud.dispose();
    style.remove();
    surface.remove();
    tip.remove();
    veil.remove();
    app.classList.remove('presenting');
    // The renderer's own settings (tone mapping, pixel ratio, shadows, clear color) go back with it.
    pipeline.dispose();
    cut.clear();
    sync.dispose();
    present.disposeMaterials();
    textures.dispose();
    lighting.dispose();
    // Put back what was open (at once: the editor shows exactly what it did).
    for (const id of new Set([...allIds(), ...openBefore.keys()])) {
      const to = openBefore.get(id) ?? 0;
      if (player.amount(id) !== to || player.isOpen(id) !== to > 0) player.scrub(id, to);
    }
    o.onExit();
  }

  const ready = (async () => {
    syncHud();
    hud.setMode('orbit');
    syncViews();
    // 4. The textures the model uses, then shaders, behind the veil.
    await textures.preload(usedTextureSets(store.doc));
    if (done) return;
    draw(store.doc);
    lighting.follow(camera);
    // The room probe before the first frame (it compiles most shaders on the way).
    captureProbe();
    try {
      await renderer.compileAsync(scene, camera);
    } catch (err) {
      console.warn('presentation: shaders compile on first draw instead', err);
    }
    if (done) return;
    prepared = true;
    // The doc may have changed while loading.
    draw(store.doc);
    // 5. Presentation takes the frame.
    viewport.setFrame(frame);
    requestAnimationFrame(() => {
      veil.classList.add('off');
      setTimeout(() => veil.remove(), 400);
    });
  })();

  const photoDebug = {
    start: (level?: PhotoLevel) => startPhoto(level),
    cancel: cancelPhoto,
    saveBlob: () => (photo ? photo.saveBlob() : Promise.reject(new Error('no photo yet'))),
    get on() {
      return photoOn;
    },
    get adapter() {
      return photo;
    },
  };
  const tour = {
    goToView,
    saveView,
    toggleWalk,
    get mode() {
      return mode;
    },
    pose: currentPose,
  };
  return { ready, exit, debug: { scene, camera, controls, pipeline, look: present, lighting, walk, tour, photo: photoDebug } };
}
