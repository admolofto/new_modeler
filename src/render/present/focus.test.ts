import { describe, expect, it } from 'vitest';
import { focusDistance, focusPose, FOCUS_MAX, FOCUS_MIN } from './focus';

describe('double-click focus', () => {
  it('moves in to 55% of the distance, kept between 2 and 10 feet', () => {
    expect(focusDistance(100)).toBeCloseTo(55);
    expect(focusDistance(20)).toBe(FOCUS_MIN);
    expect(focusDistance(1000)).toBe(FOCUS_MAX);
  });

  it('orbits the point clicked, from the same side', () => {
    const { position, target } = focusPose([0, 0, 100], [0, 0, 0]);
    expect(target).toEqual([0, 0, 0]);
    expect(position[0]).toBeCloseTo(0);
    expect(position[2]).toBeCloseTo(55);
  });

  it('stays put when the camera is on the point', () => {
    expect(focusPose([1, 2, 3], [1, 2, 3])).toEqual({ position: [1, 2, 3], target: [1, 2, 3] });
  });
});
