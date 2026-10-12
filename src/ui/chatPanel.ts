import { newChat, runTurn, userTurnText, type ImageAttachment, type Send } from '../ai/agent';
import { readCliStream } from '../ai/cliTransport';
import { defaultEngine, effortName, engineName, type Engine, type EngineConfig } from '../ai/engines';
import { CLAUDE_EFFORTS, type ModelOption } from '../ai/models';
import type { Question } from '../ai/tools';
export type { Engine } from '../ai/engines';
import type { Doc } from '../model/schema';
import type { Recipe } from '../model/recipes';
import type { Target } from '../edit/targets';
import { createRecipeAdaptation } from './recipeAdaptation';
import { el } from './dom';
import { icon } from './icons';
import { MARKDOWN_STYLE, renderMarkdown } from './markdown';
import { mountAiHelp } from './aiHelp';
import type { Proposals } from './proposals';

/**
 * AI panel: text → AI turn → preview → accept / reject. Notes waiting to be sent sit on top of the
 * message box (notes.ts) and go with the next message. Engines:
 * - Claude Code: runs `claude -p` on your Claude Code login (no API key); its tool calls
 *   come back to this tab through the MCP bridge.
 * - Codex: runs a local app-server on your Codex login and uses the same model tools.
 * - API: the in-browser agent loop through the local proxy (needs ANTHROPIC_API_KEY).
 * Either way the AI's changes land in the shared proposal (proposals.ts), shown tinted violet in
 * the viewport until accepted. Sending another message while a proposal is pending refines it.
 * When the AI is unsure it asks (ask_user): its questions show with answers to pick, and the
 * picked answers go with the next message.
 */

export interface Preview {
  doc: Doc;
  highlight: ReadonlySet<string>;
}

export interface ChatApi {
  /** Which AI answers (other AI features, like tidying voice notes, follow it). */
  readonly engine: Engine;
}

/** The notes waiting on the message box (notes.ts). */
export interface NoteAttachments {
  /** Ids of the notes that go with the next message. */
  pending(): string[];
  /** They're being sent: marks them sent and returns their rows for the message bubble. */
  send(ids: string[]): HTMLElement;
  /** New conversation: notes still open go back on the message box. */
  reset(): void;
}

export interface ChatPanel extends ChatApi {
  readonly busy: boolean;
  readonly recipeAttached: boolean;
  attachRecipe(recipe: Recipe, inputs: Readonly<Record<string, number>>, targets: readonly Target[]): void;
  subscribe(fn: () => void): void;
  /** Where waiting notes draw, on top of the message box. */
  notesSlot: HTMLElement;
  setNoteAttachments(a: NoteAttachments): void;
  /** How many notes are waiting now. */
  notesChanged(count: number): void;
}

const notesRequest = (ids: string[]) => `Please address my note${ids.length === 1 ? '' : 's'} ${ids.join(', ')}.`;
const EXAMPLES = ['A 36" base cabinet with two drawers, 3/4 ply', 'A 48" × 30" table with 2" square legs', 'Add a 1/4" roundover to the top edges'];
const CARD_LINES = 6;
/** Codex effort levels when it can't list its models. */
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const STYLE = `
.chat { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.chat header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 44px; padding: 8px; flex: none; border-bottom: 1px solid var(--line); }
.chat header b { font-size: var(--fs); }
.chat header select { height: 26px; padding: 0 22px 0 6px; border-color: transparent; background-color: transparent; color: var(--fg-2); font-size: var(--fs-sm);
  background-position: right 6px center; }
.chat header select:hover:not(:disabled) { border-color: var(--line-2); color: var(--fg); }
.chat header .model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); font-size: var(--fs-xs); }
.chat header .model.bad { color: var(--bad); }
/* Two rows: provider, model and buttons; then effort and the provider status. The model menu gives way first. */
.chat header .bar { display: flex; flex-basis: 100%; align-items: center; gap: 6px; min-width: 0; }
.chat header select { min-width: 0; max-width: 145px; }
.chat .view { flex: 1; min-height: 0; overflow-y: auto; }
.chat .log { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
.chat .msg { white-space: pre-wrap; overflow-wrap: anywhere; }
.chat .user { align-self: flex-end; max-width: 88%; padding: 7px 11px; border-radius: 12px 12px 4px 12px; background: #2a2d33; }
.chat .user .nlist { margin: 2px -4px 0; }
.chat .user .shot { display: flex; align-items: center; gap: 4px; margin-top: 2px; color: var(--fg-2); font-size: var(--fs-xs); }
.chat .user .shot svg { width: 12px; height: 12px; }
.chat .ai { align-self: flex-start; max-width: 100%; }
.chat .working { display: flex; align-items: center; gap: 8px; align-self: flex-start; padding: 4px 0; color: var(--fg-2); font-size: var(--fs-sm); }
.chat .working-dots { display: flex; gap: 3px; }
.chat .working-dots span { width: 4px; height: 4px; border-radius: 50%; background: var(--ai); animation: chat-working 1.4s ease-in-out infinite; }
.chat .working-dots span:nth-child(2) { animation-delay: .16s; }
.chat .working-dots span:nth-child(3) { animation-delay: .32s; }
.chat .working-time { color: var(--fg-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
@keyframes chat-working { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .chat .working-dots span { animation: none; } }
.chat .tool { position: relative; padding-left: 14px; color: var(--fg-3); font-size: var(--fs-sm); }
.chat .tool::before { content: ''; position: absolute; left: 3px; top: .6em; width: 5px; height: 5px; border-radius: 50%; background: var(--line-3); }
.chat .tool.bad { color: var(--warn); }
.chat .err { padding: 6px 10px; border-radius: 8px; background: #f2706a14; color: #f7b3ae; font-size: var(--fs-sm); }
.chat .welcome { display: grid; gap: 10px; padding: 6px 0; color: var(--fg-2); }
.chat .welcome p { margin: 0; }
.chat .examples { display: grid; gap: 6px; }
.chat .examples button { justify-self: start; max-width: 100%; padding: 6px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: none;
  color: var(--fg); font-size: var(--fs-sm); text-align: left; cursor: pointer; transition: background-color .12s, border-color .12s; }
.chat .examples button:hover { background: var(--hover); border-color: var(--line-3); }
.chat .card { flex: none; margin: 0 12px 10px; padding: 10px 12px; border: 1px solid #8b7bff66; border-radius: 10px; background: var(--ai-soft); }
.chat .card h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 600; }
.chat .card h4::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--ai); }
.chat .card h4 span { color: var(--fg-2); font-weight: 400; }
.chat .card ul { margin: 0 0 8px; padding-left: 18px; max-height: 180px; overflow-y: auto; font-size: var(--fs-sm); }
.chat .card li { margin: 1px 0; }
.chat .card .more { margin: -4px 0 8px; padding: 0; border: 0; background: none; color: var(--fg-2); font-size: var(--fs-sm); text-decoration: underline; cursor: pointer; }
.chat .card .row { display: flex; gap: 6px; }
.chat .card .stale { margin: 0 0 8px; color: var(--bad); font-size: var(--fs-sm); }
.chat .compose { flex: none; margin: 0 12px 12px; padding: 8px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--field);
  transition: border-color .12s, box-shadow .12s; }
.chat .compose:focus-within { border-color: var(--focus); box-shadow: 0 0 0 2px #8fb4ff2e; }
.chat .compose .attached { max-height: 220px; margin: -2px -2px 6px; padding-bottom: 6px; overflow-y: auto; border-bottom: 1px solid var(--line-2); }
.chat .compose > textarea { display: block; width: 100%; min-height: 40px; max-height: 180px; padding: 0 2px; border: 0; background: none; box-shadow: none; }
.chat .compose .row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.chat .compose .status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-3); font-size: var(--fs-xs); }
.chat .ask { display: grid; gap: 10px; padding: 10px 12px; border: 1px solid #8b7bff66; border-radius: 10px; }
.chat .ask h4 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--fs-sm); font-weight: 600; }
.chat .ask h4::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--ai); }
.chat .ask .q p { margin: 0 0 6px; overflow-wrap: anywhere; }
.chat .ask .opts { display: flex; flex-wrap: wrap; gap: 6px; }
.chat .ask .opts button { max-width: 100%; padding: 4px 10px; border: 1px solid var(--line-2); border-radius: 999px; background: none; color: var(--fg);
  font-size: var(--fs-sm); text-align: left; cursor: pointer; transition: background-color .12s, border-color .12s; }
.chat .ask .opts button:hover:not(:disabled) { background: var(--hover); border-color: var(--line-3); }
.chat .ask .opts button[aria-pressed="true"] { border-color: var(--ai); background: var(--ai-soft); }
.chat .ask .opts button:disabled { cursor: default; }
.chat .ask .opts button:disabled:not([aria-pressed="true"]) { opacity: .5; }
.chat .ask .hint { margin: 0; color: var(--fg-3); font-size: var(--fs-xs); }
`;

const ENGINE_KEY = 'new-modeler.engine';
const loadEngine = (): Engine | null => {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    return v === 'api' || v === 'claude-code' || v === 'codex' ? v : null;
  } catch {
    return null;
  }
};
const saveEngine = (e: Engine) => {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    // storage unavailable
  }
};
/** Per-provider choices (model, effort); '' = the provider's default. */
const MODELS_KEY = 'new-modeler.models';
const EFFORTS_KEY = 'new-modeler.efforts';
const loadChoices = (key: string): Partial<Record<Engine, string>> => {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { return {}; }
};
const saveChoices = (key: string, choices: Partial<Record<Engine, string>>) => {
  try { localStorage.setItem(key, JSON.stringify(choices)); } catch { /* private browsing */ }
};

export function mountChatPanel(
  parent: HTMLElement,
  proposals: Proposals,
  send: Send,
  setPreview: (p: Preview | null) => void,
  capture: () => ImageAttachment,
  onRecipePrepared?: (doc: Doc, ids: string[]) => void,
  /** What the picture of the view shows that the model doesn't (doors drawn open), or null. */
  viewNote?: () => string | null,
): ChatPanel {
  parent.append(el('style', {}, STYLE + MARKDOWN_STYLE));
  let engine: Engine = loadEngine() ?? 'claude-code';
  let config: EngineConfig | null = null;
  const savedModels = loadChoices(MODELS_KEY);
  const savedEfforts = loadChoices(EFFORTS_KEY);
  const choice = (saved: Partial<Record<Engine, string>>) => { const value = saved[engine]; return typeof value === 'string' ? value : ''; };
  const selectedModel = () => choice(savedModels);
  const selectedEffort = () => choice(savedEfforts);
  let chat = newChat(); // API engine history
  let sessionId: string | undefined; // Selected CLI engine's conversation
  let running: AbortController | null = null;
  const recipes = createRecipeAdaptation(proposals, () => !!running);
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  let showAll = false;
  let notes: NoteAttachments | null = null;
  let attached = 0;
  /** The camera was turned on because notes arrived (it turns off again once they're gone). */
  let autoShot = false;
  /** The AI's open questions (ask_user): the answers picked go with the next message. */
  let asking: { questions: Question[]; picked: (string | undefined)[]; buttons: HTMLButtonElement[]; hint: HTMLElement } | null = null;

  const engineSel = el('select', { title: 'Which AI answers', 'aria-label': 'AI provider' });
  engineSel.append(el('option', { value: 'claude-code' }, 'Claude Code'), el('option', { value: 'codex' }, 'Codex'), el('option', { value: 'api' }, 'API'));
  const modelLabel = el('span', { class: 'model' });
  const modelSel = el('select', { title: 'AI model', 'aria-label': 'AI model' });
  const effortSel = el('select', { title: 'How hard the AI thinks before answering: higher is slower and more thorough', 'aria-label': 'AI effort' });
  /** The provider's model list, once loaded (Codex's carries each model's effort levels). */
  let modelOptions: ModelOption[] = [];
  let modelOptionsRequest = 0;

  /** Effort levels for the selected model, and what Default means (when the server or provider says). */
  function effortChoices(): { levels: readonly string[]; fallback: string | undefined } {
    if (engine !== 'codex') return { levels: CLAUDE_EFFORTS, fallback: engine === 'api' ? config?.api.effort : config?.claudeCode.effort };
    const id = selectedModel() || (config && config.codex.model !== 'default' ? config.codex.model : '');
    const model = modelOptions.find((m) => (id ? m.id === id : m.isDefault));
    return { levels: model?.efforts ?? CODEX_EFFORTS, fallback: config?.codex.effort ?? model?.defaultEffort };
  }
  function showEfforts() {
    const { levels, fallback } = effortChoices();
    const saved = selectedEffort();
    effortSel.replaceChildren(
      el('option', { value: '' }, fallback ? `Default effort (${effortName(fallback).toLowerCase()})` : 'Default effort'),
      ...levels.map((e) => el('option', { value: e }, `${effortName(e)} effort`)),
    );
    // A level this model doesn't list stays shown, so the menu matches what's sent.
    if (saved && !levels.includes(saved)) effortSel.append(el('option', { value: saved }, `${effortName(saved)} effort`));
    effortSel.value = saved;
  }
  effortSel.addEventListener('change', () => {
    savedEfforts[engine] = effortSel.value;
    saveChoices(EFFORTS_KEY, savedEfforts);
    add('tool', `Effort set to ${effortSel.value ? effortName(effortSel.value).toLowerCase() : 'default'}.`);
    showEngine();
  });

  async function loadModels() {
    const request = ++modelOptionsRequest;
    const provider = engine;
    modelOptions = [];
    showEfforts();
    const configured = config ? (provider === 'api' ? config.api : provider === 'codex' ? config.codex : config.claudeCode).model : 'default';
    modelSel.replaceChildren(el('option', { value: '' }, configured === 'default' ? 'Default model' : `Default (${configured})`));
    if (selectedModel()) modelSel.append(el('option', { value: selectedModel() }, selectedModel()));
    modelSel.value = selectedModel();
    try {
      const response = await fetch(`/api/ai/models?engine=${provider}`);
      const data = await response.json();
      if (request !== modelOptionsRequest) return;
      if (!response.ok) throw new Error(data.error?.message ?? 'Model list unavailable');
      modelOptions = data.models as ModelOption[];
      for (const model of modelOptions) {
        const existing = [...modelSel.options].find((option) => option.value === model.id);
        if (existing) existing.textContent = model.label;
        else modelSel.append(el('option', { value: model.id }, model.label));
      }
      modelSel.title = 'Choose the model for this provider';
    } catch (err) {
      if (request !== modelOptionsRequest) return;
      modelSel.title = `Model list unavailable: ${(err as Error).message}. Default and custom models remain usable.`;
    }
    if (request !== modelOptionsRequest) return;
    modelSel.append(el('option', { value: '__custom' }, 'Custom model…'));
    modelSel.value = selectedModel();
    showEfforts();
  }
  modelSel.addEventListener('change', () => {
    let value = modelSel.value;
    if (value === '__custom') {
      const custom = window.prompt('Enter the exact model ID supported by this provider:', selectedModel());
      if (!custom || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(custom.trim())) { modelSel.value = selectedModel(); return; }
      value = custom.trim();
    }
    if (value === selectedModel()) return;
    savedModels[engine] = value;
    saveChoices(MODELS_KEY, savedModels);
    chat = newChat();
    sessionId = undefined;
    closeQuestions();
    clearRecipe('Model changed');
    add('tool', `Model changed to ${value || 'default'} (new conversation).`);
    showEngine();
    void loadModels();
  });
  const newChatBtn = el('button', { class: 'btn ghost icon', title: 'New conversation' }, icon('plus'));
  const help = mountAiHelp(parent);
  const helpBtn = el('button', { class: 'btn ghost sm', title: 'AI setup and usage instructions', 'aria-label': 'AI help' }, icon('help'), 'Help');
  helpBtn.addEventListener('click', () => help.open(engine, config));

  const log = el('div', { class: 'log', role: 'log' });
  const workingTime = el('span', { class: 'working-time', 'aria-hidden': 'true' });
  const working = el('div', { class: 'working' },
    el('span', { class: 'working-dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
    el('span', {}, 'Working…'), workingTime,
  );
  const chatView = el('div', { class: 'view' }, log);
  const card = el('div', { class: 'card', role: 'region', 'aria-label': 'Proposed change' });

  const input = el('textarea', { rows: 2, placeholder: 'Describe a piece or a change…', 'aria-label': 'Message to the AI' });
  const shotBtn = el('button', { class: 'btn ghost icon sm', title: 'Include a picture of the 3D view (numbered pins mark your notes)', 'aria-pressed': 'false' }, icon('camera'));
  const status = el('span', { class: 'status' });
  const sendBtn = el('button', { class: 'btn ai sm' });
  const notesSlot = el('div', { class: 'attached', role: 'group', 'aria-label': 'Notes going with the next message', hidden: true });
  const recipeSlot = el('div', { class: 'attached', role: 'group', 'aria-label': 'Recipe going with the next message', hidden: true });
  const compose = el('div', { class: 'compose' }, recipeSlot, notesSlot, input, el('div', { class: 'row' }, shotBtn, status, sendBtn));
  parent.append(
    el(
      'div',
      { class: 'chat' },
      el('header', {}, el('div', { class: 'bar' }, engineSel, modelSel, helpBtn, newChatBtn), el('div', { class: 'bar' }, effortSel, modelLabel)),
      chatView,
      card,
      compose,
    ),
  );

  const scroll = () => (chatView.scrollTop = chatView.scrollHeight);
  const put = (node: HTMLElement) => {
    log.querySelector('.welcome')?.remove();
    log.insertBefore(node, working.parentNode === log ? working : null);
    scroll();
  };
  const add = (cls: string, text: string) => put(el('div', { class: `msg ${cls}` }, cls === 'ai' ? renderMarkdown(text) : text));

  function showPlaceholder() {
    input.placeholder = asking ? 'Type an answer…' : attached ? 'Add a message (optional)…' : 'Describe a piece or a change…';
  }

  /** The AI's questions, with its suggested answers to pick (one question: picking sends it). */
  function showQuestions(questions: Question[]) {
    closeQuestions();
    const one = questions.length === 1;
    const hint = el('p', { class: 'hint' },
      !one ? 'Pick answers, add anything below, then Send.' : questions[0]!.options?.length ? 'Pick an answer, or type your own below.' : 'Type your answer below.');
    const ask: NonNullable<typeof asking> = { questions, picked: questions.map(() => undefined), buttons: [], hint };
    const rows = questions.map((q, i) => {
      const options = (q.options ?? []).map((text) => {
        const b = el('button', { type: 'button', 'aria-pressed': 'false', disabled: !!running }, text);
        b.addEventListener('click', () => {
          if (asking !== ask) return;
          ask.picked[i] = ask.picked[i] === text ? undefined : text;
          for (const o of options) o.setAttribute('aria-pressed', String(o.textContent === ask.picked[i]));
          if (one && ask.picked[0]) void submit();
        });
        ask.buttons.push(b);
        return b;
      });
      return el('div', { class: 'q' }, el('p', {}, q.question), ...(options.length ? [el('div', { class: 'opts', role: 'group', 'aria-label': q.question }, ...options)] : []));
    });
    put(el('div', { class: 'ask', role: 'group', 'aria-label': 'Questions from the AI' }, el('h4', {}, one ? 'Question' : `${questions.length} questions`), ...rows, hint));
    asking = ask;
    showPlaceholder();
    if (!running) input.focus();
  }
  /** Answered or moved on from: the card stays in the log with what was picked. */
  function closeQuestions() {
    if (!asking) return;
    for (const b of asking.buttons) b.disabled = true;
    asking.hint.remove();
    asking = null;
    showPlaceholder();
  }
  /** The picked answers, as the user's words: the answer alone for one question, else question → answer lines. */
  function answersText(): string {
    if (!asking) return '';
    const { questions, picked } = asking;
    if (questions.length === 1) return picked[0] ?? '';
    return questions.flatMap((q, i) => (picked[i] ? [`${q.question} → ${picked[i]}`] : [])).join('\n');
  }

  function showRecipe() {
    const attachment = recipes.attachment;
    recipeSlot.hidden = !attachment;
    recipeSlot.replaceChildren();
    if (attachment) {
      const remove = el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Remove recipe attachment' }, 'Remove');
      remove.addEventListener('click', () => { recipes.clear(); showRecipe(); input.focus(); });
      recipeSlot.append(el('div', { class: 'row' }, el('b', {}, attachment.recipe.name), remove),
        el('div', {}, `${attachment.targets.length ? `${attachment.targets.length} selected target(s)` : 'No target selected'} · Describe how to adapt it, then Send.`));
    }
    changed();
  }
  function clearRecipe(reason: string) {
    if (!recipes.attachment) return;
    recipes.clear();
    showRecipe();
    add('tool', `${reason}: unsent recipe attachment removed. Your message is kept.`);
  }

  function welcome(): HTMLElement {
    const examples = EXAMPLES.map((text) => {
      const b = el('button', {}, text);
      b.addEventListener('click', () => {
        input.value = text;
        grow();
        input.focus();
      });
      return b;
    });
    return el(
      'div',
      { class: 'welcome' },
      el('p', {}, 'Describe what to build or change — or press V and talk while pointing at the model. The AI’s changes show in violet until you accept them.'),
      el('div', { class: 'examples' }, ...examples),
    );
  }
  log.append(welcome());

  function showEngine() {
    engineSel.value = engine;
    let text: string;
    let ok = true;
    if (!config) [text, ok] = ['AI proxy unavailable', false];
    else if (engine === 'claude-code') [text, ok] = config.claudeCode.available ? [`your login · ${config.claudeCode.model}`, true] : ['claude CLI not found', false];
    else if (engine === 'codex') {
      [text, ok] = !config.codex.available ? ['Codex CLI not found', false]
        : !config.codex.loggedIn ? ['Sign in with codex login', false]
        : [`your login · ${config.codex.model}`, true];
    } else [text, ok] = config.api.hasKey ? [`${selectedModel() || config.api.model} · ${selectedEffort() || config.api.effort}`, true] : ['no ANTHROPIC_API_KEY', false];
    modelLabel.textContent = text;
    modelLabel.title = engine === 'codex' && config?.codex.hint ? config.codex.hint : text;
    modelLabel.classList.toggle('bad', !ok);
  }
  let checkingConfig = false;
  function refreshConfig(initial = false) {
    if (checkingConfig) return;
    checkingConfig = true;
    void fetch('/api/ai/config', { cache: 'no-store' })
    .then((r) => r.json())
    .then((c: EngineConfig) => {
      config = c;
      if (initial && !running) { engine = defaultEngine(c, loadEngine()); void loadModels(); }
      showEngine();
      showEfforts();
    })
    .catch(() => showEngine())
    .finally(() => { checkingConfig = false; });
  }
  refreshConfig(true);
  window.addEventListener('focus', () => refreshConfig());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshConfig(); });
  engineSel.addEventListener('change', () => {
    engine = engineSel.value as Engine;
    saveEngine(engine);
    chat = newChat();
    sessionId = undefined;
    closeQuestions();
    clearRecipe('Provider changed');
    showEngine();
    refreshConfig();
    void loadModels();
    add('tool', `Switched to ${engineName(engine)} (new conversation).`);
  });

  function showPending() {
    const pending = proposals.pending;
    card.hidden = !pending;
    setPreview(pending && !pending.stale ? { doc: pending.draft, highlight: pending.diff.touched } : null);
    if (!pending) return void (showAll = false);
    const lines = pending.diff.lines.length ? pending.diff.lines : ['No visible change'];
    const shown = showAll ? lines : lines.slice(0, CARD_LINES);
    const accept = el('button', { class: 'btn ai', disabled: !!pending.stale || !!running }, icon('check'), 'Accept');
    const reject = el('button', { class: 'btn', disabled: !!running }, pending.stale ? 'Discard' : 'Reject');
    accept.addEventListener('click', () => {
      if (proposals.accept()) add('tool', 'Accepted.');
    });
    reject.addEventListener('click', () => {
      proposals.reject();
      add('tool', pending.stale ? 'Discarded.' : 'Rejected.');
    });
    const more = el('button', { class: 'more' }, `Show all ${lines.length}`);
    more.addEventListener('click', () => ((showAll = true), showPending()));
    card.replaceChildren(
      el('h4', {}, 'Proposed change', el('span', {}, `· ${lines.length} change${lines.length === 1 ? '' : 's'}`)),
      el('ul', {}, ...shown.map((l) => el('li', {}, l))),
      ...(shown.length < lines.length ? [more] : []),
      ...(pending.stale ? [el('div', { class: 'stale' }, `Can’t apply to the model as it is now: ${pending.stale}`)] : []),
      el('div', { class: 'row' }, accept, reject),
    );
  }
  proposals.subscribe(showPending);
  // Both CLI engines and external MCP clients share the live model's proposal tools.
  proposals.onTool((name, out) => (out.questions ? showQuestions(out.questions) : add(`tool${out.isError ? ' bad' : ''}`, name === 'get_model' ? 'Read the model' : out.summary)));

  function setRunning(ctrl: AbortController | null) {
    running = ctrl;
    sendBtn.replaceChildren(...(ctrl ? [icon('stop'), 'Stop'] : [icon('send'), 'Send']));
    sendBtn.className = `btn sm ${ctrl ? '' : 'ai'}`;
    sendBtn.title = ctrl ? 'Stop the AI' : 'Send (Enter)';
    newChatBtn.disabled = engineSel.disabled = modelSel.disabled = effortSel.disabled = !!ctrl;
    for (const b of asking?.buttons ?? []) b.disabled = !!ctrl;
    showPending();
    changed();
  }

  async function viaApi(text: string, note: string | undefined, images: ImageAttachment[], signal: AbortSignal): Promise<string> {
    const r = await runTurn({
      send: (req, signal) => send({ ...req, ...(selectedModel() && { model: selectedModel() }), ...(selectedEffort() && { effort: selectedEffort() }) }, signal),
      chat,
      doc: proposals.working(),
      text,
      note,
      images,
      signal,
      recipes: proposals.recipes,
      onEvent: (e) => (e.type === 'text' ? add('ai', e.text) : e.questions ? showQuestions(e.questions) : add(`tool${e.ok ? '' : ' bad'}`, e.summary)),
    });
    if (r.stop === 'refusal') add('err', 'The model declined this request.');
    if (r.stop === 'max_tokens') add('err', 'The reply was cut off (too long). Try a smaller step.');
    if (r.stop === 'max_steps') add('err', 'Stopped after too many tool calls; the proposal so far is shown.');
    proposals.add(r.ops, r.draft);
    const cached = r.usage.cacheRead ? `, ${Math.round((100 * r.usage.cacheRead) / (r.usage.cacheRead + r.usage.cacheWrite + r.usage.input))}% cached` : '';
    return `${r.usage.output} tokens out${cached}`;
  }

  async function viaCli(text: string, note: string | undefined, images: ImageAttachment[], signal: AbortSignal): Promise<string> {
    const res = await fetch(`/api/ai/${engine}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: userTurnText(proposals.working(), note, text, proposals.recipes),
        ...(selectedModel() && { model: selectedModel() }), ...(selectedEffort() && { effort: selectedEffort() }),
        ...(images.length && { images }), ...(sessionId && { sessionId }),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? `AI proxy error ${res.status}`);
    }
    let summary = '';
    let lastText = '';
    await readCliStream(res.body, (e) => {
      if (e.type === 'session') sessionId = e.id;
      else if (e.type === 'text') add('ai', (lastText = e.text));
      else if (e.type === 'done') {
        if (e.sessionId) sessionId = e.sessionId;
        if (e.isError) throw new Error([e.text && e.text !== lastText ? e.text : '', e.hint].filter(Boolean).join('\n') || `${engineName(engine)} reported an error.`);
        else if (e.text && e.text !== lastText) add('ai', e.text);
        summary = e.outputTokens ? `${e.outputTokens} tokens out` : '';
      }
    });
    return summary;
  }

  async function submit() {
    const typed = input.value.trim();
    const answers = answersText();
    const ids = notes?.pending() ?? [];
    if ((!typed && !answers && !ids.length) || running) return;
    let prepared: ReturnType<typeof recipes.prepare> = null;
    let images: ImageAttachment[];
    try {
      if (recipes.context && proposals.pending?.stale) throw new Error('Discard the stale recipe proposal before sending another message.');
      images = shotBtn.getAttribute('aria-pressed') === 'true' ? [capture()] : [];
      prepared = recipes.prepare();
    } catch (err) {
      add('err', (err as Error).message);
      return; // Keep typed text, notes and recipe intact if preparation failed.
    }
    showRecipe();
    if (prepared) {
      try { onRecipePrepared?.(prepared.doc, [prepared.wrapperId]); } catch { /* Preview remains usable if camera framing fails. */ }
    }
    input.value = '';
    grow();
    closeQuestions();
    const said = [answers, typed].filter(Boolean).join('\n\n');
    const text = [...(recipes.context ? [recipes.context] : []), ...(ids.length ? [notesRequest(ids)] : []), ...(said ? [said] : [])].join('\n\n');
    log.querySelector('.welcome')?.remove();
    log.append(
      el(
        'div',
        { class: 'msg user' },
        ...(said ? [said] : []),
        ...(prepared ? [el('div', { class: 'shot' }, `Recipe: ${prepared.name}`)] : []),
        ...(notes && ids.length ? [notes.send(ids)] : []),
        ...(images.length ? [el('div', { class: 'shot' }, icon('camera'), 'with a picture of the view')] : []),
      ),
    );
    scroll();
    const note = [proposals.takeNote(), ...(images.length ? [viewNote?.()] : [])].filter(Boolean).join(' ') || undefined;

    const ctrl = new AbortController();
    setRunning(ctrl);
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 1000);
    status.textContent = '';
    workingTime.textContent = '';
    log.append(working);
    scroll();
    const tick = setInterval(() => (workingTime.textContent = `${secs()}s`), 500);
    try {
      const extra = await (engine === 'api' ? viaApi : viaCli)(text, note, images, ctrl.signal);
      status.textContent = [`${secs()}s`, extra].filter(Boolean).join(' · ');
    } catch (err) {
      status.textContent = '';
      if (ctrl.signal.aborted) add('tool', 'Stopped.');
      else add('err', (err as Error).message);
      if (recipes.context) {
        add('tool', 'The recipe copy is still a pending proposal. Send again to refine it, or Reject to remove it.');
        if (!input.value) { input.value = typed; grow(); }
      }
    } finally {
      clearInterval(tick);
      working.remove();
      setRunning(null);
    }
  }

  /** The box grows with what's typed, up to its max height. */
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!running) void submit();
    }
  });
  sendBtn.addEventListener('click', () => (running ? running.abort() : void submit()));
  const shotOn = () => shotBtn.getAttribute('aria-pressed') === 'true';
  const setShot = (on: boolean) => shotBtn.setAttribute('aria-pressed', String(on));
  shotBtn.addEventListener('click', () => {
    autoShot = false;
    setShot(!shotOn());
  });
  newChatBtn.addEventListener('click', () => {
    chat = newChat();
    sessionId = undefined;
    status.textContent = '';
    closeQuestions();
    log.replaceChildren(welcome());
    clearRecipe('New conversation');
    if (proposals.pending) add('tool', 'The existing proposal is still pending. Accept or Reject it before attaching another recipe.');
    notes?.reset();
  });

  setRunning(null);
  showEngine();
  return {
    get engine() {
      return engine;
    },
    get busy() { return !!running; },
    get recipeAttached() { return !!recipes.attachment; },
    attachRecipe(recipe, inputs, targets) {
      recipes.attach(recipe, inputs, targets);
      showRecipe();
      setTimeout(() => input.focus(), 0); // The Recipes modal closes after this callback returns.
    },
    subscribe(fn) { listeners.add(fn); },
    notesSlot,
    setNoteAttachments: (a) => void (notes = a),
    notesChanged(n) {
      // Notes are numbered like the pins, so a picture of the view goes with them unless turned off.
      if (n && !attached && !shotOn()) {
        autoShot = true;
        setShot(true);
      } else if (!n && autoShot) {
        autoShot = false;
        setShot(false);
      }
      attached = n;
      notesSlot.hidden = !n;
      showPlaceholder();
    },
  };
}

/** API engine transport: the local proxy (server/aiProxy.ts) holds the key. */
export const proxySend: Send = async (req, signal) => {
  const res = await fetch('/api/ai/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    ...(signal && { signal }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `AI proxy error ${res.status}`);
  return body;
};
