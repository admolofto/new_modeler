import { expect, it } from 'vitest';
import '../plugins';
import { emptyDoc } from '../model/defaults';
import { nodeAffine } from '../model/world';
import { diffDocs } from './diff';
import { runTool, type ToolState } from './tools';

it('organizes existing door parts with a reviewable tree change and unchanged world geometry/bindings', () => {
  const state: ToolState = { draft: emptyDoc(), ops: [] };
  const apply = (ops: unknown[]) => {
    const r = runTool(state, 'apply_ops', { ops });
    expect(r.isError, r.content).toBe(false);
    return r;
  };
  apply([
    { op: 'add', entity: { kind: 'assembly', id: 'cab', name: 'Cabinet', transform: { position: [640, 128, 192], rotation: [0, 90, 0] } } },
    { op: 'add', entity: { kind: 'variable', id: 'offset', name: 'Offset', group: 'Door', value: 64 } },
    { op: 'add', parent: 'cab', entity: { kind: 'part', id: 'panel', name: 'Panel', material: 'ply-3-4', shape: { type: 'box', params: { x: 640, y: 1280, z: 46 } } } },
    { op: 'bind', node: 'panel', path: 'position.x', expr: 'offset' },
  ]);
  const before = state.draft;
  const result = apply([
    { op: 'add', parent: 'cab', entity: { kind: 'assembly', id: 'door', name: 'Door' } },
    { op: 'move', id: 'panel', parent: 'door' },
  ]);
  expect(nodeAffine(state.draft, 'panel')).toEqual(nodeAffine(before, 'panel'));
  expect(state.draft.parts.panel).toEqual(before.parts.panel);
  expect(state.draft.assemblies.door!.children).toEqual(['panel']);
  expect(result.content).toContain('panel "Panel" under door "Door"');
  expect(diffDocs(before, state.draft).lines).toContain('~ Panel: moved into Door');
  const organized = state.draft;
  apply([{ op: 'update', id: 'door', patch: { hidden: true } }]);
  expect(diffDocs(organized, state.draft).lines).toContain('~ Door: hidden in viewport');
});

it('flags tree problems the batch introduced, and only those', () => {
  const state: ToolState = { draft: emptyDoc(), ops: [] };
  let x = 0;
  const part = (id: string, name: string) => ({ op: 'add', entity: { kind: 'part', id, name, material: 'ply-3-4', transform: { position: [(x += 2000), 0, 0] }, shape: { type: 'box', params: { x: 640, y: 640, z: 46 } } } });
  const messy = runTool(state, 'apply_ops', { ops: [
    part('leg1', 'Leg'), part('leg2', 'Leg'),
    { op: 'add', entity: { kind: 'assembly', id: 'stuff', name: 'Assembly' } },
  ] });
  expect(messy.content).toContain('Tree check');
  expect(messy.content).toContain('stuff "Assembly" has a default name');
  expect(messy.content).toContain('stuff "Assembly" is an empty folder');
  expect(messy.content).toContain('leg1 "Leg" and leg2 "Leg" share a name under the top level');
  expect(messy.content).toContain('2 parts are loose at the top level');

  const tidy = runTool(state, 'apply_ops', { ops: [
    { op: 'update', id: 'stuff', patch: { name: 'Bench' } },
    { op: 'move', id: 'leg1', parent: 'stuff', keepWorld: true },
    { op: 'move', id: 'leg2', parent: 'stuff', keepWorld: true },
    { op: 'update', id: 'leg1', patch: { name: 'Left leg' } },
    { op: 'update', id: 'leg2', patch: { name: 'Right leg' } },
  ] });
  expect(tidy.isError, tidy.content).toBe(false);
  expect(tidy.content).not.toContain('Tree check');
  // Untouched mess elsewhere stays quiet.
  runTool(state, 'apply_ops', { ops: [part('a', 'Part'), part('bb', 'Part')] });
  expect(runTool(state, 'apply_ops', { ops: [{ op: 'update', id: 'stuff', patch: { name: 'Bench 48"' } }] }).content).not.toContain('Tree check');
});
