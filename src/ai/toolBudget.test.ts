import { describe, expect, it } from 'vitest';
import '../plugins';
import { aiOpSchema, toolDefs } from './tools';

describe('AI tool schemas', () => {
  // Measured at 35,182 characters before presentation mode (phase 1), ~49.5k with the room (phase 5)
  // and ~66k with the props and appliances (phase 7: 11 prop shapes and 4 appliance generators, ~16k
  // after terse describes and bare finish objects). Raised from 60k to 72k in phase 7, leaving ~6k for
  // views (phase 8); the view entity and its line in the apply_ops description took ~1.9k (~67.9k).
  // The wall piece (SketchUp floor plans) took ~3.6k after a terse describe and default-free
  // finishes (~74.1k): raised to 76k. Grow it on purpose, not by accident.
  it('stay within the size budget', () => {
    expect(JSON.stringify(toolDefs()).length).toBeLessThan(76_000);
  });

  it('offer a decor entity for the decor shapes the AI may add (a pull), not stock shapes', () => {
    const add = (shape: unknown) => aiOpSchema().safeParse({ op: 'add', entity: { kind: 'decor', shape } }).success;
    expect(add({ type: 'pull', params: { style: 'knob' } })).toBe(true);
    expect(add({ type: 'box', params: { x: 64, y: 64, z: 64 } })).toBe(false);
    // Finish presets are plain strings in the schema (the prompt documents them), not enums.
    expect(JSON.stringify(toolDefs())).not.toContain('wood:walnut');
  });
});
