import { describe, expect, it } from 'vitest';
import '../plugins';
import { runTool, TOOL_APPLY, TOOL_NEW_VERSION, type ToolState, type VersionHost } from '../ai/tools';
import { demoDoc, emptyDoc } from './defaults';
import { applyOps } from './ops';
import { serialize } from './persistence';
import type { Doc } from './schema';
import { createStore } from './store';
import {
  addVersion, deserializeVersions, findVersion, neighborOf, newVersionSet, openVersions, removeVersion, serializeVersions, updateVersion, versionTitle,
} from './versions';

const block = (id: string, x = 0): Doc => {
  const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'block', id, name: id, transform: { position: [x, 0, 0], rotation: [0, 0, 0] }, size: [640, 640, 640] } }]);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};

describe('design versions', () => {
  it('number versions and never reuse a number', () => {
    let set = newVersionSet(emptyDoc(), 1);
    set = addVersion(set, { doc: emptyDoc(), by: 'user' }).set;
    const { set: s3, version } = addVersion(set, { doc: emptyDoc(), by: 'ai', name: ' L-shape ', summary: 'Sink on the return' });
    expect(version).toMatchObject({ id: 'v3', n: 3, name: 'L-shape', unseen: true });
    expect(versionTitle(version)).toBe('v3 · L-shape');
    const s4 = addVersion(removeVersion(s3, 'v2'), { doc: emptyDoc(), by: 'user' }).version;
    expect(s4.id).toBe('v4');
    expect(findVersion(s3, 'l-shape')?.id).toBe('v3');
    expect(findVersion(s3, 'V2')?.id).toBe('v2');
  });

  it('archive out of the tabs and pick a neighbour to show', () => {
    let set = newVersionSet(emptyDoc());
    set = addVersion(set, { doc: emptyDoc(), by: 'user' }).set;
    set = addVersion(set, { doc: emptyDoc(), by: 'user' }).set;
    expect(neighborOf(set, 'v2')).toBe('v3');
    expect(neighborOf(set, 'v3')).toBe('v2');
    set = updateVersion(set, 'v2', { archived: true });
    expect(openVersions(set).map((v) => v.id)).toEqual(['v1', 'v3']);
    expect(updateVersion(set, 'v2', { archived: false }).versions[1]).not.toHaveProperty('archived');
    expect(() => removeVersion(set, 'v1')).toThrow();
  });

  it('save every version in one file that older apps read as the open one', () => {
    let set = newVersionSet(block('a'));
    set = addVersion(set, { doc: block('b', 1280), by: 'ai', name: 'Island', summary: 'An island' }).set;
    set = updateVersion({ ...set, active: 'v2' }, 'v1', { archived: true });
    const text = serializeVersions(set, block('b2', 1280));
    const raw = JSON.parse(text) as { parts: Record<string, unknown>; versions: { active: string; list: { doc?: unknown }[] } };
    // The open version is the file's own model; the others ride along.
    expect(Object.keys(raw.parts)).toEqual(['b2']);
    expect(raw.versions.active).toBe('v2');
    expect(raw.versions.list[1]).not.toHaveProperty('doc');

    const back = deserializeVersions(text);
    expect(back.active).toBe('v2');
    expect(back.versions.map((v) => [v.id, v.name, !!v.archived])).toEqual([['v1', '', true], ['v2', 'Island', false]]);
    expect(Object.keys(back.versions[0]!.doc.parts)).toEqual(['a']);
    expect(Object.keys(back.versions[1]!.doc.parts)).toEqual(['b2']);
    expect(back.versions[1]!.summary).toBe('An island');
  });

  it('save a single version as a plain model file, and open plain files as one version', () => {
    const doc = demoDoc();
    expect(serializeVersions(newVersionSet(doc), doc)).toBe(serialize(doc));
    const set = deserializeVersions(serialize(doc));
    expect(set.versions).toHaveLength(1);
    expect(set.active).toBe('v1');
  });

  it('name the version that fails to load', () => {
    let set = newVersionSet(emptyDoc());
    set = addVersion(set, { doc: emptyDoc(), by: 'user', name: 'Galley' }).set;
    const raw = JSON.parse(serializeVersions(set, emptyDoc())) as { versions: { list: { doc?: { version: number } }[] } };
    raw.versions.list[1]!.doc!.version = 999;
    expect(() => deserializeVersions(JSON.stringify(raw))).toThrow(/v2 · Galley/);
  });
});

describe('store.swap', () => {
  it('swaps docs with their own undo history, not as an undo step', () => {
    const store = createStore(block('a'));
    store.dispatch([{ op: 'update', id: 'a', patch: { name: 'A2' } }]);
    const hist = store.swap(block('b'));
    expect(store.canUndo()).toBe(false);
    expect(Object.keys(store.doc.parts)).toEqual(['b']);
    store.swap(block('a'), hist);
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.doc.parts.a!.name).toBe('a');
  });
});

describe('new_version tool', () => {
  function host(open: Doc) {
    const docs = new Map<string, Doc>([['v1', open]]);
    const h: VersionHost = {
      start: (name, _summary, from) => {
        const id = `v${docs.size + 1}`;
        const base = docs.get(from ?? 'v1');
        if (!base) throw new Error(`there's no version "${from}"`);
        docs.set(id, base);
        return { id, label: `${id} · ${name}` };
      },
      doc: (id) => docs.get(id),
      save: (id, doc) => void docs.set(id, doc),
    };
    return { h, docs };
  }
  const addBlock = (id: string) => ({ ops: [{ op: 'add', entity: { kind: 'block', id, name: id, size: [640, 640, 640] } }] });

  it('builds alternatives in their own versions and leaves the open one’s proposal alone', () => {
    const { h, docs } = host(block('a'));
    const state: ToolState = { draft: docs.get('v1')!, ops: [], versions: h };
    expect(runTool(state, TOOL_APPLY, addBlock('p')).isError).toBe(false);
    expect(runTool(state, TOOL_NEW_VERSION, { name: 'Galley' }).isError).toBe(false);
    const out = runTool(state, TOOL_APPLY, addBlock('g'));
    expect(out.summary).toMatch(/^v2 · Galley: /);
    runTool(state, TOOL_NEW_VERSION, { name: 'Island', from: 'v1' });
    runTool(state, TOOL_APPLY, addBlock('i'));
    // The proposal holds only what came before new_version.
    expect(state.ops).toHaveLength(1);
    expect(Object.keys(state.draft.parts).sort()).toEqual(['a', 'p']);
    expect(Object.keys(docs.get('v2')!.parts).sort()).toEqual(['a', 'g']);
    expect(Object.keys(docs.get('v3')!.parts).sort()).toEqual(['a', 'i']);
    expect(Object.keys(docs.get('v1')!.parts)).toEqual(['a']);
  });

  it('says why when there are no versions or the base is missing', () => {
    expect(runTool({ draft: emptyDoc(), ops: [] }, TOOL_NEW_VERSION, { name: 'x' }).isError).toBe(true);
    const { h } = host(emptyDoc());
    const out = runTool({ draft: emptyDoc(), ops: [], versions: h }, TOOL_NEW_VERSION, { name: 'x', from: 'v9' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/no version "v9"/);
  });
});
