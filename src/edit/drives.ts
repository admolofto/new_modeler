import type { Handle, V3 } from '../geometry/types';
import { generatedOwner } from '../model/generate';
import type { Op } from '../model/ops';
import type { Doc, Part } from '../model/schema';
import { apply, rotate, rotation } from '../model/world';
import { generators, shapes } from '../plugins';
import { changedTop, getPath, setPath } from './params';
import { resolveTarget, type Target } from './targets';

/**
 * Handle drives → ops. A drive is one numeric param a handle edits: the part's shape, one of
 * its features, or — for a face of a generated part that the generator claims — the
 * generator's params (push a cabinet side and the cabinet gets wider; ROADMAP rule 9).
 * Dragging moves the handle by a part-local displacement; each linear drive grows by the
 * displacement's component along its axis. Ops carry absolute values, so re-applying the same
 * drag to the same base doc is idempotent.
 */

export type DriveOwner = { kind: 'shape' } | { kind: 'feature'; id: string } | { kind: 'generator'; asm: string };

export interface Drive {
  owner: DriveOwner;
  /** Dotted path into the owner's params. */
  path: string;
  label: string;
  /** Current value (model units). */
  value: number;
  /** Part-local direction that grows the param; absent for radial params (diameter, radius). */
  axis?: V3 | undefined;
  /** Growing also moves the part (shape drives) or assembly (generator drives) origin by axis × growth. */
  moveOrigin?: boolean | undefined;
}

export type Constraint = { kind: 'line'; dir: V3 } | { kind: 'plane'; u: V3; v: V3 };

export interface HandleDrives {
  part: Part;
  handle: Handle;
  drives: Drive[];
  /** Part-local drag constraint; null when no drive is linear (edit those numerically). */
  constraint: Constraint | null;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

function ownerParams(doc: Doc, part: Part, owner: DriveOwner): Record<string, unknown> {
  if (owner.kind === 'shape') return part.shape.params;
  if (owner.kind === 'feature') return part.features.find((f) => f.id === owner.id)?.params ?? {};
  return doc.assemblies[owner.asm]?.generator?.params ?? {};
}

/** The generator param a face of a generated part drives, if its generator claims that face. */
function generatorDrive(doc: Doc, part: Part, handle: Handle): Drive | null {
  const asm = generatedOwner(doc, part.id);
  if (!asm || handle.kind !== 'face' || handle.source !== 'shape' || !handle.normal) return null;
  const def = generators.get(asm.generator!.type);
  if (!def.faceDrive) return null;
  const R = rotation(part.transform.rotation);
  const n = rotate(R, handle.normal);
  const axis = ([0, 1, 2] as const).find((k) => Math.abs(n[k]) > 1 - 1e-9);
  if (axis === undefined) return null;
  const plane = Math.round(apply({ m: R, t: part.transform.position }, handle.points[0]!)[axis]);
  const gd = def.faceDrive(asm.generator!.params, { role: part.role!, axis, max: n[axis] > 0, plane });
  if (!gd) return null;
  const value = getPath(asm.generator!.params, gd.param);
  if (typeof value !== 'number') return null;
  return { owner: { kind: 'generator', asm: asm.id }, path: gd.param, label: gd.label, value, axis: scale(handle.normal, gd.sign), moveOrigin: gd.moveOrigin };
}

function constraintOf(handle: Handle, drives: Drive[]): Constraint | null {
  const axes = drives.flatMap((d) => (d.axis ? [unit(d.axis)] : []));
  if (!axes.length) return null;
  if (handle.normal) return { kind: 'line', dir: unit(handle.normal) };
  const distinct: V3[] = [];
  for (const a of axes) if (!distinct.some((b) => Math.abs(dot(a, b)) > 1 - 1e-6)) distinct.push(a);
  if (distinct.length === 1) return { kind: 'line', dir: distinct[0]! };
  const u = distinct[0]!;
  const w = distinct[1]!;
  return { kind: 'plane', u, v: unit(add(w, scale(u, -dot(w, u)))) };
}

/** What a target's handle can edit, or null if it isn't a handle of a buildable part. */
export function handleDrives(doc: Doc, target: Target): HandleDrives | null {
  const r = resolveTarget(doc, target);
  if (!r?.handle) return null;
  const { part, handle } = r;
  const gen = generatorDrive(doc, part, handle);
  const drives: Drive[] = gen
    ? [gen]
    : handle.drives.flatMap((d) => {
        const owner: DriveOwner = d.target === 'shape' ? { kind: 'shape' } : { kind: 'feature', id: d.target };
        const value = getPath(ownerParams(doc, part, owner), d.param);
        return typeof value === 'number' ? [{ owner, path: d.param, label: d.label ?? d.param, value, axis: d.axis, moveOrigin: d.moveOrigin }] : [];
      });
  return { part, handle, drives, constraint: constraintOf(handle, drives) };
}

export interface DriveChange {
  drive: Drive;
  delta: number;
}

/** Ops that grow each drive by its (integer) delta, moving origins where drives say so. */
export function driveOps(doc: Doc, partId: string, changes: DriveChange[]): Op[] {
  const part = doc.parts[partId];
  if (!part) return [];
  const R = rotation(part.transform.rotation);
  const edited = new Map<string, { owner: DriveOwner; before: Record<string, unknown>; after: Record<string, unknown> }>();
  let partShift: V3 = [0, 0, 0];
  const asmShift = new Map<string, V3>();

  for (const { drive, delta } of changes) {
    if (!delta) continue;
    const key = JSON.stringify(drive.owner);
    let e = edited.get(key);
    if (!e) {
      const before = ownerParams(doc, part, drive.owner);
      e = { owner: drive.owner, before, after: structuredClone(before) };
      edited.set(key, e);
    }
    setPath(e.after, drive.path, drive.value + delta);
    if (drive.moveOrigin && drive.axis) {
      const shift = scale(drive.axis, delta);
      if (drive.owner.kind === 'generator') {
        // Generator params live in the assembly's frame.
        asmShift.set(drive.owner.asm, add(asmShift.get(drive.owner.asm) ?? [0, 0, 0], rotate(R, shift)));
      } else {
        partShift = add(partShift, shift);
      }
    }
  }

  const ops: Op[] = [];
  for (const { owner, before, after } of edited.values()) {
    if (owner.kind === 'shape') {
      const norm = shapes.get(part.shape.type).normalize?.(after);
      const params = norm ? (norm.params as Record<string, unknown>) : after;
      if (norm) partShift = add(partShift, norm.offset);
      ops.push({ op: 'update', id: part.id, patch: { shape: { params: changedTop(before, params) } } });
    } else if (owner.kind === 'feature') {
      ops.push({ op: 'updateFeature', part: part.id, feature: owner.id, params: changedTop(before, after) });
    } else {
      ops.push({ op: 'update', id: owner.asm, patch: { params: changedTop(before, after) } });
    }
  }
  const moveBy = (id: string, pos: V3, rot: V3, local: V3) => {
    const d = rotate(rotation(rot), local).map(Math.round) as V3;
    if (d.some((c) => c !== 0)) ops.push({ op: 'move', id, to: add(pos, d) });
  };
  moveBy(part.id, part.transform.position, part.transform.rotation, partShift);
  for (const [asmId, shift] of asmShift) {
    const asm = doc.assemblies[asmId]!;
    moveBy(asmId, asm.transform.position, asm.transform.rotation, shift);
  }
  return ops;
}

/** Linear drive deltas for a part-local drag displacement. */
export function dragChanges(hd: HandleDrives, disp: V3): DriveChange[] {
  return hd.drives.flatMap((drive) => (drive.axis ? [{ drive, delta: Math.round(dot(disp, drive.axis)) }] : []));
}

/** Sets one drive to an absolute value (inspector fields). */
export function setDriveOps(doc: Doc, hd: HandleDrives, drive: Drive, value: number): Op[] {
  return driveOps(doc, hd.part.id, [{ drive, delta: Math.round(value) - drive.value }]);
}
