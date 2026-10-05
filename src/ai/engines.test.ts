import { describe, expect, it } from 'vitest';
import { defaultEngine, tidyEngine, type EngineConfig } from './engines';

const config: EngineConfig = {
  api: { model: 'test', effort: 'high', hasKey: false },
  claudeCode: { available: true, version: 'test', model: 'default' },
  codex: { available: true, version: 'test', model: 'default', loggedIn: true },
};

describe('AI providers', () => {
  it('keeps the saved provider and the existing Claude default', () => {
    expect(defaultEngine(config, 'codex')).toBe('codex');
    expect(defaultEngine(config, null)).toBe('claude-code');
  });

  it('chooses logged-in Codex when Claude is absent, or a configured API before an unsigned CLI', () => {
    const withoutClaude = { ...config, claudeCode: { ...config.claudeCode, available: false } };
    expect(defaultEngine(withoutClaude, null)).toBe('codex');
    expect(defaultEngine({ ...withoutClaude, codex: { ...config.codex, loggedIn: false }, api: { ...config.api, hasKey: true } }, null)).toBe('api');
  });

  it('voice cleanup stays on Codex, even when Claude or an API is also available', () => {
    expect(tidyEngine('codex', true, true)).toBe('codex');
    expect(tidyEngine('codex', false, false)).toBe('codex');
    expect(tidyEngine('api', true, false)).toBe('claude-code');
    expect(tidyEngine('api', true, true)).toBe('api');
  });
});
