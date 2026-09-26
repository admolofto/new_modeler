import { applyOps, type Op, type OpResult } from './ops';
import type { Doc } from './schema';

export interface DispatchOptions {
  /**
   * Consecutive dispatches with the same key collapse into one undo step
   * (e.g. live-typing a width). Any other dispatch, undo or redo ends the run.
   */
  coalesce?: string;
}

export interface Store {
  readonly doc: Doc;
  dispatch(ops: readonly Op[], opts?: DispatchOptions): OpResult;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Replaces the doc (e.g. file load) as an undoable step. */
  replace(doc: Doc): void;
  subscribe(fn: (doc: Doc) => void): () => void;
}

const MAX_HISTORY = 200;

/** Undo history holds whole-doc snapshots: docs are immutable once committed, so undo is just a pointer swap. */
export function createStore(initial: Doc): Store {
  let doc = initial;
  const past: Doc[] = [];
  let future: Doc[] = [];
  let coalesceKey: string | null = null;
  const listeners = new Set<(doc: Doc) => void>();
  const emit = () => listeners.forEach((fn) => fn(doc));

  const commit = (next: Doc, key: string | null) => {
    if (key === null || key !== coalesceKey) {
      past.push(doc);
      if (past.length > MAX_HISTORY) past.shift();
    }
    coalesceKey = key;
    future = [];
    doc = next;
    emit();
  };

  return {
    get doc() {
      return doc;
    },
    dispatch(ops, opts) {
      const result = applyOps(doc, ops);
      if (result.ok) commit(result.doc, opts?.coalesce ?? null);
      return result;
    },
    undo() {
      const prev = past.pop();
      if (!prev) return false;
      future.push(doc);
      doc = prev;
      coalesceKey = null;
      emit();
      return true;
    },
    redo() {
      const next = future.pop();
      if (!next) return false;
      past.push(doc);
      doc = next;
      coalesceKey = null;
      emit();
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    replace(next) {
      commit(next, null);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
