import type { V3 } from '../../geometry/types';
import type { Bounds, PresetId } from './lightPlan';

/**
 * Path-traced photo stills (B8), the pure part: the sample targets, how big the photo is, how it's
 * tiled and paced, the progress and ETA shown, the file name, and what the path tracer sees in place
 * of what it can't draw — a gradient sky (or the studio's neutral surround) for the environment, two
 * softboxes in the studio, and a floor that fades into the background in place of the studio floor's
 * shader fade or the shadow catcher. Inches; colors linear.
 */

export type PhotoLevel = 'draft' | 'good' | 'best';

export const PHOTO_LEVELS: readonly { id: PhotoLevel; label: string; samples: number }[] = [
  { id: 'draft', label: 'Draft', samples: 64 },
  { id: 'good', label: 'Good', samples: 256 },
  { id: 'best', label: 'Best', samples: 1024 },
];

export const photoSamples = (level: PhotoLevel): number => PHOTO_LEVELS.find((l) => l.id === level)!.samples;

/**
 * Light bounces per path, and extra ones through glass. three-gpu-pathtracer 0.0.26 sizes its table of
 * stratified random numbers as `bounces + transmissiveBounces + 5` per bounce but reads entries up to
 * index 16 (`rand(15)` picks a surface's lobe, `rand2(16)` samples a sphere): a smaller table reads
 * nothing there, so those choices stop varying per sample and each pixel settles on its own fixed
 * answer — a salt-and-pepper pattern no number of samples clears. Keep the sum at least 12.
 */
export const PHOTO_BOUNCES = 8;
export const PHOTO_TRANSMISSIVE_BOUNCES = 4;
/** The highest random-number index the path tracer's shader reads (see above). */
export const PATH_TRACER_MAX_RAND = 16;

/** A tile's longest side (pixels): one draw per tile keeps each GPU job short (no driver timeout). */
export const TILE_PX = 512;
/** The photo's pixels at most (a 4K-wide frame costs too much per sample). */
export const PHOTO_MAX_PIXELS = 4_200_000;

/**
 * The photo's size in pixels: the view's CSS size × a scale per quality tier (1 on Fast, 1.5 on
 * Balanced, 2 on High), its longer side at most min(4096, the GPU's texture limit) and its area at most
 * `PHOTO_MAX_PIXELS`.
 */
export function photoSize(width: number, height: number, tier: 'fast' | 'balanced' | 'high', maxTexture: number): [number, number] {
  const scale = tier === 'high' ? 2 : tier === 'balanced' ? 1.5 : 1;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let k = Math.min(scale, Math.min(4096, maxTexture) / Math.max(w, h));
  k = Math.min(k, Math.sqrt(PHOTO_MAX_PIXELS / (w * h)));
  // Rounded down, so the budget and the limit hold.
  return [Math.max(1, Math.floor(w * k + 1e-6)), Math.max(1, Math.floor(h * k + 1e-6))];
}

/** Tiles across and down so none is larger than `tile` pixels a side. */
export const photoTiles = (width: number, height: number, tile = TILE_PX): [number, number] => [Math.max(1, Math.ceil(width / tile)), Math.max(1, Math.ceil(height / tile))];

/** Frames slower than this (ms) mean the GPU is full: fewer tiles per frame. */
const SLOW_FRAME_MS = 45;
/** Frames faster than this (ms) leave room for one more tile. */
const FAST_FRAME_MS = 24;

/**
 * Tiles to draw in the next frame (additive increase, multiplicative decrease): one more while frames
 * stay quick, half as many when one drags, between 1 and `max` (a whole sample).
 */
export function nextTilesPerFrame(current: number, frameMs: number, max: number): number {
  let n = current;
  if (frameMs > SLOW_FRAME_MS) n = Math.floor(current / 2);
  else if (frameMs < FAST_FRAME_MS) n = current + 1;
  return Math.max(1, Math.min(Math.max(1, max), n));
}

export interface PhotoProgress {
  /** Whole samples so far. */
  samples: number;
  target: number;
  /** Seconds since the photo started (preparing included). */
  elapsed: number;
  /** Seconds left at the rate so far; null before the first sample. */
  eta: number | null;
}

/**
 * Progress: samples against the target, the time taken, and the time left at the sampling rate so far
 * (`sampling`: ms since the first sample began, so compiling the shader doesn't skew it).
 */
export function photoProgress(samples: number, target: number, elapsedMs: number, samplingMs: number): PhotoProgress {
  const done = Math.min(Math.floor(samples), target);
  const eta = done >= target ? 0 : samples > 0 && samplingMs > 0 ? ((target - samples) * samplingMs) / samples / 1000 : null;
  return { samples: done, target, elapsed: Math.max(0, elapsedMs / 1000), eta };
}

/** "8 s", "2 min 05 s", "1 h 03 min". */
export function formatSeconds(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  if (t < 3600) return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`;
  return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} min`;
}

/** The PNG's name: "<model> – photo.png" (characters files can't hold become spaces). */
export function photoFileName(model: string): string {
  const name = model.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'model';
  return `${name} – photo.png`;
}

/**
 * The edge-preserving denoise's strength for a sample count (its sigma, pixels): strong while the
 * image is grainy, fading out as it converges; 0 = off (from about 400 samples on).
 */
export function denoiseSigma(samples: number): number {
  if (samples < 1) return 0;
  const s = 4 * Math.sqrt(8 / Math.max(8, samples));
  return s < 0.6 ? 0 : Math.round(s * 100) / 100;
}

// ── Matching the live view ───────────────────────────────────────────────

/**
 * Samples at which the photo's exposure and white balance are matched to the live view again (each
 * round lands closer: the tone curve bends the first guess).
 */
export const MATCH_AT: readonly number[] = [1, 4, 16, 64];

/** sRGB byte → linear. */
const decode = (v: number) => {
  const s = Math.min(1, Math.max(0, v / 255));
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/**
 * The photo's per-channel gains (linear light, before tone mapping) for the next round: they move its
 * average color toward the live view's — fully in brightness, `chroma` of the way in color — since a
 * path-traced room lit only through its windows comes out darker and bluer than the presentation's
 * tuned look. Means are display bytes (0–255); gains stay within 0.25×–6×.
 */
export function matchGain(gain: V3, photo: V3, live: V3, chroma = 0.8): V3 {
  const p = photo.map(decode) as V3;
  const l = live.map(decode) as V3;
  const lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = lum(l) / Math.max(1e-4, lum(p));
  return gain.map((g, i) => {
    const balance = l[i]! / Math.max(1e-4, p[i]!) / k;
    return Math.min(6, Math.max(0.25, g * k * balance ** chroma));
  }) as V3;
}

// ── What the path tracer sees ────────────────────────────────────────────

/** sRGB hex → linear RGB. */
export function linearOf(hex: string): V3 {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)];
}

/** The environment: radiance (linear) straight up, at the horizon and below it. */
export interface PhotoEnv {
  zenith: V3;
  horizon: V3;
  ground: V3;
}

const scaled = (hex: string, k: number): V3 => linearOf(hex).map((v) => v * k) as V3;

/**
 * The environment per preset. Day, evening and night are a sky (what the windows see, and what lights
 * a room through them; the sun itself is the directional light), the studio a neutral surround whose
 * light on the floor, with the key and the softboxes, about matches the raster studio's.
 */
export const PHOTO_ENV: Readonly<Record<PresetId, PhotoEnv>> = {
  studio: { zenith: scaled('#ffffff', 0.8), horizon: scaled('#ffffff', 0.62), ground: scaled('#ffffff', 0.4) },
  day: { zenith: scaled('#6f9be0', 1.1), horizon: scaled('#c4d3e6', 1.25), ground: scaled('#8a8f7a', 0.55) },
  evening: { zenith: scaled('#5b6fa6', 0.35), horizon: scaled('#f0a274', 0.55), ground: scaled('#4d463e', 0.18) },
  night: { zenith: scaled('#0b1430', 0.06), horizon: scaled('#141a2c', 0.05), ground: scaled('#14151a', 0.02) },
};

/**
 * The environment's radiance in direction `y` (the up component of a unit vector): the horizon color
 * blended toward the zenith with height, and quickly to the ground below the horizon.
 */
export function envAt(env: PhotoEnv, y: number): V3 {
  // Weighted this way, the ends come out exactly (t = 0: a, t = 1: b).
  const mix = (a: V3, b: V3, t: number): V3 => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
  if (y >= 0) return mix(env.horizon, env.zenith, Math.sqrt(Math.min(1, y)));
  const t = Math.min(1, -y / 0.15);
  return mix(env.horizon, env.ground, t * t * (3 - 2 * t));
}

/** A studio softbox: a rectangle of light at `position` facing `target`. */
export interface Softbox {
  position: V3;
  target: V3;
  width: number;
  height: number;
  /** Luminance (three's RectAreaLight intensity), white. */
  intensity: number;
}

/** Each softbox's light at the model's middle, as the irradiance of a uniform sky of this radiance. */
const SOFTBOX_SHARE = 0.12;

/**
 * Two softboxes for the studio: front-left and front-right of the model, up high, aimed at its middle,
 * sized to it; each adds about `SOFTBOX_SHARE` to an upward face's light there (E = L·A·cos/d²).
 */
export function studioSoftboxes(model: Bounds): Softbox[] {
  const c: V3 = [(model.min[0] + model.max[0]) / 2, (model.min[1] + model.max[1]) / 2, (model.min[2] + model.max[2]) / 2];
  const span = Math.max(24, Math.hypot(model.max[0] - model.min[0], model.max[1] - model.min[1], model.max[2] - model.min[2]));
  const size = Math.max(24, span * 0.6);
  const dist = Math.max(60, span * 1.4);
  const out: Softbox[] = [];
  for (const side of [-1, 1]) {
    const az = (side * 50 * Math.PI) / 180;
    const el = (40 * Math.PI) / 180;
    const position: V3 = [c[0] + Math.sin(az) * Math.cos(el) * dist, c[1] + Math.sin(el) * dist, c[2] + Math.cos(az) * Math.cos(el) * dist];
    const cosUp = Math.sin(el); // its light arrives this far from straight down
    const intensity = (Math.PI * SOFTBOX_SHARE * dist * dist) / (size * size * cosUp);
    out.push({ position, target: c, width: size, height: size, intensity: Math.round(intensity * 1000) / 1000 });
  }
  return out;
}

/** The photo's floor: a disc fading out (by alpha) into the background, where it stands. */
export interface PhotoFloor {
  center: V3;
  radius: number;
  /** Opaque inside `near`, gone past `far` (inches from the center). */
  near: number;
  far: number;
  /** Albedo, linear. */
  color: V3;
}

/** The floor's opacity at distance `r` from its center (a smoothstep from `near` to `far`). */
export function floorAlpha(floor: Pick<PhotoFloor, 'near' | 'far'>, r: number): number {
  if (r <= floor.near) return 1;
  if (r >= floor.far) return 0;
  const t = (r - floor.near) / (floor.far - floor.near);
  return 1 - t * t * (3 - 2 * t);
}
