import { deserialize, serialize } from '../model/persistence';
import type { Doc } from '../model/schema';

const KEY = 'new-modeler.doc';

/** Last autosaved doc, or null. A doc that fails to load is kept under a backup key, never silently dropped. */
export function loadLocal(): Doc | null {
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
    return text ? deserialize(text) : null;
  } catch (err) {
    console.warn('autosaved model could not be loaded; kept as', `${KEY}.unreadable`, err);
    try {
      if (text) localStorage.setItem(`${KEY}.unreadable`, text);
    } catch {
      // storage unavailable
    }
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function saveLocalSoon(doc: Doc): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, serialize(doc));
    } catch (err) {
      console.warn('autosave failed', err);
    }
  }, 250);
}

export function downloadFile(doc: Doc, name = 'model.modeler.json'): void {
  const url = URL.createObjectURL(new Blob([serialize(doc)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** Opens a file picker; resolves to the loaded doc (throws ModelError on a bad file) or null if cancelled. */
export function pickFile(): Promise<Doc | null> {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(deserialize(await file.text()));
      } catch (err) {
        reject(err);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
