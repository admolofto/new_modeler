import { el } from './dom';

/**
 * On the hosted app, notices when a newer build has been published (each build's script has a
 * new hashed name) and offers a Reload button. Checks when the tab comes back into focus and
 * every half hour. The model is autosaved, so reloading keeps the work. Off on the dev server.
 */

const CSS = `
.update-ready { position: fixed; left: 50%; top: 56px; transform: translateX(-50%); z-index: 1000; display: flex; align-items: center; gap: 12px;
  padding: 8px 8px 8px 14px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 8px 24px #0009;
  font-size: var(--fs-sm); }
`;
const EVERY_MS = 30 * 60_000;

/** The module script a page loads (its build's entry). */
export function entryScript(doc: Document, base: string): string | null {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
  return src ? new URL(src, base).href : null;
}

export function watchForUpdates(): void {
  if (import.meta.env.DEV) return;
  const current = entryScript(document, location.href);
  if (!current) return;
  let shown = false;
  let checking = false;
  const check = async () => {
    if (shown || checking) return;
    checking = true;
    try {
      const html = await (await fetch(location.pathname, { cache: 'no-store' })).text();
      const latest = entryScript(new DOMParser().parseFromString(html, 'text/html'), location.href);
      if (latest && latest !== current) show();
    } catch {
      // offline: try again later
    } finally {
      checking = false;
    }
  };
  const show = () => {
    shown = true;
    const reload = el('button', { class: 'btn ai' }, 'Reload');
    reload.addEventListener('click', () => location.reload());
    const later = el('button', { class: 'btn ghost' }, 'Later');
    const bar = el('div', { class: 'update-ready', role: 'status' }, 'A new version of Modeler is ready.', reload, later);
    later.addEventListener('click', () => bar.remove());
    document.body.append(el('style', {}, CSS), bar);
  };
  window.addEventListener('focus', () => void check());
  setInterval(() => void check(), EVERY_MS);
}
