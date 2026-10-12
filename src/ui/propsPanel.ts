import type { DecorInfo } from '../plugins';
import { shapes } from '../plugins';
import { APPLIANCES } from '../plugins/generators/appliances';
import { el } from './dom';
import { icon } from './icons';
import type { PlaceItem, PlaceTool } from './placeTool';

/**
 * The Props catalog (A8): a toolbar button opening the props the scene can be staged with, grouped by
 * kind — appliances (generator assemblies, and the range hood), lighting, furniture, accessories.
 * Picking one hands it to the place tool. Built from the registry, so a new prop shape shows up here.
 */

const CSS = `
.props-wrap { position: relative; display: inline-flex; }
.props-pop { position: fixed; width: 372px; max-height: min(560px, calc(100dvh - 80px)); overflow: auto; }
.props-pop h4 { margin: 10px 0 6px; font-size: var(--fs-sm); color: var(--fg-2); font-weight: 600; }
.props-pop h4:first-child { margin-top: 0; }
.props-pop .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.props-pop .grid .btn { justify-content: center; white-space: normal; height: auto; min-height: 30px; padding: 4px 6px; line-height: 1.2; }
.props-pop .hint { margin: 10px 0 0; color: var(--fg-3); font-size: var(--fs-sm); }
`;

const GROUPS: [DecorInfo['category'], string][] = [
  ['appliance', 'Appliances'],
  ['lighting', 'Lighting'],
  ['furniture', 'Furniture'],
  ['accessory', 'Accessories'],
];

/** What the catalog offers, by group: appliance generators first, then each category's prop shapes. */
export function catalog(): { title: string; items: PlaceItem[] }[] {
  const decor = shapes.all().filter((d) => d.decor && !d.decor.internal);
  return GROUPS.map(([category, title]) => ({
    title,
    items: [
      ...(category === 'appliance' ? APPLIANCES.map((a): PlaceItem => ({ kind: 'generator', type: a.type, label: a.label })) : []),
      ...decor.filter((d) => d.decor!.category === category).map((d): PlaceItem => ({ kind: 'decor', type: d.type, label: d.decor!.label })),
    ],
  })).filter((g) => g.items.length);
}

export function mountPropsPanel(o: { slot: HTMLElement; placeTool: PlaceTool; beforeStart?(): void }): { close(): void } {
  document.head.append(el('style', {}, CSS));
  const button = el('button', { class: 'btn ghost', title: 'Props: appliances, lights, furniture and accessories to stage the scene' }, icon('props'), el('span', { class: 't' }, 'Props'));
  const pop = el(
    'div',
    { class: 'pop props-pop', role: 'dialog', 'aria-label': 'Props' },
    ...catalog().flatMap((g) => [
      el('h4', {}, g.title),
      el(
        'div',
        { class: 'grid' },
        ...g.items.map((item) => {
          const b = el('button', { class: 'btn', type: 'button', title: `Place a ${item.label.toLowerCase()}` }, item.label);
          b.addEventListener('click', () => {
            show(false);
            o.beforeStart?.();
            o.placeTool.start(item);
          });
          return b;
        }),
      ),
    ]),
    el('p', { class: 'hint' }, 'Click where it goes; Shift-click to place several; Esc to stop.'),
  );
  pop.hidden = true;
  const show = (on = pop.hidden) => {
    pop.hidden = !on;
    if (on) {
      // Under the button, kept on screen.
      const r = button.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 380, r.left + r.width / 2 - 186)))}px`;
    }
    sync();
  };
  const sync = () => button.setAttribute('aria-pressed', String(!pop.hidden || o.placeTool.active));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (o.placeTool.active) {
      o.placeTool.stop();
      return show(false);
    }
    show();
  });
  window.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !button.contains(e.target as Node)) show(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) show(false);
  });
  o.placeTool.subscribe(sync);
  o.slot.append(el('span', { class: 'props-wrap' }, button, pop));
  sync();
  return { close: () => show(false) };
}
