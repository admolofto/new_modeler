import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/plugins';
import type { CliEvent } from '../src/ai/cliTransport';
import { emptyDoc } from '../src/model/defaults';
import { createStore } from '../src/model/store';
import { createProposals } from '../src/ui/proposals';
import { CODEX_LOGIN_HINT, codexConfig, codexModels, codexStatus, resolveCodexBin, runCodex, type CodexConfig } from './codex';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: unknown };
class FakeCli extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  requests: Message[] = [];
  onInput: (message: Message) => void = () => undefined;
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      for (const raw of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(raw) as Message;
        this.requests.push(message);
        queueMicrotask(() => { if (!this.killed) this.onInput(message); });
      }
    });
  }
  send(message: Message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  reply(message: Message, result: unknown) { this.send({ id: message.id, result }); }
  kill() { this.killed = true; this.emit('close', 0); return true; }
}

const cfg: CodexConfig = { bin: 'codex.exe', cwd: process.cwd(), model: 'test-model', effort: 'high' };
let child: FakeCli;
let loggedIn: boolean;
let onTurn: (message: Message) => void;

beforeEach(() => {
  loggedIn = true;
  child = new FakeCli();
  onTurn = () => undefined;
  child.onInput = (message) => {
    if (message.method === 'initialize') child.reply(message, {});
    else if (message.method === 'account/read') child.reply(message, { account: loggedIn ? { type: 'chatgpt' } : null });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') child.reply(message, { thread: { id: message.params.threadId ?? 'modeler-session' } });
    else if (message.method === 'turn/start') { child.reply(message, { turn: { id: 'turn-1' } }); onTurn(message); }
  };
  vi.mocked(spawn).mockImplementation(() => child as unknown as ReturnType<typeof spawn>);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const notify = (method: string, params: Record<string, unknown>) => child.send({ method, params: { threadId: 'modeler-session', ...params } });
const complete = (status = 'completed', error?: { message: string }) => notify('turn/completed', { turn: { id: 'turn-1', status, error } });

describe('Codex modeling connection', () => {
  it('routes actual modeling tools into a reviewable proposal and reports the reply', async () => {
    const store = createStore(emptyDoc());
    const proposals = createProposals(store);
    const events: CliEvent[] = [];
    onTurn = () => {
      child.send({ id: 90, method: 'item/tool/call', params: { threadId: 'modeler-session', turnId: 'turn-1', tool: 'apply_ops', arguments: { ops: [{ op: 'add', entity: { kind: 'block', id: 'test-block', name: 'Codex block', size: [64, 64, 64] } }] } } });
    };
    const original = child.onInput;
    child.onInput = (message) => {
      original(message);
      if (message.id === 90 && message.result) {
        expect(message.result.success).toBe(true);
        notify('item/completed', { item: { type: 'agentMessage', text: 'Added a 1″ block.' } });
        notify('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { last: { outputTokens: 42 } } });
        complete();
      }
    };
    const result = await runCodex({ cfg, prompt: 'Add a block', call: async (name, input) => proposals.runTool(name, input), onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ sessionId: 'modeler-session', text: 'Added a 1″ block.', isError: false, outputTokens: 42 });
    expect(events).toEqual([{ type: 'session', id: 'modeler-session' }, { type: 'text', text: 'Added a 1″ block.' }]);
    expect(store.doc.parts['test-block']).toBeUndefined();
    expect(proposals.pending?.draft.parts['test-block']).toBeDefined();
    proposals.accept();
    expect(store.doc.parts['test-block']).toBeDefined();
    store.undo();
    expect(store.doc.parts['test-block']).toBeUndefined();
  });

  it('resumes the saved Codex session and supplies screenshot inputs', async () => {
    onTurn = () => complete();
    await runCodex({ cfg, prompt: 'Refine it', sessionId: 'modeler-session', images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(child.requests.some((message) => message.method === 'thread/start')).toBe(false);
    expect(child.requests.find((message) => message.method === 'thread/resume')?.params).toMatchObject({ threadId: 'modeler-session', sandbox: 'read-only', approvalPolicy: 'never', model: 'test-model' });
    expect(child.requests.find((message) => message.method === 'turn/start')?.params.input).toContainEqual({ type: 'image', url: 'data:image/png;base64,AAAA' });
  });

  it('returns failed turns as errors and rejects unknown tool calls', async () => {
    const call = vi.fn();
    onTurn = () => child.send({ id: 91, method: 'item/tool/call', params: { threadId: 'modeler-session', turnId: 'turn-1', tool: 'delete_files', arguments: {} } });
    const original = child.onInput;
    child.onInput = (message) => {
      original(message);
      if (message.id === 91 && message.result) {
        expect(message.result.success).toBe(false);
        complete('failed', { message: 'Authentication expired' });
      }
    };
    expect(await runCodex({ cfg, prompt: 'Test', call })).toMatchObject({ isError: true, text: 'Authentication expired', hint: CODEX_LOGIN_HINT });
    expect(call).not.toHaveBeenCalled();
  });

  it('cleans up the process and rejects when the user stops', async () => {
    const ctrl = new AbortController();
    onTurn = () => ctrl.abort();
    await expect(runCodex({ cfg, prompt: 'Test', signal: ctrl.signal })).rejects.toThrow('stopped');
    expect(child.killed).toBe(true);
  });

  it('surfaces a CLI crash instead of leaving the chat working indefinitely', async () => {
    onTurn = () => { child.stderr.write('CLI failure'); child.emit('close', 17); };
    await expect(runCodex({ cfg, prompt: 'Test' })).rejects.toThrow('Codex exited with code 17: CLI failure');
  });

  it('fails before inference when Codex is unsigned, with an actionable login hint', async () => {
    loggedIn = false;
    await expect(runCodex({ cfg, prompt: 'Test' })).rejects.toThrow('codex login');
    expect(child.requests.some((message) => message.method === 'turn/start')).toBe(false);
    expect(child.killed).toBe(true);
  });

  it('tidies voice notes with no modeling tools or persistent session', async () => {
    onTurn = () => { notify('item/completed', { item: { type: 'agentMessage', text: '{"notes":[]}' } }); complete(); };
    await runCodex({ cfg, prompt: 'Tidy', tidy: true });
    expect(child.requests.find((message) => message.method === 'thread/start')?.params).toMatchObject({ ephemeral: true, dynamicTools: [] });
    expect(child.requests.find((message) => message.method === 'turn/start')?.params).toMatchObject({ effort: 'low', outputSchema: expect.any(Object) });
  });

  it('drops inherited keys and desktop chat identity from the child process', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'never-pass-this');
    vi.stubEnv('CODEX_THREAD_ID', 'hosting-chat');
    onTurn = () => complete();
    await runCodex({ cfg, prompt: 'Test' });
    const options = vi.mocked(spawn).mock.calls[0]![2]!;
    expect(options.env?.OPENAI_API_KEY).toBeUndefined();
    expect(options.env?.CODEX_THREAD_ID).toBeUndefined();
    expect(options.windowsHide).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain('features.shell_tool=false');
  });
});

describe('Codex availability', () => {
  it('loads the model catalog across pages and excludes hidden entries', async () => {
    const original = child.onInput;
    child.onInput = (message) => {
      original(message);
      if (message.method === 'model/list') child.reply(message, message.params.cursor
        ? { data: [{ model: 'second', displayName: 'Second' }, { model: 'hidden', hidden: true }], nextCursor: null }
        : { data: [{ model: 'first', displayName: 'First' }], nextCursor: 'next' });
    };
    expect(await codexModels(cfg)).toEqual([{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]);
    expect(child.requests.filter((message) => message.method === 'model/list').map((message) => message.params.cursor)).toEqual([undefined, 'next']);
    expect(child.requests.some((message) => message.method === 'turn/start')).toBe(false);
    expect(child.killed).toBe(true);
  });
  it('detects the desktop executable while honoring explicit configuration', () => {
    expect(resolveCodexBin({ CODEX_CLI_PATH: 'desktop.exe' }, 'win32', () => true)).toBe('desktop.exe');
    expect(codexConfig({ CODEX_CLI_PATH: 'desktop.exe', CODEX_BIN: 'custom.exe' }).bin).toBe('custom.exe');
  });

  it('finds a Windows install added after the server started without relying on PATH', () => {
    const installed = join('local-app-data', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    let present = false;
    const exists = (path: string) => present && path === installed;
    const env = { LOCALAPPDATA: 'local-app-data', PATH: 'old-path' };
    expect(resolveCodexBin(env, 'win32', exists)).toBe('codex');
    present = true;
    expect(resolveCodexBin(env, 'win32', exists)).toBe(installed);
    expect(resolveCodexBin({ ...env, CODEX_BIN: 'custom.exe' }, 'win32', exists)).toBe('custom.exe');
  });

  it('ignores stale desktop paths and resolves native Windows PATH executables', () => {
    const installed = join('cli-bin', 'codex.exe');
    expect(resolveCodexBin({ CODEX_CLI_PATH: 'removed.exe', Path: 'other-bin;"cli-bin"' }, 'win32', (path) => path === installed)).toBe(installed);
    expect(resolveCodexBin({ LOCALAPPDATA: 'local-app-data' }, 'linux', () => true)).toBe('codex');
  });

  it('reports missing CLI without starting an account or inference request', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const missing = new FakeCli();
      queueMicrotask(() => missing.emit('error', new Error('ENOENT')));
      return missing as unknown as ReturnType<typeof spawn>;
    });
    expect(await codexStatus(cfg)).toMatchObject({ available: false, version: null, loggedIn: false });
  });

  it('distinguishes an installed CLI from a login, without returning account details', async () => {
    loggedIn = false;
    const version = new FakeCli();
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => { version.stdout.write('codex-cli test'); version.emit('close', 0); });
      return version as unknown as ReturnType<typeof spawn>;
    });
    expect(await codexStatus(cfg)).toEqual({ available: true, version: 'codex-cli test', model: 'test-model', loggedIn: false, hint: CODEX_LOGIN_HINT });
    expect(child.requests.some((message) => message.method === 'thread/start')).toBe(false);
  });
});
