import type { RecEvent } from './timing';

/**
 * Speech recognition: the browser's Web Speech API (Chrome sends the audio to Google, Edge to
 * Microsoft), or a scripted stand-in for tests and `__modeler.voice.simulate`.
 */

export type RecError = 'unsupported' | 'not-allowed' | 'no-mic' | 'network' | 'other';

export interface Recognizer {
  start(): void;
  /** Finishes what's been heard (final results may still arrive), then `onEnd` fires once. */
  stop(): void;
  /** Stops at once; `onEnd` still fires once. */
  abort(): void;
  onResult?: ((e: RecEvent) => void) | undefined;
  onError?: ((kind: RecError, message: string) => void) | undefined;
  onEnd?: (() => void) | undefined;
}

// The Web Speech API isn't in lib.dom; just what's used here.
interface SpeechResults {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface SpeechRec {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: SpeechResults }) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRec;

const speechCtor = (): SpeechCtor | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const speechSupported = (): boolean => !!speechCtor();

const MESSAGES: Record<Exclude<RecError, 'other'>, string> = {
  unsupported: 'Voice notes need Chrome or Edge.',
  'not-allowed': 'The microphone is blocked. Allow it from the site settings in the address bar, then press M again.',
  'no-mic': 'No microphone found.',
  network: "Couldn't reach the speech service. Voice notes need Chrome or Edge (other browsers built on Chromium often lack it).",
};

/** Continuous recognition with interim results; restarts itself when Chrome stops after a silence. */
export function webSpeech(lang = navigator.language): Recognizer {
  const Ctor = speechCtor();
  let rec: SpeechRec | null = null;
  let active = false;
  let ended = true;
  let session = 0;
  let restarts: number[] = [];
  let endTimer: ReturnType<typeof setTimeout> | undefined;

  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(endTimer);
    api.onEnd?.();
  };
  /** Ends soon even if the recognizer never reports it did. */
  const endWithin = (ms: number) => {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      try {
        rec?.abort();
      } catch {
        // already stopped
      }
      end();
    }, ms);
  };
  const fail = (kind: RecError, message?: string) => {
    active = false;
    api.onError?.(kind, message ?? MESSAGES[kind as Exclude<RecError, 'other'>] ?? 'Speech recognition failed.');
    try {
      rec?.abort();
    } catch {
      // not started
    }
    endWithin(500);
  };

  function make(): SpeechRec {
    const r = new Ctor!();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (r !== rec) return;
      const results: RecEvent['results'][number][] = [];
      for (let i = 0; i < e.results.length; i++) results.push({ text: e.results[i]![0].transcript, final: e.results[i]!.isFinal });
      api.onResult?.({ at: performance.now(), session, results });
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') return fail('not-allowed');
      if (e.error === 'audio-capture') return fail('no-mic');
      if (e.error === 'network') return fail('network');
      fail('other', `Speech recognition error: ${e.error}${e.message ? ` (${e.message})` : ''}`);
    };
    r.onend = () => {
      if (r !== rec) return;
      if (!active) return end();
      const now = performance.now();
      restarts = [...restarts.filter((t) => now - t < 10_000), now];
      if (restarts.length > 5) return fail('other', 'Speech recognition keeps stopping.');
      session++;
      try {
        rec = make();
        rec.start();
      } catch (err) {
        fail('other', (err as Error).message);
      }
    };
    return r;
  }

  const api: Recognizer = {
    start() {
      ended = false;
      if (!Ctor) return fail('unsupported');
      active = true;
      try {
        rec = make();
        rec.start();
      } catch (err) {
        fail('other', (err as Error).message);
      }
    },
    stop() {
      if (!active) return;
      active = false;
      try {
        rec?.stop();
      } catch {
        // not started
      }
      endWithin(2000);
    },
    abort() {
      active = false;
      try {
        rec?.abort();
      } catch {
        // not started
      }
      endWithin(500);
    },
  };
  return api;
}

/** Plays recognizer events (`at` = ms after start) in real time. */
export function scriptedRecognizer(events: readonly RecEvent[], now: () => number = () => performance.now()): Recognizer {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let ended = true;
  const finish = () => {
    timers.splice(0).forEach(clearTimeout);
    if (ended) return;
    ended = true;
    setTimeout(() => api.onEnd?.(), 0);
  };
  const api: Recognizer = {
    start() {
      ended = false;
      for (const e of events) timers.push(setTimeout(() => api.onResult?.({ ...e, at: now() }), e.at));
    },
    stop: finish,
    abort: finish,
  };
  return api;
}
