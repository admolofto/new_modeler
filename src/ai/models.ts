export interface ModelOption {
  id: string;
  label: string;
  /** Effort levels the model takes (Codex lists them per model). */
  efforts?: string[];
  defaultEffort?: string;
  /** The provider's default model. */
  isDefault?: boolean;
}

/** Model names are data, never command-line switches or shell input. */
export function requestedModel(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value)) throw new Error('Invalid model name');
  return value;
}

/** Effort levels Claude takes, through the API and Claude Code alike. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof CLAUDE_EFFORTS)[number];

/** An effort level from the browser: one of `allowed` when given, else a plain word the provider checks itself. */
export function requestedEffort(value: unknown, allowed?: readonly string[]): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-z]{1,16}$/.test(value) || (allowed && !allowed.includes(value))) throw new Error('Invalid effort level');
  return value;
}
