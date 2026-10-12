import { describe, expect, it } from 'vitest';
import type { V3 } from '../../geometry/types';
import { accumulationWeight, diskSample, halton, jitter, lowerTier, neutral, pickTier, slowWatch, stillSize, TIERS, untoneMapped } from './pipeline';

describe('the pipeline helpers', () => {
  it('runs the Halton sequence', () => {
    expect([1, 2, 3, 4, 5].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125, 0.625]);
    expect([1, 2, 3, 4].map((i) => +halton(i, 3).toFixed(6))).toEqual([0.333333, 0.666667, 0.111111, 0.444444]);
  });

  it('jitters within a pixel, every sample somewhere new', () => {
    const offs = Array.from({ length: 32 }, (_, k) => jitter(k));
    for (const [x, y] of offs) for (const v of [x, y]) expect(v >= -0.5 && v < 0.5).toBe(true);
    expect(new Set(offs.map((o) => o.join())).size).toBe(32);
    // Evenly spread: the mean offset is near the pixel center.
    const mean = offs.reduce((a, o) => [a[0] + o[0] / 32, a[1] + o[1] / 32], [0, 0]);
    expect(Math.abs(mean[0])).toBeLessThan(0.05);
    expect(Math.abs(mean[1])).toBeLessThan(0.05);
  });

  it('weighs samples so the running mix is their plain average', () => {
    const samples = [0.2, 0.9, 0.4, 0.7, 0.1];
    let history = 123; // whatever was there: sample 0 has weight 1
    samples.forEach((s, n) => (history = history + (s - history) * accumulationWeight(n)));
    expect(history).toBeCloseTo(samples.reduce((a, b) => a + b) / samples.length);
  });

  it('picks a tier from the GPU name', () => {
    expect(pickTier('Google SwiftShader')).toBe('fast');
    expect(pickTier('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('fast');
    expect(pickTier('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('balanced');
    expect(pickTier('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)')).toBe('balanced');
    expect(pickTier('ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(pickTier('Apple M2')).toBe('high');
    expect(pickTier('')).toBe('high');
    expect([lowerTier('high'), lowerTier('balanced'), lowerTier('fast')]).toEqual(['balanced', 'fast', null]);
  });

  it('keeps the tiers in order', () => {
    const order = [TIERS.fast, TIERS.balanced, TIERS.high];
    for (let i = 1; i < 3; i++) {
      expect(order[i]!.dprCap).toBeGreaterThan(order[i - 1]!.dprCap);
      expect(order[i]!.shadowMap).toBeGreaterThan(order[i - 1]!.shadowMap);
      expect(order[i]!.samples).toBeGreaterThan(order[i - 1]!.samples);
    }
    expect([TIERS.fast.physical, TIERS.fast.ao, TIERS.fast.bloom]).toEqual([false, 'still', false]);
  });

  it('steps down only after a run of slow moving frames', () => {
    const w = slowWatch(28, 10);
    for (let i = 0; i < 9; i++) expect(w.add(40)).toBe(false);
    expect(w.add(40)).toBe(true);
    w.reset();
    for (let i = 0; i < 20; i++) expect(w.add(i % 2 ? 40 : 10)).toBe(false); // averages 25 ms
  });

  it('sizes a saved image at twice the view, within the GPU limit', () => {
    expect(stillSize(1200, 800, 16384)).toEqual([2400, 1600]);
    expect(stillSize(2560, 1440, 16384)).toEqual([4096, 2304]);
    expect(stillSize(2560, 1440, 2048)).toEqual([2048, 1152]);
  });

  it('spreads area-light samples over the unit disk', () => {
    const pts = Array.from({ length: 32 }, (_, k) => diskSample(k, 32));
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1);
    const mean = pts.reduce((a, p) => [a[0] + p[0] / 32, a[1] + p[1] / 32], [0, 0]);
    expect(Math.hypot(mean[0], mean[1])).toBeLessThan(0.1);
  });

  it('inverts Neutral tone mapping, so the backdrop shows exactly as picked', () => {
    for (const target of [
      [0.831, 0.815, 0.783],
      [0.2, 0.3, 0.4],
      [0.05, 0.05, 0.06],
    ] as V3[]) {
      const back = neutral(untoneMapped(target));
      back.forEach((v, i) => expect(v).toBeCloseTo(target[i]!, 4));
    }
    // Bright values are compressed (so their input is higher).
    expect(untoneMapped([0.83, 0.83, 0.83])[0]).toBeGreaterThan(0.83);
  });
});
