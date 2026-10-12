import type { V3 } from '../../geometry/types';
import { descendants } from '../../model/doc';
import type { Doc, Lighting } from '../../model/schema';
import { inches } from '../../model/units';
import { hiddenNodes } from '../../model/visibility';
import { nodeAffine, rotate, union, worldBoxes } from '../../model/world';

/**
 * Light planning for presentation (pure, inches). Phase 3 has the key light's shadow fit, phase 4
 * `kelvinToRGB` (glowing finishes); phase 6 adds the lighting presets, fixture intensities,
 * `planLights`, `autoSun`, under-cabinet strips and the stand-in ceiling spots.
 */

export interface Bounds {
  min: V3;
  max: V3;
}

/**
 * An orthographic shadow camera for a directional light: placed along `dir` (pointing from the model
 * toward the light) and looking at the box's center, sized to the box seen from the light, with a
 * depth range reaching the shadows the box throws onto the floor at its min Y (`floorShadows: false`
 * when the floor is inside the box anyway — a room — which keeps a low sun's depth range tight).
 */
export interface OrthoFit {
  position: V3;
  target: V3;
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function fitOrtho(dir: V3, box: Bounds, o: { floorShadows?: boolean } = {}): OrthoFit {
  const z = norm(dir);
  // The camera's axes as three's lookAt makes them (up = +Y unless the light is straight above).
  const up: V3 = Math.abs(z[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const c: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const pad = Math.max(1, diag * 0.04);

  let [l, r, b, t] = [Infinity, -Infinity, Infinity, -Infinity];
  /** The nearest and farthest depths toward the light (along `z`). */
  let [hi, lo] = [-Infinity, Infinity];
  for (let i = 0; i < 8; i++) {
    const p: V3 = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
    const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    l = Math.min(l, dot(d, x));
    r = Math.max(r, dot(d, x));
    b = Math.min(b, dot(d, y));
    t = Math.max(t, dot(d, y));
    hi = Math.max(hi, dot(d, z));
    lo = Math.min(lo, dot(d, z));
    // Where this corner's shadow lands on the floor: the same spot seen from the light, only deeper.
    if (o.floorShadows !== false && z[1] > 0.05) {
      const h = p[1] - box.min[1];
      lo = Math.min(lo, dot(d, z) - h / z[1]);
    }
  }
  // The camera sits just past the nearest point.
  const dist = hi + pad * 2;
  return {
    position: [c[0] + z[0] * dist, c[1] + z[1] * dist, c[2] + z[2] * dist],
    target: c,
    left: l - pad,
    right: r + pad,
    bottom: b - pad,
    top: t + pad,
    near: pad,
    far: dist - lo + pad,
  };
}

/** A direction toward the light from azimuth (0 = front, +Z; positive turns toward +X) and elevation, degrees. */
export function lightDir(azimuth: number, elevation: number): V3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * A light's color at `kelvin` as a camera white-balanced to `balance` sees it: linear RGB, its
 * brightest channel 1. A 2700 K bulb under a 4000 K balance reads warm, not orange.
 */
export function balancedKelvin(kelvin: number, balance: number): V3 {
  const [a, b] = [kelvinToRGB(kelvin).map(toLinear), kelvinToRGB(balance).map(toLinear)];
  const c = a.map((v, i) => v / Math.max(1e-4, b[i]!));
  const max = Math.max(...c);
  return c.map((v) => v / max) as V3;
}

/**
 * A light's color at a color temperature (kelvin, 1000–40000), sRGB 0…1 with its brightest channel
 * at 1 — Tanner Helland's fit to the blackbody curve. 6500 K is about white; 2700 K a warm bulb.
 */
export function kelvinToRGB(kelvin: number): V3 {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((c) => Math.min(255, Math.max(0, c)) / 255) as V3;
}

// ── Presets (B7) ─────────────────────────────────────────────────────────

/** A lighting preset as drawn: `auto` resolves to one of these. */
export type PresetId = 'studio' | 'day' | 'evening' | 'night';
export const PRESET_IDS: readonly PresetId[] = ['studio', 'day', 'evening', 'night'];

export interface SkySpec {
  /** Preetham sky (three's Sky.js) parameters. */
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  cloudCoverage: number;
  /** The sky's own sun elevation (degrees) when it differs from the light's (night: below the horizon). */
  elevation?: number;
  /** A multiplier on the sky's radiance, and a color added to it (linear): night's deep blue. */
  gain: number;
  tint: string;
}

export interface PresetSpec {
  /** Tone-mapping exposure (before the user's brightness). */
  exposure: number;
  /** The environment light: the studio's RoomEnvironment, or the probe (captured from the scene). */
  env: { source: 'studio' | 'probe'; intensity: number };
  /** The key light / sun. A fixed azimuth (the studio's) or, without one, the saved or automatic sun's. */
  sun: { intensity: number; color: string; elevation: number; azimuth?: number };
  /** A hemisphere fill (sky above, ground below). */
  hemi: { intensity: number; sky: string; ground: string };
  /** Ceiling fixtures (and glowing finishes) level, 0…1. */
  fixtures: number;
  /** Under-cabinet lights when the doc doesn't say. */
  underCabinet: boolean;
  /** The camera's white balance (kelvin): warm bulbs read warm, not orange (`balancedKelvin`). */
  whiteBalance: number;
  bloom: number;
  /** The sky outside, or none (the studio backdrop). */
  sky: SkySpec | null;
  /** The outdoor ground's color (unlit: shown as is, at the preset's exposure), and the haze it fades to far off. */
  ground: string;
  horizon: string;
  /** Whether the room shell shows (the studio hides it). */
  room: boolean;
}

/**
 * The presets (B7's table, tuned by eye on screen). They differ only in intensities and colors (and
 * what shows), never in the number of lights or which cast shadows, so switching never recompiles.
 */
export const PRESETS: Readonly<Record<PresetId, PresetSpec>> = {
  studio: {
    exposure: 1,
    env: { source: 'studio', intensity: 0.65 },
    sun: { intensity: 1.6, color: '#ffffff', elevation: 50, azimuth: 35 },
    hemi: { intensity: 0, sky: '#ffffff', ground: '#ffffff' },
    fixtures: 0,
    underCabinet: false,
    whiteBalance: 6500,
    bloom: 0,
    sky: null,
    ground: '#ebe9e5',
    horizon: '#ebe9e5',
    room: false,
  },
  day: {
    exposure: 1,
    env: { source: 'probe', intensity: 1 },
    sun: { intensity: 3, color: '#fff1de', elevation: 35 },
    hemi: { intensity: 1.2, sky: '#eef2fa', ground: '#c8b49c' },
    fixtures: 0,
    underCabinet: false,
    whiteBalance: 6500,
    bloom: 0.08,
    sky: { turbidity: 2.5, rayleigh: 1.2, mieCoefficient: 0.004, mieDirectionalG: 0.8, cloudCoverage: 0.3, gain: 0.5, tint: '#000000' },
    ground: '#8a8f7a',
    horizon: '#c4cdd6',
    room: true,
  },
  evening: {
    exposure: 1.1,
    env: { source: 'probe', intensity: 0.6 },
    sun: { intensity: 1.2, color: '#ffad66', elevation: 10 },
    hemi: { intensity: 0.12, sky: '#9fb2e0', ground: '#7a5f4c' },
    fixtures: 1,
    underCabinet: true,
    whiteBalance: 3300,
    bloom: 0.12,
    sky: { turbidity: 8, rayleigh: 2.5, mieCoefficient: 0.006, mieDirectionalG: 0.85, cloudCoverage: 0.25, gain: 0.5, tint: '#000000' },
    ground: '#4d463e',
    horizon: '#a08a7c',
    room: true,
  },
  night: {
    exposure: 1.6,
    env: { source: 'probe', intensity: 0.4 },
    sun: { intensity: 0, color: '#9bb0ff', elevation: 35 },
    hemi: { intensity: 0.04, sky: '#5a6c99', ground: '#3a3532' },
    fixtures: 1,
    underCabinet: true,
    whiteBalance: 3200,
    bloom: 0.25,
    sky: { turbidity: 2, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8, cloudCoverage: 0, elevation: -12, gain: 0, tint: '#060b1c' },
    ground: '#14151a',
    horizon: '#0c0f19',
    room: true,
  },
};

/** The preset drawn for the saved lighting: `auto` is the studio without a room, day with one. */
export function resolvePreset(lighting: Lighting | undefined, hasRoom: boolean): PresetId {
  const p = lighting?.preset ?? 'auto';
  return p === 'auto' ? (hasRoom ? 'day' : 'studio') : p;
}

/** The user's brightness (EV) on top of a preset's exposure. */
export const presetExposure = (id: PresetId, ev = 0): number => PRESETS[id].exposure * Math.pow(2, ev);

/** Whether the under-cabinet lights are on: as saved, else the preset's default (never in the studio). */
export const underCabinetOn = (id: PresetId, lighting: Lighting | undefined): boolean => id !== 'studio' && (lighting?.underCabinet ?? PRESETS[id].underCabinet);

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A light to place (inches; the model's `LightSpec` scaled 1/64, at world positions). */
export interface FixtureLight {
  kind: 'spot' | 'point' | 'area';
  at: V3;
  /** Where it points (spots, areas); straight down when absent. */
  dir?: V3;
  /** An area light's width direction (world x when absent). */
  along?: V3;
  /** An area light's width × height (inches). */
  size?: [number, number];
  lumens: number;
  kelvin: number;
  /** A spot's full beam angle (degrees). */
  beam?: number;
  /** How many fixtures it stands for (after merging). */
  count?: number;
}

/** in² per m²: falloff runs in inches, so a candela's illuminance at d inches is cd × 1550 / d². */
const IN2_PER_M2 = 1550;
/** The calibration point: a 650 lm, 60° downlight 60" above lights a surface at ⅔ of the Day sun. */
export const CALIBRATION = { lumens: 650, beam: 60, distance: 60, ofSun: 2 / 3 };
const DEFAULT_BEAM = 60;

const spotCandela = (lumens: number, beam: number) => lumens / (2 * Math.PI * (1 - Math.cos((beam * Math.PI) / 360)));

/** Scene units per real lux: the Day sun stands for direct sunlight indoors, so fixtures scale with it. */
export const FIXTURE_K = (CALIBRATION.ofSun * PRESETS.day.sun.intensity * CALIBRATION.distance ** 2) / (spotCandela(CALIBRATION.lumens, CALIBRATION.beam) * IN2_PER_M2);

/**
 * A fixture's three.js intensity: candela for spots (lm / 2π(1 − cos(θ/2))) and points (lm / 4π),
 * luminance for area lights (lm / π·area), × 1550 (inches) × `FIXTURE_K`.
 */
export function fixtureIntensity(spec: Pick<FixtureLight, 'kind' | 'lumens' | 'beam' | 'size'>): number {
  const k = IN2_PER_M2 * FIXTURE_K;
  if (spec.kind === 'spot') return spotCandela(spec.lumens, spec.beam ?? DEFAULT_BEAM) * k;
  if (spec.kind === 'point') return (spec.lumens / (4 * Math.PI)) * k;
  const [w, h] = spec.size ?? [1, 1];
  return (spec.lumens / (Math.PI * Math.max(1e-3, w * h))) * k;
}

const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function merge(a: FixtureLight, b: FixtureLight): FixtureLight {
  const lm = a.lumens + b.lumens || 1;
  const [wa, wb] = [a.lumens / lm, b.lumens / lm];
  const mix = (p: V3, q: V3): V3 => [p[0] * wa + q[0] * wb, p[1] * wa + q[1] * wb, p[2] * wa + q[2] * wb];
  const out: FixtureLight = { kind: a.kind, at: mix(a.at, b.at), lumens: a.lumens + b.lumens, kelvin: a.kelvin * wa + b.kelvin * wb, count: (a.count ?? 1) + (b.count ?? 1) };
  if (a.dir || b.dir) out.dir = norm(mix(a.dir ?? [0, -1, 0], b.dir ?? [0, -1, 0]));
  if (a.along) out.along = a.along;
  // The merged spot covers both: its beam widens by the angle between them, seen from 4' below.
  if (a.kind === 'spot') {
    const spread = (2 * Math.atan(Math.sqrt(dist2(a.at, b.at)) / 2 / 48) * 180) / Math.PI;
    out.beam = Math.min(160, Math.max(a.beam ?? DEFAULT_BEAM, b.beam ?? DEFAULT_BEAM) + spread);
  }
  if (a.size || b.size) out.size = [Math.max(a.size?.[0] ?? 0, b.size?.[0] ?? 0), Math.max(a.size?.[1] ?? 0, b.size?.[1] ?? 0)];
  return out;
}

/**
 * Fits fixtures into a light budget (a tier's `fixtures`): while there are too many, the nearest two
 * of one kind merge into one (lumens summed, placed at their lumen-weighted middle); when no two of a
 * kind are left to merge, the dimmest light goes.
 */
export function planLights(lights: readonly FixtureLight[], budget: number): FixtureLight[] {
  const out: FixtureLight[] = lights.map((l) => ({ ...l, count: l.count ?? 1 }));
  const max = Math.max(0, Math.floor(budget));
  while (out.length > max) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        if (out[i]!.kind !== out[j]!.kind) continue;
        const d = dist2(out[i]!.at, out[j]!.at);
        if (d < bestD) [bestD, best] = [d, [i, j]];
      }
    if (!best) {
      let dim = 0;
      for (let i = 1; i < out.length; i++) if (out[i]!.lumens < out[dim]!.lumens) dim = i;
      out.splice(dim, 1);
      continue;
    }
    const [i, j] = best;
    out[i] = merge(out[i]!, out[j]!);
    out.splice(j, 1);
  }
  return out;
}

/** A light the scene's fixtures give off (model/look.ts `sceneLights`: world, model units). */
export interface SceneFixture {
  at: V3;
  dir?: V3;
  along?: V3;
  spec: { kind: FixtureLight['kind']; size?: [number, number]; lumens: number; kelvin: number; beam?: number };
}

/** The scene's fixtures as lights to place: positions and sizes in inches (1/64), directions as they are. */
export function fixturesFrom(lights: readonly SceneFixture[]): FixtureLight[] {
  return lights.map(({ at, dir, along, spec }) => ({
    kind: spec.kind,
    at: [at[0] / 64, at[1] / 64, at[2] / 64],
    ...(dir && { dir: norm(dir) }),
    ...(along && { along: norm(along) }),
    ...(spec.size && { size: [spec.size[0] / 64, spec.size[1] / 64] as [number, number] }),
    lumens: spec.lumens,
    kelvin: spec.kelvin,
    ...(spec.beam !== undefined && { beam: spec.beam }),
  }));
}

/** The stand-ins for a room with no light fixtures of its own (no cans, pendants…): ceiling spots. */
export const AUTO_FIXTURE = { lumens: 800, kelvin: 2700, beam: 70 };

/** A 2 × 2 grid of ceiling spots inside a room (its inside box, inches), pointing down. */
export function autoFixtures(room: Bounds): FixtureLight[] {
  const out: FixtureLight[] = [];
  const y = room.max[1] - 1;
  for (const fx of [0.25, 0.75])
    for (const fz of [0.25, 0.75]) {
      const x = room.min[0] + (room.max[0] - room.min[0]) * fx;
      const z = room.min[2] + (room.max[2] - room.min[2]) * fz;
      out.push({ kind: 'spot', at: [x, y, z], dir: [0, -1, 0], ...AUTO_FIXTURE });
    }
  return out;
}

// ── The sun ──────────────────────────────────────────────────────────────

export interface SunAngles {
  azimuth: number;
  elevation: number;
}

/** The sun without a window to come through: front-right, like the studio's key. */
export const DEFAULT_SUN: SunAngles = { azimuth: 35, elevation: 35 };
/** How far the automatic sun turns off the window's axis, and its elevation (degrees). */
export const AUTO_SUN = { turn: 25, elevation: 35 };

/**
 * The sun for a room: shining in through its largest window — from outside along the window's
 * outward direction, turned 25° so the patch it throws rakes across the room — 35° up. Given the
 * room's middle, it turns the way that throws the patch toward the middle (not into a side wall).
 */
export function autoSun(windows: readonly { center?: V3; outward: V3; area: number }[], middle?: V3): SunAngles {
  if (!windows.length) return { ...DEFAULT_SUN };
  const w = windows.reduce((a, b) => (b.area > a.area ? b : a));
  const base = (Math.atan2(w.outward[0], w.outward[2]) * 180) / Math.PI;
  let turn = AUTO_SUN.turn;
  if (middle && w.center) {
    // Sunlight travels against the light's direction: from the window toward −lightDir.
    const toward = (t: number) => {
      const d = lightDir(base + t, 0);
      return -d[0] * (middle[0] - w.center![0]) - d[2] * (middle[2] - w.center![2]);
    };
    if (toward(-turn) > toward(turn) + 1e-9) turn = -turn;
  }
  const az = base + turn;
  return { azimuth: ((((az + 180) % 360) + 360) % 360) - 180, elevation: AUTO_SUN.elevation };
}

// ── Under-cabinet lights ─────────────────────────────────────────────────

/** An under-cabinet light strip (inches): under a run of wall cabinets, near their front, facing down. */
export interface Strip {
  center: V3;
  /** Its length along the run, and its width. */
  length: number;
  width: number;
  /** The run's direction (a world axis), and the cabinets' front. */
  along: V3;
  front: V3;
  lumens: number;
  kelvin: number;
}

/** Cabinets hung above this (model units) count as wall cabinets. */
const WALL_CABINET_MIN_Y = inches(30);
/** Lumens per foot, color, width and inset from the cabinets' front (inches), and the most strips placed. */
export const STRIP = { lumensPerFoot: 300, kelvin: 3000, width: 1, inset: 3.5, max: 4 };

/**
 * Light strips under the wall cabinets: carcasses whose bottom is above 30"; side-by-side ones
 * (same bottom, same front, touching) make one run and one strip; the four longest are kept.
 */
export function underCabinetStrips(doc: Doc): Strip[] {
  const hidden = hiddenNodes(doc);
  const boxes = worldBoxes(doc);
  const tol = inches(1);
  type Run = { ax: 0 | 2; sign: number; y: number; front: number; lo: number; hi: number };
  const runs: Run[] = [];
  for (const asm of Object.values(doc.assemblies)) {
    if (asm.generator?.type !== 'carcass' || hidden.has(asm.id)) continue;
    const parts = descendants(doc, asm.id)
      .filter((id) => doc.parts[id] && !hidden.has(id))
      .map((id) => boxes.get(id))
      .filter((b) => !!b);
    if (!parts.length) continue;
    const b = union(parts);
    if (b.min[1] <= WALL_CABINET_MIN_Y) continue;
    const f = rotate(nodeAffine(doc, asm.id).m, [0, 0, 1]);
    const ax: 0 | 2 = Math.abs(f[0]) > Math.abs(f[2]) ? 0 : 2;
    const sign = Math.sign(f[ax]) || 1;
    const run = ax === 0 ? 2 : 0;
    runs.push({ ax, sign, y: b.min[1], front: sign > 0 ? b.max[ax] : b.min[ax], lo: b.min[run], hi: b.max[run] });
  }
  runs.sort((a, b) => a.ax - b.ax || a.sign - b.sign || a.lo - b.lo);
  const merged: Run[] = [];
  for (const r of runs) {
    const m = merged.find((x) => x.ax === r.ax && x.sign === r.sign && Math.abs(x.y - r.y) <= tol && Math.abs(x.front - r.front) <= tol && r.lo <= x.hi + tol && r.hi >= x.lo - tol);
    if (!m) {
      merged.push({ ...r });
      continue;
    }
    m.lo = Math.min(m.lo, r.lo);
    m.hi = Math.max(m.hi, r.hi);
    m.y = Math.min(m.y, r.y);
    m.front = r.sign > 0 ? Math.max(m.front, r.front) : Math.min(m.front, r.front);
  }
  const strips = merged.map((r): Strip => {
    const length = Math.max(6, (r.hi - r.lo) / 64 - 2);
    const mid = (r.lo + r.hi) / 2 / 64;
    const depth = r.front / 64 - r.sign * STRIP.inset;
    const y = r.y / 64 - 0.25;
    return {
      center: r.ax === 2 ? [mid, y, depth] : [depth, y, mid],
      length,
      width: STRIP.width,
      along: r.ax === 2 ? [1, 0, 0] : [0, 0, 1],
      front: r.ax === 2 ? [0, 0, r.sign] : [r.sign, 0, 0],
      lumens: (STRIP.lumensPerFoot * length) / 12,
      kelvin: STRIP.kelvin,
    };
  });
  return strips.sort((a, b) => b.length - a.length).slice(0, STRIP.max);
}
