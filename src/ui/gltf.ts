import type { Store } from '../model/store';
import { el } from './dom';
import { toast } from './toast';

/** "glTF": downloads the model for other 3D apps, with an opening animation for every door, drawer and lid. */
export function mountGltfExport(o: { slot: HTMLElement; store: Store }): void {
  const btn = el(
    'button',
    { class: 'btn ghost', title: 'Download the model as glTF (.glb) with an Open animation for each door, drawer and lid — for Blender, 3D viewers and web pages' },
    'glTF',
  );
  o.slot.append(btn);
  btn.addEventListener('click', async () => {
    const doc = o.store.doc;
    if (!doc.roots.length) return toast('The model is empty — nothing to export.', true);
    btn.disabled = true;
    try {
      // The exporter loads on first use.
      const { exportGlb } = await import('../render/gltfExport');
      const bytes = await exportGlb(doc);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      Object.assign(document.createElement('a'), { href: url, download: 'model.glb' }).click();
      URL.revokeObjectURL(url);
      const n = Object.keys(doc.motions).length;
      toast(`Exported model.glb${n ? ` with ${n} opening animation${n === 1 ? '' : 's'} (and “Open all”)` : ''}.`);
    } catch (err) {
      toast(`Couldn't export: ${(err as Error).message}`, true);
    } finally {
      btn.disabled = false;
    }
  });
}
