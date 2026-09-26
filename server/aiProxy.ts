import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import type { Plugin, ViteDevServer } from 'vite';
import { z } from 'zod';
import type { AiRequest, ImageAttachment } from '../src/ai/agent.ts';
import { parseTidyReply, TIDY_JSON_SCHEMA, TIDY_SYSTEM, TidyInput, tidyPrompt } from '../src/ai/tidy.ts';
import { createBridge } from './bridge.ts';
import { claudeClient, claudeConfig, createMessage } from './claude.ts';
import { claudeCodeConfig, claudeCodeVersion, runClaudeCode, runClaudeOnce, TIDY_PROMPT_FILE } from './claudeCode.ts';
import { createMcpHandler } from './mcp.ts';

/**
 * AI endpoints on the Vite dev server (localhost only):
 *   /mcp                      MCP server; tools run in the open modeler tab (Claude Code connects here)
 *   GET  /api/ai/config       which engines are available
 *   POST /api/ai/messages     API engine: an AiRequest in, the final Claude message out (needs ANTHROPIC_API_KEY)
 *   POST /api/ai/claude-code  Claude Code engine: { prompt, sessionId? } in, NDJSON events out (uses your Claude Code login)
 *   POST /api/ai/tidy-notes   { engine?, input: TidyInput } in, { notes } out: cleans up dictated voice notes (src/ai/tidy.ts)
 * Keys and credentials stay in Node; nothing secret reaches the browser.
 */
export function aiProxy(env: Record<string, string | undefined>): Plugin {
  const cfg = claudeConfig(env);
  const ccCfg = claudeCodeConfig(env);
  const ccVersion = claudeCodeVersion(ccCfg);
  let client: Anthropic | undefined;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  /** Browsers send Origin on cross-site requests; only the app's own pages (or non-browser clients) get in. */
  const localOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };

  /** Ends a request's work when the client goes away. */
  const abortOnClose = (res: ServerResponse) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    return abort;
  };

  async function messages(req: IncomingMessage, res: ServerResponse) {
    let body: AiRequest;
    try {
      const raw = (await readJson(req)) as Partial<AiRequest>;
      if (!Array.isArray(raw.messages) || typeof raw.max_tokens !== 'number') throw new Error('expected messages and max_tokens');
      // Only the fields the app uses; model and options are set server-side.
      body = { messages: raw.messages, max_tokens: raw.max_tokens, system: raw.system, tools: raw.tools, cache_control: raw.cache_control };
    } catch (err) {
      return json(res, 400, { error: { message: `bad request: ${(err as Error).message}` } });
    }
    const abort = abortOnClose(res);
    try {
      client ??= claudeClient(env);
      json(res, 200, await createMessage(client, cfg, body, abort.signal));
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof Anthropic.APIError) {
        return json(res, err.status ?? 502, { error: { type: err.name, message: err.message } });
      }
      const hint = env.ANTHROPIC_API_KEY ? '' : ' — set ANTHROPIC_API_KEY in .env.local (see .env.example) and restart the dev server';
      return json(res, 500, { error: { message: `${(err as Error).message}${hint}` } });
    }
  }

  /** Screenshots from the page: JPEG/PNG base64, a few MB at most. */
  const parseImages = (raw: unknown): ImageAttachment[] => {
    if (raw === undefined) return [];
    const ok = (x: unknown): x is ImageAttachment =>
      !!x && typeof x === 'object' && ['image/jpeg', 'image/png'].includes((x as ImageAttachment).mediaType) && typeof (x as ImageAttachment).data === 'string';
    if (!Array.isArray(raw) || raw.length > 4 || !raw.every(ok)) throw new Error('images must be up to 4 {mediaType, data} JPEG/PNG');
    if (raw.reduce((n, x) => n + x.data.length, 0) > 8_000_000) throw new Error('images too large');
    return raw.map(({ mediaType, data }) => ({ mediaType, data }));
  };

  async function claudeCode(server: ViteDevServer, req: IncomingMessage, res: ServerResponse) {
    let body: { prompt: string; sessionId?: string; images: ImageAttachment[] };
    try {
      const raw = await readJson(req);
      if (typeof raw.prompt !== 'string' || !raw.prompt) throw new Error('expected prompt');
      body = { prompt: raw.prompt, images: parseImages(raw.images), ...(typeof raw.sessionId === 'string' && { sessionId: raw.sessionId }) };
    } catch (err) {
      return json(res, 400, { error: { message: `bad request: ${(err as Error).message}` } });
    }
    const base = server.resolvedUrls?.local[0];
    if (!base) return json(res, 500, { error: { message: 'dev server URL unknown' } });
    const abort = abortOnClose(res);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const emit = (e: unknown) => res.write(`${JSON.stringify(e)}\n`);
    try {
      const result = await runClaudeCode({
        cfg: ccCfg,
        prompt: body.prompt,
        images: body.images,
        sessionId: body.sessionId,
        mcpUrl: new URL('/mcp', base).href,
        signal: abort.signal,
        onEvent: emit,
      });
      emit({ type: 'done', ...result });
    } catch (err) {
      if (!abort.signal.aborted) emit({ type: 'error', message: (err as Error).message });
    }
    res.end();
  }

  /** Tidies dictated notes on the chat's engine, or the other one if that can't run. Capped at 60s. */
  async function tidyNotes(req: IncomingMessage, res: ServerResponse) {
    let input: TidyInput;
    let wanted: string | undefined;
    try {
      const raw = await readJson(req);
      const r = TidyInput.safeParse(raw.input);
      if (!r.success) throw new Error(z.prettifyError(r.error));
      input = r.data;
      wanted = typeof raw.engine === 'string' ? raw.engine : undefined;
    } catch (err) {
      return json(res, 400, { error: { message: `bad request: ${(err as Error).message}` } });
    }
    const hasCc = (await ccVersion) !== null;
    const hasKey = !!env.ANTHROPIC_API_KEY;
    const engine = wanted === 'api' ? (hasKey || !hasCc ? 'api' : 'claude-code') : hasCc ? 'claude-code' : 'api';
    const abort = abortOnClose(res);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
    const started = Date.now();
    try {
      let text: string;
      if (engine === 'api') {
        client ??= claudeClient(env);
        const msg = await createMessage(
          client,
          cfg,
          { system: TIDY_SYSTEM, messages: [{ role: 'user', content: tidyPrompt(input) }], max_tokens: 8000 },
          signal,
          { effort: 'low', format: { type: 'json_schema', schema: TIDY_JSON_SCHEMA } },
        );
        text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      } else {
        const r = await runClaudeOnce({ cfg: ccCfg, systemPromptFile: TIDY_PROMPT_FILE, prompt: tidyPrompt(input), signal });
        if (r.isError) return json(res, 502, { error: { message: r.text || 'Claude Code failed', hint: r.hint } });
        text = r.text;
      }
      const ids = new Set(input.candidates.map((c) => c.id));
      json(res, 200, { ...parseTidyReply(text, ids), engine, ms: Date.now() - started });
    } catch (err) {
      if (abort.signal.aborted) return;
      const status = err instanceof Anthropic.APIError ? (err.status ?? 502) : 500;
      json(res, status, { error: { message: signal.aborted ? 'timed out' : (err as Error).message } });
    }
  }

  return {
    name: 'ai-proxy',
    configureServer(server) {
      const mcp = createMcpHandler(createBridge(server));
      server.middlewares.use('/mcp', (req, res) => {
        if (!localOrigin(req)) return json(res, 403, { error: { message: 'forbidden origin' } });
        void mcp(req, res);
      });
      server.middlewares.use('/api/ai', (req, res) => {
        const url = req.url ?? '';
        if (!localOrigin(req)) return json(res, 403, { error: { message: 'forbidden origin' } });
        if (req.method === 'GET' && url.startsWith('/config')) {
          void ccVersion.then((version) =>
            json(res, 200, {
              api: { ...cfg, hasKey: !!env.ANTHROPIC_API_KEY },
              claudeCode: { available: version !== null, version, model: ccCfg.model ?? 'default' },
            }),
          );
          return;
        }
        if (req.method === 'POST' && url.startsWith('/messages')) return void messages(req, res);
        if (req.method === 'POST' && url.startsWith('/claude-code')) return void claudeCode(server, req, res);
        if (req.method === 'POST' && url.startsWith('/tidy-notes')) return void tidyNotes(req, res);
        json(res, 404, { error: { message: 'not found' } });
      });
    },
  };
}
