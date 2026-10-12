import { modelSnapshot, savedRecipes } from '../ai/context';
import { diffDocs, type DocDiff } from '../ai/diff';
import { runTool, TOOL_GET_MODEL, type ToolOutcome, type ToolState, type VersionHost } from '../ai/tools';
import { applyOps, type Op } from '../model/ops';
import type { Recipe } from '../model/recipes';
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
  /** The user's saved recipe library, if the app has one (reading it may throw). */
  readonly recipes: (() => readonly Recipe[]) | undefined;
  /** The app's design versions, for the AI's new_version. */
  readonly versions: AppVersions | undefined;
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

export interface ProposalOptions {
  /** The user's saved recipes, for the AI's recipe catalog and tools. */
  recipes?: () => readonly Recipe[];
  /** The app's design versions (ui/versions.ts). */
  versions?: AppVersions;
}

export interface AppVersions extends VersionHost {
  /** The versions for the AI, in a line; empty while there's only one. */
  describe(): string;
}

export function createProposals(store: Store, options: ProposalOptions = {}): Proposals {
  let pending: Proposal | null = null;
  let note: string | undefined;
  /** The version the AI's new_version started (MCP calls arrive one at a time); a new chat turn starts on the open one. */
  let building: ToolState['building'];
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
    recipes: options.recipes,
    versions: options.versions,
    add(ops, draft) {
      if (!ops.length) return;
      const base = pending && !pending.stale ? pending.ops : [];
      pending = { ops: [...base, ...ops], draft, diff: diffDocs(store.doc, draft) };
      emit();
    },
    runTool(name, input) {
      let out: ToolOutcome;
      const built = building && options.versions?.doc(building.id);
      if (name === TOOL_GET_MODEL && building && built) {
        const status = `You are building version ${building.label}, a separate design alternative (not a proposal); the model below is that version.`;
        out = { content: `${status}\n<model>\n${modelSnapshot(built, savedRecipes(options.recipes))}\n</model>`, isError: false, summary: `read ${building.label}` };
      } else if (name === TOOL_GET_MODEL) {
        out = { content: `${self.status()}\n<model>\n${modelSnapshot(working(), savedRecipes(options.recipes))}\n</model>`, isError: false, summary: 'read the model' };
      } else {
        const state: ToolState = { draft: working(), ops: [], recipes: options.recipes, versions: options.versions, building };
        out = runTool(state, name, input);
        building = state.building;
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
      building = undefined;
      const versions = options.versions?.describe();
      if (pending && !pending.stale) {
        return [versions, 'Your last proposal has not been accepted yet. The snapshot includes it; changes you make now are added to the same proposal.'].filter(Boolean).join(' ');
      }
      const n = note;
      note = undefined;
      return [versions, n].filter(Boolean).join(' ') || undefined;
    },
    status() {
      const versions = options.versions?.describe();
      const head = versions ? `${versions} ` : '';
      if (pending && !pending.stale) return `${head}A proposal of ${pending.ops.length} ops is pending (not yet accepted); the model below includes it and new changes add to it.`;
      return head + (note ?? 'No proposal is pending.');
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
