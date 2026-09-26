import * as THREE from 'three';
import { BLOCK_STEP, blockSize, splitOps } from '../edit/blocks';
import { boxDimensions, type DimLine } from '../edit/dimensions';
import { inferSplit } from '../edit/snap';
import type { V3 } from '../geometry/types';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { apply, frameBoxes, nodeAffine, rotate, type Box3 } from '../model/world';
import type { BlockDraft } from '../render/blockDraft';
import type { SceneSync } from '../render/sceneSync';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { CLICK_PX, SNAP_PX } from './interaction';
import type { Selection } from './selection';
import { fmt, parse, shop } from './units';

/**
 * The split tool (S, with one block selected): a cut follows the cursor across the block — across
 * its width by default, Tab for its height or depth — snapping to the seams of the blocks above or
 * below, its middle and 3" steps from either end (cabinet widths), else 1/2". Click to cut; it keeps
 * cutting what's left, so a long run becomes a row of cabinets in a few clicks. Type a width and
 * Enter to cut at it. Each cut is one undo step; Esc or S stops.
 */

export interface SplitToolOptions {
  viewport: Viewport;
  sceneSync: SceneSync;
  store: Store;
  selection: Selection;
  draft: BlockDraft;
  editBlocked(): string | null;
  setDims(lines: DimLine[] | null): void;
  setSnapNode(id: string | null): void;
  onStatus(msg: string, error?: boolean): void;
}

export interface SplitTool {
  readonly active: boolean;
  toggle(on?: boolean): void;
  subscribe(fn: () => void): void;
}

const AXIS_NAMES = ['width', 'height', 'depth'];
const U = UNITS_PER_INCH;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function attachSplitTool(o: SplitToolOptions): SplitTool {
  const { viewport, store, selection } = o;
  const { camera, renderer } = viewport;
  const canvas = renderer.domElement;
  const container = canvas.parentElement!;
  const raycaster = new THREE.Raycaster();
  const label = el('div', { class: 'drag-label len block-label' });
  label.style.display = 'none';
  document.body.append(label);

  let id: string | null = null;
  let k: 0 | 1 | 2 = 0;
  let at: number | null = null;
  let typed = '';
  let down: { x: number; y: number; moved: boolean } | null = null;
  let last: PointerEvent | null = null;
  const listeners = new Set<() => void>();

  const setRay = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  };

  /** Draws the cut at `s` from the block's min face along axis k. */
  function showCut(s: number, why: string, node: string | null, e: PointerEvent | null) {
    const doc = store.doc;
    const part = id ? doc.parts[id] : undefined;
    if (!part) return;
    const size = blockSize(part);
    const A = nodeAffine(doc, part.id);
    const [u, v] = ([0, 1, 2] as const).filter((i) => i !== k);
    const corner = (pu: number, pv: number): V3 => {
      const p: V3 = [0, 0, 0];
      p[k] = s;
      p[u!] = pu;
      p[v!] = pv;
      return apply(A, p);
    };
    o.draft.set({ rect: [corner(0, 0), corner(size[u!]!, 0), corner(size[u!]!, size[v!]!), corner(0, size[v!]!)] });
    const piece = (a: number, b: number): Box3 => {
      const min: V3 = [0, 0, 0];
      const max: V3 = [...size];
      min[k] = a;
      max[k] = b;
      return { min, max };
    };
    const along = (b: Box3): DimLine => {
      const l = boxDimensions(b)[k]!;
      return { ...l, a: apply(A, l.a), b: apply(A, l.b), out: rotate(A.m, l.out) };
    };
    o.setDims([along(piece(0, s)), along(piece(s, size[k]))]);
    o.setSnapNode(node);
    at = s;
    if (!e) return;
    const prompt = typed ? ` · ${AXIS_NAMES[k]}: ${typed}▌` : '';
    label.replaceChildren(...shop([`${fmt(s)} | ${fmt(size[k] - s)}`, 'click to cut', ...(why ? [why] : []), 'Tab: split another way'].join(' · ') + prompt));
    label.classList.remove('bad');
    label.style.display = '';
    label.style.left = `${e.clientX + 16}px`;
    label.style.top = `${e.clientY + 12}px`;
  }

  function update(e: PointerEvent) {
    const doc = store.doc;
    const part = id ? doc.parts[id] : undefined;
    if (!part) return toggle(false);
    setRay(e);
    const size = blockSize(part);
    const A = nodeAffine(doc, part.id);
    // Under the cursor on the block; off it, where the ray passes closest to the line through its middle.
    const mesh = o.sceneSync.meshOf(part.id);
    const hit = mesh && raycaster.intersectObject(mesh, false)[0];
    let raw: number;
    if (hit) raw = mesh.worldToLocal(hit.point.clone()).getComponent(k);
    else {
      const mid: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
      mid[k] = 0;
      const P = apply(A, mid);
      const e3: V3 = [0, 0, 0];
      e3[k] = 1;
      const D = rotate(A.m, e3);
      const ro = raycaster.ray.origin.toArray().map((c) => c * U) as V3;
      const rd = raycaster.ray.direction.toArray() as V3;
      const w0: V3 = [P[0] - ro[0], P[1] - ro[1], P[2] - ro[2]];
      const b = dot(D, rd);
      const denom = 1 - b * b;
      if (denom < 1e-4) return;
      raw = (b * dot(rd, w0) - dot(D, w0)) / denom;
    }
    const center = new THREE.Vector3(...apply(A, [size[0] / 2, size[1] / 2, size[2] / 2])).divideScalar(U);
    const tol = e.altKey ? 0 : SNAP_PX * viewport.unitsPerPx(center);
    const boxes = new Map([...frameBoxes(doc, A)].filter(([other]) => other !== part.id));
    const s = inferSplit(doc, k, size[k], raw, tol, boxes, e.altKey ? 1 : BLOCK_STEP);
    if (!s) {
      o.draft.set(null);
      o.setDims(null);
      at = null;
      label.style.display = 'none';
      return;
    }
    showCut(s.s, s.label, s.node || null, e);
  }

  function cut(s: number) {
    const doc = store.doc;
    if (!id || !doc.parts[id]) return;
    const blocked = o.editBlocked();
    if (blocked) return o.onStatus(blocked, true);
    const before = new Set(Object.keys(doc.parts));
    const r = store.dispatch(splitOps(doc, id, k, s));
    if (!r.ok) return o.onStatus(r.error, true);
    // Keep cutting what's left.
    const rest = Object.keys(store.doc.parts).find((p) => !before.has(p));
    if (rest) {
      id = rest;
      selection.set([{ node: rest }]);
    }
    o.onStatus(`Cut. Keep clicking to cut what's left${rest ? ` (${store.doc.parts[rest]!.name})` : ''}, or Esc.`);
    if (last) update(last);
  }

  function toggle(on = !id) {
    if (on === !!id) return;
    if (on) {
      const blocked = o.editBlocked();
      if (blocked) return o.onStatus(blocked, true);
      const [t, ...more] = selection.targets;
      const part = t && !t.handle && !more.length ? store.doc.parts[t.node] : undefined;
      if (!part?.block) return o.onStatus('Select one block to split it.', true);
      id = part.id;
      k = 0;
      o.onStatus('Split: click where to cut (Tab: split another way; type a width and Enter). Esc to stop.');
    } else {
      id = null;
      o.onStatus('');
    }
    typed = '';
    at = null;
    down = null;
    o.draft.set(null);
    o.setDims(null);
    o.setSnapNode(null);
    label.style.display = 'none';
    canvas.style.cursor = on ? 'crosshair' : '';
    if (on && last) update(last);
    listeners.forEach((fn) => fn());
  }

  container.addEventListener(
    'pointerdown',
    (e) => {
      if (id && e.button === 0) down = { x: e.clientX, y: e.clientY, moved: false };
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (e) => {
    last = e;
    if (!id) return;
    if (down) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) down.moved = true;
      return;
    }
    update(e);
  });
  window.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!id || !d || d.moved || e.button !== 0) return;
    last = e;
    update(e);
    if (at !== null) cut(at);
  });
  store.subscribe((doc) => {
    if (id && !doc.parts[id]) toggle(false);
  });

  const consume = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey) return;
      const key = e.key;
      if (!id) {
        if (key.toLowerCase() === 's' && !e.altKey && selection.targets.length === 1 && store.doc.parts[selection.targets[0]!.node]?.block && !selection.targets[0]!.handle) {
          consume(e);
          toggle(true);
        }
        return;
      }
      if (key === 'Escape' || (key.toLowerCase() === 's' && !typed)) {
        consume(e);
        if (typed) typed = '';
        else return toggle(false);
      } else if (key === 'Tab') {
        consume(e);
        k = k === 0 ? 2 : k === 2 ? 1 : 0;
      } else if (key === 'Enter' && typed) {
        consume(e);
        const u = parse(typed);
        typed = '';
        const part = store.doc.parts[id];
        if (u === null || !part || u <= 0 || u >= blockSize(part)[k]) {
          o.onStatus(`That isn't a width inside the block — try 24 or 18 1/2.`, true);
        } else cut(u);
      } else if (key === 'Backspace' && typed) {
        consume(e);
        typed = typed.slice(0, -1);
      } else if (/^[\d.]$/.test(key) || (typed && /^[\d.,/ '"a-z-]$/i.test(key))) {
        consume(e);
        typed += key;
      } else return;
      if (last) update(last);
    },
    { capture: true },
  );

  return {
    get active() {
      return !!id;
    },
    toggle,
    subscribe: (fn) => void listeners.add(fn),
  };
}
