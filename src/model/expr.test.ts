import { describe, expect, it } from 'vitest';
import { bareVariable, evalFormula, parseFormula } from './expr';

const vars: Record<string, number> = { a: 10, b: 4, cabW: 2304, gap: 8 };
const ev = (src: string) => evalFormula(parseFormula(src), (id) => vars[id]);

describe('formulas', () => {
  it('follows precedence, parens and unary minus', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-a + 2')).toBe(-8);
    expect(ev('a - b - 1')).toBe(5);
    expect(ev('a / b / 2')).toBe(1.25);
    expect(ev('(cabW - gap) / 2')).toBe(1148);
  });

  it('calls min / max / round / floor / ceil', () => {
    expect(ev('min(a, b, 3)')).toBe(3);
    expect(ev('max(a, b)')).toBe(10);
    expect(ev('round(a / b)')).toBe(3);
    expect(ev('floor(a / b) + ceil(a / b)')).toBe(5);
  });

  it('reads inch literals as 1/64" and plain numbers as unitless', () => {
    expect(ev('1 1/2in')).toBe(96);
    expect(ev('3/4in * 2')).toBe(96);
    expect(ev('0.5in')).toBe(32);
    expect(ev('12 in')).toBe(768);
    expect(ev('cabW - 1/8in')).toBe(2296);
    expect(ev('3 - 1/2in')).toBe(-29); // spaced minus is subtraction, not a mixed number
  });

  it('lists the variables it reads and spots a bare variable', () => {
    expect(parseFormula('(cabW + 2*a - gap) / 2').refs).toEqual(['cabW', 'a', 'gap']);
    expect(bareVariable(parseFormula(' cabW '))).toBe('cabW');
    expect(bareVariable(parseFormula('cabW + 0'))).toBeNull();
  });

  it('gives readable errors', () => {
    expect(() => parseFormula('1 +')).toThrow(/ends too soon/);
    expect(() => parseFormula('foo(1)')).toThrow(/unknown function "foo"/);
    expect(() => parseFormula('a b')).toThrow(/unexpected "b" at column 3/);
    expect(() => parseFormula('2inner')).toThrow(/unexpected "inner"/);
    expect(() => parseFormula('(a + 1')).toThrow(/missing "\)"/);
    expect(() => parseFormula('round(a, b)')).toThrow(/round\(\) takes 1 argument/);
    expect(() => parseFormula('a $ b')).toThrow(/unexpected "\$"/);
    expect(() => ev('a / (b - 4)')).toThrow(/divides by zero/);
    expect(() => ev('nope + 1')).toThrow(/no variable "nope"/);
  });
});
