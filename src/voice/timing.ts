/**
 * Word timing for speech recognition that doesn't report any (the Web Speech API). Each result
 * event carries the session's whole transcript so far; words are compared by position with the
 * previous event, so a word keeps its time when the recognizer revises it ("for" → "four" is
 * the same audio) and only newly heard words get stamped — at the event time minus the
 * recognizer's latency, spread back over the time they'd take to say. Pure: no DOM.
 */

export interface RecEvent {
  /** When the event arrived (ms, same clock as hover timestamps). */
  at: number;
  /** Recognizer session: a restart begins a new, empty results list. */
  session: number;
  results: readonly { text: string; final: boolean }[];
}

export interface TimedWord {
  text: string;
  t0: number;
  t1: number;
  final: boolean;
  /** First word of a recognizer result: the recognizer heard a phrase break here. */
  phraseStart?: boolean;
}

export const CLOCK = {
  /** How long after a word ends the recognizer reports it. */
  latencyMs: 350,
  /** Longest a newly reported word is assumed to have taken to say. */
  maxWordMs: 350,
  /** Shortest, when a burst of words would otherwise overlap the previous one. */
  minWordMs: 120,
};

export const tokenize = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export interface WordClock {
  push(e: RecEvent): void;
  /** Every word heard so far, oldest first. */
  words(): TimedWord[];
}

export function createWordClock(cfg = CLOCK): WordClock {
  let frozen: TimedWord[] = [];
  let current: TimedWord[] = [];
  let session: number | null = null;

  return {
    push(e) {
      if (session !== null && e.session !== session) {
        frozen = [...frozen, ...current.map((w) => ({ ...w, final: true }))];
        current = [];
      }
      session = e.session;
      const next: Omit<TimedWord, 't0' | 't1'>[] = e.results.flatMap((r) =>
        tokenize(r.text).map((text, i) => ({ text, final: r.final, ...(i === 0 && { phraseStart: true }) })),
      );
      const kept = next.slice(0, current.length).map((w, i) => ({ ...w, t0: current[i]!.t0, t1: current[i]!.t1 }));
      const added = next.slice(current.length);
      if (added.length) {
        const last = kept.at(-1) ?? frozen.at(-1);
        const k = added.length;
        let end = e.at - cfg.latencyMs;
        const start = Math.max(last?.t1 ?? -Infinity, end - k * cfg.maxWordMs);
        if (end - start < k * cfg.minWordMs) end = start + k * cfg.minWordMs;
        const d = (end - start) / k;
        added.forEach((w, i) => kept.push({ ...w, t0: start + i * d, t1: start + (i + 1) * d }));
      }
      current = kept;
    },
    words: () => [...frozen, ...current],
  };
}
