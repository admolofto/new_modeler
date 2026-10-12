import { describe, expect, it, vi } from 'vitest';
import { claimKeys, installModalKeys, keysClaimed, presentAction, routeModalKey, type KeyOwnerSet } from './keys';

type FakeKey = KeyboardEvent & { stopImmediatePropagation: ReturnType<typeof vi.fn>; preventDefault: ReturnType<typeof vi.fn> };

/** A key event as the window sees it: typed into a field or not. */
function key(k: string, o: { type?: 'keydown' | 'keyup'; field?: boolean } = {}): FakeKey {
  return {
    key: k,
    type: o.type ?? 'keydown',
    target: { closest: (sel: string) => (o.field && sel.includes('input') ? {} : null) },
    stopImmediatePropagation: vi.fn(),
    preventDefault: vi.fn(),
  } as unknown as FakeKey;
}

const owner: KeyOwnerSet = { keydown: (e) => e.key === 'Escape', keyup: (e) => e.key === 'o' };

describe('modal keys', () => {
  it('does nothing without an owner', () => {
    const e = key('Delete');
    expect(routeModalKey(e, null)).toBe('pass');
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('swallows every key the owner gets, preventing the default only of the ones it handles', () => {
    const del = key('Delete');
    expect(routeModalKey(del, owner)).toBe('swallowed');
    expect(del.stopImmediatePropagation).toHaveBeenCalled();
    expect(del.preventDefault).not.toHaveBeenCalled();
    const esc = key('Escape');
    expect(routeModalKey(esc, owner)).toBe('handled');
    expect(esc.stopImmediatePropagation).toHaveBeenCalled();
    expect(esc.preventDefault).toHaveBeenCalled();
  });

  it('routes keyups to the keyup handler', () => {
    expect(routeModalKey(key('o', { type: 'keyup' }), owner)).toBe('handled');
    expect(routeModalKey(key('Escape', { type: 'keyup' }), owner)).toBe('swallowed');
    expect(routeModalKey(key('o', { type: 'keyup' }), { keydown: () => true })).toBe('swallowed');
  });

  it('lets typing into fields and modifier-only keys through', () => {
    const typed = key('a', { field: true });
    expect(routeModalKey(typed, owner)).toBe('pass');
    expect(typed.stopImmediatePropagation).not.toHaveBeenCalled();
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
      const e = key(k);
      expect(routeModalKey(e, owner)).toBe('pass');
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });

  it('copes with a target that is not an element (the window)', () => {
    const e = { ...key('x'), target: {} } as unknown as KeyboardEvent;
    expect(routeModalKey(e, owner)).toBe('swallowed');
  });

  it('listens once, in the capture phase, and routes to whoever claimed the keys', () => {
    const listeners: [string, (e: Event) => void, unknown][] = [];
    const target = { addEventListener: (type: string, fn: (e: Event) => void, opts: unknown) => listeners.push([type, fn, opts]) } as unknown as Window;
    installModalKeys(target);
    installModalKeys(target);
    expect(listeners.map(([t, , o]) => [t, o])).toEqual([
      ['keydown', { capture: true }],
      ['keyup', { capture: true }],
    ]);
    const down = listeners[0]![1];
    const seen: string[] = [];
    const release = claimKeys({ keydown: (e) => (seen.push(e.key), true) });
    expect(keysClaimed()).toBe(true);
    const e = key('Escape');
    down(e as unknown as Event);
    expect(seen).toEqual(['Escape']);
    expect(e.preventDefault).toHaveBeenCalled();
    release();
    expect(keysClaimed()).toBe(false);
    const after = key('Escape');
    down(after as unknown as Event);
    expect(after.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('a stale release does not drop a newer owner', () => {
    const r1 = claimKeys(owner);
    const r2 = claimKeys({ keydown: () => false });
    r1();
    expect(keysClaimed()).toBe(true);
    r2();
    expect(keysClaimed()).toBe(false);
  });
});

describe('presentation keys', () => {
  it('step through views (presenter clickers send PageUp / PageDown)', () => {
    for (const k of ['ArrowRight', 'PageDown', ' ']) expect(presentAction(k, false)).toBe('next');
    for (const k of ['ArrowLeft', 'PageUp']) expect(presentAction(k, false)).toBe('prev');
    expect(presentAction('3', false)).toEqual({ view: 2 });
    expect(presentAction('0', false)).toBeNull();
    expect(presentAction('V', false)).toBe('walk');
    expect(presentAction('Escape', true)).toBe('escape');
  });

  it('walk with WASD and the arrows while walking; PageUp / PageDown / Space still change views', () => {
    for (const k of ['w', 'A', 'ArrowLeft', 'ArrowRight']) expect(presentAction(k, true)).toBe('move');
    expect(presentAction('PageDown', true)).toBe('next');
    expect(presentAction(' ', true)).toBe('next');
    expect(presentAction('ArrowRight', false)).toBe('next');
  });

  it('hide the controls (H) and go fullscreen (F), walking or not', () => {
    for (const walking of [false, true]) {
      expect(presentAction('h', walking)).toBe('hud');
      expect(presentAction('F', walking)).toBe('fullscreen');
    }
  });
});
