import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../../plugins';
import type { V3 } from '../../geometry/types';
import { DEFAULT_CARCASS, emptyDoc } from '../../model/defaults';
import { applyOps, type Op } from '../../model/ops';
import type { Doc } from '../../model/schema';
import { inches } from '../../model/units';
import { sceneLights } from '../../model/look';
import {
  autoFixtures,
  autoSun,
  CALIBRATION,
  DEFAULT_SUN,
  fitOrtho,
  fixtureIntensity,
  fixturesFrom,
  kelvinToRGB,
  lightDir,
  planLights,
  PRESET_IDS,
  PRESETS,
  presetExposure,
  resolvePreset,
  underCabinetOn,
  underCabinetStrips,
  type FixtureLight,
} from './lightPlan';

describe('fitOrtho', () => {
  const box = { min: [-10, 0, -12] as V3, max: [50, 36, 24] as V3 };
  const dir = lightDir(35, 50);

  /** A shadow camera set up as three's DirectionalLight would. */
  const cam = (b = box, d = dir, floorShadows = true) => {
    const f = fitOrtho(d, b, { floorShadows });
    const c = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, f.near, f.far);
    c.position.set(...f.position);
    c.lookAt(new THREE.Vector3(...f.target));
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  const inside = (c: THREE.Camera, p: V3) => {
    const q = new THREE.Vector3(...p).project(c);
    return Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1 && q.z >= -1 && q.z <= 1;
  };
  const corners = (b: { min: V3; max: V3 }): V3[] =>
    Array.from({ length: 8 }, (_, i) => [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);

  it('sees every corner of the box', () => {
    const c = cam();
    for (const p of corners(box)) expect(inside(c, p)).toBe(true);
  });

  it('contains a room for a low sun, without the floor-shadow reach', () => {
    const room = { min: [-6, -1.5, -6] as V3, max: [186, 97.5, 150] as V3 };
    const low = lightDir(-155, 6);
    const tight = fitOrtho(low, room, { floorShadows: false });
    const loose = fitOrtho(low, room);
    for (const p of corners(room)) expect(inside(cam(room, low, false), p)).toBe(true);
    expect(tight.far - tight.near).toBeLessThan(loose.far - loose.near);
  });

  it('reaches the shadows thrown on the floor', () => {
    const c = cam();
    // The top back corner's shadow: down the light's direction to y = 0.
    const top: V3 = [-10, 36, -12];
    const k = 36 / dir[1];
    expect(inside(c, [top[0] - dir[0] * k, 0, top[2] - dir[2] * k])).toBe(true);
  });

  it('has its near plane in front of the camera and the light above the model', () => {
    const f = fitOrtho(dir, box);
    expect(f.near).toBeGreaterThan(0);
    expect(f.far).toBeGreaterThan(f.near);
    expect(f.position[1]).toBeGreaterThan(box.max[1]);
    expect(f.target).toEqual([20, 18, 6]);
  });

  it('copes with a light straight above', () => {
    const f = fitOrtho([0, 1, 0], box);
    expect(f.right - f.left).toBeGreaterThanOrEqual(36);
    expect(f.top - f.bottom).toBeGreaterThanOrEqual(36);
  });

  it('turns azimuth and elevation into a direction', () => {
    expect(lightDir(0, 0).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);
    expect(lightDir(90, 0)[0]).toBeCloseTo(1);
    expect(lightDir(35, 50)[1]).toBeCloseTo(Math.sin((50 * Math.PI) / 180));
  });
});

describe('kelvinToRGB', () => {
  it('matches the blackbody fit at reference temperatures', () => {
    const [r, g, b] = kelvinToRGB(2700);
    expect(r).toBe(1);
    expect(g).toBeCloseTo(0.654, 2);
    expect(b).toBeCloseTo(0.343, 2);
    expect(kelvinToRGB(6600).every((c) => c > 0.99)).toBe(true);
    // Cooler is bluer.
    expect(kelvinToRGB(3000)[2]).toBeGreaterThan(kelvinToRGB(2700)[2]);
    expect(kelvinToRGB(10000)[0]).toBeLessThan(1);
  });
});

describe('fixtureIntensity', () => {
  it('lights a surface 60" under a 650 lm downlight at 2/3 of the Day sun', () => {
    const cd = fixtureIntensity({ kind: 'spot', lumens: CALIBRATION.lumens, beam: CALIBRATION.beam });
    // three: illuminance = candela / distance² (decay 2), the sun's = its intensity.
    expect(cd / CALIBRATION.distance ** 2).toBeCloseTo((2 / 3) * PRESETS.day.sun.intensity, 6);
  });

  it('scales with lumens and narrows with the beam; points spread over the sphere', () => {
    const spot = (lumens: number, beam = 60) => fixtureIntensity({ kind: 'spot', lumens, beam });
    expect(spot(1300)).toBeCloseTo(2 * spot(650));
    expect(spot(650, 30)).toBeGreaterThan(spot(650, 60));
    const point = fixtureIntensity({ kind: 'point', lumens: 800 });
    // A 360° "spot" is a point light.
    expect(spot(800, 360)).toBeCloseTo(point, 6);
  });

  it('gives area lights a luminance that falls with their size', () => {
    const a = fixtureIntensity({ kind: 'area', lumens: 600, size: [24, 1] });
    const b = fixtureIntensity({ kind: 'area', lumens: 600, size: [48, 1] });
    expect(a).toBeCloseTo(2 * b);
  });
});

describe('planLights', () => {
  const spot = (x: number, z: number, lumens = 650): FixtureLight => ({ kind: 'spot', at: [x, 96, z], dir: [0, -1, 0], lumens, kelvin: 3000, beam: 60 });

  it('keeps everything within budget', () => {
    const lights = [spot(0, 0), spot(10, 0)];
    expect(planLights(lights, 8)).toHaveLength(2);
    expect(planLights(lights, 8)[0]!.count).toBe(1);
  });

  it('merges the nearest pair of a kind first, keeping the lumens', () => {
    const lights = [spot(0, 0), spot(6, 0), spot(100, 0), spot(200, 0)];
    const out = planLights(lights, 3);
    expect(out).toHaveLength(3);
    const merged = out.find((l) => l.count === 2)!;
    expect(merged.at[0]).toBeCloseTo(3);
    expect(merged.lumens).toBe(1300);
    expect(merged.beam).toBeGreaterThan(60);
    expect(out.reduce((s, l) => s + l.lumens, 0)).toBe(4 * 650);
  });

  it('respects any budget, merging only within a kind', () => {
    const lights: FixtureLight[] = [...Array.from({ length: 12 }, (_, i) => spot((i % 4) * 30, Math.floor(i / 4) * 30)), { kind: 'point', at: [0, 60, 0], lumens: 800, kelvin: 2700 }];
    for (const budget of [12, 8, 4, 2, 1]) {
      const out = planLights(lights, budget);
      expect(out.length).toBeLessThanOrEqual(budget);
    }
    // At 2: the spots merge into one; the point stays.
    const two = planLights(lights, 2);
    expect(two.map((l) => l.kind).sort()).toEqual(['point', 'spot']);
    expect(two.find((l) => l.kind === 'spot')!.count).toBe(12);
    // At 1, nothing of the point's kind to merge with: the dimmer light goes.
    expect(planLights(lights, 1).map((l) => l.kind)).toEqual(['spot']);
    expect(planLights(lights, 0)).toEqual([]);
  });

  it('places the stand-in ceiling spots inside the room, pointing down', () => {
    const room = { min: [0, 0, 0] as V3, max: [120, 96, 144] as V3 };
    const spots = autoFixtures(room);
    expect(spots).toHaveLength(4);
    for (const s of spots) {
      expect(s.at[0]).toBeGreaterThan(0);
      expect(s.at[0]).toBeLessThan(120);
      expect(s.at[1]).toBeLessThan(96);
      expect(s.dir).toEqual([0, -1, 0]);
    }
  });
});

describe('autoSun', () => {
  it('shines in through the largest window, turned 25°, 35° up', () => {
    const sun = autoSun([
      { outward: [1, 0, 0], area: 100 },
      { outward: [0, 0, -1], area: 400 },
    ]);
    expect(sun.elevation).toBe(35);
    // The back window faces −Z (azimuth 180°): turned 25° → −155°.
    expect(sun.azimuth).toBeCloseTo(-155);
    const d = lightDir(sun.azimuth, sun.elevation);
    // The light comes from outside that window.
    expect(d[2]).toBeLessThan(0);
  });

  it('turns toward the middle of the room, not into a side wall', () => {
    const back = { center: [60, 60, 0] as V3, outward: [0, 0, -1] as V3, area: 100 };
    // The room's middle to the right of the window: sunlight heads right (+X), so it comes from the left.
    const right = autoSun([back], [100, 0, 50]);
    const left = autoSun([back], [20, 0, 50]);
    expect(right.azimuth).not.toBeCloseTo(left.azimuth);
    const travel = (s: { azimuth: number; elevation: number }) => -lightDir(s.azimuth, s.elevation)[0];
    expect(travel(right)).toBeGreaterThan(0);
    expect(travel(left)).toBeLessThan(0);
  });

  it('has a default without windows', () => {
    expect(autoSun([])).toEqual(DEFAULT_SUN);
  });
});

describe('presets', () => {
  it('define everything the rig needs', () => {
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.exposure).toBeGreaterThan(0);
      expect(p.env.intensity).toBeGreaterThan(0);
      expect(p.sun.intensity).toBeGreaterThanOrEqual(0);
      expect(p.sun.elevation).toBeGreaterThanOrEqual(0);
      for (const c of [p.sun.color, p.hemi.sky, p.hemi.ground, p.ground, p.horizon, ...(p.sky ? [p.sky.tint] : [])]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.fixtures).toBeGreaterThanOrEqual(0);
      expect(p.fixtures).toBeLessThanOrEqual(1);
      expect(p.bloom).toBeGreaterThanOrEqual(0);
    }
    expect(PRESETS.studio.room).toBe(false);
    expect(PRESETS.studio.sky).toBeNull();
    expect(PRESETS.studio.sun.azimuth).toBeDefined();
    expect(PRESETS.studio.bloom).toBe(0);
    expect(PRESETS.night.sun.intensity).toBe(0);
    expect(PRESETS.day.fixtures).toBe(0);
    for (const id of ['day', 'evening', 'night'] as const) {
      expect(PRESETS[id].sky).not.toBeNull();
      expect(PRESETS[id].env.source).toBe('probe');
    }
  });

  it('resolves auto: the studio without a room, day with one', () => {
    expect(resolvePreset(undefined, false)).toBe('studio');
    expect(resolvePreset(undefined, true)).toBe('day');
    expect(resolvePreset({ preset: 'auto' }, true)).toBe('day');
    expect(resolvePreset({ preset: 'night' }, false)).toBe('night');
  });

  it('applies the brightness in stops, and the under-cabinet default', () => {
    expect(presetExposure('evening', 1)).toBeCloseTo(PRESETS.evening.exposure * 2);
    expect(presetExposure('day', -1)).toBeCloseTo(0.5);
    expect(underCabinetOn('evening', undefined)).toBe(true);
    expect(underCabinetOn('day', undefined)).toBe(false);
    expect(underCabinetOn('day', { preset: 'day', underCabinet: true })).toBe(true);
    expect(underCabinetOn('studio', { preset: 'studio', underCabinet: true })).toBe(false);
  });
});

describe('underCabinetStrips', () => {
  function ok(doc: Doc, ops: Op[]): Doc {
    const r = applyOps(doc, ops);
    if (!r.ok) throw new Error(r.error);
    return r.doc;
  }
  const wall = { height: inches(30), depth: inches(12), toeKick: null, shelves: 1 };
  const cab = (id: string, position: V3, params: Record<string, unknown> = wall, rotation: V3 = [0, 0, 0]): Op => ({
    op: 'add',
    entity: { kind: 'assembly', id, name: id, transform: { position, rotation }, generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, ...params } } },
  });

  it('puts one strip under each run of wall cabinets, none under base cabinets', () => {
    const d = ok(emptyDoc(), [
      cab('base', [0, 0, 0], {}),
      cab('w1', [0, inches(54), 0]),
      cab('w2', [inches(36), inches(54), 0]),
      // Apart from the run: its own strip.
      cab('w3', [inches(120), inches(54), 0]),
    ]);
    const strips = underCabinetStrips(d);
    expect(strips).toHaveLength(2);
    const [long, short] = strips;
    expect(long!.length).toBeCloseTo(72 - 2);
    expect(long!.center[0]).toBeCloseTo(36);
    expect(long!.center[1]).toBeLessThan(54);
    expect(long!.center[1]).toBeGreaterThan(53);
    expect(long!.front).toEqual([0, 0, 1]);
    // Near the front, under the cabinet.
    expect(long!.center[2]).toBeGreaterThan(6);
    expect(long!.center[2]).toBeLessThan(13.5);
    expect(long!.lumens).toBeCloseTo(300 * (70 / 12));
    expect(short!.length).toBeCloseTo(34);
  });

  it('follows a turned run, and keeps at most four', () => {
    const turned = ok(emptyDoc(), [cab('w1', [0, inches(54), inches(36)], wall, [0, 90, 0]), cab('w2', [0, inches(54), inches(72)], wall, [0, 90, 0])]);
    const [s] = underCabinetStrips(turned);
    expect(s!.front).toEqual([1, 0, 0]);
    expect(s!.along).toEqual([0, 0, 1]);
    expect(s!.length).toBeCloseTo(70);
    const many = ok(
      emptyDoc(),
      Array.from({ length: 6 }, (_, i) => cab(`w${i}`, [inches(i * 60), inches(54), 0])),
    );
    expect(underCabinetStrips(many)).toHaveLength(4);
  });
});

describe('fixtures from the scene (phase 7)', () => {
  it('maps sceneLights to lights in inches: spots, points and areas with their direction and size', () => {
    const r = applyOps(emptyDoc(), [
      { op: 'add', entity: { kind: 'decor', id: 'pend', transform: { position: [inches(30), inches(66), inches(10)] }, shape: { type: 'pendant', params: { shade: 'globe' } } } },
      { op: 'add', entity: { kind: 'decor', id: 'strip', transform: { position: [0, inches(54), 0], rotation: [0, 90, 0] }, shape: { type: 'stripLight', params: { length: inches(36) } } } },
      { op: 'add', entity: { kind: 'decor', id: 'can', transform: { position: [inches(60), inches(96), inches(60)] }, shape: { type: 'recessedLight', params: {} } } },
    ]);
    if (!r.ok) throw new Error(r.error);
    const d = r.doc;
    const lights = fixturesFrom(sceneLights(d));
    const [pend, strip, can] = lights;
    expect(pend).toMatchObject({ kind: 'point', lumens: 800, kelvin: 2700 });
    expect(pend!.at[1]).toBeGreaterThan(66);
    expect(pend!.at[1]).toBeLessThan(96);
    expect(strip).toMatchObject({ kind: 'area', size: [36, 1], lumens: 900 });
    // Turned a quarter about Y: it runs along −Z now, still shining down.
    expect(strip!.along!.map((c) => Math.round(c))).toEqual([0, 0, -1]);
    expect(strip!.dir!.map((c) => Math.round(c))).toEqual([0, -1, 0]);
    expect(can).toMatchObject({ kind: 'spot', beam: 60, lumens: 650 });
    expect(can!.at[1]).toBeCloseTo(96 + 3 / 64, 6);
    // Planned into a budget: kinds merge only with their own kind.
    const many = [...lights, ...lights.map((l) => ({ ...l, at: [l.at[0] + 6, l.at[1], l.at[2]] as V3 }))];
    const plan = planLights(many, 3);
    expect(plan.map((l) => l.kind).sort()).toEqual(['area', 'point', 'spot']);
    expect(plan.find((l) => l.kind === 'area')!.along).toBeDefined();
  });
});
