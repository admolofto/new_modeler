/**
 * Modal keyboard ownership (B1): while a mode (presentation) owns the keyboard, editor shortcuts
 * never see a key. One window capture listener, installed first (right after the theme), so it runs
 * before every other key handler: with an owner, a key not typed into a field stops there
 * (`stopImmediatePropagation`), and its default is prevented only when the owner handled it — so
 * browser shortcuts (Ctrl R, F5, F12) still work. Modifier-only keys pass through untouched.
 */

/** Handles a key; true when it did something (its default is then prevented). */
export type KeyOwner = (e: KeyboardEvent) => boolean;

export interface KeyOwnerSet {
  keydown: KeyOwner;
  keyup?: KeyOwner;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);

let owner: KeyOwnerSet | null = null;
let installed = false;

/** Whether an event's target is a field the user is typing into. */
function typing(target: EventTarget | null): boolean {
  const t = target as { closest?: (sel: string) => unknown } | null;
  return typeof t?.closest === 'function' && !!t.closest('input, select, textarea, [contenteditable]');
}

/**
 * What the owner does with one key event: nothing without an owner, in a field, or for a modifier on
 * its own; else the event stops here, and its default is prevented if the owner handled it.
 */
export function routeModalKey(e: KeyboardEvent, own: KeyOwnerSet | null): 'pass' | 'swallowed' | 'handled' {
  if (!own || typing(e.target) || MODIFIERS.has(e.key)) return 'pass';
  e.stopImmediatePropagation();
  const fn = e.type === 'keyup' ? own.keyup : own.keydown;
  if (fn?.(e)) {
    e.preventDefault();
    return 'handled';
  }
  return 'swallowed';
}

/** Installs the listener once (call right after `mountTheme()`, before anything else listens for keys). */
export function installModalKeys(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed) return;
  installed = true;
  const route = (e: Event) => void routeModalKey(e as KeyboardEvent, owner);
  target.addEventListener('keydown', route, { capture: true });
  target.addEventListener('keyup', route, { capture: true });
}

/** Takes the keyboard until the returned release is called (one owner at a time: the latest wins). */
export function claimKeys(own: KeyOwnerSet): () => void {
  owner = own;
  return () => {
    if (owner === own) owner = null;
  };
}

/** Whether a mode owns the keyboard now. */
export const keysClaimed = (): boolean => owner !== null;

/** What a key does in presentation (B1). */
export type PresentAction = 'escape' | 'next' | 'prev' | { view: number } | 'walk' | 'openAll' | 'lighting' | 'move' | 'hud' | 'fullscreen';

/** Keys that walk (WASD and the arrows), as `KeyboardEvent.key` lower-cased. */
export const WALK_KEYS: ReadonlySet<string> = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

/**
 * A presentation key's action (pure): `→` / PageDown / Space the next view, `←` / PageUp the one
 * before (what presenter clickers send), `1`–`9` view N, `V` walk, `O` open or close all, `L` the
 * lighting, Esc back out. Walking, WASD and the arrows walk instead.
 */
export function presentAction(key: string, walking: boolean): PresentAction | null {
  const k = key.toLowerCase();
  if (walking && WALK_KEYS.has(k)) return 'move';
  if (k === 'escape') return 'escape';
  if (k === 'arrowright' || k === 'pagedown' || k === ' ' || k === 'spacebar') return 'next';
  if (k === 'arrowleft' || k === 'pageup') return 'prev';
  if (/^[1-9]$/.test(k)) return { view: Number(k) - 1 };
  if (k === 'v') return 'walk';
  if (k === 'o') return 'openAll';
  if (k === 'l') return 'lighting';
  if (k === 'h') return 'hud';
  if (k === 'f') return 'fullscreen';
  return null;
}
