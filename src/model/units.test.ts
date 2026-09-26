import { describe, expect, it } from 'vitest';
import { formatInches, formatLength, inches, lengthCell, parseInches, parseLength } from './units';

describe('units', () => {
  it('converts inches to integer 64ths', () => {
    expect(inches(34.5)).toBe(2208);
    expect(inches(23 / 32)).toBe(46);
    expect(Number.isInteger(inches(0.1))).toBe(true);
  });

  it('formats reduced fractions', () => {
    expect(formatInches(2208)).toBe('34 1/2"');
    expect(formatInches(46)).toBe('23/32"');
    expect(formatInches(64 * 36)).toBe('36"');
    expect(formatInches(-16)).toBe('-1/4"');
  });

  it('parses decimals, fractions and mixed numbers', () => {
    expect(parseInches('34.5')).toBe(2208);
    expect(parseInches('34 1/2')).toBe(2208);
    expect(parseInches('34-1/2"')).toBe(2208);
    expect(parseInches('23/32 in')).toBe(46);
    expect(parseInches('.75')).toBe(48);
    expect(parseInches('-1/4')).toBe(-16);
    expect(parseInches('abc')).toBeNull();
    expect(parseInches('1/0')).toBeNull();
    expect(parseInches('')).toBeNull();
  });

  it('formats metric and spreadsheet cells', () => {
    expect(formatLength(2304, 'mm')).toBe('914.4 mm');
    expect(formatLength(46, 'mm')).toBe('18.3 mm');
    expect(formatLength(2208, 'in')).toBe('34 1/2"');
    expect(lengthCell(2208, 'in')).toBe('34 1/2');
    expect(lengthCell(2304, 'mm')).toBe('914.4');
  });

  it('parses feet, metric and bare numbers per unit system', () => {
    expect(parseLength(`2' 6 1/2"`, 'in')).toBe(inches(30.5));
    expect(parseLength('2ft 6in', 'in')).toBe(inches(30));
    expect(parseLength(`3'`, 'in')).toBe(inches(36));
    expect(parseLength('18mm', 'in')).toBe(45);
    expect(parseLength('1.8 cm', 'in')).toBe(45);
    expect(parseLength('610', 'mm')).toBe(inches(610 / 25.4));
    expect(parseLength('610', 'in')).toBe(inches(610));
    expect(parseLength('3 1/2', 'mm')).toBe(inches(3.5)); // fractions are always inches
    expect(parseLength('23 1/2"', 'mm')).toBe(inches(23.5));
    expect(parseLength('-4mm', 'in')).toBe(-10);
    expect(parseLength('12 inches', 'in')).toBe(inches(12));
    expect(parseLength(`2' x`, 'in')).toBeNull();
    expect(parseLength('mm', 'in')).toBeNull();
  });
});
