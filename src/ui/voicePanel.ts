import { TidyOutput, type TidyInput } from '../ai/tidy';
import { targetPoint } from '../edit/targets';
import type { V3 } from '../geometry/types';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import type { Pin } from '../render/overlay';
import type { DraftNote } from '../voice/align';
import { scriptedRecognizer, speechSupported, webSpeech, type Recognizer } from '../voice/recognizer';
import { timeline, type SimStep } from '../voice/script';
import { createVoiceSession, type SessionDump, type VoiceSession } from '../voice/session';
import type { ChatApi, Engine } from './chatPanel';
import { el } from './dom';
import { icon } from './icons';
import { targetLabel } from './labels';
import type { Selection } from './selection';

/**
 * Voice notes: press M (or the Talk button floating at the bottom of the 3D view), talk while
 * pointing at the model, press M again. Draft pins follow what you're talking about as you speak;
 * when you stop, Claude tidies the notes and they're added like typed ones (one undo step), waiting
 * on the chat's message box. A caption by the cursor shows what's heard and what it's attaching
 * to; a chip above the button shows progress and results.
 */

const STYLE = `
.voice-dock { position: absolute; left: 50%; bottom: 16px; z-index: 6; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: max-content; max-width: calc(100% - 32px); pointer-events: none; }
.voice-dock > * { pointer-events: auto; }
.voice-btn { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px 0 14px; border: 1px solid var(--line-2); border-radius: 20px;
  background: var(--raised); color: var(--fg); font-size: var(--fs); font-weight: 600; box-shadow: 0 8px 24px #0008; cursor: pointer;
  transition: background-color .12s, border-color .12s; }
.voice-btn:hover:not(:disabled) { background: #2a2d33; border-color: var(--line-3); }
.voice-btn:disabled { padding-right: 14px; cursor: default; }
.voice-btn svg { width: 18px; height: 18px; color: var(--note); }
.voice-btn.off { opacity: .6; }
.voice-btn.rec { background: var(--note); border-color: var(--note); color: #fff; }
.voice-btn.rec:hover:not(:disabled) { background: #f0654f; border-color: #f0654f; }
.voice-btn .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: mic-pulse 1s ease-in-out infinite; }
.voice-btn .clock { font-variant-numeric: tabular-nums; font-weight: 500; }
.voice-btn.rec kbd { background: #0000002e; border-color: #ffffff4d; color: #fff; }
@keyframes mic-pulse { 50% { opacity: .25; } }
.voice-chip { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 10px; max-width: min(560px, 100%); padding: 6px 6px 6px 12px;
  background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 8px 24px #0008; font-size: var(--fs-sm); }
.voice-chip.rec { border-color: #e8543f80; }
.voice-chip.err { border-color: #f2706a73; color: #f7b3ae; }
.voice-chip b { font-weight: 600; }
.voice-chip .hint { color: var(--fg-3); }
.voice-chip .privacy { flex-basis: 100%; padding-right: 6px; color: var(--fg-3); font-size: var(--fs-xs); }
.voice-cap { position: fixed; z-index: 60; max-width: 340px; padding: 5px 9px; pointer-events: none; background: #141518f0; border: 1px solid var(--line-2);
  border-left: 3px solid var(--note); border-radius: 6px; color: var(--fg); font: var(--fs-sm)/1.45 var(--font); }
.voice-cap .interim { color: var(--fg-3); }
.voice-cap .to { display: block; margin-top: 2px; color: #ffb4a8; }
`;

const ACK_KEY = 'new-modeler.voice-ack';
const CAPTION_WORDS = 12;
const STATUS_MS = 8000;

export interface VoicePanelOptions {
  store: Store;
  selection: Selection;
  chat: ChatApi;
  /** The doc on screen (an AI proposal while one is pending). */
  shown(): Doc;
  /** Draft pins changed. */
  onPins(): void;
}

export interface VoicePanel {
  session: VoiceSession;
  /** Draft pins for the overlay, numbered after the open notes. */
  pins(doc: Doc): Pin[];
  /** Plays a scripted session through the real UI (no microphone needed); resolves when its notes are added. */
  simulate(steps: SimStep[]): Promise<SessionDump | null>;
}

/** The dev server's tidy endpoint (server/aiProxy.ts), on the chat's engine. */
async function proxyTidy(engine: Engine, input: TidyInput, signal: AbortSignal): Promise<TidyOutput> {
  const res = await fetch('/api/ai/tidy-notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine, input }), signal });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; hint?: string } };
  if (!res.ok) throw new Error([body.error?.message ?? `HTTP ${res.status}`, body.error?.hint].filter(Boolean).join(' — '));
  return TidyOutput.parse(body);
}

const load = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage unavailable
  }
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function mountVoicePanel(parent: HTMLElement, o: VoicePanelOptions): VoicePanel {
  parent.append(el('style', {}, STYLE));
  const supported = speechSupported();
  let scripted: Recognizer | null = null;

  const session = createVoiceSession({
    recognizer: () => {
      const r = scripted ?? webSpeech();
      scripted = null;
      return r;
    },
    now: () => performance.now(),
    doc: o.shown,
    selection: () => o.selection.targets,
    dispatch: (ops) => o.store.dispatch(ops),
    tidy: (input, signal) => proxyTidy(o.chat.engine, input, signal),
    tidyTimeoutMs: () => (o.chat.engine === 'api' ? 20_000 : 45_000),
    onChange: () => render(),
  });

  // ── Talk button, status chip above it, caption by the cursor ─────────────
  const mic = el('button', { class: `voice-btn${supported ? '' : ' off'}`, title: supported ? 'Voice notes: talk while pointing at the model (M)' : 'Voice notes need Chrome or Edge' });
  mic.addEventListener('click', () => session.toggle());
  const chip = el('div', { class: 'voice-chip', role: 'status' });
  const dock = el('div', { class: 'voice-dock' }, chip, mic);
  const caption = el('div', { class: 'voice-cap' });
  parent.append(dock);
  document.body.append(caption);
  // Toasts sit above the dock.
  new ResizeObserver(() => parent.style.setProperty('--toast-bottom', `${dock.offsetHeight + 24}px`)).observe(dock);
  let cursor = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    cursor = { x: e.clientX, y: e.clientY };
    if (caption.style.display !== 'none') placeCaption();
  });
  const placeCaption = () => {
    const r = caption.getBoundingClientRect();
    caption.style.left = `${Math.min(cursor.x + 18, window.innerWidth - r.width - 8)}px`;
    caption.style.top = `${Math.min(cursor.y + 16, window.innerHeight - r.height - 8)}px`;
  };

  let statusSeen = session.status;
  let statusAt = 0;
  let dismissed: typeof statusSeen | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let pinSig = '';

  const label = (doc: Doc, d: DraftNote | undefined) => (d?.targets.length ? d.targets.map((t) => targetLabel(doc, t)).join(' + ') : '');
  const button = (text: string | Node, onClick: () => void, title = '') => {
    const b = el('button', { class: `btn ghost sm${typeof text === 'string' ? '' : ' icon'}`, title }, text);
    b.addEventListener('click', onClick);
    return b;
  };

  function render() {
    const doc = o.shown();
    const live = session.live();
    const current = live.drafts.at(-1);
    const elapsed = clock(performance.now() - (session.startedAt ?? 0));
    mic.classList.toggle('rec', session.recording || session.stopping);
    mic.disabled = session.stopping;
    mic.replaceChildren(
      ...(session.stopping
        ? [el('span', { class: 'dot' }), 'Finishing…']
        : session.recording
          ? [el('span', { class: 'dot' }), el('span', { class: 'clock' }, elapsed), 'Stop', el('kbd', {}, 'M')]
          : [icon('mic'), 'Talk', el('kbd', {}, 'M')]),
    );

    if (session.status !== statusSeen) {
      statusSeen = session.status;
      statusAt = performance.now();
    }
    const kids: (Node | string)[] = [];
    let cls = '';
    if (session.recording || session.stopping) {
      cls = 'rec';
      const to = label(doc, current);
      kids.push(to ? el('span', {}, `→ ${to}`) : el('b', {}, 'Listening'), el('span', { class: 'hint' }, to ? 'Esc discards' : 'Point at what you mean · Esc discards'));
      if (!load(ACK_KEY)) {
        kids.push(
          el(
            'span',
            { class: 'privacy' },
            'Your browser sends the audio to its speech service (Google in Chrome, Microsoft in Edge); the text and part names then go to Claude to tidy the notes.',
          ),
        );
      }
    }
    if (session.tidying) {
      if (kids.length) kids.push(el('span', { class: 'hint' }, '·'));
      kids.push(`Tidying ${session.tidying} note${session.tidying === 1 ? '' : 's'}…`, button('Skip', () => session.skipTidy()));
    }
    const s = session.status;
    const fresh = s.text && s !== dismissed && (s.error || performance.now() - statusAt < STATUS_MS);
    if (!kids.length && fresh) {
      cls = s.error ? 'err' : '';
      kids.push(s.text, button(icon('x'), () => ((dismissed = s), render()), 'Dismiss'));
    }
    chip.className = `voice-chip ${cls}`;
    chip.replaceChildren(...kids);
    chip.style.display = kids.length ? '' : 'none';

    // Caption by the cursor: the last words heard (unsettled ones dimmed) and what they attach to.
    if (session.recording || session.stopping) {
      const words = live.words.slice(-CAPTION_WORDS);
      const settled = words.filter((w) => w.final).map((w) => w.text);
      const interim = words.filter((w) => !w.final).map((w) => w.text);
      const to = label(doc, current);
      caption.replaceChildren(
        ...(words.length ? [`${live.words.length > CAPTION_WORDS ? '… ' : ''}${settled.join(' ')} `, el('span', { class: 'interim' }, interim.join(' '))] : ['Listening…']),
        ...(to ? [el('span', { class: 'to' }, `→ ${to}`)] : []),
      );
      caption.style.display = '';
      placeCaption();
    } else {
      caption.style.display = 'none';
    }

    const busy = session.recording || session.stopping || !!session.tidying || !!fresh;
    if (busy && !ticker) ticker = setInterval(render, 1000);
    if (!busy && ticker) ticker = void clearInterval(ticker);
    if (!session.recording && !session.stopping && live.words.length === 0 && session.last()) save(ACK_KEY, '1');

    const sig = JSON.stringify([session.recording, live.drafts.map((d) => [d.targets, Math.round(d.confidence * 10)])]);
    if (sig !== pinSig) {
      pinSig = sig;
      o.onPins();
    }
  }

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'm') session.toggle();
    else if (k === 'escape' && (session.recording || session.stopping)) session.cancel();
    else return;
    e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) session.stop();
  });
  render();

  return {
    session,
    pins(doc) {
      const open = Object.values(doc.annotations).filter((a) => !a.resolved).length;
      const drafts = session.live().drafts;
      return drafts.flatMap((d, i): Pin[] => {
        const pts = d.targets.map((t) => targetPoint(doc, t));
        const at = pts.find((p): p is V3 => p !== null);
        if (!at) return [];
        return [
          {
            noteId: `voice:${i}`,
            label: String(open + i + 1),
            at,
            links: pts.filter((p): p is V3 => p !== null && p !== at),
            active: session.recording && i === drafts.length - 1,
            draft: true,
            opacity: 0.35 + 0.5 * d.confidence,
          },
        ];
      });
    },
    async simulate(steps) {
      if (session.recording || session.stopping) throw new Error('already recording');
      const tl = timeline(steps);
      scripted = scriptedRecognizer(tl.events);
      session.start();
      for (const h of tl.hovers) {
        setTimeout(() => {
          o.selection.setHover(h.target);
          session.hover(h.target);
        }, h.at);
      }
      await new Promise((resolve) => setTimeout(resolve, tl.end + 300));
      session.stop();
      await session.whenIdle();
      return session.last();
    },
  };
}
