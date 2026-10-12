import { describe, expect, it } from 'vitest';
import { CLAUDE_EFFORTS, requestedEffort, requestedModel } from './models';

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

describe('requested effort', () => {
  it('keeps the default when unset, and limits Claude to its levels', () => {
    expect(requestedEffort(undefined, CLAUDE_EFFORTS)).toBeUndefined();
    expect(requestedEffort('', CLAUDE_EFFORTS)).toBeUndefined();
    expect(requestedEffort('xhigh', CLAUDE_EFFORTS)).toBe('xhigh');
    expect(() => requestedEffort('minimal', CLAUDE_EFFORTS)).toThrow('Invalid effort level');
  });
  it('passes plain words through for providers that check their own levels, and nothing else', () => {
    expect(requestedEffort('minimal')).toBe('minimal');
    for (const value of [null, 3, '--effort', 'High', 'low high', 'x'.repeat(17)]) expect(() => requestedEffort(value)).toThrow('Invalid effort level');
  });
});
