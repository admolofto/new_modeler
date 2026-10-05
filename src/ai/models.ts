export interface ModelOption { id: string; label: string }

/** Model names are data, never command-line switches or shell input. */
export function requestedModel(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value)) throw new Error('Invalid model name');
  return value;
}
