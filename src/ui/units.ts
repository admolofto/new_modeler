import { formatLength, parseLength, type UnitSystem } from '../model/units';

/**
 * Display units, a per-browser preference (the model always stores 1/64"). Every panel formats
 * and parses lengths through here, and re-renders when the user flips inches ⇄ mm.
 */

const KEY = 'new-modeler.units';

function load(): UnitSystem {
  try {
    return localStorage.getItem(KEY) === 'mm' ? 'mm' : 'in';
  } catch {
    return 'in';
  }
}

let system: UnitSystem = load();
const listeners = new Set<() => void>();

export const units = {
  get system(): UnitSystem {
    return system;
  },
  set(next: UnitSystem): void {
    if (next === system) return;
    system = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable: the choice lasts for this session
    }
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): void {
    listeners.add(fn);
  },
};

/** Model units → `23 5/8"` or `600.1 mm`. */
export const fmt = (u: number): string => formatLength(u, system);

/**
 * Display text only (never inputs), as nodes that read like a shop drawing: inch marks become
 * primes and each fraction goes in a `.frac` span the font draws stacked — `34 1/2"` → `34 ½″`.
 * Only the fraction gets the font's `frac` feature: some fonts shrink every figure it touches.
 */
export function shop(text: string): (string | HTMLElement)[] {
  const s = text.replace(/(\d) (?=\d+\/\d+)/g, '$1\u2009').replace(/(\d)"/g, '$1″');
  const out: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of s.matchAll(/\d+\/\d+/g)) {
    const frac = Object.assign(document.createElement('span'), { className: 'frac', textContent: m[0] });
    out.push(s.slice(last, m.index), frac);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out.filter((x) => x !== '');
}

/** Typed text → model units, or null. Accepts inches, feet-inches and metric in either mode. */
export const parse = (text: string): number | null => parseLength(text, system);

export const LENGTH_HINT = 'Lengths: 23 1/2, 23-1/2", 2\' 6", 18mm or 1.8cm; a bare number is in the current units.';
