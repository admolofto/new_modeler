import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageAttachment } from '../src/ai/agent.ts';
import { SYSTEM_PROMPT } from '../src/ai/prompt.ts';
import { TIDY_SYSTEM } from '../src/ai/tidy.ts';
import { mcpToolDefs } from '../src/ai/tools.ts';

/**
 * Claude Code engine: runs `claude -p` headless on the user's Claude Code login (no API key),
 * with the modeler's MCP server as its only tools. Shared by the dev-server endpoint and evals.
 */

export interface ClaudeCodeConfig {
  bin: string;
  model?: string | undefined;
  effort?: string | undefined;
  /** Working dir for the headless sessions: away from any project's CLAUDE.md and settings. */
  cwd: string;
}

export const TIDY_PROMPT_FILE = 'tidy-prompt.md';

export function claudeCodeConfig(env: Record<string, string | undefined>): ClaudeCodeConfig {
  const cwd = join(tmpdir(), 'new-modeler-claude');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'system-prompt.md'), SYSTEM_PROMPT);
  writeFileSync(join(cwd, TIDY_PROMPT_FILE), TIDY_SYSTEM);
  return { bin: env.CLAUDE_CODE_BIN || 'claude', model: env.CLAUDE_CODE_MODEL || undefined, effort: env.CLAUDE_CODE_EFFORT || undefined, cwd };
}

/** Child env: never hand it an API key (that would bill the API instead of the subscription). */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  return env;
}

/** Installed version, or null if the CLI isn't on PATH. */
export function claudeCodeVersion(cfg: ClaudeCodeConfig): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cfg.bin, ['--version'], { env: childEnv() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

export type ClaudeCodeEvent = { type: 'session'; id: string } | { type: 'text'; text: string };

export interface ClaudeCodeResult {
  sessionId: string | undefined;
  /** Final reply text. */
  text: string;
  isError: boolean;
  costUsd?: number | undefined;
  durationMs?: number | undefined;
  outputTokens?: number | undefined;
  /** What to do about a known failure, e.g. an expired login. */
  hint?: string | undefined;
}

function hintFor(text: string): string | undefined {
  if (/authenticat|oauth|log ?in|credential/i.test(text)) {
    return 'Claude Code needs you to sign in: run `claude` in a terminal, then /login. The chat works as soon as that CLI is logged in.';
  }
  return undefined;
}

/** Every modeler tool, so a new one is allowed without editing a list here. */
export const mcpToolNames = () => mcpToolDefs().map((t) => `mcp__modeler__${t.name}`);

export function runClaudeCode(opts: {
  cfg: ClaudeCodeConfig;
  prompt: string;
  /** Sent with the prompt as one stream-json user message. */
  images?: ImageAttachment[] | undefined;
  mcpUrl: string;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((e: ClaudeCodeEvent) => void) | undefined;
}): Promise<ClaudeCodeResult> {
  const { cfg } = opts;
  const mcpConfig = join(cfg.cwd, `mcp-${createHash('sha1').update(opts.mcpUrl).digest('hex').slice(0, 12)}.json`);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { modeler: { type: 'http', url: opts.mcpUrl } } }));
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt-file', join(cfg.cwd, 'system-prompt.md'),
    // Only the modeler's tools: no shell, no file access.
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
    '--allowedTools', mcpToolNames().join(','),
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    ...(opts.images?.length ? ['--input-format', 'stream-json'] : []),
    ...(opts.sessionId ? ['--resume', opts.sessionId] : []),
    ...(cfg.model ? ['--model', cfg.model] : []),
    ...(cfg.effort ? ['--effort', cfg.effort] : []),
  ];
  let stdin = opts.prompt;
  if (opts.images?.length) {
    const content = [
      ...opts.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text: opts.prompt },
    ];
    stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  }
  return spawnClaude(cfg, args, stdin, opts);
}

/** A one-off text task (tidying dictated notes): its own system prompt, no tools at all, no session kept, low effort. */
export function runClaudeOnce(opts: { cfg: ClaudeCodeConfig; systemPromptFile: string; prompt: string; signal?: AbortSignal | undefined }): Promise<ClaudeCodeResult> {
  const { cfg } = opts;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt-file', join(cfg.cwd, opts.systemPromptFile),
    '--tools', '',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(cfg.model ? ['--model', cfg.model] : []),
    '--effort', 'low',
  ];
  return spawnClaude(cfg, args, opts.prompt, { signal: opts.signal });
}

/** Runs `claude` with these args and stdin, reading its stream-json output. */
function spawnClaude(
  cfg: ClaudeCodeConfig,
  args: string[],
  stdin: string,
  opts: { sessionId?: string | undefined; signal?: AbortSignal | undefined; onEvent?: ((e: ClaudeCodeEvent) => void) | undefined },
): Promise<ClaudeCodeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.bin, args, { cwd: cfg.cwd, env: childEnv() });
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let sessionId = opts.sessionId;
    let result: ClaudeCodeResult | undefined;
    let buf = '';
    let stderr = '';
    const line = (raw: string) => {
      if (!raw.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof msg.session_id === 'string' && msg.session_id !== sessionId) {
        sessionId = msg.session_id;
        opts.onEvent?.({ type: 'session', id: sessionId });
      }
      if (msg.type === 'assistant' && !(msg as { error?: unknown }).error) {
        const content = (msg.message as { content?: { type: string; text?: string }[] })?.content ?? [];
        const text = content.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n').trim();
        if (text) opts.onEvent?.({ type: 'text', text });
      } else if (msg.type === 'result') {
        const text = typeof msg.result === 'string' ? msg.result : '';
        const isError = msg.is_error === true || msg.subtype !== 'success';
        result = {
          sessionId,
          text,
          isError,
          hint: isError ? hintFor(text) : undefined,
          costUsd: msg.total_cost_usd as number | undefined,
          durationMs: msg.duration_ms as number | undefined,
          outputTokens: (msg.usage as { output_tokens?: number } | undefined)?.output_tokens,
        };
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`couldn't start Claude Code (${cfg.bin}): ${err.message}`));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      line(buf);
      if (opts.signal?.aborted) return reject(new Error('stopped'));
      if (result) return resolve(result);
      const detail = stderr.trim().slice(0, 500);
      const hint = hintFor(detail);
      reject(new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}${hint ? `\n${hint}` : ''}`));
    });
    child.stdin.end(stdin);
  });
}
