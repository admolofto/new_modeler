import { targetsOf } from '../edit/gizmo';
import { exportCollada, parseCollada } from '../io/collada';
import { importSketchUp, type ImportSummary } from '../io/sketchupImport';
import type { Doc } from '../model/schema';
import type { Store } from '../model/store';
import { el } from './dom';
import type { Selection } from './selection';
import { toast } from './toast';

/**
 * SketchUp exchange through COLLADA (.dae), which SketchUp reads and writes natively:
 * Import… adds a SketchUp model as editable parts in one undo step; Export downloads the model.
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
    { class: 'btn ghost', title: 'Add a SketchUp model as editable parts. In SketchUp: File › Export › 3D Model, type COLLADA (.dae)' },
    'Import…',
  );
  const exportBtn = el('button', { class: 'btn ghost', title: 'Download the model for SketchUp (.dae). In SketchUp: File › Import' }, 'Export');
  o.slot.append(importBtn, exportBtn);

  importBtn.addEventListener('click', async () => {
    const blocked = o.editBlocked();
    if (blocked) return toast(blocked, true);
    const file = await pickDae();
    if (!file) return;
    try {
      const title = file.name.replace(/\.dae$/i, '') || 'SketchUp import';
      const insertion = importSketchUp(o.store.doc, parseCollada(await file.text()), title);
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

function pickDae(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.dae,model/vnd.collada+xml' });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describe(s: ImportSummary): string {
  const made = [s.boxes && plural(s.boxes, 'board'), s.outlines && plural(s.outlines, 'shaped part'), s.blocks && plural(s.blocks, 'blockout')].filter(Boolean);
  const notes = [
    s.simplified && `${plural(s.simplified, 'part')} lost holes or pockets`,
    s.skipped && `skipped ${plural(s.skipped, 'flat face')}`,
    s.materialsAdded.length && `added ${s.materialsAdded.join(', ')}`,
  ].filter(Boolean);
  return `Imported ${made.join(', ') || 'nothing'}${notes.length ? ` (${notes.join('; ')})` : ''}. Undo removes it.`;
}
