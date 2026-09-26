import type { Target } from '../edit/targets';
import type { Word } from './align';
import { createHoverLog, type HoverSpan } from './hoverLog';
import type { RecEvent } from './timing';

/**
 * Scripted voice sessions: what was said and pointed at, when. Drives the alignment tests and
 * `__modeler.voice.simulate` (a session played through the real UI without a microphone).
 */

export interface SimStep {
  /** ms from the start. */
  at: number;
  /** Point at this: a Target, a node id, or `node/handle`; null = nothing. */
  hover?: string | Target | null;
  /** Start saying this (one recognizer phrase), one word every `wordMs`. */
  say?: string;
  wordMs?: number;
}

export interface Timeline {
  events: RecEvent[];
  hovers: { at: number; target: Target | null }[];
  end: number;
}

export const WORD_MS = 250;

export function toTarget(h: string | Target | null): Target | null {
  if (h === null || typeof h === 'object') return h;
  const [node, handle] = h.split('/');
  return { node: node!, ...(handle && { handle }) };
}

/** The words as actually spoken (true times). */
export function wordsOf(steps: readonly SimStep[]): (Word & { phrase: number })[] {
  const out: (Word & { phrase: number })[] = [];
  let phrase = 0;
  for (const s of steps) {
    if (!s.say) continue;
    const ms = s.wordMs ?? WORD_MS;
    s.say
      .split(/\s+/)
      .filter(Boolean)
      .forEach((text, i) => out.push({ text, t0: s.at + i * ms, t1: s.at + (i + 1) * ms, phrase, ...(i === 0 && { phraseStart: true }) }));
    phrase++;
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

export function hoversOf(steps: readonly SimStep[]): Timeline['hovers'] {
  return steps.filter((s) => s.hover !== undefined).map((s) => ({ at: s.at, target: toTarget(s.hover!) }));
}

/** Hover spans as the hover log would record them. */
export function spansOf(steps: readonly SimStep[], until: number): HoverSpan[] {
  const log = createHoverLog();
  for (const h of hoversOf(steps)) log.record(h.target, h.at);
  return log.spans(until);
}

/** Recognizer events for the script: each word arrives `latencyMs` after it's said; a phrase goes final `finalMs` after that. */
export function timeline(steps: readonly SimStep[], o: { latencyMs?: number; finalMs?: number } = {}): Timeline {
  const latency = o.latencyMs ?? 350;
  const finalMs = o.finalMs ?? 400;
  const words = wordsOf(steps);
  const phrases = [...new Set(words.map((w) => w.phrase))].map((p) => {
    const ws = words.filter((w) => w.phrase === p);
    return { ws, finalAt: ws.at(-1)!.t1 + latency + finalMs };
  });
  const arrive = (w: Word) => w.t1 + latency;
  const times = [...new Set([...words.map(arrive), ...phrases.map((p) => p.finalAt)])].sort((a, b) => a - b);
  const events: RecEvent[] = times.map((at) => ({
    at,
    session: 0,
    results: phrases
      .filter((p) => arrive(p.ws[0]!) <= at)
      .map((p) => ({ text: p.ws.filter((w) => arrive(w) <= at).map((w) => w.text).join(' '), final: at >= p.finalAt })),
  }));
  const hovers = hoversOf(steps);
  const end = Math.max(0, ...events.map((e) => e.at), ...hovers.map((h) => h.at));
  return { events, hovers, end };
}
