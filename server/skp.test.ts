import { describe, expect, it } from 'vitest';
import { findSketchUpDll, rowMajor } from './skp.ts';

describe('SketchUp .skp reading', () => {
  it('turns a column-major SketchUp transform into a row-major matrix', () => {
    // Translation (1, 2, 3) sits in the last column once transposed.
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
    expect(rowMajor(t)).toEqual([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]);
  });

  it('folds a uniform scale kept in w into the matrix', () => {
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 0.5];
    expect(rowMajor(t)).toEqual([2, 0, 0, 8, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  });

  it('finds no SketchUp when an override points nowhere', () => {
    expect(findSketchUpDll({ SKETCHUP_API_DLL: '/nowhere/SketchUpAPI.dll' })).toBeNull();
  });
});
