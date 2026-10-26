import { targetsOf } from '../edit/gizmo';
import { exportCollada, parseCollada, type ColladaScene } from '../io/collada';
import { importSketchUp, type ImportSummary } from '../io/sketchupImport';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { el } from './dom';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * SketchUp exchange: Import… adds a SketchUp model (.skp, read by the local server through SketchUp's own
 * library, or a COLLADA .dae export) as editable parts in one undo step; Export downloads a .dae.
 */

export interface SketchUpOptions {
  slot: HTMLElement;
  store: Store;
  selection: Selection;
  editBlocked: () => string | null;
  onImported?: (doc: Doc, ids: string[]) => void;
}

export function mountSketchUp(o: SketchUpOptions): void {
  const importBtn = el(
    'button',
    { class: 'btn ghost', title: 'Add a SketchUp model (.skp, or a COLLADA .dae export) as editable parts' },
    'Import SketchUp…',
  );
  const exportBtn = el('button', { class: 'btn ghost', title: 'Download the model for SketchUp (.dae). In SketchUp: File › Import' }, 'Export for SketchUp (.dae)');
  o.slot.append(importBtn, exportBtn);

  importBtn.addEventListener('click', async () => {
    const blocked = o.editBlocked();
    if (blocked) return toast(blocked, true);
    const file = await pickFile();
    if (!file) return;
    try {
      const title = file.name.replace(/\.(dae|skp)$/i, '') || 'SketchUp import';
      const scene = /\.skp$/i.test(file.name) ? await readSkp(file) : parseCollada(await file.text());
      const insertion = importSketchUp(o.store.doc, scene, title, { recognize: true });
      const result = o.store.dispatch(insertion.ops);
      if (!result.ok) throw new Error(result.error);
      o.selection.set(targetsOf(result.doc, [insertion.wrapperId]));
      o.onImported?.(result.doc, [insertion.wrapperId]);
      toast(describe(insertion.summary));
    } catch (err) {
      toast(`Couldn't import that file: ${(err as Error).message}`, true);
    }
  });

  exportBtn.addEventListener('click', () => {
    const doc = o.store.doc;
    if (!doc.roots.length) return toast('The model is empty — nothing to export.', true);
    try {
      const url = URL.createObjectURL(new Blob([exportCollada(doc)], { type: 'model/vnd.collada+xml' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'model.dae' });
      a.click();
      URL.revokeObjectURL(url);
      toast('Exported model.dae. In SketchUp: File › Import, then choose COLLADA.');
    } catch (err) {
      toast(`Couldn't export: ${(err as Error).message}`, true);
    }
  });
}

/** .skp files are read by the local server (server/skp.ts), which needs SketchUp installed on the PC. */
async function readSkp(file: File): Promise<ColladaScene> {
  const noServer = 'opening .skp files needs Modeler running on a PC with SketchUp installed. In SketchUp: File › Export › 3D Model › COLLADA (.dae), and import that instead';
  let res: Response;
  try {
    res = await fetch('/api/skp', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } });
  } catch {
    throw new Error(noServer);
  }
  const body = (await res.json().catch(() => null)) as { scene?: ColladaScene; error?: { message?: string } } | null;
  if (res.ok && body?.scene) return body.scene;
  throw new Error(res.status === 404 || !body ? noServer : (body.error?.message ?? `error ${res.status}`));
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.skp,.dae,model/vnd.collada+xml' });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function describe(s: ImportSummary): string {
  const made = [s.boxes && plural(s.boxes, 'board'), s.outlines && plural(s.outlines, 'shaped part'), s.blocks && plural(s.blocks, 'blockout')].filter(Boolean);
  const notes = [
    s.simplified && `${plural(s.simplified, 'part')} lost holes or pockets`,
    s.skipped && `skipped ${plural(s.skipped, 'flat face')}`,
    s.materialsAdded.length && `added ${s.materialsAdded.join(', ')}`,
  ].filter(Boolean);
  const r = s.recognized;
  const native = [
    r?.walls && `${plural(r.walls, 'wall')} with ${plural(r.openings, 'door or window', 'doors and windows')}`,
    r?.cabinets && plural(r.cabinets, 'cabinet'),
    r?.counters && plural(r.counters, 'countertop'),
    r?.rooms && plural(r.rooms, 'room'),
  ].filter(Boolean).join(', ');
  const raw = made.join(', ');
  const what = [native, raw && (native ? `and ${raw} as they were` : raw)].filter(Boolean).join(' ');
  if (s.unrecognized) notes.unshift(`${plural(s.unrecognized, 'piece')} came in as drawn: the app couldn't build ${s.unrecognized === 1 ? 'it' : 'them'}`);
  return `Imported ${what || 'nothing'}${notes.length ? ` (${notes.join('; ')})` : ''}. Undo removes it.`;
}
