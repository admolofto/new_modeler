import { describe, expect, it } from 'vitest';
import { requestedModel } from './models';

describe('requested AI model', () => {
  it('preserves provider defaults and accepts exact IDs and aliases', () => {
    expect(requestedModel(undefined)).toBeUndefined();
    expect(requestedModel('')).toBeUndefined();
    expect(requestedModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(requestedModel('sonnet')).toBe('sonnet');
  });
  it('rejects malformed input before spawning a CLI or calling an API', () => {
    for (const value of [null, {}, '--model', 'model\n--flag', 'model name', 'x'.repeat(121)]) expect(() => requestedModel(value)).toThrow('Invalid model name');
  });
});
