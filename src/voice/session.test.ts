import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../plugins';
import type { TidyInput, TidyOutput } from '../ai/tidy';
import { GROUND, type Target } from '../edit/targets';
import { emptyDoc } from '../model/defaults';
import type { Op } from '../model/ops';
import { createStore, type Store } from '../model/store';
import { inches } from '../model/units';
import { scriptedRecognizer } from './recognizer';
import { timeline, toTarget, type SimStep } from './script';
import { createVoiceSession, type VoiceDeps, type VoiceSession } from './session';

const panel = (id: string, name: string, x: number): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name, material: 'ply-3-4', transform: { position: [x, 0, 0] }, shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } } },
});

const TALK: SimStep[] = [
  { at: 0, hover: 'top' },
  { at: 500, say: 'the top should overhang by an inch' },
];

function setup(tidy?: VoiceDeps['tidy']) {
  const store: Store = createStore(emptyDoc());
  store.dispatch([panel('top', 'Top', 0), panel('side', 'Left side', inches(20))]);
  let dispatches = 0;
  let script: SimStep[] = [];
  const session: VoiceSession = createVoiceSession({
    recognizer: () => scriptedRecognizer(timeline(script).events, () => Date.now()),
    now: () => Date.now(),
    doc: () => store.doc,
    selection: () => [],
    dispatch: (ops) => {
      dispatches++;
      return store.dispatch(ops);
    },
    tidy,
    tidyTimeoutMs: () => 5000,
    onChange: () => {},
  });
  /** Plays a script through the session and stops after it. */
  const play = async (steps: SimStep[]) => {
    script = steps;
    const t0 = Date.now();
    session.start();
    for (const h of timeline(steps).hovers) setTimeout(() => session.hover(h.target), h.at - (Date.now() - t0));
    await vi.advanceTimersByTimeAsync(timeline(steps).end + 100);
    session.stop();
    await vi.advanceTimersByTimeAsync(10);
  };
  const notes = () => Object.values(store.doc.annotations);
  return { store, session, play, notes, dispatches: () => dispatches };
}

/** A tidy that attaches one cleaned-up note to the candidate labelled "Top". */
const tidyToTop = async (input: TidyInput): Promise<TidyOutput> => ({
  notes: [{ note: 'Overhang the top 1".', targets: [input.candidates.find((c) => c.label === 'Top')!.id] }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('voice session', () => {
  it('adds a recording’s notes in one dispatch that one undo removes', async () => {
    const s = setup();
    await s.play(TALK);
    await s.session.whenIdle();
    expect(s.dispatches()).toBe(1);
    expect(s.notes().map((n) => [n.note, n.targets.map((t) => t.node)])).toEqual([['The top should overhang by an inch.', ['top']]]);
    expect(s.session.status.text).toMatch(/Added 1 note/);
    s.store.undo();
    expect(s.notes()).toEqual([]);
  });

  it('shows live drafts while listening', async () => {
    const { store } = setup();
    const events = timeline(TALK);
    const session = createVoiceSession({
      recognizer: () => scriptedRecognizer(events.events, () => Date.now()),
      now: () => Date.now(),
      doc: () => store.doc,
      selection: () => [],
      dispatch: (ops) => store.dispatch(ops),
      onChange: () => {},
    });
    session.hover(toTarget('top'));
    session.start();
    expect(session.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(events.end);
    expect(session.live().words.map((w) => w.text).join(' ')).toBe('the top should overhang by an inch');
    expect(session.live().drafts.map((d) => d.targets.map((t) => t.node))).toEqual([['top']]);
    session.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(session.status.text).toBe('Discarded.');
    expect(Object.keys(store.doc.annotations)).toEqual([]);
  });

  it('uses the tidied notes', async () => {
    const tidy = vi.fn(tidyToTop);
    const s = setup(tidy);
    await s.play(TALK);
    await s.session.whenIdle();
    expect(tidy).toHaveBeenCalledOnce();
    expect(tidy.mock.calls[0]![0].transcript).toMatch(/^\[0\.\ds → #1 Top\] the top should overhang by an inch$/);
    expect(s.notes().map((n) => [n.note, n.targets.map((t) => t.node)])).toEqual([['Overhang the top 1".', ['top']]]);
    expect(s.session.last()!.tidied).toBeDefined();
  });

  it('adds the drafts as heard when tidying fails', async () => {
    const s = setup(() => Promise.reject(new Error('not signed in')));
    await s.play(TALK);
    await s.session.whenIdle();
    expect(s.dispatches()).toBe(1);
    expect(s.notes()[0]!.note).toBe('The top should overhang by an inch.');
    expect(s.session.status).toEqual({ text: expect.stringMatching(/Tidying failed \(not signed in\).*Added 1 note as heard/), error: true });
  });

  it('adds the drafts as heard when tidying times out', async () => {
    const s = setup(() => new Promise(() => {}));
    await s.play(TALK);
    expect(s.session.tidying).toBe(1);
    expect(s.notes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.notes()).toHaveLength(1);
    expect(s.session.status.text).toMatch(/timed out/);
  });

  it('skips tidying on request, and ignores a late reply', async () => {
    let reply!: (o: TidyOutput) => void;
    const s = setup(() => new Promise((resolve) => (reply = resolve)));
    await s.play(TALK);
    s.session.skipTidy();
    expect(s.notes()).toHaveLength(1);
    reply({ notes: [{ note: 'late', targets: [] }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.dispatches()).toBe(1);
  });

  it('adds nothing when nothing was said', async () => {
    const s = setup(tidyToTop);
    await s.play([{ at: 0, hover: 'top' }, { at: 1000, hover: null }]);
    await s.session.whenIdle();
    expect(s.dispatches()).toBe(0);
    expect(s.session.status.text).toBe("Didn't catch anything.");
  });

  it('pins notes to the ground when there’s no model, or where the floor was pointed at', async () => {
    const store = createStore(emptyDoc());
    const script: SimStep[] = [{ at: 500, say: 'start with a base cabinet' }];
    const tidy = vi.fn(async (input: TidyInput): Promise<TidyOutput> => ({ notes: [{ note: 'Base cabinet here.', targets: input.candidates.map((c) => c.id) }] }));
    const session = createVoiceSession({
      recognizer: () => scriptedRecognizer(timeline(script).events, () => Date.now()),
      now: () => Date.now(),
      doc: () => store.doc,
      selection: () => [],
      dispatch: (ops) => store.dispatch(ops),
      tidy,
      onChange: () => {},
    });
    const record = async (hover: Target | null) => {
      session.hover(hover);
      session.start();
      await vi.advanceTimersByTimeAsync(timeline(script).end + 100);
      session.stop();
      await vi.advanceTimersByTimeAsync(10);
      await session.whenIdle();
    };
    await record(null);
    await record({ node: GROUND, at: [640, 0, -320] });
    expect(Object.values(store.doc.annotations).map((n) => n.targets)).toEqual([[{ node: GROUND }], [{ node: GROUND, at: [640, 0, -320] }]]);
    expect(tidy.mock.calls[1]![0].transcript).toMatch(/→ #1 Ground\]/);
  });

  it('records again while the last recording is being tidied', async () => {
    const replies: ((o: TidyOutput) => void)[] = [];
    const s = setup((input) => new Promise((resolve) => replies.push(() => void tidyToTop(input).then(resolve))));
    await s.play(TALK);
    expect(s.session.tidying).toBe(1);
    await s.play([{ at: 0, hover: 'side' }, { at: 500, say: 'this side needs shelf pin holes' }]);
    expect(s.session.tidying).toBe(2);
    replies.forEach((r) => r({ notes: [] }));
    await s.session.whenIdle();
    expect(s.dispatches()).toBe(2);
    expect(s.notes()).toHaveLength(2);
  });
});
