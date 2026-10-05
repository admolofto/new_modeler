export type Engine = 'claude-code' | 'codex' | 'api';

export interface EngineConfig {
  api: { model: string; effort: string; hasKey: boolean };
  claudeCode: { available: boolean; version: string | null; model: string };
  codex: { available: boolean; version: string | null; model: string; loggedIn: boolean; hint?: string };
}

export const engineName = (engine: Engine) => ({ 'claude-code': 'Claude Code', codex: 'Codex', api: 'the API' })[engine];

/** Keep a user's choice; otherwise prefer an installed, configured engine. */
export function defaultEngine(config: EngineConfig, saved: Engine | null): Engine {
  if (saved) return saved;
  if (config.claudeCode.available) return 'claude-code';
  if (config.codex.available && config.codex.loggedIn) return 'codex';
  if (config.api.hasKey) return 'api';
  return config.codex.available ? 'codex' : 'claude-code';
}

/** Voice cleanup follows the requested provider instead of silently switching away from Codex. */
export function tidyEngine(wanted: string | undefined, hasClaude: boolean, hasKey: boolean): Engine {
  if (wanted === 'codex') return 'codex';
  if (wanted === 'api') return hasKey || !hasClaude ? 'api' : 'claude-code';
  return hasClaude ? 'claude-code' : 'api';
}
