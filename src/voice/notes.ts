import type { TidyInput, TidyOutput } from '../ai/tidy';
import { describeTarget, isGround, targetKey, type Target } from '../edit/targets';
import type { V3 } from '../geometry/types';
import { parentIndex } from '../model/doc';
import type { Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { ALIGN, keptAt, keptSpans, type DraftNote, type Kept, type Word } from './align';
import type { HoverSpan } from './hoverLog';

/**
 * From a finished voice session to annotation ops: the candidates the tidy pass may attach
 * notes to, its input, reading its reply (or the drafts, if it's skipped or fails), a fallback
 * target for notes about nothing in particular, and the ops. Pure.
 */

export interface NoteSpec {
  note: string;
  targets: Target[];
}

export interface Candidate {
  id: number;
  target: Target;
  label: string;
  hovered: boolean;
}

const MAX_CANDIDATES = 120;

/** Where the cursor rested longest over these spans. */
function longestRest(spans: readonly Kept[]): V3 | undefined {
  let best: V3 | undefined;
  let rest = -1;
  for (const k of spans) {
    k.ats.forEach((s, i) => {
      const r = (k.ats[i + 1]?.t ?? k.t1) - s.t;
      if (r > rest) [best, rest] = [s.at, r];
    });
  }
  return best && [...best];
}

/**
 * Things notes may attach to: the drafts' targets, everything pointed at (each face / edge, and
 * its part), the assemblies above those, and every part when there aren't too many.
 */
export function candidates(doc: Doc, spans: readonly HoverSpan[], drafts: readonly DraftNote[], maxParts = 80): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (target: Target, hovered: boolean) => {
    const k = targetKey(target);
    if (seen.has(k) || !(doc.parts[target.node] || doc.assemblies[target.node] || isGround(target))) return;
    seen.add(k);
    out.push({ id: out.length + 1, target, label: describeTarget(doc, target), hovered });
  };
  for (const d of drafts) for (const t of d.targets) add(structuredClone(t), true);

  const kept = keptSpans(spans);
  const byKey = new Map<string, Kept[]>();
  const byNode = new Map<string, Kept[]>();
  for (const k of kept) {
    byKey.set(k.key, [...(byKey.get(k.key) ?? []), k]);
    byNode.set(k.node, [...(byNode.get(k.node) ?? []), k]);
  }
  const withAt = (t: Target, ks: Kept[]): Target => {
    const at = longestRest(ks);
    return at ? { ...t, at } : t;
  };
  for (const ks of byKey.values()) {
    const { node, handle } = ks[0]!;
    if (ks.reduce((ms, k) => ms + k.t1 - k.t0, 0) >= ALIGN.minDwellMs) add(withAt({ node, ...(handle && { handle }) }, ks), true);
  }
  for (const [node, ks] of byNode) add(withAt({ node }, ks), true);

  const parents = parentIndex(doc);
  for (const node of byNode.keys()) {
    for (let p = parents.get(node) ?? null; p; p = parents.get(p) ?? null) add({ node: p }, false);
  }
  const parts = Object.keys(doc.parts);
  if (parts.length <= maxParts) for (const id of parts) add({ node: id }, false);

  const counts = new Map<string, number>();
  for (const c of out) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  for (const c of out) if (counts.get(c.label)! > 1) c.label = `${c.label} [${c.target.node}]`;
  return out.slice(0, MAX_CANDIDATES);
}

const idFinder = (cands: readonly Candidate[]) => {
  const byKey = new Map(cands.map((c) => [targetKey(c.target), c]));
  return (key: string, node: string) => byKey.get(key) ?? byKey.get(node);
};

/** The tidy request: candidates, the transcript with hover markers and pauses, and the drafts. */
export function tidyInput(words: readonly Word[], spans: readonly HoverSpan[], drafts: readonly DraftNote[], cands: readonly Candidate[], t0: number): TidyInput {
  const kept = keptSpans(spans);
  const find = idFinder(cands);
  const parts: string[] = [];
  let last = '';
  words.forEach((w, i) => {
    if (i > 0 && w.t0 - words[i - 1]!.t1 >= ALIGN.hardGapMs) parts.push('‖');
    const k = keptAt(kept, w.t0);
    const c = k ? find(k.key, k.node) : undefined;
    const mark = c ? `#${c.id} ${c.label}` : 'nothing';
    if (mark !== last) parts.push(`[${(Math.max(0, w.t0 - t0) / 1000).toFixed(1)}s → ${mark}]`);
    last = mark;
    parts.push(w.text);
  });
  let transcript = parts.join(' ');
  if (transcript.length > 20_000) transcript = `${transcript.slice(0, 19_990)} …`;
  return {
    candidates: cands.map(({ id, label, hovered }) => ({ id, label, hovered })),
    transcript,
    drafts: drafts.slice(0, 40).map((d) => ({
      text: d.text.slice(0, 5_000),
      targets: d.targets.flatMap((t) => find(targetKey(t), t.node)?.id ?? []).slice(0, 4),
      confidence: Math.round(d.confidence * 100) / 100,
    })),
  };
}

export function fromTidy(out: TidyOutput, cands: readonly Candidate[]): NoteSpec[] {
  const byId = new Map(cands.map((c) => [c.id, c.target]));
  return out.notes
    .map((n) => ({ note: n.note.trim(), targets: n.targets.flatMap((id) => (byId.has(id) ? [structuredClone(byId.get(id)!)] : [])) }))
    .filter((n) => n.note);
}

export function fromDrafts(drafts: readonly DraftNote[]): NoteSpec[] {
  return drafts.filter((d) => d.text).map((d) => ({ note: d.text, targets: d.targets.map((t) => structuredClone(t)) }));
}

/** Notes with no target get the fallback (the selection, else the model's root, else the ground); with none, they're skipped. */
export function attach(notes: readonly NoteSpec[], fallback: readonly Target[]): { notes: NoteSpec[]; skipped: string[] } {
  const ready: NoteSpec[] = [];
  const skipped: string[] = [];
  for (const n of notes) {
    if (n.targets.length) ready.push(n);
    else if (fallback.length) ready.push({ ...n, targets: fallback.map((t) => structuredClone(t)) });
    else skipped.push(n.note);
  }
  return { notes: ready, skipped };
}

export function noteOps(notes: readonly NoteSpec[]): Op[] {
  return notes.map((n) => ({ op: 'add', entity: { kind: 'annotation', note: n.note, targets: n.targets } }));
}
