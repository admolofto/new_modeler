import { describe, expect, it } from 'vitest';
import '../plugins';
import type { V3 } from '../geometry/types';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { EYE_HEIGHT } from './room';
import type { Doc, View, ViewFrom } from './schema';
import { inches } from './units';
import { FROM, motionPlan, viewCamera, viewMotions, WALL_MARGIN } from './views';
import { worldBoxes } from './world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

const base = () =>
  ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [inches(6), inches(6)], doors: 2 } } } }]);
const v = (o: Partial<View>): View => ({ id: 'v', name: 'V', ...o }) as View;
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return a.map((c) => c / l) as V3;
};

describe('viewMotions', () => {
  const d = base();
  it('keeps motion ids and expands node ids to the motions moving parts inside them', () => {
    expect(viewMotions(d, v({ open: ['a1'] })).sort()).toEqual(['a1.motion.door-left', 'a1.motion.door-right', 'a1.motion.drawer-1', 'a1.motion.drawer-2']);
    expect(viewMotions(d, v({ open: ['a1.drawer-1'] }))).toEqual(['a1.motion.drawer-1']);
    // A door part inside the folder its motion moves.
    expect(viewMotions(d, v({ open: ['a1.door-left'] }))).toEqual(['a1.motion.door-left']);
    expect(viewMotions(d, v({ open: ['a1.motion.drawer-2', 'a1.drawer-2'] }))).toEqual(['a1.motion.drawer-2']);
    expect(viewMotions(d, v({ open: ['a1.side-left'] }))).toEqual([]);
    expect(viewMotions(d, v({}))).toEqual([]);
  });

  it('plans a flight: close what the view does not open at the start, open the rest halfway', () => {
    expect(motionPlan(['a', 'b'], ['b', 'c'])).toEqual({ close: ['a'], open: ['c'] });
  });
});

describe('viewCamera', () => {
  it('returns a camera as is', () => {
    const camera = { position: [1, 2, 3] as V3, target: [0, 0, 0] as V3, fov: 40 };
    expect(viewCamera(base(), v({ camera }), 1.5)).toBe(camera);
  });

  it('fits the bounding sphere from each direction', () => {
    const d = base();
    const box = worldBoxes(d).get('a1')!;
    const center: V3 = [0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2) as V3;
    const r = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
    for (const from of Object.keys(FROM) as ViewFrom[]) {
      if (from === 'eye') continue;
      const cam = viewCamera(d, v({ frame: { nodes: ['a1'], from } }), 16 / 9);
      expect(cam.target).toEqual(center);
      const off: V3 = [cam.position[0] - center[0], cam.position[1] - center[1], cam.position[2] - center[2]];
      const dist = Math.hypot(...off);
      // The sphere fits the vertical field of view (the narrower one at 16:9).
      expect(r / dist).toBeLessThanOrEqual(Math.sin((cam.fov / 2) * (Math.PI / 180)) + 1e-9);
      const { azimuth, elevation } = FROM[from];
      const want: V3 = [Math.cos((elevation * Math.PI) / 180) * Math.sin((azimuth * Math.PI) / 180), Math.sin((elevation * Math.PI) / 180), Math.cos((elevation * Math.PI) / 180) * Math.cos((azimuth * Math.PI) / 180)];
      unit(off).forEach((c, i) => expect(c).toBeCloseTo(want[i]!, 6));
    }
  });

  it('frames the whole model by default, and honours an explicit angle and distance', () => {
    const d = base();
    const cam = viewCamera(d, v({ frame: { nodes: [], from: 'front', azimuth: 90, elevation: 0, distance: inches(100) } }), 1);
    expect(cam.position[0] - cam.target[0]).toBeCloseTo(inches(100));
    expect(cam.position[1]).toBeCloseTo(cam.target[1]);
  });

  it('stands at the eye height for an eye-level shot', () => {
    const cam = viewCamera(base(), v({ frame: { nodes: ['a1'], from: 'eye' }, mode: 'walk' }), 1.5);
    expect(cam.position[1]).toBe(EYE_HEIGHT);
    expect(cam.fov).toBe(60);
  });

  it('stays inside a room with a front wall, and out of cabinets', () => {
    const d = ok(base(), [
      { op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: -inches(36), right: inches(72), back: 0, front: inches(72), height: inches(96) } } } },
      { op: 'add', entity: { kind: 'block', id: 'island', transform: { position: [-inches(12), 0, inches(40)] }, size: [inches(60), inches(36), inches(24)] } },
    ]);
    for (const from of Object.keys(FROM) as ViewFrom[]) {
      const cam = viewCamera(d, v({ frame: { nodes: ['a1'], from, distance: inches(400) } }), 1.5);
      const p = cam.position;
      expect(p[2]).toBeLessThanOrEqual(inches(72) - WALL_MARGIN + 1e-6);
      expect(p[0]).toBeGreaterThanOrEqual(-inches(36) + WALL_MARGIN - 1e-6);
      expect(p[0]).toBeLessThanOrEqual(inches(72) - WALL_MARGIN + 1e-6);
      expect(p[1]).toBeLessThanOrEqual(inches(96) - WALL_MARGIN + 1e-6);
    }
    // In front of the cabinet, 40" off: right in the island, so it's raised over it.
    const cam = viewCamera(d, v({ frame: { nodes: ['a1'], from: 'front', distance: inches(40) } }), 1.5);
    expect(cam.position[1]).toBeGreaterThanOrEqual(inches(36) + WALL_MARGIN);
    // At eye height it slides toward what it looks at until it's clear of the island.
    const eye = viewCamera(d, v({ frame: { nodes: ['a1'], from: 'eye', azimuth: 0, distance: inches(40) } }), 1.5);
    expect(eye.position[1]).toBe(EYE_HEIGHT);
    // (62" is over the 36" island: nothing to slide past.)
    expect(eye.position[2]).toBeGreaterThan(inches(40));
  });
});
