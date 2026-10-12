import { FAMILY_LABELS, finishDef, FINISHES, type FinishFamily } from '../model/finishes';
import type { Finish } from '../model/schema';
import { el } from './dom';

/**
 * A finish picker (materials, parts, folders): the presets grouped by family, and a color beside it
 * when the preset takes one (a paint color, a stain). The first option clears the finish — what
 * it then looks like is `auto`. `value` 'mixed' = several things with different finishes.
 */
export interface FinishPickerOptions {
  value: Finish | undefined | 'mixed';
  /** The first option's label: what clearing it gives ("Auto (Birch plywood)"). */
  auto: string;
  /** Keeps it focused across re-renders (the inspector's `data-key`). */
  key?: string;
  /** `dragging`: from dragging the color (coalesce those into one undo step). */
  onChange(f: Finish | null, dragging?: boolean): void;
}

const STYLE = `
.finish-pick { display: flex; flex: 1; min-width: 0; align-items: center; gap: 4px; }
.finish-pick select { flex: 1; min-width: 0; }
.finish-pick input[type=color] { flex: none; }
`;
let styled = false;

/** "Paint #1f2a44", "Walnut". */
export function finishLabel(f: Finish): string {
  return `${finishDef(f.preset)?.label ?? f.preset}${f.color ? ` ${f.color.toLowerCase()}` : ''}`;
}

export function finishPicker(o: FinishPickerOptions): HTMLElement {
  if (!styled) {
    document.head.append(el('style', {}, STYLE));
    styled = true;
  }
  const value = o.value === 'mixed' ? undefined : o.value;
  const select = el('select', { title: 'How it looks (a look, not stock: the cut list keeps its material)' });
  if (o.key) select.dataset.key = o.key;
  if (o.value === 'mixed') select.append(el('option', { value: 'mixed', disabled: true }, 'Mixed'));
  select.append(el('option', { value: '' }, o.auto));
  for (const family of Object.keys(FAMILY_LABELS) as FinishFamily[]) {
    const defs = FINISHES.filter((f) => f.family === family);
    select.append(el('optgroup', { label: FAMILY_LABELS[family] }, ...defs.map((f) => el('option', { value: f.id }, f.label))));
  }
  select.value = o.value === 'mixed' ? 'mixed' : (value?.preset ?? '');

  const def = value && finishDef(value.preset);
  // A stain's neutral is white (no tint); paint shows its swatch until a color is picked.
  const neutral = (d: NonNullable<typeof def>) => (d.tint === 'replace' ? d.swatch : '#ffffff');
  const color = el('input', { type: 'color', value: value?.color ?? (def ? neutral(def) : '#ffffff'), title: def?.tint === 'multiply' ? 'Stain or tint' : 'Color' });
  if (o.key) color.dataset.key = `${o.key}:color`;
  color.hidden = !def || def.tint === 'none';

  select.addEventListener('change', () => {
    if (!select.value) return o.onChange(null);
    const next = finishDef(select.value)!;
    // A color carries over between presets that use it the same way (paint → lacquer), not paint → stain.
    const keep = value?.color && def && def.tint === next.tint && next.tint !== 'none';
    o.onChange({ preset: next.id, ...(keep && { color: value.color }) });
  });
  color.addEventListener('input', () => {
    if (!select.value || select.value === 'mixed') return;
    o.onChange({ ...value, preset: select.value, color: color.value }, true);
  });
  return el('div', { class: 'finish-pick' }, select, color);
}
