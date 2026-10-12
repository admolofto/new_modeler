export type Engine = 'claude-code' | 'codex' | 'api';

/** `effort` is the server's configured default (.env.local), if any. */
export interface EngineConfig {
  api: { model: string; effort: string; hasKey: boolean };
  claudeCode: { available: boolean; version: string | null; model: string; effort?: string };
  codex: { available: boolean; version: string | null; model: string; effort?: string; loggedIn: boolean; hint?: string };
}

export const engineName = (engine: Engine) => ({ 'claude-code': 'Claude Code', codex: 'Codex', api: 'the API' })[engine];

const EFFORT_NAMES: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort;

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
