import * as THREE from 'three';
import { BLOCK_STEP, blockPlacement, facingOut, facingToward } from '../edit/blocks';
import { frameBoxDimensions, type DimLine } from '../edit/dimensions';
import { inferDraw, inferExtrude } from '../edit/snap';
import type { V3 } from '../geometry/types';
import { nextId } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { UNITS_PER_INCH } from '../model/units';
import { apply, frameBoxes, IDENTITY, nodeAffine, rotate, toFrame, transpose, type Affine, type Box3 } from '../model/world';
import type { BlockDraft } from '../render/blockDraft';
import type { SceneSync } from '../render/sceneSync';
import type { Viewport } from '../render/viewport';
import { el } from './dom';
import { CLICK_PX, SNAP_PX } from './interaction';
import type { Selection } from './selection';
import { fmt, parse, shop } from './units';

/**
 * The block tool (B): sketch a placeholder block in three clicks, SketchUp-style — a corner, the
 * opposite corner, then how far it comes up (or out, on a wall). It draws on the floor or on any flat
 * face under the cursor, in that face's part's frame, so a block drawn on a turned block turns with
 * it and comes out of the face. Corners and heights snap to other parts (edit/snap.ts), else a 1/2"
 * grid; Alt = 1/64", no snapping. Type sizes any time ("24, 18" Enter, then the height). Middle-drag
 * still orbits, even mid-draw; Esc backs out. One block = one dispatch = one undo step, and the tool
 * stays on for the next one. While a folder is isolated, blocks go into it (in place).
 */

export interface BlockToolOptions {
  viewport: Viewport;
  sceneSync: SceneSync;
  store: Store;
  selection: Selection;
  draft: BlockDraft;
  /** Why direct edits are off right now, or null. */
  editBlocked(): string | null;
  /** The doc as drawn (an isolated folder only): what corners and heights snap to. */
  view?(doc: Doc): Doc;
  /** The isolated folder new blocks go into, or null (the top level). */
  folder?(): string | null;
  /** The block being drawn, as a doc to show (null: the store's). */
  setPreview(doc: Doc | null): void;
  /** Dimension lines for what's being drawn (null: back to normal). */
  setDims(lines: DimLine[] | null): void;
  setSnapNode(id: string | null): void;
  onStatus(msg: string, error?: boolean): void;
}

export interface BlockTool {
  readonly active: boolean;
  toggle(on?: boolean): void;
  /** On / off changed. */
  subscribe(fn: () => void): void;
}

/** Where a block is being drawn: a plane across axis `k` of a frame at coordinate `c`; the block comes out along `sign`. */
interface Plane {
  frame: Affine;
  k: 0 | 1 | 2;
  sign: 1 | -1;
  c: number;
  /** The part whose face it is (null: the floor). */
  host: string | null;
  /** Quarter turns about the frame's y axis that face the new block's front. */
  turns: number;
}

type Phase = { kind: 'idle' } | { kind: 'base'; plane: Plane; first: V3 } | { kind: 'height'; plane: Plane; first: V3; second: V3 };

const STYLE = `
.block-label .k { color: var(--fg-3); }
.block-label .typed { color: var(--fg); font-weight: 600; }
`;

export function attachBlockTool(o: BlockToolOptions): BlockTool {
  const { viewport, sceneSync, store } = o;
  const { camera, renderer } = viewport;
  const canvas = renderer.domElement;
  const container = canvas.parentElement!;
  const raycaster = new THREE.Raycaster();
  const label = el('div', { class: 'drag-label len block-label' });
  label.style.display = 'none';
  document.body.append(el('style', {}, STYLE), label);

  let active = false;
  let phase: Phase = { kind: 'idle' };
  let typed = '';
  let down: { x: number; y: number; moved: boolean } | null = null;
  let last: PointerEvent | null = null;
  /** The block the height phase would add (what a click commits), and the ops that add it. */
  let pending: { id: string; ops: Op[] } | null = null;
  const listeners = new Set<() => void>();

  // ── Geometry ────────────────────────────────────────────────────────────────
  const setRay = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  };
  const U = UNITS_PER_INCH;
  /** The ray in model units. */
  const ray = () => ({ o: raycaster.ray.origin.toArray().map((c) => c * U) as V3, d: raycaster.ray.direction.toArray() as V3 });
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const scene = (p: V3) => new THREE.Vector3(p[0] / U, p[1] / U, p[2] / U);
  const tolAt = (world: V3, e: PointerEvent) => (e.altKey ? 0 : SNAP_PX * viewport.unitsPerPx(scene(world)));
  const step = (e: PointerEvent) => (e.altKey ? 1 : BLOCK_STEP);

  /** Where the ray meets a plane, in the plane's frame coordinates. */
  function onPlane(pl: Plane): V3 | null {
    const { o: ro, d: rd } = ray();
    const of = toFrame(pl.frame, ro);
    const df = rotate(transpose(pl.frame.m), rd);
    if (Math.abs(df[pl.k]) < 1e-6) return null;
    const t = (pl.c - of[pl.k]) / df[pl.k];
    if (t <= 0) return null;
    return [0, 1, 2].map((i) => (i === pl.k ? pl.c : of[i]! + t * df[i]!)) as V3;
  }

  /** The face (or the floor) under the cursor to draw on, and where on it. */
  function planeUnder(doc: Doc): { plane: Plane; at: V3 } | { reason: string } | null {
    const hit = raycaster.intersectObjects(sceneSync.meshes(), false)[0];
    if (hit) {
      const mesh = hit.object as THREE.Mesh;
      const host = mesh.userData.partId as string;
      const n = hit.face?.normal;
      const k = n ? ([0, 1, 2] as const).find((i) => Math.abs(n.getComponent(i)) > 0.999) : undefined;
      if (!n || k === undefined || !doc.parts[host]) return { reason: 'Draw on the floor or a flat face that sits square to its part.' };
      const at = mesh.worldToLocal(hit.point.clone()).toArray() as V3;
      const sign = n.getComponent(k) > 0 ? 1 : -1;
      const frame = nodeAffine(doc, host);
      const turns = k === 1 ? 0 : facingOut(k, sign);
      const c = Math.round(at[k]);
      at[k] = c;
      return { plane: { frame, k, sign, c, host, turns }, at };
    }
    const toCamera = raycaster.ray.direction.clone().negate().toArray() as V3;
    const floor: Plane = { frame: IDENTITY, k: 1, sign: 1, c: 0, host: null, turns: facingToward(IDENTITY, toCamera) };
    const at = onPlane(floor);
    return at ? { plane: floor, at } : null;
  }

  // Snap boxes per frame, for the doc they came from.
  let boxCache: { doc: Doc; key: string; boxes: Map<string, Box3> } | null = null;
  const boxesFor = (doc: Doc, pl: Plane) => {
    const key = pl.host ?? '';
    if (boxCache?.doc !== doc || boxCache.key !== key) boxCache = { doc, key, boxes: frameBoxes(doc, pl.frame) };
    return boxCache.boxes;
  };

  /** Dashed guides from a snapped point along the plane to the parts it lined up with. */
  function guides(pl: Plane, p: V3, boxes: Map<string, Box3>, nodes: string[], axes: (0 | 1 | 2)[]): [V3, V3][] {
    return nodes.flatMap((node, i): [V3, V3][] => {
      const b = boxes.get(node);
      const k = axes[i];
      if (!b || k === undefined) return [];
      const j = ([0, 1, 2] as const).find((x) => x !== pl.k && x !== k)!;
      const q: V3 = [...p];
      q[j] = Math.min(Math.max(p[j], b.min[j]), b.max[j]);
      return q[j] === p[j] ? [] : [[apply(pl.frame, p), apply(pl.frame, q)]];
    });
  }

  /** The block's width axis in the plane, and the other in-plane one. */
  const planeAxes = (pl: Plane): [0 | 1 | 2, 0 | 1 | 2] => {
    const width: 0 | 2 = pl.k === 1 ? (pl.turns % 2 === 0 ? 0 : 2) : pl.k === 0 ? 2 : 0;
    const other = ([0, 1, 2] as const).find((i) => i !== pl.k && i !== width)!;
    return [width, other];
  };
  const rectBox = (pl: Plane, a: V3, b: V3, h = 0): Box3 => {
    const min = [0, 1, 2].map((i) => Math.min(a[i]!, b[i]!)) as V3;
    const max = [0, 1, 2].map((i) => Math.max(a[i]!, b[i]!)) as V3;
    [min[pl.k], max[pl.k]] = pl.sign > 0 ? [pl.c, pl.c + h] : [pl.c - h, pl.c];
    return { min, max };
  };
  const corners = (pl: Plane, a: V3, b: V3): V3[] => {
    const [u, v] = ([0, 1, 2] as const).filter((i) => i !== pl.k);
    const at = (pu: number, pv: number): V3 => {
      const p: V3 = [0, 0, 0];
      p[pl.k] = pl.c;
      p[u!] = pu;
      p[v!] = pv;
      return apply(pl.frame, p);
    };
    return [at(a[u!], a[v!]), at(b[u!], a[v!]), at(b[u!], b[v!]), at(a[u!], b[v!])];
  };

  // ── Feedback ────────────────────────────────────────────────────────────────
  const show = (e: PointerEvent, text: string, bad = false) => {
    const prompt = typedPrompt();
    label.replaceChildren(...shop(text), ...(prompt ? [el('span', { class: 'k' }, ` · ${prompt}: `), el('span', { class: 'typed' }, `${typed}▌`)] : []));
    label.classList.toggle('bad', bad);
    label.style.display = '';
    label.style.left = `${e.clientX + 16}px`;
    label.style.top = `${e.clientY + 12}px`;
  };
  const typedPrompt = () => {
    if (!typed) return '';
    if (phase.kind === 'height') return phase.plane.k === 1 ? 'height' : 'depth';
    if (phase.kind === 'base') return phase.plane.k === 1 ? 'width, depth' : 'width, height';
    return '';
  };
  const size = (b: Box3) => [0, 1, 2].map((k) => b.max[k]! - b.min[k]!);
  const clearFeedback = () => {
    o.draft.set(null);
    o.setPreview(null);
    o.setDims(null);
    o.setSnapNode(null);
    pending = null;
  };

  // ── Phases ──────────────────────────────────────────────────────────────────
  function update(e: PointerEvent) {
    setRay(e);
    const doc = o.view?.(store.doc) ?? store.doc;
    pending = null;
    if (phase.kind === 'idle') {
      o.setPreview(null);
      o.setDims(null);
      const under = planeUnder(doc);
      if (!under || 'reason' in under) {
        o.draft.set(null);
        o.setSnapNode(null);
        if (under) show(e, under.reason, true);
        else label.style.display = 'none';
        return;
      }
      const { plane: pl, at } = under;
      const boxes = boxesFor(doc, pl);
      const s = inferDraw(doc, pl.k, at, tolAt(apply(pl.frame, at), e), boxes, step(e));
      o.draft.set({ cursor: apply(pl.frame, s.p), guides: guides(pl, s.p, boxes, s.nodes, s.axes) });
      o.setSnapNode(s.nodes[0] ?? null);
      return show(e, ['Click a corner', ...s.labels].join(' · '));
    }
    const pl = phase.plane;
    const boxes = boxesFor(doc, pl);
    if (phase.kind === 'base') {
      const at = onPlane(pl);
      if (!at) return;
      const s = inferDraw(doc, pl.k, at, tolAt(apply(pl.frame, at), e), boxes, step(e), phase.first);
      const rect = rectBox(pl, phase.first, s.p);
      const [w, other] = planeAxes(pl);
      o.draft.set({ cursor: apply(pl.frame, s.p), rect: corners(pl, phase.first, s.p), guides: guides(pl, s.p, boxes, s.nodes, s.axes) });
      o.setDims(frameBoxDimensions(pl.frame, rect));
      o.setSnapNode(s.nodes[0] ?? null);
      const sz = size(rect);
      return show(e, [`${fmt(sz[w]!)} × ${fmt(sz[other]!)}`, 'click the opposite corner', ...s.labels].join(' · '));
    }
    // Height: the closest point on the line out of the rectangle's middle.
    const { first, second } = phase;
    const mid = [0, 1, 2].map((i) => (i === pl.k ? pl.c : (first[i]! + second[i]!) / 2)) as V3;
    const A = apply(pl.frame, mid);
    const nf: V3 = [0, 0, 0];
    nf[pl.k] = pl.sign;
    const N = rotate(pl.frame.m, nf);
    const { o: ro, d: rd } = ray();
    const w0: V3 = [A[0] - ro[0], A[1] - ro[1], A[2] - ro[2]];
    const b = dot(N, rd);
    const denom = 1 - b * b;
    if (denom < 1e-4) return;
    const raw = (b * dot(rd, w0) - dot(N, w0)) / denom;
    const s = inferExtrude(doc, pl.k, pl.c, pl.sign, raw, tolAt(A, e), boxes, step(e));
    heightTo(e, s.s, s.snapped ? s.label : '', s.snapped ? s.node : null);
  }

  /** Previews the block at height `h` (what a click adds). */
  function heightTo(e: PointerEvent | null, h: number, why: string, node: string | null) {
    if (phase.kind !== 'height') return;
    const pl = phase.plane;
    const box = rectBox(pl, phase.first, phase.second, h);
    const doc = store.doc;
    const { transform, size: sz } = blockPlacement(pl.frame, box, pl.turns);
    const id = nextId(doc, 'b');
    const folder = o.folder?.() ?? null;
    // Into the isolated folder, staying where it was drawn (else it'd be hidden as it's made).
    const ops: Op[] = [{ op: 'add', entity: { kind: 'block', id, transform, size: sz } }, ...(folder ? [{ op: 'move', id, parent: folder, keepWorld: true } as Op] : [])];
    const r = applyOps(doc, ops);
    o.setSnapNode(node);
    o.setDims(frameBoxDimensions(pl.frame, box));
    o.draft.set({ rect: corners(pl, phase.first, phase.second) });
    if (r.ok) {
      pending = { id, ops };
      o.setPreview(r.doc);
    }
    if (e) show(e, [`${pl.k === 1 ? 'height' : 'depth'} ${fmt(h)}`, 'click to finish', ...(why ? [why] : []), ...(r.ok ? [] : [r.error.split('\n')[0]!])].join(' · '), !r.ok);
  }

  function click(e: PointerEvent) {
    setRay(e);
    const doc = o.view?.(store.doc) ?? store.doc;
    if (phase.kind === 'idle') {
      const under = planeUnder(doc);
      if (!under || 'reason' in under) return;
      const { plane: pl, at } = under;
      const s = inferDraw(doc, pl.k, at, tolAt(apply(pl.frame, at), e), boxesFor(doc, pl), step(e));
      phase = { kind: 'base', plane: pl, first: s.p };
    } else if (phase.kind === 'base') {
      const pl = phase.plane;
      const at = onPlane(pl);
      if (!at) return;
      const s = inferDraw(doc, pl.k, at, tolAt(apply(pl.frame, at), e), boxesFor(doc, pl), step(e), phase.first);
      const sz = size(rectBox(pl, phase.first, s.p));
      if (sz.filter((_, i) => i !== pl.k).some((x) => x <= 0)) return o.onStatus('Move away from the first corner to draw a rectangle.', true);
      phase = { kind: 'height', plane: pl, first: phase.first, second: s.p };
    } else {
      update(e);
      commit();
      return;
    }
    update(e);
  }

  function commit() {
    if (!pending) return;
    const { id } = pending;
    const r = store.dispatch(pending.ops);
    clearFeedback();
    phase = { kind: 'idle' };
    if (!r.ok) return o.onStatus(r.error, true);
    o.selection.set([{ node: id }]);
    o.onStatus(`Added ${store.doc.parts[id]?.name ?? 'a block'}. Draw the next one, or Esc.`);
    if (last) update(last);
  }

  /** Typed sizes: "24, 18" for the rectangle (the second optional), then the height. */
  function applyTyped(text: string) {
    const values = text.split(/\s*[,x×]\s*/i).filter(Boolean).map(parse);
    if (!values.length || values.some((v) => v === null || v <= 0)) return o.onStatus(`"${text}" isn't a size — try 24, 18 or 34 1/2.`, true);
    const [a, b] = values as number[];
    if (phase.kind === 'base') {
      const { plane: pl, first } = phase;
      const [w, other] = planeAxes(pl);
      if (last) setRay(last);
      const cur = (last && onPlane(pl)) || first;
      const second: V3 = [...first];
      const dir = (k: number) => (cur[k]! < first[k]! ? -1 : 1);
      second[w] = first[w] + dir(w) * a!;
      second[other] = b !== undefined ? first[other] + dir(other) * b : cur[other]!;
      if (second[other] === first[other]) second[other] = first[other] + BLOCK_STEP * 2;
      phase = { kind: 'height', plane: pl, first, second };
      if (last) update(last);
    } else if (phase.kind === 'height') {
      heightTo(last, a!, '', null);
      commit();
    }
  }

  // ── On / off ────────────────────────────────────────────────────────────────
  function toggle(on = !active) {
    if (on === active) return;
    if (on) {
      const blocked = o.editBlocked();
      if (blocked) return o.onStatus(blocked, true);
    }
    active = on;
    phase = { kind: 'idle' };
    typed = '';
    down = null;
    clearFeedback();
    label.style.display = 'none';
    canvas.style.cursor = on ? 'crosshair' : '';
    o.onStatus(on ? 'Blocks: click a corner on the floor or a face, the opposite corner, then the height. Type sizes any time; Esc to stop.' : '');
    if (on && last) update(last);
    listeners.forEach((fn) => fn());
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  container.addEventListener(
    'pointerdown',
    (e) => {
      if (!active || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, moved: false };
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (e) => {
    last = e;
    if (!active) return;
    if (down) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) down.moved = true;
      return;
    }
    update(e);
  });
  canvas.addEventListener('pointerleave', () => {
    if (!active || phase.kind !== 'idle') return;
    o.draft.set(null);
    label.style.display = 'none';
  });
  window.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!active || !d || d.moved || e.button !== 0) return;
    if (o.editBlocked()) return o.onStatus(o.editBlocked()!, true);
    click(e);
  });

  const consume = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (!active) {
        if (k.toLowerCase() === 'b' && !e.altKey) (consume(e), toggle(true));
        return;
      }
      if (k === 'Escape') {
        consume(e);
        if (typed) typed = '';
        else if (phase.kind !== 'idle') {
          phase = { kind: 'idle' };
          clearFeedback();
        } else return toggle(false);
        if (last) update(last);
      } else if (k === 'Enter' && typed) {
        consume(e);
        const text = typed;
        typed = '';
        applyTyped(text);
      } else if (k === 'Backspace' && typed) {
        consume(e);
        typed = typed.slice(0, -1);
        if (last) update(last);
      } else if (phase.kind !== 'idle' && (/^[\d.]$/.test(k) || (typed && /^[\d.,/ '"x×a-z-]$/i.test(k)))) {
        consume(e);
        typed += k;
        if (last) update(last);
      } else if (k.toLowerCase() === 'b' && !typed) {
        consume(e);
        toggle(false);
      }
    },
    { capture: true },
  );

  return {
    get active() {
      return active;
    },
    toggle,
    subscribe: (fn) => void listeners.add(fn),
  };
}
