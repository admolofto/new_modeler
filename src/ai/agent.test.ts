import { describe, expect, it } from 'vitest';
import '../plugins';
import { DEFAULT_CARCASS, demoDoc, emptyDoc } from '../model/defaults';
import { applyOps, type Op } from '../model/ops';
import type { Doc } from '../model/schema';
import { inches } from '../model/units';
import { newChat, runTurn, type Message, type Send } from './agent';
import { modelSnapshot } from './context';
import { mcpToolDefs, normalizeLengths, runTool, TOOL_ASK, toolDefs } from './tools';
import { overlaps, worldBoxes } from '../model/world';

function ok(doc: Doc, ops: Op[]): Doc {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

let n = 0;
function reply(content: Message['content'], stop: Message['stop_reason'] = 'end_turn'): Message {
  return {
    id: `msg_${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Message;
}
const toolCall = (id: string, input: unknown): Message['content'][number] =>
  ({ type: 'tool_use', id, name: 'apply_ops', input }) as unknown as Message['content'][number];
const say = (text: string): Message['content'][number] => ({ type: 'text', text, citations: null }) as unknown as Message['content'][number];

/** Replays canned responses and records every request. */
function scripted(responses: Message[]) {
  const requests: Parameters<Send>[0][] = [];
  const send: Send = async (req) => {
    requests.push(structuredClone(req));
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    return next;
  };
  return { send, requests };
}

const panel = (id: string, x = 0): Op => ({
  op: 'add',
  entity: { kind: 'part', id, name: id, material: 'ply-3-4', transform: { position: [x, 0, 0] }, shape: { type: 'box', params: { x: inches(12), y: inches(30), z: 46 } } },
});

describe('markup', () => {
  it('puts open notes in the snapshot with target points, and sends screenshots', async () => {
    const doc = ok(demoDoc(), [
      { op: 'add', entity: { kind: 'annotation', note: 'overhang 1 1/2"', targets: [{ node: 'tabletop', handle: 'face:top' }, { node: 'a1.side-right', handle: 'face:right' }] } },
      { op: 'add', entity: { kind: 'annotation', note: 'done already', targets: [{ node: 'door' }], resolved: true } },
      { op: 'add', entity: { kind: 'annotation', note: 'stale', targets: [{ node: 'gone' }] } },
    ]);
    const snap = JSON.parse(modelSnapshot(doc));
    expect(snap.notes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n3']);
    expect(snap.notes[0].targets[1]).toEqual({ node: 'a1.side-right', name: 'Right side', handle: 'face:right', point: [inches(36), inches(17.25), inches(12)] });
    expect(snap.notes[1].targets[0]).toEqual({ node: 'gone', missing: true });

    const { send, requests } = scripted([reply([toolCall('t1', { ops: [{ op: 'update', id: 'n1', patch: { resolved: true } }] })], 'tool_use'), reply([say('Done.')])]);
    const r = await runTurn({ send, chat: newChat(), doc, text: 'fix my notes', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] });
    const first = requests[0]!.messages[0]!.content as { type: string }[];
    expect(first.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(r.draft.annotations.n1!.resolved).toBe(true);
  });
});

describe('tool schemas', () => {
  it('are generated from the registry', () => {
    const [apply, inspect] = toolDefs();
    const text = JSON.stringify(apply!.input_schema);
    expect(apply!.input_schema.type).toBe('object');
    for (const needle of ['"carcass"', '"drawers"', '"hole"', '"pocket"', '"edgeProfile"', '"outline"', '"box"', 'Frameless cabinet']) {
      expect(text).toContain(needle);
    }
    expect(inspect!.name).toBe('inspect_part');
    expect(text.length).toBeLessThan(40_000);
  });

  it('converts inch strings to model units', () => {
    expect(normalizeLengths({ a: '34 1/2in', b: ['3/4"', '12 inches'], name: 'Left side', n: 5 })).toEqual({
      a: inches(34.5),
      b: [48, inches(12)],
      name: 'Left side',
      n: 5,
    });
  });
});

describe('runTool', () => {
  it('rejects a bad batch without touching the draft, then applies a good one', () => {
    const state = { draft: emptyDoc(), ops: [] as Op[] };
    const bad = runTool(state, 'apply_ops', { ops: [panel('a'), { op: 'update', id: 'nope', patch: {} }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/nothing from this batch was applied.*op 2 \(update\): nothing with id "nope"/);
    expect(state.draft.parts).toEqual({});

    const good = runTool(state, 'apply_ops', { ops: [panel('a'), panel('b', inches(12))] });
    expect(good.isError).toBe(false);
    expect(good.content).toMatch(/Created: a "a", b "b"/);
    expect(state.ops).toHaveLength(2);
    expect(Object.keys(state.draft.parts)).toEqual(['a', 'b']);
  });

  it('warns about interpenetrating parts', () => {
    const state = { draft: emptyDoc(), ops: [] as Op[] };
    const out = runTool(state, 'apply_ops', { ops: [panel('a'), panel('b', inches(6))] });
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/interpenetrate[\s\S]*a "a" × b "b": 6" × 30" × 23\/32"/);
  });

  it('inspects a part', () => {
    const state = { draft: demoDoc(), ops: [] as Op[] };
    const out = JSON.parse(runTool(state, 'inspect_part', { id: 'door' }).content);
    expect(out.flatFaces.find((f: { id: string }) => f.id === 'face:front').u).toEqual([8, inches(17.75) - 8]); // flat area, inside the 1/8" roundover
    expect(out.edges).toContain('edge:top-front');
  });
});

describe('ask_user', () => {
  it('returns the questions for the chat and tells the model to wait for the answers', () => {
    const out = runTool({ draft: emptyDoc(), ops: [] }, TOOL_ASK, { questions: [{ question: ' Overlay or inset doors? ', options: ['Overlay', 'Inset'] }] });
    expect(out).toMatchObject({ isError: false, summary: 'asked 1 question', questions: [{ question: 'Overlay or inset doors?', options: ['Overlay', 'Inset'] }] });
    expect(out.content).toMatch(/End your turn/);
  });
  it('rejects empty or oversized question lists', () => {
    for (const input of [{}, { questions: [] }, { questions: [{ question: '' }] }, { questions: Array.from({ length: 5 }, () => ({ question: 'Why?' })) }, { questions: [{ question: 'Pick', options: ['a', 'b', 'c', 'd', 'e'] }] }]) {
      expect(runTool({ draft: emptyDoc(), ops: [] }, TOOL_ASK, input)).toMatchObject({ isError: true, summary: '✗ questions rejected' });
    }
  });
  it('is offered to the in-app chat only, not to outside MCP clients', () => {
    expect(toolDefs().map((t) => t.name)).toContain(TOOL_ASK);
    expect(mcpToolDefs({ chat: true }).map((t) => t.name)).toContain(TOOL_ASK);
    expect(mcpToolDefs().map((t) => t.name)).not.toContain(TOOL_ASK);
  });
});

describe('world bounds', () => {
  it('composes nested transforms and 90° rotations', () => {
    const d = ok(emptyDoc(), [
      { op: 'add', entity: { kind: 'assembly', id: 'run', transform: { position: [inches(10), 0, 0] } } },
      { ...panel('p'), parent: 'run' } as Op,
      { op: 'move', id: 'p', to: [0, 0, 0], rotation: [0, 90, 0] },
    ]);
    // 90° about Y maps local +X to world −Z.
    expect(worldBoxes(d).get('p')).toEqual({ min: [inches(10), 0, -inches(12)], max: [inches(10) + 46, inches(30), 0] });
  });

  it('bounds a generated carcass and ignores its own parts for overlaps', () => {
    const d = ok(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'a1', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS, drawers: [0, 0], shelves: 0 } } } }]);
    const box = worldBoxes(d).get('a1')!;
    expect(box.min).toEqual([0, 0, 0]);
    expect(box.max).toEqual([inches(36), inches(34.5), inches(24) + 46]); // fronts stand proud
    expect(overlaps(d, Object.keys(d.parts))).toEqual([]);
  });
});

describe('runTurn', () => {
  it('retries after a rejected batch and returns only the applied ops', async () => {
    const { send, requests } = scripted([
      reply([toolCall('t1', { ops: [{ op: 'delete', id: 'ghost' }] })], 'tool_use'),
      reply([toolCall('t2', { ops: [panel('side')] })], 'tool_use'),
      reply([say('Added a 12" × 30" panel.')]),
    ]);
    const chat = newChat();
    const events: string[] = [];
    const r = await runTurn({ send, chat, doc: emptyDoc(), text: 'add a panel', onEvent: (e) => events.push(e.type === 'tool' ? `${e.ok}` : e.text) });

    expect(r.stop).toBe('done');
    expect(r.text).toBe('Added a 12" × 30" panel.');
    expect(r.ops).toEqual([panel('side')]);
    expect(Object.keys(r.draft.parts)).toEqual(['side']);
    expect(events).toEqual(['false', 'true', 'Added a 12" × 30" panel.']);

    // user, assistant(tool_use), user(error result), assistant, user(result), assistant
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const firstResult = (chat.messages[2]!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(firstResult.is_error).toBe(true);
    expect(firstResult.content).toMatch(/nothing with id "ghost"/);
    expect(requests[0]!.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
    expect(JSON.stringify(requests[0]!.messages[0])).toContain('<model>');
  });

  it('sends "unchanged" only when the model has not moved since the last snapshot', async () => {
    const chat = newChat();
    const doc = emptyDoc();
    await runTurn({ send: scripted([reply([say('It is empty.')])]).send, chat, doc, text: 'what is here?' });
    const second = scripted([reply([toolCall('t', { ops: [panel('p')] })], 'tool_use'), reply([say('done')])]);
    await runTurn({ send: second.send, chat, doc, text: 'add a panel' });
    expect(JSON.stringify(second.requests[0]!.messages.at(-1))).toContain('model unchanged');

    // It applied ops, so even a rejected proposal forces a fresh snapshot next turn.
    const third = scripted([reply([say('ok')])]);
    await runTurn({ send: third.send, chat, doc, text: 'hi', note: 'The user rejected your last change.' });
    const last = JSON.stringify(third.requests[0]!.messages.at(-1));
    expect(last).toContain('<model>');
    expect(last).toContain('rejected your last change');
  });

  it('rolls the chat back when the request fails', async () => {
    const chat = newChat();
    const { send } = scripted([reply([toolCall('t', { ops: [panel('p')] })], 'tool_use')]);
    await expect(runTurn({ send, chat, doc: emptyDoc(), text: 'go' })).rejects.toThrow(/no more scripted/);
    expect(chat.messages).toEqual([]);
  });

  it('ends the turn on ask_user and sends its results with the answers', async () => {
    const chat = newChat();
    const questions = [{ question: 'How deep?', options: ['12"', '24"'] }, { question: 'Doors or drawers?' }];
    const first = scripted([reply([say('A couple of questions first.'), { type: 'tool_use', id: 'q1', name: TOOL_ASK, input: { questions } } as unknown as Message['content'][number]], 'tool_use')]);
    const events: unknown[] = [];
    const r = await runTurn({ send: first.send, chat, doc: emptyDoc(), text: 'build a cabinet', onEvent: (e) => events.push(e) });
    expect(r.stop).toBe('asked');
    expect(first.requests).toHaveLength(1); // no second request while the user answers
    expect(events.at(-1)).toMatchObject({ type: 'tool', name: TOOL_ASK, ok: true, questions });
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // The waiting tool result opens the next user message, ahead of the answers.
    const second = scripted([reply([say('Building it 24" deep with doors.')])]);
    await runTurn({ send: second.send, chat, doc: emptyDoc(), text: 'How deep? → 24"' });
    const content = second.requests[0]!.messages.at(-1)!.content as { type: string; tool_use_id?: string; text?: string }[];
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'q1' });
    expect(content.at(-1)).toMatchObject({ type: 'text', text: 'How deep? → 24"' });
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(chat.toolResults).toBeUndefined();
  });

  it('keeps ask_user results waiting when the answering turn fails', async () => {
    const chat = newChat();
    const ask = { type: 'tool_use', id: 'q1', name: TOOL_ASK, input: { questions: [{ question: 'Which side?' }] } } as unknown as Message['content'][number];
    await runTurn({ send: scripted([reply([ask], 'tool_use')]).send, chat, doc: emptyDoc(), text: 'add a door' });
    await expect(runTurn({ send: scripted([]).send, chat, doc: emptyDoc(), text: 'left' })).rejects.toThrow(/no more scripted/);
    expect(chat.messages).toHaveLength(2);
    expect(chat.toolResults?.[0]).toMatchObject({ tool_use_id: 'q1' });
  });

  it('drops a tool call truncated by max_tokens', async () => {
    const chat = newChat();
    const { send } = scripted([reply([toolCall('t', { ops: [panel('p')] })], 'max_tokens')]);
    const r = await runTurn({ send, chat, doc: emptyDoc(), text: 'go' });
    expect(r.stop).toBe('max_tokens');
    expect(r.ops).toEqual([]);
    expect(chat.messages.map((m) => m.role)).toEqual(['user']);
  });
});
