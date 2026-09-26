/**
 * Model units: integer 1/64". Every stored length is an integer count of 64ths.
 * Floats only appear in derived geometry and at the UI boundary.
 */
export const UNITS_PER_INCH = 64;

/** Inches (may be fractional) → model units, rounded to the nearest 1/64". */
export function inches(n: number): number {
  return Math.round(n * UNITS_PER_INCH);
}

/** Model units → inches as a float (display / render only). */
export function toInches(u: number): number {
  return u / UNITS_PER_INCH;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 2208 → `34 1/2"`, 46 → `23/32"`, -16 → `-1/4"`. */
export function formatInches(u: number): string {
  const sign = u < 0 ? '-' : '';
  const abs = Math.abs(Math.round(u));
  const whole = Math.floor(abs / UNITS_PER_INCH);
  const rem = abs % UNITS_PER_INCH;
  if (rem === 0) return `${sign}${whole}"`;
  const g = gcd(rem, UNITS_PER_INCH);
  const frac = `${rem / g}/${UNITS_PER_INCH / g}`;
  return whole === 0 ? `${sign}${frac}"` : `${sign}${whole} ${frac}"`;
}

/**
 * Parses `34.5`, `34 1/2`, `34-1/2`, `1/2`, optionally with a trailing `"` or `in`.
 * Returns model units, or null if the text isn't a length.
 */
export function parseInches(text: string): number | null {
  const s = text.trim().replace(/\s*("|in)$/i, '').trim();
  if (s === '') return null;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1).trim() : s;
  let value: number;
  const mixed = /^(\d+)(?:\s+|-)(\d+)\/(\d+)$/.exec(body);
  const frac = /^(\d+)\/(\d+)$/.exec(body);
  if (mixed) {
    const den = Number(mixed[3]);
    if (den === 0) return null;
    value = Number(mixed[1]) + Number(mixed[2]) / den;
  } else if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;
    value = Number(frac[1]) / den;
  } else if (/^\d*\.?\d+$|^\d+\.$/.test(body)) {
    value = Number(body);
  } else {
    return null;
  }
  return inches(neg ? -value : value);
}

/** How lengths are shown and what a bare number means when typed. Storage is always 1/64". */
export type UnitSystem = 'in' | 'mm';

export const MM_PER_INCH = 25.4;

/** 2286 → `907.3 mm` (one decimal: 1/64" is 0.4 mm). */
export function formatMm(u: number): string {
  const mm = (u / UNITS_PER_INCH) * MM_PER_INCH;
  return `${Number(mm.toFixed(1))} mm`;
}

export function formatLength(u: number, system: UnitSystem): string {
  return system === 'mm' ? formatMm(u) : formatInches(u);
}

/** Model units → plain number for spreadsheets: `34 1/2` (inches) or `876.3` (mm). */
export function lengthCell(u: number, system: UnitSystem): string {
  return system === 'mm' ? String(Number(((u / UNITS_PER_INCH) * MM_PER_INCH).toFixed(1))) : formatInches(u).slice(0, -1);
}

const NUM = String.raw`\d+(?:\.\d*)?|\.\d+`;

/**
 * Any length a woodworker might type, rounded to 1/64": inch forms (`34 1/2`, `34-1/2"`, `.75in`),
 * feet and inches (`2' 6 1/2"`, `2ft 6in`, `3'`), and metric (`18mm`, `1.8 cm`). A bare number is
 * inches or millimetres per `system`; anything with a fraction is inches either way.
 */
export function parseLength(text: string, system: UnitSystem): number | null {
  const s = text.trim().toLowerCase();
  if (s === '') return null;
  const metric = new RegExp(`^(-)?\\s*(${NUM})\\s*(mm|cm|m)$`).exec(s);
  if (metric) {
    const n = Number(metric[2]) * { mm: 1, cm: 10, m: 1000 }[metric[3] as 'mm' | 'cm' | 'm'];
    return inches(((metric[1] ? -1 : 1) * n) / MM_PER_INCH);
  }
  const feet = new RegExp(`^(-)?\\s*(${NUM})\\s*(?:'|ft|feet|foot)\\s*(.*)$`).exec(s);
  if (feet) {
    const rest = feet[3]!.trim();
    const inch = rest === '' ? 0 : parseInches(rest);
    if (inch === null || inch < 0) return null;
    const u = inches(Number(feet[2]) * 12) + inch;
    return feet[1] ? -u : u;
  }
  if (system === 'mm' && new RegExp(`^-?\\s*(?:${NUM})$`).test(s)) {
    return inches(Number(s.replace(/\s/g, '')) / MM_PER_INCH);
  }
  return parseInches(s.replace(/\s*(?:inches|inch)$/, ''));
}
