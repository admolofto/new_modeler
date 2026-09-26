import { targetKey, type Target } from '../edit/targets';
import type { V3 } from '../geometry/types';
import type { HoverSpan } from './hoverLog';

/**
 * Lines up what was said with what the pointer was over, and turns it into draft notes. The
 * words decide where a note starts and ends (pauses, phrase breaks, "and…"); the hover decides
 * what it's about. Each word votes for what was hovered in a window just before it — people
 * point, then talk, and often move on before they finish — so leaving early still counts for
 * the thing you were on. Nothing hovered casts no vote; quick passes over other parts are
 * ignored; and if you were still on the last thing you talked about but moved to something new
 * as you started speaking, the new thing wins. Pure: no DOM, no Three.js.
 */

export interface Word {
  text: string;
  t0: number;
  t1: number;
  phraseStart?: boolean | undefined;
}

export type Reason = 'hover' | 'pair' | 'carry' | 'none';

export interface DraftNote {
  text: string;
  /** Word index range [w0, w1). */
  w0: number;
  w1: number;
  t0: number;
  t1: number;
  /** Empty when nothing was pointed at (the caller picks a fallback). */
  targets: Target[];
  /** 0–1: how much of what was said voted for the target. */
  confidence: number;
  reason: Reason;
}

export const ALIGN = {
  /** Silence that ends an utterance. */
  hardGapMs: 700,
  /** A shorter pause: a place a note may split. */
  softGapMs: 250,
  /** Hover shorter than this is passing over, not pointing. */
  minDwellMs: 250,
  /** Ordinary words look at hover in [c − lag − half, c − lag + half] around their centre c. */
  lagMs: 300,
  halfMs: 450,
  /** "this / that / here…" look at a tighter window nearer the word. */
  deicticLagMs: 150,
  deicticHalfMs: 350,
  /** Hover from well before the utterance started counts less. */
  preRollMs: 300,
  preWeight: 0.5,
  /**
   * If something new is reached within the utterance's first `arriveMs` (or `arriveFrac` of it),
   * hover still on the previous note's part from before you spoke counts `staleWeight`.
   */
  arriveMs: 1000,
  arriveFrac: 0.5,
  staleWeight: 0.3,
  weights: { deictic: 3, content: 1, function: 0.5, filler: 0.1 },
  /** Share of a chunk's word weight its winner needs to count at all… */
  minConf: 0.2,
  /** …and to split off from its neighbour as a separate note. */
  splitConf: 0.35,
  /** Word weight (markers aside) a chunk needs to stand as its own note. */
  minSubstance: 2.5,
  /** A face / edge is named only if it holds this share of its part's votes. */
  handleShare: 0.6,
  /** A note with no target inherits the previous one's, and same-target notes merge, within this gap. */
  carryMs: 3000,
  /** "this … that": each pointing word needs this share of its votes on one part… */
  pairMinShare: 0.6,
  /** …and hover under this share of its window. */
  pairMinCover: 0.3,
  maxTargets: 3,
};

export type AlignConfig = typeof ALIGN;

// ── Words ─────────────────────────────────────────────────────────────────────

export type WordClass = 'deictic' | 'filler' | 'function' | 'content';

const DEICTIC = new Set(['this', 'that', 'these', 'those', 'here', 'there', "that's", "there's", "here's"]);
const FILLER = new Set(['um', 'umm', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'like', 'okay', 'ok', 'well', 'yeah', 'so']);
const FILLER_PAIRS = new Set(['you know', 'i mean', 'kind of', 'sort of']);
const FUNCTION = new Set(
  (
    'the a an of to in on at for by with from into onto it its it\'s is are was were be been being should would could can will ' +
    'i i\'d i\'m we you and or but then just too as than do does did has have had need needs want make one also all'
  ).split(' '),
);
/** Words that can start a new chunk. */
const MARKER = new Set(['and', 'also', 'then', 'next', 'plus', 'okay', 'ok', 'now', 'oh', 'alright', 'but']);

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

export function wordClass(w: string): WordClass {
  const n = norm(w);
  if (DEICTIC.has(n)) return 'deictic';
  if (FILLER.has(n)) return 'filler';
  if (FUNCTION.has(n)) return 'function';
  return 'content';
}

function classes(words: readonly Word[]): WordClass[] {
  const out = words.map((w) => wordClass(w.text));
  for (let i = 0; i + 1 < words.length; i++) {
    if (FILLER_PAIRS.has(`${norm(words[i]!.text)} ${norm(words[i + 1]!.text)}`)) out[i] = out[i + 1] = 'filler';
  }
  return out;
}

/** Words as one sentence: capitalised, ending in punctuation. */
export function sentence(words: readonly Word[]): string {
  const s = words.map((w) => w.text).join(' ').trim();
  if (!s) return '';
  return `${s[0]!.toUpperCase()}${s.slice(1)}${/[.?!]$/.test(s) ? '' : '.'}`;
}

// ── Hover ─────────────────────────────────────────────────────────────────────

export interface Kept {
  key: string;
  node: string;
  handle?: string | undefined;
  t0: number;
  t1: number;
  /** When the pointer arrived on this node (start of the run of spans on it). */
  runT0: number;
  ats: HoverSpan['ats'];
}

/**
 * Hover spans that count as pointing: on something, and part of a stay on that node of at least
 * `minDwellMs`. Moving between faces of one part, or a brief gap to nothing, doesn't end a stay.
 */
export function keptSpans(spans: readonly HoverSpan[], cfg: AlignConfig = ALIGN): Kept[] {
  const out: Kept[] = [];
  let run: { node: string; t0: number; t1: number; members: Kept[] } | null = null;
  const flush = () => {
    if (run && run.t1 - run.t0 >= cfg.minDwellMs) for (const m of run.members) out.push({ ...m, runT0: run.t0 });
    run = null;
  };
  for (const s of spans) {
    if (!s.target || s.t1 <= s.t0) continue;
    const node = s.target.node;
    if (!run || run.node !== node || s.t0 - run.t1 >= cfg.minDwellMs) {
      flush();
      run = { node, t0: s.t0, t1: s.t1, members: [] };
    }
    run.t1 = s.t1;
    run.members.push({ key: targetKey(s.target), node, handle: s.target.handle, t0: s.t0, t1: s.t1, runT0: s.t0, ats: s.ats });
  }
  flush();
  return out;
}

/** Index of the first kept span ending after `t` (spans are in time order and don't overlap). */
function firstEndingAfter(kept: readonly Kept[], t: number): number {
  let lo = 0;
  let hi = kept.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (kept[m]!.t1 <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The kept span under the pointer at `t`, if any. */
export function keptAt(kept: readonly Kept[], t: number): Kept | null {
  const k = kept[firstEndingAfter(kept, t)];
  return k && k.t0 <= t ? k : null;
}

/** Where the cursor rested longest on a node (and handle) within [x0, x1]. */
function restingPoint(kept: readonly Kept[], node: string, handle: string | undefined, x0: number, x1: number): V3 | undefined {
  let best: V3 | undefined;
  let bestRest = -1;
  for (let i = firstEndingAfter(kept, x0); i < kept.length && kept[i]!.t0 < x1; i++) {
    const k = kept[i]!;
    if (k.node !== node || (handle && k.handle !== handle)) continue;
    k.ats.forEach((s, j) => {
      const end = Math.min(k.ats[j + 1]?.t ?? k.t1, x1);
      const rest = end - Math.max(s.t, x0);
      if (rest > bestRest) {
        bestRest = rest;
        best = s.at;
      }
    });
  }
  return best && [...best];
}

// ── Alignment ─────────────────────────────────────────────────────────────────

interface Vote {
  node: string;
  handle?: string | undefined;
  v: number;
}

interface Tally {
  a: number;
  b: number;
  weight: number;
  substance: number;
  nodes: Map<string, number>;
  keys: Map<string, Vote>;
  winner: string | null;
  conf: number;
}

export function align(words: readonly Word[], spans: readonly HoverSpan[], cfg: AlignConfig = ALIGN): DraftNote[] {
  if (!words.length) return [];
  const kept = keptSpans(spans, cfg);
  const cls = classes(words);
  const weightOf = (i: number) => cfg.weights[cls[i]!];
  const notes: DraftNote[] = [];
  let prevNode: string | null = null;

  for (const [u0, u1] of utterances(words, cfg)) {
    const ut0 = words[u0]!.t0;
    const ut1 = words[u1 - 1]!.t1;
    const arriveBy = ut0 + Math.max(cfg.arriveMs, cfg.arriveFrac * (ut1 - ut0));
    const fresh = prevNode !== null && kept.some((k) => k.node !== prevNode && k.runT0 >= ut0 - cfg.preRollMs && k.runT0 <= arriveBy);
    const stale = (k: Kept) => fresh && k.node === prevNode && k.runT0 < ut0;
    const pre = ut0 - cfg.preRollMs;

    // D. Each word's votes: weighted hover time in its window.
    const votes = new Map<number, Map<string, Vote>>();
    for (let i = u0; i < u1; i++) {
      const w = words[i]!;
      const c = (w.t0 + w.t1) / 2;
      const deictic = cls[i] === 'deictic';
      const lag = deictic ? cfg.deicticLagMs : cfg.lagMs;
      const half = deictic ? cfg.deicticHalfMs : cfg.halfMs;
      const [a, b] = [c - lag - half, c - lag + half];
      const mine = new Map<string, Vote>();
      for (let j = firstEndingAfter(kept, a); j < kept.length && kept[j]!.t0 < b; j++) {
        const k = kept[j]!;
        const x0 = Math.max(a, k.t0);
        const x1 = Math.min(b, k.t1);
        if (x1 <= x0) continue;
        const before = Math.max(0, Math.min(x1, pre) - x0);
        const overlap = (before * cfg.preWeight + (x1 - x0 - before)) * (stale(k) ? cfg.staleWeight : 1);
        const v = (weightOf(i) * overlap) / (b - a);
        const prev = mine.get(k.key);
        if (prev) prev.v += v;
        else mine.set(k.key, { node: k.node, handle: k.handle, v });
      }
      votes.set(i, mine);
    }

    const tally = (a: number, b: number): Tally => {
      const nodes = new Map<string, number>();
      const keys = new Map<string, Vote>();
      let weight = 0;
      let substance = 0;
      for (let i = a; i < b; i++) {
        weight += weightOf(i);
        if (!MARKER.has(norm(words[i]!.text))) substance += weightOf(i);
        for (const [key, v] of votes.get(i)!) {
          nodes.set(v.node, (nodes.get(v.node) ?? 0) + v.v);
          const k = keys.get(key);
          if (k) k.v += v.v;
          else keys.set(key, { ...v });
        }
      }
      let winner: string | null = null;
      let top = 0;
      for (const [n, v] of nodes) if (v > top) [winner, top] = [n, v];
      return { a, b, weight, substance, nodes, keys, winner, conf: weight > 0 ? Math.min(1, top / weight) : 0 };
    };
    const labelled = (t: Tally) => t.winner !== null && t.conf >= cfg.minConf;

    // C + F. Chunks at soft breaks, merged unless both sides clearly point at different things.
    const chunks = chunkRanges(words, u0, u1, cfg).map(([a, b]) => tally(a, b));
    const merged: Tally[] = [];
    let cur = chunks[0]!;
    for (const c of chunks.slice(1)) {
      const split =
        labelled(c) && labelled(cur) && c.winner !== cur.winner && c.substance >= cfg.minSubstance && cur.substance >= cfg.minSubstance && c.conf >= cfg.splitConf && cur.conf >= cfg.splitConf;
      if (split) {
        merged.push(cur);
        cur = c;
      } else {
        cur = tally(cur.a, c.b);
      }
    }
    merged.push(cur);

    // G + H. Targets for each note.
    for (const t of merged) {
      const w0 = words[t.a]!;
      const w1 = words[t.b - 1]!;
      const [x0, x1] = [w0.t0 - cfg.lagMs - cfg.halfMs, w1.t1];
      const targetFor = (node: string): Target => {
        const nodeVotes = t.nodes.get(node) ?? 0;
        let best: Vote | undefined;
        for (const v of t.keys.values()) if (v.node === node && (!best || v.v > best.v)) best = v;
        const handle = best?.handle && best.v >= cfg.handleShare * nodeVotes ? best.handle : undefined;
        const at = restingPoint(kept, node, handle, x0, x1);
        return { node, ...(handle && { handle }), ...(at && { at }) };
      };

      const pair: string[] = [];
      for (let i = t.a; i < t.b; i++) {
        if (cls[i] !== 'deictic') continue;
        const byNode = new Map<string, number>();
        for (const v of votes.get(i)!.values()) byNode.set(v.node, (byNode.get(v.node) ?? 0) + v.v);
        const total = [...byNode.values()].reduce((s, v) => s + v, 0);
        const [node, top] = [...byNode].reduce((m, e) => (e[1] > m[1] ? e : m), ['', 0] as [string, number]);
        if (total >= cfg.pairMinCover * weightOf(i) && top >= cfg.pairMinShare * total && !pair.includes(node)) pair.push(node);
      }

      let targets: Target[] = [];
      let reason: Reason = 'none';
      if (pair.length >= 2) {
        targets = pair.slice(0, cfg.maxTargets).map(targetFor);
        reason = 'pair';
      } else if (labelled(t)) {
        targets = [targetFor(t.winner!)];
        reason = 'hover';
      }
      push({ text: sentence(words.slice(t.a, t.b)), w0: t.a, w1: t.b, t0: w0.t0, t1: w1.t1, targets, confidence: reason === 'none' ? 0 : t.conf, reason });
    }
    prevNode = notes.at(-1)?.targets[0]?.node ?? null;
  }
  return notes;

  // I. Carry a target over to a follow-up with none; merge consecutive notes on the same targets.
  function push(n: DraftNote) {
    const prev = notes.at(-1);
    const near = prev && n.t0 - prev.t1 <= cfg.carryMs;
    if (!n.targets.length && near && prev.targets.length) {
      n.targets = prev.targets.map((t) => structuredClone(t));
      n.reason = 'carry';
      n.confidence = prev.confidence / 2;
    }
    if (near && sameTargets(prev, n)) {
      notes[notes.length - 1] = {
        ...prev,
        text: `${prev.text} ${n.text}`,
        w1: n.w1,
        t1: n.t1,
        confidence: Math.max(prev.confidence, n.confidence),
        reason: prev.reason === 'carry' ? n.reason : prev.reason,
      };
    } else {
      notes.push(n);
    }
  }
}

const sameTargets = (a: DraftNote, b: DraftNote) =>
  a.targets.length === b.targets.length && a.targets.every((t, i) => targetKey(t) === targetKey(b.targets[i]!));

/** B. Word index ranges split at long silences. */
function utterances(words: readonly Word[], cfg: AlignConfig): [number, number][] {
  const out: [number, number][] = [];
  let s = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.t0 - words[i - 1]!.t1 >= cfg.hardGapMs) {
      out.push([s, i]);
      s = i;
    }
  }
  out.push([s, words.length]);
  return out;
}

/** C. Places a note may split inside an utterance: short pauses, phrase breaks, sentence ends, "and / also / then…". */
function chunkRanges(words: readonly Word[], u0: number, u1: number, cfg: AlignConfig): [number, number][] {
  const out: [number, number][] = [];
  let s = u0;
  for (let i = u0 + 1; i < u1; i++) {
    const w = words[i]!;
    const p = words[i - 1]!;
    if (w.t0 - p.t1 >= cfg.softGapMs || w.phraseStart || /[.?!]$/.test(p.text) || (MARKER.has(norm(w.text)) && i - s >= 2)) {
      out.push([s, i]);
      s = i;
    }
  }
  out.push([s, u1]);
  return out;
}
