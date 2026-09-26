import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/plugins/index.ts';
import { newChat, runTurn, userTurnText, type Send } from '../src/ai/agent.ts';
import { modelSnapshot } from '../src/ai/context.ts';
import { runTool, type ToolState } from '../src/ai/tools.ts';
import { demoDoc, emptyDoc } from '../src/model/defaults.ts';
import { applyOps, type Op } from '../src/model/ops.ts';
import type { Doc } from '../src/model/schema.ts';
import { claudeClient, claudeConfig, createMessage } from '../server/claude.ts';
import { claudeCodeConfig, runClaudeCode } from '../server/claudeCode.ts';
import { createMcpHandler } from '../server/mcp.ts';
import { CASES, type EvalCase } from './cases.ts';
import { Grader } from './grade.ts';

/**
 * Live eval. `npm run eval` (or `npm run eval -- -t mantel` for a subset); writes
 * evals/results/latest.json. Engine: AI_ENGINE=claude-code (your Claude Code login; the
 * default without an API key) or AI_ENGINE=api (ANTHROPIC_API_KEY, billed per token).
 */

const env = process.env;
const engine = env.AI_ENGINE === 'api' || (!env.AI_ENGINE && env.ANTHROPIC_API_KEY) ? 'api' : 'claude-code';

interface Usage {
  output: number;
  costUsd: number;
}
interface StepResult {
  text: string;
  ops: Op[];
  failure?: string;
  usage: Usage;
}
/** Runs one prompt against `doc`; returns the proposal's ops. */
type Runner = (step: string, doc: Doc, note: string | undefined) => Promise<StepResult>;

// ── API engine ────────────────────────────────────────────────────────────────
function apiRunner(): Runner {
  const cfg = claudeConfig(env);
  const client = claudeClient(env);
  const send: Send = (req, signal) => createMessage(client, cfg, req, signal);
  const chat = newChat();
  return async (step, doc, note) => {
    const r = await runTurn({ send, chat, doc, text: step, note });
    return { text: r.text, ops: r.ops, ...(r.stop !== 'done' && { failure: `stopped: ${r.stop}` }), usage: { output: r.usage.output, costUsd: 0 } };
  };
}

// ── Claude Code engine: `claude -p` against an in-process MCP server, one route per case ──
const routes = new Map<string, ReturnType<typeof createMcpHandler>>();
let mcpServer: Server | undefined;
let mcpBase = '';
let nextRoute = 1;

function claudeCodeRunner(): Runner {
  const cfg = claudeCodeConfig(env);
  const route = String(nextRoute++);
  const state: ToolState = { draft: emptyDoc(), ops: [] };
  routes.set(
    route,
    createMcpHandler(async (name, input) => (name === 'get_model' ? { content: modelSnapshot(state.draft), isError: false } : runTool(state, name, input))),
  );
  let sessionId: string | undefined;
  return async (step, doc, note) => {
    state.draft = doc;
    state.ops = [];
    const r = await runClaudeCode({ cfg, prompt: userTurnText(doc, note, step), mcpUrl: `${mcpBase}/mcp/${route}`, sessionId });
    sessionId = r.sessionId;
    return {
      text: r.text,
      ops: state.ops,
      ...(r.isError && { failure: `Claude Code error: ${r.text}${r.hint ? ` (${r.hint})` : ''}` }),
      usage: { output: r.outputTokens ?? 0, costUsd: r.costUsd ?? 0 },
    };
  };
}

beforeAll(async () => {
  if (engine !== 'claude-code') return;
  mcpServer = createServer((req, res) => {
    const handler = routes.get(/^\/mcp\/(\d+)/.exec(req.url ?? '')?.[1] ?? '');
    if (handler) void handler(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => mcpServer!.listen(0, '127.0.0.1', resolve));
  mcpBase = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
});

// ── Cases ─────────────────────────────────────────────────────────────────────
interface Row {
  name: string;
  pass: boolean;
  failures: string[];
  replies: string[];
  seconds: number;
  usage: Usage;
}
const rows: Row[] = [];

async function runCase(c: EvalCase): Promise<string[]> {
  const t0 = Date.now();
  const run = engine === 'api' ? apiRunner() : claudeCodeRunner();
  let doc = c.start === 'demo' ? demoDoc() : emptyDoc();
  if (c.setup) {
    const r = applyOps(doc, c.setup);
    if (!r.ok) throw new Error(`case setup failed: ${r.error}`);
    doc = r.doc;
  }
  const replies: string[] = [];
  const usage: Usage = { output: 0, costUsd: 0 };
  const failures: string[] = [];
  let note: string | undefined;

  for (const step of c.steps) {
    const r = await run(step, doc, note);
    usage.output += r.usage.output;
    usage.costUsd += r.usage.costUsd;
    replies.push(r.text);
    if (r.failure) failures.push(`step "${step}": ${r.failure}`);
    note = undefined;
    if (r.ops.length) {
      // What the Accept button does.
      const applied = applyOps(doc, r.ops);
      if (!applied.ok) failures.push(`proposal doesn't re-apply: ${applied.error}`);
      else doc = applied.doc;
      note = 'The user accepted your last proposal; it is now part of the model.';
    }
  }

  const g = new Grader(doc);
  if (!failures.length) c.check(g, replies);
  failures.push(...g.failures);
  rows.push({ name: c.name, pass: !failures.length, failures, replies, seconds: Math.round((Date.now() - t0) / 1000), usage });
  return failures;
}

describe(`evals (${engine})`, () => {
  for (const c of CASES) {
    it.concurrent(c.name, async () => {
      expect(await runCase(c)).toEqual([]);
    });
  }
});

afterAll(() => {
  mcpServer?.close();
  if (!rows.length) return;
  const passed = rows.filter((r) => r.pass).length;
  const output = rows.reduce((s, r) => s + r.usage.output, 0);
  const cost = rows.reduce((s, r) => s + r.usage.costUsd, 0);
  const model = engine === 'api' ? claudeConfig(env).model : (env.CLAUDE_CODE_MODEL ?? 'Claude Code default');
  const report = { engine, model, at: new Date().toISOString(), passed, total: rows.length, outputTokens: output, costUsd: cost, rows };
  mkdirSync('evals/results', { recursive: true });
  writeFileSync('evals/results/latest.json', JSON.stringify(report, null, 2));
  writeFileSync(`evals/results/${report.at.replace(/[:.]/g, '-')}.json`, JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${rows.length} passed · ${engine} · ${output} output tokens${cost ? ` · ~$${cost.toFixed(2)} (as reported)` : ''}`);
});
