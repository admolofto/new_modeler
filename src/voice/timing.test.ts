import { describe, expect, it } from 'vitest';
import { createHoverLog } from './hoverLog';
import { CLOCK, createWordClock, type RecEvent } from './timing';

const ev = (at: number, ...results: [string, boolean?][]): RecEvent => ({ at, session: 0, results: results.map(([text, final]) => ({ text, final: !!final })) });

describe('word clock', () => {
  it('stamps words as interim results grow, in order', () => {
    const c = createWordClock();
    c.push(ev(1000, ['the']));
    c.push(ev(1250, ['the top']));
    c.push(ev(1500, ['the top is']));
    const w = c.words();
    expect(w.map((x) => x.text)).toEqual(['the', 'top', 'is']);
    expect(w[0]!.t1).toBe(1000 - CLOCK.latencyMs);
    expect(w[1]!.t0).toBe(w[0]!.t1);
    expect(w[2]!.t1).toBe(1500 - CLOCK.latencyMs);
  });

  it('keeps a word’s time when the recognizer revises it', () => {
    const c = createWordClock();
    c.push(ev(1000, ['for']));
    const before = c.words()[0]!;
    c.push(ev(1400, ['four inches']));
    const [four, inches] = c.words();
    expect(four).toMatchObject({ text: 'four', t0: before.t0, t1: before.t1 });
    expect(inches!.t1).toBe(1400 - CLOCK.latencyMs);
  });

  it('drops words the recognizer takes back', () => {
    const c = createWordClock();
    c.push(ev(1000, ['the top is']));
    c.push(ev(1200, ['the top']));
    expect(c.words().map((w) => w.text)).toEqual(['the', 'top']);
  });

  it('starts a new list after a recognizer restart', () => {
    const c = createWordClock();
    c.push(ev(1000, ['the top', true]));
    c.push({ at: 3000, session: 1, results: [{ text: 'is thin', final: false }] });
    const w = c.words();
    expect(w.map((x) => x.text)).toEqual(['the', 'top', 'is', 'thin']);
    expect(w.slice(0, 2).every((x) => x.final)).toBe(true);
    expect(w[2]!.t0).toBeGreaterThanOrEqual(w[1]!.t1);
  });

  it('spreads a burst after silence back over the time it would take to say', () => {
    const c = createWordClock();
    c.push(ev(5000, ['one two three four']));
    const w = c.words();
    expect(w[3]!.t1).toBe(5000 - CLOCK.latencyMs);
    expect(w[0]!.t0).toBe(5000 - CLOCK.latencyMs - 4 * CLOCK.maxWordMs);
  });

  it('never lets a burst overlap earlier words', () => {
    const c = createWordClock();
    c.push(ev(1000, ['a']));
    c.push(ev(1010, ['a b c d']));
    const w = c.words();
    for (let i = 1; i < w.length; i++) expect(w[i]!.t0).toBeGreaterThanOrEqual(w[i - 1]!.t1);
    expect(w[3]!.t1 - w[1]!.t0).toBeCloseTo(3 * CLOCK.minWordMs);
  });

  it('marks where each recognizer result starts', () => {
    const c = createWordClock();
    c.push(ev(2000, ['the top is thin', true], ['and the side']));
    expect(c.words().map((w) => !!w.phraseStart)).toEqual([true, false, false, false, true, false, false]);
  });
});

describe('hover log', () => {
  it('starts a span only when the target changes', () => {
    const log = createHoverLog();
    log.record({ node: 'a', at: [0, 0, 0] }, 0);
    log.record({ node: 'a', at: [1, 0, 0] }, 100);
    log.record({ node: 'a', handle: 'face:top' }, 200);
    log.record(null, 300);
    const spans = log.spans(400);
    expect(spans.map((s) => [s.target, s.t0, s.t1])).toEqual([
      [{ node: 'a' }, 0, 200],
      [{ node: 'a', handle: 'face:top' }, 200, 300],
      [null, 300, 400],
    ]);
    expect(spans[0]!.ats).toEqual([
      { t: 0, at: [0, 0, 0] },
      { t: 100, at: [1, 0, 0] },
    ]);
  });

  it('samples cursor points at most every 50ms, keeping the latest', () => {
    const log = createHoverLog(50);
    log.record({ node: 'a', at: [0, 0, 0] }, 0);
    log.record({ node: 'a', at: [1, 0, 0] }, 10);
    log.record({ node: 'a', at: [2, 0, 0] }, 20);
    log.record({ node: 'a', at: [3, 0, 0] }, 80);
    expect(log.spans(100)[0]!.ats).toEqual([
      { t: 0, at: [2, 0, 0] },
      { t: 80, at: [3, 0, 0] },
    ]);
  });
});
