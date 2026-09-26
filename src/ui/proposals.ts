import { modelSnapshot } from '../ai/context';
import { diffDocs, type DocDiff } from '../ai/diff';
import { runTool, TOOL_GET_MODEL, type ToolOutcome, type ToolState } from '../ai/tools';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';

/**
 * The pending AI proposal, shared by every way the AI reaches the model: the in-app chat
 * (API or Claude Code engine) and a Claude Code session driving the MCP tools directly.
 * AI changes accumulate here until the user accepts (one dispatch = one undo step) or
 * rejects them.
 */

export interface Proposal {
  /** Every op of the proposal so far (may span several turns). */
  ops: Op[];
  draft: Doc;
  diff: DocDiff;
  /** Set when the doc changed underneath and the ops no longer apply. */
  stale?: string;
}

export interface Proposals {
  readonly pending: Proposal | null;
  /** What the AI builds on: the pending draft if there is one, else the store's doc. */
  working(): Doc;
  /** Appends ops that were applied on top of `working()`, giving `draft`. */
  add(ops: Op[], draft: Doc): void;
  /** Runs an AI tool against the working doc; applied ops join the proposal. */
  runTool(name: string, input: unknown): ToolOutcome;
  accept(): boolean;
  reject(): void;
  /** One-shot note for the next chat turn about what happened to the last proposal. */
  takeNote(): string | undefined;
  /** Status line for the AI: pending proposal or last decision. */
  status(): string;
  subscribe(fn: () => void): void;
  /** Tool runs, e.g. from a Claude Code session, for the chat log. */
  onTool(fn: (name: string, out: ToolOutcome) => void): void;
}

export function createProposals(store: Store): Proposals {
  let pending: Proposal | null = null;
  let note: string | undefined;
  const listeners = new Set<() => void>();
  const toolListeners = new Set<(name: string, out: ToolOutcome) => void>();
  const emit = () => listeners.forEach((fn) => fn());

  const working = () => (pending && !pending.stale ? pending.draft : store.doc);

  // Keep the proposal on top of whatever the store holds now (undo, panel edits…).
  store.subscribe((doc) => {
    if (!pending) return;
    const r = applyOps(doc, pending.ops);
    pending = r.ok ? { ops: pending.ops, draft: r.doc, diff: diffDocs(doc, r.doc) } : { ...pending, stale: r.error };
    emit();
  });

  const self: Proposals = {
    get pending() {
      return pending;
    },
    working,
    add(ops, draft) {
      if (!ops.length) return;
      const base = pending && !pending.stale ? pending.ops : [];
      pending = { ops: [...base, ...ops], draft, diff: diffDocs(store.doc, draft) };
      emit();
    },
    runTool(name, input) {
      let out: ToolOutcome;
      if (name === TOOL_GET_MODEL) {
        out = { content: `${self.status()}\n<model>\n${modelSnapshot(working())}\n</model>`, isError: false, summary: 'read the model' };
      } else {
        const state: ToolState = { draft: working(), ops: [] };
        out = runTool(state, name, input);
        self.add(state.ops, state.draft);
      }
      toolListeners.forEach((fn) => fn(name, out));
      return out;
    },
    accept() {
      const p = pending;
      if (!p || p.stale) return false;
      pending = null; // before dispatch, so the store listener doesn't re-apply it
      const r = store.dispatch(p.ops);
      if (!r.ok) {
        pending = { ...p, stale: r.error };
        emit();
        return false;
      }
      note = 'The user accepted your last proposal; it is now part of the model.';
      emit();
      return true;
    },
    reject() {
      pending = null;
      note = 'The user rejected your last proposal; none of it was applied.';
      emit();
    },
    takeNote() {
      if (pending && !pending.stale) {
        return 'Your last proposal has not been accepted yet. The snapshot includes it; changes you make now are added to the same proposal.';
      }
      const n = note;
      note = undefined;
      return n;
    },
    status() {
      if (pending && !pending.stale) return `A proposal of ${pending.ops.length} ops is pending (not yet accepted); the model below includes it and new changes add to it.`;
      return note ?? 'No proposal is pending.';
    },
    subscribe(fn) {
      listeners.add(fn);
    },
    onTool(fn) {
      toolListeners.add(fn);
    },
  };
  return self;
}
