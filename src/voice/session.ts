import type { TidyInput, TidyOutput } from '../ai/tidy';
import { GROUND, type Target } from '../edit/targets';
import type { Op, OpResult } from '../model/ops';
import type { Doc } from '../model/schema';
import { align, type DraftNote } from './align';
import { createHoverLog, type HoverLog, type HoverSpan } from './hoverLog';
import { attach, candidates, fromDrafts, fromTidy, noteOps, tidyInput, type NoteSpec } from './notes';
import type { Recognizer } from './recognizer';
import { createWordClock, type TimedWord, type WordClock } from './timing';

/**
 * A voice-notes recording, start to finish: listen (words + hover, re-aligned a few times a
 * second for the live draft pins), stop, let Claude tidy the drafts, and add the notes in one
 * dispatch — one undo step. A new recording can start while the last one is being tidied.
 * No DOM: the recognizer, clock, tidy call and store come in as deps.
 */

export interface VoiceDeps {
  recognizer(): Recognizer;
  now(): number;
  /** The doc on screen (candidate labels come from it). */
  doc(): Doc;
  /** Fallback target for notes about nothing in particular. */
  selection(): readonly Target[];
  dispatch(ops: Op[]): OpResult;
  /** Claude's cleanup; without it the drafts are added as heard. */
  tidy?: ((input: TidyInput, signal: AbortSignal) => Promise<TidyOutput>) | undefined;
  tidyTimeoutMs?: (() => number) | undefined;
  onChange(): void;
}

export interface VoiceStatus {
  text: string;
  error: boolean;
}

/** A finished recording, for debugging and turning real sessions into test fixtures. */
export interface SessionDump {
  words: TimedWord[];
  spans: HoverSpan[];
  drafts: DraftNote[];
  tidy?: TidyInput;
  tidied?: TidyOutput;
}

export interface VoiceSession {
  readonly recording: boolean;
  /** When the current recording started (deps.now clock). */
  readonly startedAt: number | null;
  /** Waiting for the recognizer to finish after stop. */
  readonly stopping: boolean;
  /** Draft notes waiting on the tidy pass. */
  readonly tidying: number;
  /** The last outcome or error. */
  readonly status: VoiceStatus;
  toggle(): void;
  start(): void;
  stop(): void;
  /** Stops and throws away what was said. */
  cancel(): void;
  /** Every hover change from the viewport (logged only while recording). */
  hover(t: Target | null): void;
  /** Adds anything waiting on the tidy pass as heard. */
  skipTidy(): void;
  /** Words heard this recording, and the draft notes shown as pins (this recording's and any awaiting tidy). */
  live(): { words: TimedWord[]; drafts: DraftNote[] };
  last(): SessionDump | null;
  /** Resolves once nothing is recording or waiting on tidy. */
  whenIdle(): Promise<void>;
}

export const MAX_RECORDING_MS = 10 * 60_000;
const LIVE_MS = 250;
const DEFAULT_TIDY_MS = 45_000;

interface Recording {
  rec: Recognizer;
  clock: WordClock;
  log: HoverLog;
  t0: number;
  stopping: boolean;
  cancelled: boolean;
  failed: boolean;
  drafts: DraftNote[];
  maxTimer: ReturnType<typeof setTimeout>;
}

interface Job {
  drafts: DraftNote[];
  abort: AbortController;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createVoiceSession(deps: VoiceDeps): VoiceSession {
  let cur: Recording | null = null;
  const jobs: Job[] = [];
  let hovered: Target | null = null;
  let status: VoiceStatus = { text: '', error: false };
  let dump: SessionDump | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const idle: (() => void)[] = [];

  const changed = () => {
    deps.onChange();
    if (!cur && !jobs.length) idle.splice(0).forEach((fn) => fn());
  };
  const say = (text: string, error = false) => (status = { text, error });

  const scheduleLive = () => {
    if (liveTimer !== undefined) return;
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      if (!cur) return;
      cur.drafts = align(cur.clock.words(), cur.log.spans(deps.now()));
      changed();
    }, LIVE_MS);
  };

  function start() {
    if (cur) return;
    let rec: Recognizer;
    try {
      rec = deps.recognizer();
    } catch (err) {
      say((err as Error).message, true);
      return changed();
    }
    const r: Recording = {
      rec,
      clock: createWordClock(),
      log: createHoverLog(),
      t0: deps.now(),
      stopping: false,
      cancelled: false,
      failed: false,
      drafts: [],
      maxTimer: setTimeout(stop, MAX_RECORDING_MS),
    };
    cur = r;
    r.log.record(hovered, r.t0);
    rec.onResult = (e) => {
      if (cur !== r) return;
      r.clock.push(e);
      scheduleLive();
      changed();
    };
    rec.onError = (_kind, message) => {
      if (cur !== r) return;
      r.failed = true;
      say(message, true);
      changed();
    };
    rec.onEnd = () => finish(r);
    say('');
    rec.start();
    changed();
  }

  function stop() {
    if (!cur || cur.stopping) return;
    cur.stopping = true;
    cur.rec.stop();
    changed();
  }

  function cancel() {
    if (!cur) return;
    cur.cancelled = cur.stopping = true;
    cur.rec.abort();
    changed();
  }

  function finish(r: Recording) {
    if (cur !== r) return;
    cur = null;
    clearTimeout(r.maxTimer);
    clearTimeout(liveTimer);
    liveTimer = undefined;
    if (r.cancelled) {
      say('Discarded.');
      return changed();
    }
    const words = r.clock.words();
    const spans = r.log.spans(deps.now());
    const drafts = align(words, spans);
    const d: SessionDump = (dump = { words, spans, drafts });
    if (!words.length) {
      if (!r.failed) say("Didn't catch anything.");
      return changed();
    }
    const job: Job = { drafts, abort: new AbortController(), done: false };
    jobs.push(job);
    if (!deps.tidy) return commit(job, fromDrafts(drafts), '');

    const cands = candidates(deps.doc(), spans, drafts);
    const input = (d.tidy = tidyInput(words, spans, drafts, cands, r.t0));
    job.timer = setTimeout(() => commit(job, fromDrafts(drafts), 'Tidying timed out'), deps.tidyTimeoutMs?.() ?? DEFAULT_TIDY_MS);
    deps.tidy(input, job.abort.signal).then(
      (out) => {
        d.tidied = out;
        commit(job, fromTidy(out, cands), '');
      },
      (err: Error) => commit(job, fromDrafts(drafts), `Tidying failed (${err.message})`),
    );
    changed();
  }

  /** Adds a finished recording's notes in one dispatch. `why` says why they're added as heard. */
  function commit(job: Job, notes: NoteSpec[], why: string) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.abort.abort();
    jobs.splice(jobs.indexOf(job), 1);
    const doc = deps.doc();
    const sel = deps.selection();
    const fallback: Target[] = sel.length ? [...sel] : [{ node: doc.roots[0] ?? GROUND }];
    const { notes: ready, skipped } = attach(notes, fallback);
    const prefix = why ? `${why} — ` : '';
    if (!ready.length) {
      say(`${prefix}${skipped.length ? `Nothing to attach "${skipped[0]}" to.` : 'Nothing to note.'}`, !!why || skipped.length > 0);
      return changed();
    }
    const r = deps.dispatch(noteOps(ready));
    if (!r.ok) say(r.error, true);
    else {
      const extra = skipped.length ? `; ${plural(skipped.length, 'note')} had nothing to attach to` : '';
      say(`${prefix}Added ${plural(ready.length, 'note')}${why ? ' as heard' : ''}${extra} · Ctrl+Z undoes`, !!why);
    }
    changed();
  }

  return {
    get recording() {
      return !!cur && !cur.stopping;
    },
    get startedAt() {
      return cur?.t0 ?? null;
    },
    get stopping() {
      return !!cur?.stopping;
    },
    get tidying() {
      return jobs.reduce((n, j) => n + j.drafts.length, 0);
    },
    get status() {
      return status;
    },
    toggle: () => (cur ? stop() : start()),
    start,
    stop,
    cancel,
    hover(t) {
      hovered = t;
      if (!cur) return;
      cur.log.record(t, deps.now());
      scheduleLive();
    },
    skipTidy() {
      for (const j of [...jobs]) commit(j, fromDrafts(j.drafts), '');
    },
    live: () => ({ words: cur?.clock.words() ?? [], drafts: [...jobs.flatMap((j) => j.drafts), ...(cur?.drafts ?? [])] }),
    last: () => dump,
    whenIdle: () => (!cur && !jobs.length ? Promise.resolve() : new Promise((resolve) => idle.push(resolve))),
  };
}
