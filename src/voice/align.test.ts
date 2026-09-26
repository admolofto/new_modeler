import { describe, expect, it } from 'vitest';
import { targetKey } from '../edit/targets';
import { align, type DraftNote } from './align';
import { spansOf, timeline, wordsOf, type SimStep } from './script';
import { createWordClock } from './timing';

const END = 20_000;
const run = (steps: SimStep[]) => align(wordsOf(steps), spansOf(steps, END));
const keys = (notes: DraftNote[]) => notes.map((n) => n.targets.map(targetKey));

describe('align: what a note is about', () => {
  it('attaches to what was hovered the whole time', () => {
    const notes = run([{ at: 0, hover: 'top' }, { at: 1000, say: 'the top should overhang by an inch' }]);
    expect(keys(notes)).toEqual([['top']]);
    expect(notes[0]!.text).toBe('The top should overhang by an inch.');
    expect(notes[0]!.reason).toBe('hover');
  });

  it('keeps the target when the mouse leaves early into empty space', () => {
    const notes = run([{ at: 0, hover: 'top' }, { at: 1000, say: 'the top should overhang by an inch' }, { at: 2050, hover: null }]);
    expect(keys(notes)).toEqual([['top']]);
  });

  it('keeps the target when the mouse leaves early for the next thing, then talks about that', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 1000, say: 'the top needs a roundover on the front' },
      { at: 2000, hover: null },
      { at: 2100, hover: 'side' },
      { at: 3800, say: 'this side needs shelf pin holes' },
    ]);
    expect(keys(notes)).toEqual([['top'], ['side']]);
  });

  it('follows a late mouse after a filler lead-in', () => {
    const notes = run([
      { at: 0, hover: 'back' },
      { at: 500, say: 'the back is too thin' },
      { at: 3000, say: 'okay so um the drawer front is too tall' },
      { at: 3300, hover: null },
      { at: 3700, hover: 'drawer' },
    ]);
    expect(keys(notes)).toEqual([['back'], ['drawer']]);
  });

  it('follows a late mouse that arrives almost halfway through, with no lead-in', () => {
    const notes = run([
      { at: 0, hover: 'back' },
      { at: 500, say: 'the back is too thin' },
      { at: 3000, say: 'the drawer front is too tall' },
      { at: 3500, hover: null },
      { at: 3700, hover: 'drawer' },
    ]);
    expect(keys(notes)).toEqual([['back'], ['drawer']]);
  });

  it('ignores parts the mouse only passes over', () => {
    const notes = run([
      { at: 0, hover: null },
      { at: 1000, hover: 'b' },
      { at: 1150, hover: 'c' },
      { at: 1350, hover: 'drawer' },
      { at: 1500, say: 'the drawer front is too tall' },
    ]);
    expect(keys(notes)).toEqual([['drawer']]);
  });

  it('splits two subjects separated by a pause', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 500, say: 'the top needs a roundover' },
      { at: 2000, hover: 'side' },
      { at: 2700, say: 'and this side needs shelf pin holes' },
    ]);
    expect(keys(notes)).toEqual([['top'], ['side']]);
  });

  it('splits two subjects at a short pause and "and" when both clearly point somewhere', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 500, say: 'the top needs a roundover' },
      { at: 1900, hover: 'side' },
      { at: 2100, say: 'and this side needs shelf pin holes' },
    ]);
    expect(keys(notes)).toEqual([['top'], ['side']]);
    expect(notes[1]!.text).toBe('And this side needs shelf pin holes.');
  });

  it("doesn't split mid-phrase when the mouse moves without a pause", () => {
    const notes = run([{ at: 0, hover: 'top' }, { at: 500, say: 'the top should overhang the front by an inch' }, { at: 1500, hover: 'front' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.targets).toHaveLength(1);
  });

  it('attaches "this … that" to both things, in order', () => {
    const notes = run([{ at: 0, hover: 'a' }, { at: 500, say: 'this should line up with that', wordMs: 300 }, { at: 1750, hover: 'b' }]);
    expect(keys(notes)).toEqual([['a', 'b']]);
    expect(notes[0]!.reason).toBe('pair');
  });

  it('carries the target to a quick follow-up with nothing hovered, and merges it', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 500, say: 'the top is too thin' },
      { at: 1800, hover: null },
      { at: 3250, say: 'and it should be taller too' },
    ]);
    expect(keys(notes)).toEqual([['top']]);
    expect(notes[0]!.text).toBe('The top is too thin. And it should be taller too.');
  });

  it('leaves a follow-up long after with no target', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 500, say: 'the top is too thin' },
      { at: 1800, hover: null },
      { at: 6750, say: 'and it should be taller too' },
    ]);
    expect(keys(notes)).toEqual([['top'], []]);
    expect(notes[1]!.reason).toBe('none');
  });

  it('treats wobbling between faces of one part as the part', () => {
    const steps: SimStep[] = [{ at: 500, say: 'the top needs a roundover' }];
    for (let t = 0; t < 3000; t += 200) steps.push({ at: t, hover: 'top/face:top' }, { at: t + 100, hover: 'top/face:front' });
    expect(keys(run(steps))).toEqual([['top']]);
  });

  it('names the face when most of the pointing was on it', () => {
    const steps: SimStep[] = [{ at: 500, say: 'the top needs a roundover' }];
    for (let t = 0; t < 3000; t += 500) steps.push({ at: t, hover: 'top/face:top' }, { at: t + 400, hover: 'top/face:front' });
    expect(keys(run(steps))).toEqual([['top/face:top']]);
  });

  it('keeps the target through a gap in hover (orbiting)', () => {
    const notes = run([
      { at: 0, hover: 'top' },
      { at: 500, say: 'the top should overhang the front by an inch' },
      { at: 1200, hover: null },
      { at: 2200, hover: 'top' },
    ]);
    expect(keys(notes)).toEqual([['top']]);
  });

  it('returns nothing for no words', () => {
    expect(run([{ at: 0, hover: 'top' }])).toEqual([]);
  });

  it('puts the pin where the cursor rested longest', () => {
    const notes = run([
      { at: 0, hover: { node: 'top', at: [1, 1, 1] } },
      { at: 100, hover: { node: 'top', at: [5, 5, 5] } },
      { at: 500, say: 'the top is too thin' },
    ]);
    expect(notes[0]!.targets).toEqual([{ node: 'top', at: [5, 5, 5] }]);
  });

  it('has no target when nothing was ever hovered', () => {
    const notes = run([{ at: 500, say: 'the top is too thin' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.targets).toEqual([]);
    expect(notes[0]!.reason).toBe('none');
  });

  it('gives the same answer through recognizer timing as with true word times', () => {
    const steps: SimStep[] = [
      { at: 0, hover: 'back' },
      { at: 500, say: 'the back is too thin' },
      { at: 3000, say: 'the drawer front is too tall' },
      { at: 3500, hover: null },
      { at: 3700, hover: 'drawer' },
    ];
    const clock = createWordClock();
    for (const e of timeline(steps).events) clock.push(e);
    expect(keys(align(clock.words(), spansOf(steps, END)))).toEqual([['back'], ['drawer']]);
  });
});
