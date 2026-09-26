import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import type { CarcassParams } from '../plugins/generators/carcass';
import type { OutlineParams } from '../plugins/shapes/outline';
import { actionsFor } from './actions';
import { dragChanges, driveOps, handleDrives, setDriveOps } from './drives';
import { describeTarget, targetPoint, type Target } from './targets';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** Drags a handle by a part-local displacement and applies the result. */
function drag(doc: Doc, target: Target, disp: V3): { doc: Doc; ops: Op[] } {
  const hd = handleDrives(doc, target);
  if (!hd?.constraint) throw new Error(`${target.node}/${target.handle} isn't draggable`);
  const ops = driveOps(doc, hd.part.id, dragChanges(hd, disp));
  return { doc: ok(doc, ops), ops };
}

const carcass = (d: Doc) => d.assemblies.a1!.generator!.params as unknown as CarcassParams;
const W = inches(36);
const T = 46;

describe('push/pull on a generated cabinet', () => {
  it('pulling the right side out widens the cabinet', () => {
    const { doc, ops } = drag(demoDoc(), { node: 'a1.side-right', handle: 'face:right' }, [inches(6), 0, 0]);
    expect(ops).toEqual([{ op: 'update', id: 'a1', patch: { params: { width: inches(42) } } }]);
    expect(carcass(doc).width).toBe(inches(42));
    expect(doc.parts['a1.side-right']!.transform.position[0]).toBe(inches(42) - T);
    expect(doc.assemblies.a1!.transform.position).toEqual([0, 0, 0]);
    // The side's through hole and shelf pins came along (they're overrides on the part).
    expect(doc.parts['a1.side-right']!.features).toHaveLength(27);
  });

  it('pulling the left side out widens it leftward, keeping the right side put', () => {
    const { doc } = drag(demoDoc(), { node: 'a1.side-left', handle: 'face:left' }, [-inches(2), 0, 0]);
    expect(carcass(doc).width).toBe(inches(38));
    expect(doc.assemblies.a1!.transform.position).toEqual([-inches(2), 0, 0]);
  });

  it('top, back and toe kick faces drive height, depth and the kick', () => {
    expect(carcass(drag(demoDoc(), { node: 'a1.top', handle: 'face:top' }, [0, inches(1), 0]).doc).height).toBe(inches(35.5));
    const deeper = drag(demoDoc(), { node: 'a1.back', handle: 'face:back' }, [0, 0, -inches(1)]).doc;
    expect(carcass(deeper).depth).toBe(inches(25));
    expect(deeper.assemblies.a1!.transform.position).toEqual([0, 0, -inches(1)]);
    const kick = drag(demoDoc(), { node: 'a1.kick', handle: 'face:front' }, [0, 0, inches(1)]).doc;
    expect(carcass(kick).toeKick).toEqual({ height: inches(4), depth: inches(2) });
  });

  it('an inner face the generator does not claim becomes an override', () => {
    const { doc } = drag(demoDoc(), { node: 'a1.shelf-1', handle: 'face:front' }, [0, 0, -inches(1)]);
    expect(carcass(doc)).toEqual(carcass(demoDoc()));
    expect(doc.assemblies.a1!.generator!.overrides['shelf-1']).toMatchObject({ shape: { z: expect.any(Number) } });
  });

  it('refuses a drag that breaks the generator (the op fails, nothing changes)', () => {
    const d = demoDoc();
    const hd = handleDrives(d, { node: 'a1.side-right', handle: 'face:right' })!;
    const r = applyOps(d, driveOps(d, 'a1.side-right', dragChanges(hd, [-inches(34), 0, 0])));
    expect(r.ok).toBe(false);
  });
});

describe('direct edits on plain parts', () => {
  it('pulls a min-side face: grows the box and moves it so the far side stays', () => {
    const d0 = demoDoc();
    const { doc } = drag(d0, { node: 'door', handle: 'face:left' }, [-inches(1), 0, 0]);
    expect(doc.parts.door!.shape.params.x).toBe(inches(18.75));
    expect(doc.parts.door!.transform.position[0]).toBe(d0.parts.door!.transform.position[0] - inches(1));
  });

  it('drags an outline point, re-basing the outline when it goes below 0', () => {
    const d0 = demoDoc();
    const hd = handleDrives(d0, { node: 'tabletop', handle: 'vertex:top-bl' })!;
    expect(hd.constraint?.kind).toBe('plane');
    const { doc } = drag(d0, { node: 'tabletop', handle: 'vertex:top-bl' }, [-inches(1), 0, -inches(1)]);
    const pts = (doc.parts.tabletop!.shape.params as unknown as OutlineParams).points;
    expect(pts[0]!.at).toEqual([0, 0]);
    expect(pts[1]!.at).toEqual([inches(37.5) + inches(1), inches(1)]);
    const p0 = d0.parts.tabletop!.transform.position;
    expect(doc.parts.tabletop!.transform.position).toEqual([p0[0] - inches(1), p0[1], p0[2] - inches(1)]);
  });

  it('pushes an outline side along its normal, moving both end points', () => {
    const { doc } = drag(demoDoc(), { node: 'tabletop', handle: 'face:side-br' }, [inches(2), 0, 0]);
    const pts = (doc.parts.tabletop!.shape.params as unknown as OutlineParams).points;
    expect(pts[1]!.at[0]).toBe(inches(39.5));
    expect(pts[2]!.at[0]).toBe(inches(39.5));
    expect(pts[0]!.at[0]).toBe(0);
  });

  it('moves a hole by its center and changes its depth by its floor', () => {
    const moved = drag(demoDoc(), { node: 'door', handle: 'f2:center' }, [0, inches(1), 0]).doc;
    expect(moved.parts.door!.features.find((f) => f.id === 'f2')!.params.at).toEqual([57, inches(4)]);
    const shallower = drag(demoDoc(), { node: 'door', handle: 'f2:floor' }, [0, 0, -8]).doc;
    expect(shallower.parts.door!.features.find((f) => f.id === 'f2')!.params.depth).toBe(inches(3 / 8));
  });

  it('sets radial params numerically', () => {
    const d = demoDoc();
    const hd = handleDrives(d, { node: 'tabletop', handle: 'f1:edge:top-bl' })!;
    expect(hd.constraint).toBeNull();
    expect(hd.drives.map((x) => [x.label, x.value])).toEqual([['radius', inches(1 / 4)]]);
    const doc = ok(d, setDriveOps(d, hd, hd.drives[0]!, inches(3 / 8)));
    expect(doc.parts.tabletop!.features[0]!.params.r).toBe(inches(3 / 8));
  });
});

describe('selection actions', () => {
  const run = (doc: Doc, targets: Target[], id: string, values: Record<string, number | null> = {}) => {
    const a = actionsFor(doc, targets).find((x) => x.id === id);
    if (!a) throw new Error(`no action ${id}; have ${actionsFor(doc, targets).map((x) => x.id).join(', ')}`);
    const defaults = Object.fromEntries(a.fields.map((f) => [f.key, f.value]));
    return ok(doc, a.run({ ...defaults, ...values }));
  };

  it('drills where the face was clicked', () => {
    const doc = run(demoDoc(), [{ node: 'door', handle: 'face:front', at: [inches(5), inches(10) + 1, 46] }], 'hole', { d: inches(1) });
    expect(doc.parts.door!.features.at(-1)).toMatchObject({ type: 'hole', params: { face: 'face:front', at: [inches(5), inches(10)], d: inches(1) } });
    expect(doc.parts.door!.features.at(-1)!.params.depth).toBeUndefined();
  });

  it('pockets a face', () => {
    const doc = run(demoDoc(), [{ node: 'door', handle: 'face:front', at: [inches(8), inches(15), 46] }], 'pocket');
    expect(doc.parts.door!.features.at(-1)).toMatchObject({ type: 'pocket', params: { size: [inches(2), inches(1)], depth: inches(1 / 4) } });
  });

  it('profiles selected edges, replacing an existing profile on them', () => {
    const edges: Target[] = ['edge:top-front', 'edge:front-left'].map((handle) => ({ node: 'door', handle }));
    const doc = run(demoDoc(), edges, 'chamfer', { r: inches(1 / 8) });
    const profiles = doc.parts.door!.features.filter((f) => f.type === 'edgeProfile');
    expect(profiles.map((f) => f.params.edges)).toEqual([['edge:bottom-front', 'edge:front-right'], ['edge:top-front', 'edge:front-left']]);
    expect(profiles[1]!.params).toMatchObject({ profile: 'chamfer', r: inches(1 / 8) });
  });

  it('rounds and clips corners', () => {
    const door = run(demoDoc(), [{ node: 'door', handle: 'vertex:top-front-left' }], 'round-corner');
    expect(door.parts.door!.features.at(-1)!.params).toMatchObject({ edges: ['edge:top-left'], profile: 'roundover', r: inches(1 / 2) });
    const top = run(demoDoc(), [{ node: 'tabletop', handle: 'vertex:top-bl' }], 'corner-radius', { r: inches(2) });
    expect((top.parts.tabletop!.shape.params as unknown as OutlineParams).points[0]!.r).toBe(inches(2));
  });

  it('deletes parts and removes features', () => {
    expect(run(demoDoc(), [{ node: 'door' }], 'delete').parts.door).toBeUndefined();
    const doc = run(demoDoc(), [{ node: 'door', handle: 'f2:wall' }], 'remove-feature');
    expect(doc.parts.door!.features.map((f) => f.id)).toEqual(['f1', 'f3']);
  });
});

describe('targets', () => {
  it('locates and names targets, including stale ones', () => {
    const d = demoDoc();
    expect(targetPoint(d, { node: 'a1.side-right', handle: 'face:right' })).toEqual([W, inches(34.5) / 2, inches(12)]);
    expect(targetPoint(d, { node: 'door', at: [0, 0, 0] })).toEqual(d.parts.door!.transform.position);
    expect(describeTarget(d, { node: 'a1.top', handle: 'face:top' })).toBe('Top · face:top');
    expect(describeTarget(d, { node: 'gone' })).toBe('(missing gone)');
    expect(targetPoint(d, { node: 'gone' })).toBeNull();
  });
});

describe('joint actions', () => {
  it('offers a dado / rabbet between two touching parts, housing = the partly covered one, then removal', () => {
    const add = (id: string, position: V3, size: V3): Op => ({
      op: 'add',
      entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position, rotation: [0, 0, 0] }, shape: { type: 'box', params: { x: size[0], y: size[1], z: size[2] } } },
    });
    const r = applyOps(emptyDoc(), [add('shelf', [46, 640, 0], [1280, 46, 768]), add('side', [0, 0, 0], [46, 1920, 768])]);
    if (!r.ok) throw new Error(r.error);
    const acts = actionsFor(r.doc, [{ node: 'shelf' }, { node: 'side' }]);
    const dado = acts.find((a) => a.id === 'dado')!;
    expect(dado.label).toBe('Dado shelf into side');
    const joined = applyOps(r.doc, dado.run({ depth: 16 }));
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.doc.parts.side!.joinery).toHaveLength(1);
    expect(actionsFor(joined.doc, [{ node: 'side' }, { node: 'shelf' }]).map((a) => a.label)).toContain('Remove dado joint');
    expect(actionsFor(r.doc, [{ node: 'shelf' }, { node: 'side' }]).some((a) => a.id === 'rabbet')).toBe(true);
  });
});
