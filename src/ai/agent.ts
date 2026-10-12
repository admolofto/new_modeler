import type Anthropic from '@anthropic-ai/sdk';
import type { Op } from '../model/ops';
import type { Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import { modelSnapshot, savedRecipes } from './context';
import { SYSTEM_PROMPT } from './prompt';
import { runTool, toolDefs, type Question, type ToolState, type VersionHost } from './tools';

/**
 * One chat turn: send the request, run tool calls against a draft doc, loop until the model
 * ends its turn. Pure — the transport (`send`) is injected: the browser posts to the local
 * proxy, evals call the SDK directly. Nothing touches the store; the caller previews `ops`
 * and dispatches them on accept.
 */

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type AiRequest = Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'system' | 'tools' | 'messages' | 'max_tokens' | 'cache_control'> & { model?: string; effort?: string };
export type Send = (req: AiRequest, signal?: AbortSignal) => Promise<Message>;

/** Chat state. `messages` is append-only (so prompt caching and replayed thinking stay valid). */
export interface Chat {
  messages: MessageParam[];
  /** Last snapshot sent, to skip resending an unchanged model. */
  lastSnapshot?: string;
  /** Results of the turn that ended on ask_user; they open the next user message, with the answers. */
  toolResults?: Anthropic.Beta.BetaToolResultBlockParam[];
}

/** A base64 image for the user turn, e.g. a screenshot of the viewport. */
export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
}

export type AgentEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; ok: boolean; summary: string; questions?: Question[] };

export interface TurnResult {
  /** The model's final reply text. */
  text: string;
  /** Every op applied this turn, in order. Empty = nothing to preview. */
  ops: Op[];
  draft: Doc;
  /** asked: the model put questions to the user (ask_user); the answers go in the next turn. */
  stop: 'done' | 'asked' | 'refusal' | 'max_tokens' | 'max_steps';
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface TurnOptions {
  send: Send;
  chat: Chat;
  doc: Doc;
  text: string;
  /** Context for the model, e.g. whether its last proposal was accepted. */
  note?: string | undefined;
  images?: ImageAttachment[] | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((e: AgentEvent) => void) | undefined;
  maxSteps?: number;
  /** The user's saved recipe library: catalogued in the snapshot, used by the recipe tools. */
  recipes?: (() => readonly Recipe[]) | undefined;
  /** The app's design versions, for new_version. */
  versions?: VersionHost | undefined;
}

export const MAX_TOKENS = 32000;
let cachedTools: ReturnType<typeof toolDefs> | undefined;
const tools = () => (cachedTools ??= toolDefs());

/** One user turn as plain text (Claude Code engine): snapshot, optional note, request. */
export function userTurnText(doc: Doc, note: string | undefined, text: string, recipes?: () => readonly Recipe[]): string {
  return [`<model>\n${modelSnapshot(doc, savedRecipes(recipes))}\n</model>`, ...(note ? [`<note>${note}</note>`] : []), text].join('\n\n');
}

export function newChat(): Chat {
  return { messages: [] };
}

export function buildRequest(messages: MessageParam[]): AiRequest {
  return {
    max_tokens: MAX_TOKENS,
    tools: tools(),
    // Breakpoint on the system prompt caches tools + system; top-level auto caching covers the growing history.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages,
  };
}

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const { send, chat, doc, onEvent } = opts;
  const start = chat.messages.length;
  const snapshot = modelSnapshot(doc, savedRecipes(opts.recipes));
  const carried = chat.toolResults ?? [];
  chat.toolResults = undefined;
  const content: (Anthropic.Beta.BetaToolResultBlockParam | Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam)[] = [
    ...carried,
    { type: 'text', text: snapshot === chat.lastSnapshot ? '<model unchanged since the last snapshot />' : `<model>\n${snapshot}\n</model>` },
  ];
  if (opts.note) content.push({ type: 'text', text: `<note>${opts.note}</note>` });
  for (const img of opts.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  content.push({ type: 'text', text: opts.text });
  chat.messages.push({ role: 'user', content });

  const state: ToolState = { draft: doc, ops: [], recipes: opts.recipes, versions: opts.versions };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text = '';
  const maxSteps = opts.maxSteps ?? 16;

  try {
    for (let step = 0; ; step++) {
      if (step >= maxSteps) return finish('max_steps');
      const res = await send(buildRequest(chat.messages), opts.signal);
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      chat.messages.push({ role: 'assistant', content: res.content as MessageParam['content'] });

      const said = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (said) {
        text = said;
        onEvent?.({ type: 'text', text: said });
      }
      if (res.stop_reason === 'refusal') return finish('refusal');
      if (res.stop_reason === 'pause_turn') continue;

      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason === 'max_tokens') {
        // A tool call cut off mid-input can't be trusted; drop the turn's pending calls.
        if (calls.length) chat.messages.pop();
        return finish('max_tokens');
      }
      if (!calls.length) return finish('done');

      let asked = false;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((call) => {
        const out = runTool(state, call.name, call.input);
        asked ||= !!out.questions;
        onEvent?.({ type: 'tool', name: call.name, ok: !out.isError, summary: out.summary, ...(out.questions && { questions: out.questions }) });
        return { type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError && { is_error: true }) };
      });
      if (asked) {
        // The user answers in their own time: the results wait for the next turn's message.
        chat.toolResults = results;
        return finish('asked');
      }
      chat.messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    // Leave the chat as it was before this turn so the user can retry.
    chat.messages.length = start;
    if (carried.length) chat.toolResults = carried;
    throw err;
  }

  function finish(stop: TurnResult['stop']): TurnResult {
    // Once the model has applied ops its picture diverges from `doc`, so always resend next turn.
    chat.lastSnapshot = state.ops.length ? undefined : snapshot;
    return { text, ops: state.ops, draft: state.draft, stop, usage };
  }
}

