import { describe, expect, it } from 'vitest';
import {
  denoiseSigma,
  envAt,
  floorAlpha,
  formatSeconds,
  linearOf,
  MATCH_AT,
  matchGain,
  nextTilesPerFrame,
  PATH_TRACER_MAX_RAND,
  PHOTO_BOUNCES,
  PHOTO_ENV,
  PHOTO_LEVELS,
  PHOTO_MAX_PIXELS,
  PHOTO_TRANSMISSIVE_BOUNCES,
  photoFileName,
  photoProgress,
  photoSamples,
  photoSize,
  photoTiles,
  studioSoftboxes,
} from './photoPlan';

describe('photo sample targets', () => {
  it('are Draft 64, Good 256, Best 1024', () => {
    expect(PHOTO_LEVELS.map((l) => [l.label, l.samples])).toEqual([
      ['Draft', 64],
      ['Good', 256],
      ['Best', 1024],
    ]);
    expect(photoSamples('good')).toBe(256);
  });
});

describe('the path tracer settings', () => {
  it('gives its random-number table room for every index its shader reads', () => {
    // The table is bounces + transmissive bounces + 5 wide; indices past it read nothing and leave a fixed per-pixel pattern.
    expect(PHOTO_BOUNCES + PHOTO_TRANSMISSIVE_BOUNCES + 5).toBeGreaterThan(PATH_TRACER_MAX_RAND);
  });
});

describe('matching the live view', () => {
  it('brightens a dark, blue photo toward a warm live view, and keeps a matched one as it is', () => {
    const g = matchGain([1, 1, 1], [99, 106, 119], [152, 139, 123]);
    // Brighter overall, and warmer: more red than blue.
    expect(Math.min(...g)).toBeGreaterThan(1);
    expect(g[0]).toBeGreaterThan(g[2]);
    expect(matchGain([1.4, 1.2, 1.1], [150, 140, 120], [150, 140, 120])).toEqual([1.4, 1.2, 1.1].map((v) => expect.closeTo(v, 6)));
  });

  it('stays within its limits, and rounds come in order', () => {
    expect(matchGain([1, 1, 1], [1, 1, 1], [255, 255, 255])).toEqual([6, 6, 6]);
    expect(matchGain([1, 1, 1], [255, 255, 255], [1, 1, 1])).toEqual([0.25, 0.25, 0.25]);
    expect([...MATCH_AT].sort((a, b) => a - b)).toEqual(MATCH_AT);
  });
});

describe('the photo size and tiles', () => {
  it('scales the view per tier, capped by the texture limit and a pixel budget', () => {
    expect(photoSize(1000, 600, 'fast', 16384)).toEqual([1000, 600]);
    expect(photoSize(1000, 600, 'balanced', 16384)).toEqual([1500, 900]);
    expect(photoSize(1000, 600, 'high', 16384)).toEqual([2000, 1200]);
    // A small GPU limit wins.
    expect(photoSize(1000, 600, 'high', 1024)).toEqual([1024, 614]);
    // A big view stays within the pixel budget, keeping its shape.
    const [w, h] = photoSize(2400, 1350, 'high', 16384);
    expect(w * h).toBeLessThanOrEqual(PHOTO_MAX_PIXELS);
    expect(w / h).toBeCloseTo(2400 / 1350, 2);
  });

  it('tiles so no tile is over 512 pixels a side', () => {
    expect(photoTiles(512, 512)).toEqual([1, 1]);
    expect(photoTiles(2000, 1200)).toEqual([4, 3]);
    expect(photoTiles(1, 1)).toEqual([1, 1]);
  });

  it('draws one more tile per frame while frames are quick, half as many when one drags', () => {
    expect(nextTilesPerFrame(1, 10, 12)).toBe(2);
    expect(nextTilesPerFrame(12, 10, 12)).toBe(12); // a whole sample at most
    expect(nextTilesPerFrame(8, 30, 12)).toBe(8); // in between: hold
    expect(nextTilesPerFrame(8, 60, 12)).toBe(4);
    expect(nextTilesPerFrame(1, 200, 12)).toBe(1); // never below one
  });
});

describe('photo progress', () => {
  it('counts whole samples and estimates the time left from the sampling rate', () => {
    // 16 of 64 samples in 4 s of sampling (10 s since the start, compiling included): 12 s left.
    const p = photoProgress(16, 64, 10_000, 4_000);
    expect(p).toEqual({ samples: 16, target: 64, elapsed: 10, eta: 12 });
    expect(photoProgress(16.6, 64, 10_000, 4_000).samples).toBe(16);
  });

  it('has no estimate before the first sample, and none left once done', () => {
    expect(photoProgress(0, 64, 3_000, 0).eta).toBeNull();
    expect(photoProgress(64, 64, 20_000, 18_000)).toMatchObject({ samples: 64, eta: 0 });
    // Past a lowered target it reads as the target.
    expect(photoProgress(80, 64, 20_000, 18_000)).toMatchObject({ samples: 64, eta: 0 });
  });

  it('formats durations', () => {
    expect(formatSeconds(8.4)).toBe('8 s');
    expect(formatSeconds(125)).toBe('2 min 05 s');
    expect(formatSeconds(3780)).toBe('1 h 03 min');
  });
});

describe('the photo file', () => {
  it('is named after the model', () => {
    expect(photoFileName('Base cabinet')).toBe('Base cabinet – photo.png');
    expect(photoFileName('a/b:c?')).toBe('a b c – photo.png');
    expect(photoFileName('  ')).toBe('model – photo.png');
  });
});

describe('the denoise', () => {
  it('is strong while grainy and off once converged', () => {
    expect(denoiseSigma(0)).toBe(0);
    expect(denoiseSigma(1)).toBe(4);
    expect(denoiseSigma(64)).toBeGreaterThan(1);
    expect(denoiseSigma(64)).toBeLessThan(denoiseSigma(16));
    expect(denoiseSigma(1024)).toBe(0);
  });
});

describe('what the path tracer sees', () => {
  it('converts sRGB to linear', () => {
    expect(linearOf('#ffffff')).toEqual([1, 1, 1]);
    expect(linearOf('#000000')).toEqual([0, 0, 0]);
    expect(linearOf('#808080')[0]).toBeCloseTo(0.2159, 3);
  });

  it('runs the sky from the ground up through the horizon to the zenith', () => {
    const day = PHOTO_ENV.day;
    expect(envAt(day, 1)).toEqual(day.zenith);
    expect(envAt(day, 0)).toEqual(day.horizon);
    expect(envAt(day, -1)).toEqual(day.ground);
    // Blue overhead, brighter at the horizon than the ground.
    expect(day.zenith[2]).toBeGreaterThan(day.zenith[0]);
    expect(day.horizon[1]).toBeGreaterThan(day.ground[1]);
    // Night is dark, the studio neutral.
    for (const v of [...PHOTO_ENV.night.zenith, ...PHOTO_ENV.night.horizon]) expect(v).toBeLessThan(0.05);
    for (const c of [PHOTO_ENV.studio.zenith, PHOTO_ENV.studio.horizon, PHOTO_ENV.studio.ground]) expect(c[0]).toBeCloseTo(c[2]);
  });

  it('puts two softboxes up front, left and right, aimed at the model, giving its middle a set share of light', () => {
    const model = { min: [0, 0, 0] as [number, number, number], max: [36, 34.5, 24] as [number, number, number] };
    const boxes = studioSoftboxes(model);
    expect(boxes).toHaveLength(2);
    const [l, r] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
    expect(l.position[0]).toBeLessThan(18);
    expect(r.position[0]).toBeGreaterThan(18);
    for (const b of boxes) {
      expect(b.position[2]).toBeGreaterThan(24); // in front
      expect(b.position[1]).toBeGreaterThan(34.5); // above
      expect(b.target).toEqual([18, 17.25, 12]);
      // E = L·A·cos/d² on an upward face at the target, as a uniform sky's radiance (E/π).
      const d = b.position.map((v, i) => v - b.target[i]!);
      const dist = Math.hypot(...d);
      const e = (b.intensity * b.width * b.height * (d[1]! / dist)) / (dist * dist);
      expect(e / Math.PI).toBeCloseTo(0.12, 2);
    }
  });

  it('fades the floor out between its near and far radii', () => {
    const f = { near: 100, far: 300 };
    expect(floorAlpha(f, 0)).toBe(1);
    expect(floorAlpha(f, 100)).toBe(1);
    expect(floorAlpha(f, 200)).toBeCloseTo(0.5);
    expect(floorAlpha(f, 300)).toBe(0);
    expect(floorAlpha(f, 1000)).toBe(0);
  });
});
