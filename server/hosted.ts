import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AiRequest } from '../src/ai/agent.ts';
import { ACCESS_HEADER } from '../src/ai/access.ts';
import { CLAUDE_EFFORTS, requestedEffort, requestedModel, type Effort } from '../src/ai/models.ts';
import { parseTidyReply, TIDY_JSON_SCHEMA, TIDY_SYSTEM, TidyInput, tidyPrompt } from '../src/ai/tidy.ts';
import { claudeClient, claudeConfig, createMessage } from './claude.ts';

/**
 * The AI endpoints for the hosted app (a web link, e.g. on Vercel), where there is no
 * Claude Code or Codex login to borrow: only the API engine, paid with the server's
 * ANTHROPIC_API_KEY. Every call needs APP_ACCESS_CODE in the x-access-code header, so the
 * link alone doesn't spend the key. Same request and reply shapes as server/aiProxy.ts.
 *   GET  /api/ai/config       { hosted: true, access: 'ok' | 'needed', api, claudeCode, codex }
 *   GET  /api/ai/models       the configured API model
 *   POST /api/ai/messages     an AiRequest in, the final Claude message out
 *   POST /api/ai/tidy-notes   { input: TidyInput } in, { notes } out
 */

/** Requests carry a model snapshot and a few screenshots; anything bigger is refused. */
const MAX_BODY = 12_000_000;

export function hostedAi(env: Record<string, string | undefined>) {
  const cfg = claudeConfig(env);
  let client: Anthropic | undefined;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('request too large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const granted = (req: IncomingMessage) => {
    const want = env.APP_ACCESS_CODE;
    const got = req.headers[ACCESS_HEADER];
    if (!want || typeof got !== 'string') return false;
    const a = Buffer.from(want.trim().toLowerCase());
    const b = Buffer.from(got.trim().toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const abortOnClose = (res: ServerResponse) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    return abort;
  };

  const failed = (res: ServerResponse, err: unknown, signal: AbortSignal) => {
    if (signal.aborted && !(err instanceof Anthropic.APIError)) return json(res, 504, { error: { message: 'timed out' } });
    // A 401 here means the access code; the key's own auth failures go out as 502.
    if (err instanceof Anthropic.APIError) return json(res, err.status === 401 || err.status === 403 || !err.status ? 502 : err.status, { error: { type: err.name, message: err.message } });
    json(res, 500, { error: { message: (err as Error).message } });
  };

  async function messages(req: IncomingMessage, res: ServerResponse) {
    let body: AiRequest;
    let model: string | undefined;
    let effort: Effort | undefined;
    try {
      const raw = (await readJson(req)) as Partial<AiRequest>;
      model = requestedModel(raw.model);
      effort = requestedEffort(raw.effort, CLAUDE_EFFORTS) as Effort | undefined;
      if (!Array.isArray(raw.messages) || typeof raw.max_tokens !== 'number') throw new Error('expected messages and max_tokens');
      body = { messages: raw.messages, max_tokens: raw.max_tokens, system: raw.system, tools: raw.tools, cache_control: raw.cache_control };
    } catch (err) {
      return json(res, 400, { error: { message: `bad request: ${(err as Error).message}` } });
    }
    const abort = abortOnClose(res);
    try {
      client ??= claudeClient(env);
      json(res, 200, await createMessage(client, { ...cfg, ...(model && { model }), ...(effort && { effort }) }, body, abort.signal));
    } catch (err) {
      if (!res.destroyed) failed(res, err, abort.signal);
    }
  }

  async function tidyNotes(req: IncomingMessage, res: ServerResponse) {
    let input: TidyInput;
    try {
      const r = TidyInput.safeParse((await readJson(req)).input);
      if (!r.success) throw new Error(z.prettifyError(r.error));
      input = r.data;
    } catch (err) {
      return json(res, 400, { error: { message: `bad request: ${(err as Error).message}` } });
    }
    const abort = abortOnClose(res);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
    const started = Date.now();
    try {
      client ??= claudeClient(env);
      const msg = await createMessage(
        client,
        cfg,
        { system: TIDY_SYSTEM, messages: [{ role: 'user', content: tidyPrompt(input) }], max_tokens: 8000 },
        signal,
        { effort: 'low', format: { type: 'json_schema', schema: TIDY_JSON_SCHEMA } },
      );
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      json(res, 200, { ...parseTidyReply(text, new Set(input.candidates.map((c) => c.id))), engine: 'api', ms: Date.now() - started });
    } catch (err) {
      if (!res.destroyed) failed(res, err, signal);
    }
  }

  /** `path` is what follows /api/ai/ (e.g. 'config'). */
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const route = `${req.method} ${path.replace(/^\/+|\/+$/g, '')}`;
    if (route === 'GET config') {
      return json(res, 200, {
        hosted: true,
        access: granted(req) ? 'ok' : 'needed',
        api: { ...cfg, hasKey: !!env.ANTHROPIC_API_KEY },
        claudeCode: { available: false, version: null, model: 'default' },
        codex: { available: false, version: null, model: 'default', loggedIn: false },
      });
    }
    if (!granted(req)) return json(res, 401, { error: { type: 'access_code', message: 'The access code is missing or wrong.' } });
    if (route === 'GET models') return json(res, 200, { models: [{ id: cfg.model, label: cfg.model }] });
    if (route === 'POST messages') return messages(req, res);
    if (route === 'POST tidy-notes') return tidyNotes(req, res);
    json(res, 404, { error: { message: 'not found' } });
  };
}
