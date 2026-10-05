import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import '../plugins';
import { modelSnapshot } from '../ai/context';
import { dimensionLines } from '../edit/dimensions';
import { duplicateOps } from '../edit/duplicate';
import { inferMove, inferDraw, inferExtrude, inferSplit } from '../edit/snap';
import { createSceneSync } from '../render/sceneSync';
import { cutList } from './cutlist';
import { DEFAULT_CARCASS, emptyDoc } from './defaults';
import { applyOps, type Op } from './ops';
import { deserialize, serialize } from './persistence';
import type { Doc } from './schema';
import { parentIndex } from './doc';
import { createStore } from './store';
import { enclosingAssembly, hiddenNodes, isolateView, isolationBroken, outsideOf, unclickableNodes } from './visibility';
import { worldBoxes } from './world';

function edit(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const hide = (id: string, hidden = true): Op => ({ op: 'update', id, patch: { hidden } });
function fixture(): Doc {
  return edit(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'cab', name: 'Cabinet' } },
    { op: 'add', entity: { kind: 'assembly', id: 'door', name: 'Door' }, parent: 'cab' },
    ...['panel', 'rail'].map((id): Op => ({ op: 'add', parent: 'door', entity: {
      kind: 'part', id, name: id, material: 'ply-3-4', shape: { type: 'box', params: { x: 640, y: 640, z: 46 } },
    } })),
    { op: 'add', entity: { kind: 'block', id: 'block', size: [64, 64, 64] } },
  ]);
}

describe('viewport visibility', () => {
  it('inherits through folders, preserves child eyes, saves, and supports undo/redo without changing cut sizes', () => {
    const doc = fixture();
    const store = createStore(doc);
    expect(store.dispatch([hide('panel')]).ok).toBe(true);
    expect(store.dispatch([hide('cab')]).ok).toBe(true);
    expect(hiddenNodes(store.doc)).toEqual(new Set(['cab', 'door', 'panel', 'rail']));
    expect(cutList(store.doc)).toEqual(cutList(doc));
    expect(hiddenNodes(deserialize(serialize(store.doc)))).toEqual(hiddenNodes(store.doc));
    store.undo();
    expect(hiddenNodes(store.doc)).toEqual(new Set(['panel']));
    store.redo();
    expect(store.doc.assemblies.cab!.hidden).toBe(true);
    store.dispatch([hide('cab', false)]);
    expect(hiddenNodes(store.doc)).toEqual(new Set(['panel']));
    expect(JSON.parse(modelSnapshot(store.doc)).tree[0].children[0].children[0].hidden).toBe(true);
  });

  it('keeps generated part visibility through regeneration and reload; showing clears its override', () => {
    const doc = edit(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'cab', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    const hidden = edit(doc, [hide('cab.side-left'), { op: 'update', id: 'cab', patch: { params: { width: 40 * 64 } } }]);
    expect(deserialize(serialize(hidden)).parts['cab.side-left']!.hidden).toBe(true);
    const shown = edit(hidden, [hide('cab.side-left', false), { op: 'update', id: 'cab', patch: { params: { width: 32 * 64 } } }]);
    expect(shown.parts['cab.side-left']!.hidden).toBeUndefined();
    expect(shown.assemblies.cab!.generator!.overrides['side-left']).toBeUndefined();
  });

  it('removes hidden objects from rendered geometry and raycasting, and restores them', () => {
    const doc = fixture();
    const sync = createSceneSync(new THREE.Scene());
    sync.update(doc);
    expect(sync.meshes()).toHaveLength(3);
    sync.update(edit(doc, [hide('door'), hide('block')]));
    expect(sync.meshes()).toHaveLength(0);
    expect(sync.meshOf('panel')).toBeUndefined();
    let meshCount = 0;
    sync.root.traverse((node) => { if (node instanceof THREE.Mesh) meshCount++; });
    expect(meshCount).toBe(0);
    sync.update(doc);
    expect(sync.meshes()).toHaveLength(3);
  });

  it('excludes hidden folder descendants from snapping in every drawing mode', () => {
    const doc = edit(fixture(), [hide('cab'), hide('block')]);
    const boxes = worldBoxes(doc);
    expect(dimensionLines(doc, [])).toEqual([]);
    expect(inferMove(doc, 0, { min: [-100, 0, 0], max: [-50, 10, 10] }, 50, 5, boxes)).toBeNull();
    expect(inferDraw(doc, 1, [1, 0, 1], 5, boxes, 16).nodes).toEqual([]);
    expect(inferExtrude(doc, 0, 0, 1, 639, 5, boxes, 16).snapped).toBe(false);
    expect(inferSplit(doc, 0, 1000, 639, 5, boxes, 16)?.node).toBe('');
  });
});

describe('viewport clickability', () => {
  const lock = (id: string, unclickable = true): Op => ({ op: 'update', id, patch: { unclickable } });

  it('inherits through folders and keeps unclickable parts drawn but out of picking', () => {
    const doc = edit(fixture(), [lock('door')]);
    expect(unclickableNodes(doc)).toEqual(new Set(['door', 'panel', 'rail']));
    const sync = createSceneSync(new THREE.Scene());
    sync.update(doc);
    expect(sync.meshes()).toHaveLength(3);
    expect(sync.pickable().map((m) => m.userData.partId)).toEqual(['block']);
    sync.update(edit(doc, [lock('door', false)]));
    expect(sync.pickable()).toHaveLength(3);
  });

  it('keeps a generated part unclickable through regeneration and reload', () => {
    const doc = edit(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'cab', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    const locked = edit(doc, [lock('cab.side-left'), { op: 'update', id: 'cab', patch: { params: { width: 40 * 64 } } }]);
    expect(deserialize(serialize(locked)).parts['cab.side-left']!.unclickable).toBe(true);
    const freed = edit(locked, [lock('cab.side-left', false)]);
    expect(freed.assemblies.cab!.generator!.overrides['side-left']).toBeUndefined();
  });
});

describe('isolating a folder', () => {
  const panel = (id: string, parent: string | null, at: [number, number, number]): Op => ({ op: 'add', parent, entity: {
    kind: 'part', id, name: id, material: 'ply-3-4', transform: { position: at }, shape: { type: 'box', params: { x: 640, y: 640, z: 46 } },
  } });
  /** A kitchen folder holding a sink base (with a drawers folder) and a dishwasher; a fridge block on its own. */
  function room(): Doc {
    return edit(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Kitchen' } },
      { op: 'add', entity: { kind: 'assembly', id: 'sink', name: 'Sink base' }, parent: 'room' },
      { op: 'add', entity: { kind: 'assembly', id: 'drawers', name: 'Drawers' }, parent: 'sink' },
      { op: 'add', entity: { kind: 'assembly', id: 'dw', name: 'Dishwasher' }, parent: 'room' },
      panel('side', 'sink', [0, 0, 0]),
      panel('front', 'drawers', [128, 640, 0]),
      panel('dwPanel', 'dw', [2560, 0, 0]),
      { op: 'add', entity: { kind: 'block', id: 'fridge', transform: { position: [4000, 0, 0], rotation: [0, 0, 0] }, size: [1920, 4480, 1920] } },
    ]);
  }
  const partBoxes = (doc: Doc) => new Map([...worldBoxes(doc)].filter(([id]) => doc.parts[id]));

  it('is a view: everything outside the folder hidden, its own eyes kept, the model untouched', () => {
    const doc = edit(room(), [hide('front')]);
    const before = serialize(doc);
    const view = isolateView(doc, 'sink');
    expect(hiddenNodes(view)).toEqual(new Set(['front', 'dw', 'dwPanel', 'fridge']));
    expect(view.assemblies.room!.hidden).toBeUndefined();
    expect(isolateView(doc, 'sink')).toBe(view);
    expect(isolateView(doc, null)).toBe(doc);
    expect(isolateView(doc, 'nope')).toBe(doc);
    expect(isolateView(doc, 'side')).toBe(doc);
    expect(serialize(doc)).toBe(before);
    expect(hiddenNodes(doc)).toEqual(new Set(['front']));
  });

  it('draws only the folder, where it sits in the room', () => {
    const doc = room();
    const full = createSceneSync(new THREE.Scene());
    full.update(doc);
    const sync = createSceneSync(new THREE.Scene());
    sync.update(isolateView(doc, 'sink'));
    expect(sync.meshes().map((m) => m.userData.partId).sort()).toEqual(['front', 'side']);
    for (const id of ['front', 'side']) {
      const [a, b] = [sync.meshOf(id)!, full.meshOf(id)!];
      a.updateWorldMatrix(true, false);
      b.updateWorldMatrix(true, false);
      expect(a.matrixWorld.toArray()).toEqual(b.matrixWorld.toArray());
    }
    sync.update(doc);
    expect(sync.meshes()).toHaveLength(4);
  });

  it('snaps only to what the isolated view shows', () => {
    const doc = room();
    const view = isolateView(doc, 'dw');
    const boxes = partBoxes(doc);
    const box = () => ({ min: [700, 0, 0] as [number, number, number], max: [800, 640, 46] as [number, number, number] });
    expect(inferMove(doc, 0, box(), -50, 20, boxes)?.node).toBe('side');
    expect(inferMove(view, 0, box(), -50, 20, boxes)).toBeNull();
    expect(inferDraw(doc, 1, [645, 0, 300], 20, boxes, 32).nodes).toEqual(['side']);
    expect(inferDraw(view, 1, [645, 0, 300], 20, boxes, 32).nodes).toEqual([]);
  });

  it('puts a block drawn while isolated into the folder, where it was drawn, in a turned folder or a cabinet alike', () => {
    const doc = edit(room(), [{ op: 'move', id: 'dw', to: [3000, 0, 500], rotation: [0, 90, 0] }]);
    const add: Op = { op: 'add', entity: { kind: 'block', id: 'b9', transform: { position: [100, 0, 200], rotation: [0, 0, 0] }, size: [640, 640, 640] } };
    const atTop = edit(doc, [add]);
    const inFolder = edit(doc, [add, { op: 'move', id: 'b9', parent: 'dw', keepWorld: true }]);
    expect(parentIndex(inFolder).get('b9')).toBe('dw');
    expect(worldBoxes(inFolder).get('b9')).toEqual(worldBoxes(atTop).get('b9'));

    const cab = edit(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'cab', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } }]);
    const inCab = edit(cab, [add, { op: 'move', id: 'b9', parent: 'cab', keepWorld: true }]);
    const wider = edit(inCab, [{ op: 'update', id: 'cab', patch: { params: { width: 40 * 64 } } }]);
    expect(wider.assemblies.cab!.children).toContain('b9');
    expect(worldBoxes(wider).get('b9')).toEqual(worldBoxes(inCab).get('b9'));
  });

  it('finds the folder holding a selection, and what lies outside a folder', () => {
    const doc = room();
    expect(enclosingAssembly(doc, ['side', 'front'])).toBe('sink');
    expect(enclosingAssembly(doc, ['front'])).toBe('drawers');
    expect(enclosingAssembly(doc, ['side', 'dwPanel'])).toBe('room');
    expect(enclosingAssembly(doc, ['side', 'fridge'])).toBeNull();
    expect(enclosingAssembly(doc, [])).toBeNull();
    expect(outsideOf(doc, 'sink', ['sink', 'side', 'front', 'dwPanel', 'room'])).toEqual(['dwPanel', 'room']);
    expect(outsideOf(doc, 'gone', ['side'])).toEqual(['side']);
  });

  it('gives way when the folder goes, or something new would land unseen outside it', () => {
    const store = createStore(room());
    const start = store.doc;
    expect(store.dispatch([{ op: 'add', parent: 'drawers', entity: { kind: 'block', id: 'b1', size: [64, 64, 64] } }]).ok).toBe(true);
    expect(isolationBroken(start, store.doc, 'sink')).toBeNull();
    const before = store.doc;
    expect(store.dispatch(duplicateOps(store.doc, ['sink']).ops).ok).toBe(true);
    expect(isolationBroken(before, store.doc, 'sink')).toBe('outside');
    expect(isolationBroken(before, edit(before, [hide('room')]), 'sink')).toBe('gone');
    expect(isolationBroken(before, edit(before, [{ op: 'delete', id: 'sink' }]), 'sink')).toBe('gone');

    const undo = createStore(room());
    undo.dispatch([{ op: 'delete', id: 'fridge' }]);
    const without = undo.doc;
    undo.undo();
    expect(isolationBroken(without, undo.doc, 'sink')).toBe('outside');
  });
});
