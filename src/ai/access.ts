/**
 * The hosted app's access code (server/hosted.ts). It's remembered in this browser and sent
 * with every AI request; a share link can carry it as ?code=…, so whoever opens the link
 * never has to type it. Harmless on the dev server, which ignores the header.
 */

export const ACCESS_HEADER = 'x-access-code';
const KEY = 'new-modeler.access-code';
/** Kept here too, for browsers that refuse storage. */
let memory = '';

export function accessCode(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAccessCode(code: string): void {
  try {
    localStorage.setItem(KEY, code.trim());
  } catch {
    // storage unavailable: the code lasts until the page closes
  }
  memory = code.trim();
}

export function accessHeaders(): Record<string, string> {
  const code = memory || accessCode();
  return code ? { [ACCESS_HEADER]: code } : {};
}

/** Takes ?code=… off the address (so it isn't bookmarked or shared further) and remembers it. */
export function captureAccessCode(location: Location, history: History): void {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return;
  saveAccessCode(code);
  url.searchParams.delete('code');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

/** Asks for the code; resolves true when one was entered. */
export function askAccessCode(): boolean {
  const code = window.prompt('Enter the access code for the AI assistant:', '');
  if (!code?.trim()) return false;
  saveAccessCode(code);
  return true;
}

/** fetch with the access code; on a 401, asks for the code once and tries again. */
export async function accessFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const go = () => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), ...accessHeaders() } });
  const res = await go();
  if (res.status !== 401 || !askAccessCode()) return res;
  return go();
}
