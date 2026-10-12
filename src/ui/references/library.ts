/**
 * The reference pictures, kept in this browser (IndexedDB) so they're there after a reload. They are
 * not part of the model file: a wall of photos would make every save and AI request heavy. Every call
 * fails soft — with storage unavailable the pictures last for this session.
 */

export interface RefImage {
  id: string;
  blob: Blob;
  name: string;
  w: number;
  h: number;
  /** When it was added (ms); the wall is in this order. */
  added: number;
}

const DB = 'new-modeler.references';
const STORE = 'images';

let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(null);
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function loadImages(): Promise<RefImage[]> {
  const all = ((await run('readonly', (s) => s.getAll())) ?? []) as RefImage[];
  return all.sort((a, b) => a.added - b.added);
}

/** True when it was saved for next time. */
export const saveImage = async (img: RefImage): Promise<boolean> => (await run('readwrite', (s) => s.put(img))) !== null;

export const deleteImage = async (id: string): Promise<void> => void (await run('readwrite', (s) => s.delete(id)));
