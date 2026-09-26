import Anthropic from '@anthropic-ai/sdk';
import type { AiRequest, Message } from '../src/ai/agent.ts';

/**
 * Server-side Claude call, shared by the dev-server proxy and the eval runner. The browser
 * builds the conversation; model, effort and API options are fixed here so a page can't
 * pick them (and the key never leaves Node).
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeConfig {
  model: string;
  effort: Effort;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Reads AI_MODEL / AI_EFFORT (defaults: claude-opus-5, high). */
export function claudeConfig(env: Record<string, string | undefined>): ClaudeConfig {
  const effort = env.AI_EFFORT as Effort | undefined;
  return {
    model: env.AI_MODEL || 'claude-opus-5',
    effort: effort && EFFORTS.includes(effort) ? effort : 'high',
  };
}

/** Credentials: ANTHROPIC_API_KEY if set, else whatever the SDK resolves (e.g. an `ant auth login` profile). */
export function claudeClient(env: Record<string, string | undefined>): Anthropic {
  return new Anthropic(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {});
}

export interface MessageOptions {
  /** Overrides the configured effort (e.g. low for a quick cleanup pass). */
  effort?: Effort;
  /** Structured output: the reply's JSON schema. */
  format?: { type: 'json_schema'; schema: Record<string, unknown> };
}

export async function createMessage(client: Anthropic, cfg: ClaudeConfig, req: AiRequest, signal?: AbortSignal, opts: MessageOptions = {}): Promise<Message> {
  // Streamed server-side so long turns don't hit HTTP timeouts; the caller gets the final message.
  const stream = client.beta.messages.stream(
    {
      model: cfg.model,
      max_tokens: Math.min(req.max_tokens, 64000),
      system: req.system,
      tools: req.tools,
      messages: req.messages,
      cache_control: req.cache_control,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? cfg.effort, ...(opts.format && { format: opts.format }) },
      // On a safety-classifier decline, the API re-runs the request on its recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    },
    { signal },
  );
  return stream.finalMessage();
}
