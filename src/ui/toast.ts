import { el } from './dom';
import { icon } from './icons';
import { shop } from './units';

/**
 * One place for feedback: a short line at the bottom of the 3D view (above the voice button, which
 * sets `--toast-bottom`). Info fades on its own; an error stays until it's dismissed or the next
 * message (or `toast('')`) replaces it.
 */

const CSS = `
.toast { position: absolute; left: 50%; bottom: var(--toast-bottom, 16px); z-index: 30; display: flex; align-items: flex-start; gap: 8px;
  max-width: min(560px, calc(100% - 32px)); padding: 7px 6px 7px 12px; background: var(--raised); border: 1px solid var(--line-2);
  border-radius: 8px; box-shadow: 0 8px 24px #0009; font-size: var(--fs-sm); line-height: 1.5; white-space: pre-wrap;
  opacity: 0; transform: translate(-50%, 6px); transition: opacity .15s, transform .15s; pointer-events: none; }
.toast.on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.toast.err { border-color: #f2706a73; }
.toast.err .msg { color: #f7b3ae; }
.toast .msg { padding-top: 1px; }
.toast .btn { margin: -2px 0; }
`;

const TTL_MS = 3500;
let box: HTMLElement | null = null;
let msg: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function mountToasts(parent: HTMLElement): void {
  parent.append(el('style', {}, CSS));
  msg = el('div', { class: 'msg' });
  const close = el('button', { class: 'btn ghost icon sm', title: 'Dismiss' }, icon('x'));
  close.addEventListener('click', () => toast(''));
  box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, msg, close);
  parent.append(box);
}

/** Shows `text` (empty clears). Errors stay until replaced or dismissed. */
export function toast(text: string, error = false): void {
  if (!box || !msg) return;
  clearTimeout(timer);
  box.classList.toggle('on', !!text);
  if (!text) return;
  msg.replaceChildren(...shop(text));
  box.classList.toggle('err', error);
  if (!error) timer = setTimeout(() => box?.classList.remove('on'), TTL_MS);
}
