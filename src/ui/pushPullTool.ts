import { BLOCK_STEP } from '../edit/blocks';
import { dragChanges, driveOps, handleDrives, type HandleDrives } from '../edit/drives';
import { add, alongLine, dot, scale, sub } from '../edit/rays';
import { inferLine, partFrameBoxes } from '../edit/snap';
import type { Target } from '../edit/targets';
import type { V3 } from '../geometry/types';
import { descendants } from '../model/doc';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { rotate, nodeAffine, type Box3 } from '../model/world';
import { PALETTE } from '../render/palette';
import { SNAP_PX } from './interaction';
import { amend, AXES, cursorLabel, signed, signOf, type ToolContext } from './toolKit';
import type { Tool } from './tools';
import { fmt, parse } from './units';

/**
 * Push / Pull (P), as in SketchUp: click a face — no need to select it first — move, and click
 * again (or press, drag and let go). The face moves along its normal and the part's size follows; a
 * cabinet's outer faces resize the cabinet. It snaps flush with other parts' faces, to their sizes
 * and to corners and edges under the cursor, else to 1/16" (Alt: 1/64", no snapping). Type a
 * distance and Enter at any time, even just after, to set how far exactly; double-click another
 * face to push it the same distance again.
 */

interface Pull {
  target: Target;
  hd: HandleDrives;
  base: Doc;
  /** Where the face was grabbed and the way it moves (world model units, unit vector). */
  from: V3;
  normal: V3;
  /** The face's normal in its part's frame. */
  dir: V3;
  boxes: Map<string, Box3>;
  /** Parts that change with the pull: inference looks through them. */
  exclude: Set<string>;
  /** How far the face has moved along its normal. */
  s: number;
  ops: Op[];
  error: string | null;
  startedAt: number;
  x: number;
  y: number;
}

/** A second press this soon, in place, is a double-click: repeat the last distance. */
const DOUBLE_MS = 450;
const DOUBLE_PX = 5;

export function pushPullTool(ctx: ToolContext): Tool {
  const { store, selection, infer, tools, draft } = ctx;
  const label = cursorLabel();
  let pull: Pull | null = null;
  let last: { before: Doc; after: Doc; target: Target; s: number } | null = null;

  /** What pushing a face drives, when it's a flat face that moves along its normal. */
  const pushable = (doc: Doc, t: Target): (HandleDrives & { constraint: { kind: 'line'; dir: V3 } }) | null => {
    const hd = handleDrives(doc, t);
    return hd && hd.handle.kind === 'face' && hd.constraint?.kind === 'line' ? (hd as HandleDrives & { constraint: { kind: 'line'; dir: V3 } }) : null;
  };

  function solve(base: Doc, hd: HandleDrives, dir: V3, s: number) {
    const changes = dragChanges(hd, scale(dir, s));
    const ops = driveOps(base, hd.part.id, changes);
    const r = ops.length ? applyOps(base, ops) : ({ ok: true, doc: base } as const);
    return { changes, ops, r };
  }

  function show(e: PointerEvent | null, s: number, why: string, snapNode: string | null) {
    const p = pull!;
    const { changes, ops, r } = solve(p.base, p.hd, p.dir, s);
    const one = changes.length === 1 ? changes[0]! : null;
    const text = (one ? `${one.drive.label} ${fmt(one.drive.value + one.delta)} (${signed(one.delta)})` : `moved ${signed(s)}`) + (why ? ` · ${why}` : '');
    ctx.setSnapNode(snapNode);
    if (r.ok) {
      p.s = s;
      p.ops = ops;
      p.error = null;
      ctx.setPreview(r.doc);
    } else p.error = r.error;
    const k = ([0, 1, 2] as const).find((i) => Math.abs(p.normal[i]) > 1 - 1e-6);
    draft.set({ lines: [{ a: p.from, b: add(p.from, scale(p.normal, p.s)), color: k === undefined ? PALETTE.rubber : AXES[k]!.color }] });
    tools.measure('Distance', fmt(Math.abs(p.s)));
    if (e) label.show(e, r.ok ? text : `${text} — ${r.error.split('\n')[0]}`, !r.ok);
  }

  function update(e: PointerEvent) {
    const p = pull!;
    infer.aim(e);
    const near = e.altKey ? null : infer.point({ exclude: p.exclude, ground: false });
    // A corner or an edge under the cursor: the face goes level with it.
    if (near && near.kind !== 'face') return show(e, Math.round(dot(sub(near.at, p.from), p.normal)), near.label, near.part);
    const raw = alongLine(infer.ray(), p.from, p.normal);
    if (raw === null) return; // looking straight along the normal
    const tol = e.altKey ? 0 : SNAP_PX * infer.unitsPerPx(p.from);
    const step = e.altKey ? 1 : p.hd.part.block ? BLOCK_STEP : 4;
    const inf = tol ? inferLine(ctx.view(p.base), p.hd, p.dir, raw, tol, p.boxes) : null;
    show(e, inf ? inf.s : Math.round(raw / step) * step, inf?.label ?? '', inf?.node ?? null);
  }

  function end() {
    pull = null;
    label.hide();
    draft.set(null);
    ctx.setSnapNode(null);
    ctx.setPreview(null);
    tools.hint(null);
  }

  function commit() {
    const p = pull;
    if (!p) return;
    end();
    const blocked = ctx.editBlocked();
    if (blocked) return ctx.onStatus(blocked, true);
    if (!p.ops.length || !p.s) return;
    const r = store.dispatch(p.ops);
    if (!r.ok) return ctx.onStatus(r.error, true);
    last = { before: p.base, after: store.doc, target: p.target, s: p.s };
    tools.hint('Type a distance to change it, or double-click another face to push it the same.');
    ctx.onStatus(p.error ? `Stopped at the last size that works: ${p.error.split('\n')[0]}` : '', !!p.error);
  }

  /** The face under the pointer, as a target, with where it was hit. */
  function faceUnder(e: PointerEvent): { target: Target; world: V3 } | null {
    infer.aim(e);
    const f = infer.face();
    if (!f?.tag) return null;
    return { target: { node: f.part, handle: f.tag, at: f.at }, world: [f.world.x * 64, f.world.y * 64, f.world.z * 64] };
  }

  function start(e: PointerEvent) {
    const blocked = ctx.editBlocked();
    if (blocked) return ctx.onStatus(blocked, true);
    const hit = faceUnder(e);
    if (!hit) return;
    const base = store.doc;
    const hd = pushable(base, hit.target);
    if (!hd) return ctx.onStatus('That face doesn’t push or pull. Flat faces do; change a hole or a profile in its settings.', true);
    const exclude = new Set([hd.part.id]);
    for (const d of hd.drives) if (d.owner.kind === 'generator') for (const id of descendants(base, d.owner.asm)) exclude.add(id);
    const dir = hd.constraint.dir;
    pull = {
      target: { node: hit.target.node, handle: hit.target.handle },
      hd,
      base,
      from: hit.world,
      normal: rotate(nodeAffine(base, hd.part.id).m, dir),
      dir,
      boxes: partFrameBoxes(base, hd.part.id),
      exclude,
      s: 0,
      ops: [],
      error: null,
      startedAt: performance.now(),
      x: e.clientX,
      y: e.clientY,
    };
    selection.setHover({ node: hit.target.node, handle: hit.target.handle });
    tools.hint('Move and click to set it, or type a distance and Enter. Alt: 1/64" steps, no snapping.');
    show(e, 0, '', null);
  }

  /** Pushes a face the distance the last one went (a double-click). */
  function repeat(target: Target) {
    if (!last) return;
    const base = store.doc;
    const hd = pushable(base, target);
    if (!hd) return;
    const { ops, r } = solve(base, hd, hd.constraint.dir, last.s);
    if (!r.ok) return ctx.onStatus(r.error.split('\n')[0]!, true);
    const done = store.dispatch(ops);
    if (!done.ok) return ctx.onStatus(done.error, true);
    last = { before: base, after: store.doc, target, s: last.s };
  }

  store.subscribe((doc) => {
    if (pull && doc !== pull.base) end();
  });

  return {
    id: 'pushpull',
    name: 'Push/Pull',
    keys: ['p'],
    icon: 'pushPull',
    hint: 'Click a face to push or pull it.',
    cursor: 'crosshair',
    edits: true,
    down(e) {
      if (!pull) return start(e);
      const p = pull;
      const again = !p.s && performance.now() - p.startedAt < DOUBLE_MS && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= DOUBLE_PX;
      if (!again) return commit();
      end();
      repeat(p.target);
    },
    move(e) {
      if (pull) return update(e);
      const hit = faceUnder(e);
      const hd = hit && !ctx.editBlocked() ? pushable(store.doc, hit.target) : null;
      selection.setHover(hd ? { node: hit!.target.node, handle: hit!.target.handle } : null);
      const d = hd?.drives.length === 1 ? hd.drives[0]! : null;
      label.show(e, d ? `${d.label} ${fmt(d.value)}` : '');
    },
    up(e, dragged) {
      if (pull && dragged) {
        update(e);
        commit();
      }
    },
    leave() {
      if (pull) return;
      selection.setHover(null);
      label.hide();
    },
    key(e) {
      // Undo mid-pull lets go of the face.
      if (pull && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        end();
        return true;
      }
      return false;
    },
    typed(text) {
      const [sign, rest] = signOf(text);
      const u = parse(rest);
      if (u === null) return ctx.onStatus(`"${text}" isn't a distance — try 3, 1 1/2 or 18mm.`, true);
      if (pull) {
        show(null, (pull.s < 0 ? -1 : 1) * sign * u, '', null);
        if (pull.error) {
          const error = pull.error.split('\n')[0]!;
          end();
          return ctx.onStatus(error, true);
        }
        return commit();
      }
      if (!last) return ctx.onStatus('Click a face first, then type how far it goes.', true);
      const hd = pushable(last.before, last.target);
      const s = (last.s < 0 ? -1 : 1) * sign * u;
      const r = hd && amend(store, last, solve(last.before, hd, hd.constraint.dir, s).ops);
      if (!r) return ctx.onStatus('The model has changed since: click the face again, then type the distance.', true);
      if (!r.ok) return ctx.onStatus(r.error.split('\n')[0]!, true);
      last = { ...last, after: store.doc, s };
      tools.measure('Distance', fmt(Math.abs(s)));
    },
    cancel() {
      if (!pull) return false;
      end();
      return true;
    },
    exit() {
      if (pull) end();
      label.hide();
      last = null;
    },
  };
}
