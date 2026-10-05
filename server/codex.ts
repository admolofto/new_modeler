import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageAttachment } from '../src/ai/agent.ts';
import type { CliEvent } from '../src/ai/cliTransport.ts';
import { SYSTEM_PROMPT } from '../src/ai/prompt.ts';
import { TIDY_JSON_SCHEMA, TIDY_SYSTEM } from '../src/ai/tidy.ts';
import { mcpToolDefs } from '../src/ai/tools.ts';
import type { ToolCaller } from './mcp.ts';
import type { ModelOption } from '../src/ai/models.ts';

/** Codex app-server uses the CLI's existing login; credentials never enter the browser. */
export interface CodexConfig {
  bin: string;
  model?: string;
  effort?: string;
  cwd: string;
}

export function resolveCodexBin(env: Record<string, string | undefined>, platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const installed = join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (exists(installed)) return installed;
  }
  if (env.CODEX_CLI_PATH && exists(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (platform === 'win32') {
    const path = env.PATH ?? env.Path ?? '';
    for (const directory of path.split(';').filter(Boolean)) {
      const executable = join(directory.replace(/^"|"$/g, ''), 'codex.exe');
      if (exists(executable)) return executable;
    }
  }
  return 'codex';
}

export function codexConfig(env: Record<string, string | undefined>): CodexConfig {
  const cwd = join(tmpdir(), 'new-modeler-codex');
  mkdirSync(cwd, { recursive: true });
  return { bin: resolveCodexBin(env), model: env.CODEX_MODEL, effort: env.CODEX_EFFORT, cwd };
}

export const CODEX_LOGIN_HINT = 'Sign in to Codex with ChatGPT: run `codex login` in a terminal, then refresh the app.';

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Do not pass the hosting Codex chat's identity or an API key into an independent session.
  for (const key of Object.keys(env)) {
    if ((key.startsWith('CODEX_') && key !== 'CODEX_HOME') || key === 'OPENAI_API_KEY') delete env[key];
  }
  return env;
}

/** Scope this modeling assistant to the live model tools and a read-only filesystem. */
const CONFIG = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  'features.multi_agent': false,
  'features.code_mode.enabled': false,
  web_search: 'disabled',
  mcp_servers: {},
  plugins: {},
  hooks: {},
};

type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };

/** Newline-delimited JSON-RPC over stdio; no shell quoting or browser credentials. */
class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private stopped: Error | undefined;
  private onAbort: () => void;
  onMessage: (message: RpcMessage) => void = () => undefined;
  onFailure: (error: Error) => void = () => undefined;

  constructor(cfg: CodexConfig, private signal?: AbortSignal) {
    const overrides = Object.entries(CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    this.child = spawn(cfg.bin, ['app-server', '--listen', 'stdio://', ...overrides], { cwd: cfg.cwd, env: childEnv(), windowsHide: true });
    let buf = '';
    let stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as RpcMessage;
          if (message.method) this.onMessage(message);
          else if (typeof message.id === 'number') {
            const request = this.pending.get(message.id);
            if (!request) continue;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
          }
        } catch (err) {
          this.fail(new Error(`Invalid Codex response: ${(err as Error).message}`));
        }
      }
    });
    this.child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    this.child.on('error', (err) => this.fail(new Error(`Couldn't start Codex (${cfg.bin}): ${err.message}. Set CODEX_BIN in .env.local if needed.`)));
    this.child.stdin.on('error', (err) => this.fail(err));
    this.child.on('close', (code) => this.fail(new Error(`Codex exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`)));
    this.onAbort = () => this.fail(new Error('stopped'));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  write(message: RpcMessage) {
    if (!this.stopped) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'new_modeler', title: 'Modeler', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.signal?.removeEventListener('abort', this.onAbort);
    this.child.kill();
    this.onFailure(error);
  }

  close() { this.fail(new Error('Codex connection closed.')); }
}

export async function codexStatus(cfg: CodexConfig) {
  const version = await new Promise<string | null>((resolve) => {
    const child = spawn(cfg.bin, ['--version'], { env: childEnv(), windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', (data) => { out += data; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
  });
  const base = { available: version !== null, version, model: cfg.model ?? 'default', loggedIn: false };
  if (!version) return { ...base, hint: 'Codex CLI not found. Install Codex or set CODEX_BIN in .env.local, then restart the dev server.' };
  const rpc = new CodexRpc(cfg);
  try {
    await rpc.initialize();
    const account = await rpc.request('account/read', { refreshToken: false });
    return { ...base, loggedIn: !!account.account, ...(!account.account && { hint: CODEX_LOGIN_HINT }) };
  } catch (err) {
    return { ...base, hint: (err as Error).message };
  } finally { rpc.close(); }
}

export async function codexModels(cfg: CodexConfig): Promise<ModelOption[]> {
  const rpc = new CodexRpc(cfg);
  try {
    await rpc.initialize();
    const models = new Map<string, ModelOption>();
    let cursor: string | undefined;
    do {
      const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor && { cursor }) });
      for (const entry of page.data ?? []) {
        if (!entry.hidden && typeof entry.model === 'string') models.set(entry.model, { id: entry.model, label: entry.displayName || entry.model });
      }
      const next = page.nextCursor as string | null;
      if (next === cursor) break;
      cursor = next ?? undefined;
    } while (cursor);
    return [...models.values()];
  } finally { rpc.close(); }
}

export interface CodexResult {
  sessionId: string;
  text: string;
  isError: boolean;
  hint?: string;
  outputTokens?: number;
}

export async function runCodex(opts: {
  cfg: CodexConfig;
  prompt: string;
  images?: ImageAttachment[];
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: CliEvent) => void;
  /** The same caller as MCP: model changes land in the browser's pending proposal. */
  call?: ToolCaller;
  tidy?: boolean;
}): Promise<CodexResult> {
  opts.signal?.throwIfAborted();
  const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(10 * 60_000)]);
  const rpc = new CodexRpc(opts.cfg, signal);
  try {
    await rpc.initialize();
    const account = await rpc.request('account/read', { refreshToken: false });
    if (!account.account) throw new Error(CODEX_LOGIN_HINT);
    const tools = opts.call && !opts.tidy ? mcpToolDefs() : [];
    const names = new Set(tools.map((tool) => tool.name));
    const settings = {
      cwd: opts.cfg.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: CONFIG,
      baseInstructions: opts.tidy ? TIDY_SYSTEM : SYSTEM_PROMPT,
      developerInstructions: 'Use only the supplied modeling tools. Do not use shell, files, web, other MCP servers, or agents. Ask questions in your reply when needed.',
      ...(opts.cfg.model && { model: opts.cfg.model }),
    };
    const response = opts.sessionId && !opts.tidy
      ? await rpc.request('thread/resume', { ...settings, threadId: opts.sessionId })
      : await rpc.request('thread/start', {
          ...settings,
          ephemeral: !!opts.tidy,
          dynamicTools: tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema })),
        });
    const sessionId: string = response.thread.id;
    opts.onEvent?.({ type: 'session', id: sessionId });
    let text = '';
    let outputTokens: number | undefined;
    let turnId: string | undefined;
    let resolveTurn!: (result: CodexResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexResult>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // Install handlers before turn/start: notifications may precede its response.
    rpc.onFailure = rejectTurn;
    rpc.onMessage = (message) => {
      const p = message.params;
      if (p?.threadId && p.threadId !== sessionId) return;
      if (p?.turnId && turnId && p.turnId !== turnId) return;
      if (message.id !== undefined) {
        if (message.method === 'item/tool/call') {
          void (async () => {
            try {
              signal.throwIfAborted();
              if (!opts.call || !names.has(p.tool)) throw new Error(`Tool unavailable: ${p.tool}`);
              const result = await opts.call(p.tool, p.arguments);
              rpc.write({ id: message.id, result: { contentItems: [{ type: 'inputText', text: result.content }], success: !result.isError } });
            } catch (err) {
              rpc.write({ id: message.id, result: { contentItems: [{ type: 'inputText', text: (err as Error).message }], success: false } });
            }
          })();
        } else if (message.method?.endsWith('/requestApproval')) {
          rpc.write({ id: message.id, result: { decision: 'decline' } });
        } else {
          rpc.write({ id: message.id, error: { code: -32601, message: 'This modeling assistant supports only modeling tool calls.' } });
        }
      } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
        text = p.item.text;
        if (text) opts.onEvent?.({ type: 'text', text });
      } else if (message.method === 'thread/tokenUsage/updated') {
        outputTokens = p.tokenUsage?.last?.outputTokens;
      } else if (message.method === 'turn/completed') {
        if (turnId && p.turn.id !== turnId) return;
        const isError = p.turn.status !== 'completed';
        const detail = p.turn.error?.message || (isError ? `Codex turn ${p.turn.status}.` : text);
        resolveTurn({ sessionId, text: detail, isError, outputTokens, ...(isError && /auth|log ?in|credential/i.test(detail) && { hint: CODEX_LOGIN_HINT }) });
      }
    };
    // A failed turn/start or closed process must not leave an unhandled rejection.
    void completion.catch(() => undefined);
    const started = await rpc.request('turn/start', {
      threadId: sessionId,
      input: [
        { type: 'text', text: opts.prompt, text_elements: [] },
        ...(opts.images ?? []).map((img) => ({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` })),
      ],
      ...(opts.tidy ? { effort: 'low', outputSchema: TIDY_JSON_SCHEMA } : opts.cfg.effort ? { effort: opts.cfg.effort } : {}),
    });
    turnId = started.turn.id;
    return await completion;
  } finally { rpc.close(); }
}
