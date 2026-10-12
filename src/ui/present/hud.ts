import type { LightingPreset } from '../../model/schema';
import type { PresetId } from '../../render/present/lightPlan';
import type { Quality, Tier } from '../../render/present/pipeline';
import { TIER_LABELS } from '../../render/present/pipeline';
import { el } from '../dom';
import { icon } from '../icons';

/**
 * Presentation's controls (B1): a translucent pill at the bottom center of the view — Open all, Close
 * all, Orbit | Walk, the lighting (Auto / Day / Evening / Night / Studio, and a popover with the
 * brightness and the under-cabinet lights), Save image, Photo (a path-traced still, phase 9: its own
 * panel takes the pill's place while it renders), the rendering quality, and Exit. Above it the
 * views strip (phase 8): a chip per view of the tour (click to fly there; right-click to rename, update
 * to the view on screen, move or delete it) and "+ Save view"; the current view's name and caption
 * show at the top left. Fullscreen (F) fills the screen with the view; H hides the controls, and
 * they fade on their own after a few seconds without the mouse moving (back on any move).
 */

/** Seconds without the pointer moving before the controls fade. */
const IDLE_SECONDS = 3;

/** An aperture (the Photo button), drawn here: the shared icon set is in the editor's bundle. */
const APERTURE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/></svg>';

export const LIGHTING_CHOICES: readonly { id: LightingPreset; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Day in a room, the studio without one' },
  { id: 'day', label: 'Day', title: 'Sunlight through the windows' },
  { id: 'evening', label: 'Evening', title: 'A low warm sun, the lights on' },
  { id: 'night', label: 'Night', title: 'Only the lights' },
  { id: 'studio', label: 'Studio', title: 'The model alone on a soft gray backdrop' },
];

/** The lighting as the HUD shows it. */
export interface HudLighting {
  /** Saved (`auto` included) and drawn. */
  preset: LightingPreset;
  drawn: PresetId;
  /** Brightness (EV). */
  ev: number;
  /** Under-cabinet lights: whether there are any (wall cabinets, not the studio), and on. */
  underCabinet: { available: boolean; on: boolean };
}

const CSS = `
.pr-hud[hidden], .pr-views[hidden] { display: none !important; }
.pr-hud, .pr-views, .pr-caption { transition: opacity .35s; }
.pr-idle .pr-hud:not(:hover), .pr-idle .pr-views:not(:hover), .pr-idle .pr-caption,
.pr-hud-off .pr-hud, .pr-hud-off .pr-views, .pr-hud-off .pr-caption { opacity: 0; pointer-events: none; }
.pr-hud { position: absolute; left: 50%; bottom: 20px; z-index: 20; transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
  padding: 4px; background: #16171bcc; border: 1px solid #ffffff1f; border-radius: 999px; box-shadow: 0 10px 30px #0004;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #f2f2f0; user-select: none; }
.pr-hud .btn { height: 32px; padding: 0 14px; border-radius: 999px; background: none; color: #e9e9e6; font-size: var(--fs); }
.pr-hud .btn:hover:not(:disabled) { background: #ffffff1a; color: #fff; }
.pr-hud .btn.icon { width: 32px; padding: 0; }
.pr-hud .sep { width: 1px; height: 18px; margin: 0 4px; background: #ffffff2a; }
.pr-hud select { height: 32px; padding: 0 26px 0 12px; border: 0; border-radius: 999px; color: #e9e9e6; font: inherit; font-size: var(--fs);
  background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='m1 1 4 4 4-4' fill='none' stroke='%23d8d8d4' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center;
  appearance: none; cursor: pointer; }
.pr-hud select:hover { background-color: #ffffff1a; }
.pr-hud select option { color: #16171b; background: #f4f4f2; }
.pr-hud .seg { display: flex; gap: 0; padding: 2px; border-radius: 999px; background: #ffffff10; }
.pr-hud .seg .btn { height: 28px; padding: 0 11px; }
.pr-hud .seg .btn.on { background: #f2f2f0; color: #16171b; }
.pr-hud .seg .btn.on:hover { background: #fff; color: #16171b; }
.pr-hud .btn.icon.open { background: #ffffff26; }
.pr-pop { position: absolute; bottom: calc(100% + 10px); z-index: 21; width: 240px; padding: 12px 14px; display: grid; gap: 10px;
  background: #16171bea; border: 1px solid #ffffff1f; border-radius: 12px; box-shadow: 0 10px 30px #0005; color: #e9e9e6; font-size: var(--fs-sm); }
.pr-pop[hidden] { display: none; }
.pr-pop .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pr-pop input[type=range] { width: 100%; accent-color: #f2f2f0; }
.pr-pop label.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.pr-pop label.check.off { opacity: .45; cursor: default; }
.pr-pop .muted { color: #a9aaa6; }
.pr-views { position: absolute; left: 50%; bottom: 66px; z-index: 20; transform: translateX(-50%); display: flex; gap: 6px; align-items: center;
  max-width: calc(100% - 32px); overflow-x: auto; padding: 2px; scrollbar-width: none; user-select: none; }
.pr-views::-webkit-scrollbar { display: none; }
.pr-views .chip { flex: none; height: 28px; max-width: 220px; padding: 0 12px; border-radius: 999px; border: 1px solid #ffffff24; background: #16171bb3;
  color: #e9e9e6; font: inherit; font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 4px 14px #0003; }
.pr-views .chip:hover { background: #26272dd0; color: #fff; }
.pr-views .chip.on { background: #f2f2f0; color: #16171b; border-color: #f2f2f0; }
.pr-views .chip .n { opacity: .55; margin-right: 6px; font-variant-numeric: tabular-nums; }
.pr-views .chip.add { border-style: dashed; background: #16171b80; }
.pr-views input.chip { cursor: text; width: 160px; outline: none; border-color: #f2f2f0; }
.pr-menu { position: fixed; z-index: 30; min-width: 170px; padding: 4px; display: grid; background: #16171bf0; border: 1px solid #ffffff1f;
  border-radius: 10px; box-shadow: 0 10px 30px #0005; }
.pr-menu[hidden] { display: none; }
.pr-menu button { height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: #e9e9e6; font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.pr-menu button:hover:not(:disabled) { background: #ffffff1a; color: #fff; }
.pr-menu button:disabled { opacity: .4; cursor: default; }
.pr-menu button.danger { color: #ffb4a8; }
.pr-caption { position: absolute; left: 20px; top: 20px; z-index: 20; max-width: min(520px, calc(100% - 40px)); padding: 10px 16px; border-radius: 12px;
  background: #16171bb3; color: #f4f4f2; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 6px 20px #0003; pointer-events: none; }
.pr-caption[hidden] { display: none; }
.pr-caption .nm { font-size: var(--fs-lg); font-weight: 600; letter-spacing: .01em; }
.pr-caption .cap { margin-top: 3px; font-size: var(--fs-sm); color: #d6d6d2; line-height: 1.4; }
.pr-caption .cap:empty { display: none; }
`;

/** A view in the strip. */
export interface HudView {
  id: string;
  name: string;
  caption?: string;
}

/** What the views strip's menu asks for. */
export type ViewAction = { id: string } & ({ kind: 'rename'; name: string } | { kind: 'update' } | { kind: 'delete' } | { kind: 'move'; by: -1 | 1 });

export interface HudOptions {
  openAll(): void;
  closeAll(): void;
  saveImage(): void;
  /** Starts a path-traced photo of the view. */
  photo(): void;
  setQuality(q: Quality): void;
  setLighting(preset: LightingPreset): void;
  /** The brightness slider: `done` once it's let go (saved then; before, only previewed). */
  setBrightness(ev: number, done: boolean): void;
  setUnderCabinet(on: boolean): void;
  /** Flies to view i. */
  goToView(i: number): void;
  /** Saves the view on screen as a new one at the end of the tour. */
  saveView(): void;
  viewAction(a: ViewAction): void;
  setMode(mode: 'orbit' | 'walk'): void;
  exit(): void;
}

export interface Hud {
  /** Re-reads what can open or close (after something opens, closes or the model changes). */
  sync(state: { any: boolean; allOpen: boolean; noneOpen: boolean }): void;
  /** Shows the quality picked, and the tier Auto is on. */
  setQuality(q: Quality, tier: Tier): void;
  /** An image is being saved: its button waits. */
  setSaving(on: boolean): void;
  setLighting(l: HudLighting): void;
  /** The tour's views, and the one last gone to (its name and caption show at the top left). */
  setViews(views: readonly HudView[], current: string | null): void;
  setMode(mode: 'orbit' | 'walk'): void;
  /** A photo is rendering: the pill, the views strip and the caption step aside for its panel. */
  setPhoto(on: boolean): void;
  /** Closes the lighting popover or the views menu; false when neither was open. */
  closePopover(): boolean;
  /** Hides or shows the controls (H); the photo panel stays. */
  toggleHidden(): void;
  /** Into or out of fullscreen (F). */
  toggleFullscreen(): void;
  dispose(): void;
}

export function mountHud(parent: HTMLElement, o: HudOptions): Hud {
  const style = el('style', {}, CSS);
  const button = (title: string, ...kids: (Node | string)[]) => el('button', { class: 'btn', title }, ...kids);
  const openBtn = button('Open every door, drawer and lid (O)', icon('doorOpen'), 'Open all');
  const closeBtn = button('Close everything (O)', icon('doorClosed'), 'Close all');
  const saveLabel = el('span', {}, 'Save image');
  const saveBtn = button('Save this view as a PNG image, at twice the screen size', icon('camera'), saveLabel);
  const apertureTpl = document.createElement('template');
  apertureTpl.innerHTML = APERTURE;
  const photoBtn = button('Photo: a path-traced still of this view — light bouncing for real, glass and glow included (it takes a while)', apertureTpl.content.firstElementChild!, 'Photo');
  const quality = el(
    'select',
    { title: 'Rendering quality: Auto picks one for this computer (and steps down if moving gets slow)', 'aria-label': 'Rendering quality' },
    el('option', { value: 'auto' }, 'Auto'),
    el('option', { value: 'fast' }, 'Fast'),
    el('option', { value: 'balanced' }, 'Balanced'),
    el('option', { value: 'high' }, 'High'),
  );
  // Lighting: a segmented control, and a popover for the brightness and the under-cabinet lights.
  const presetBtns = LIGHTING_CHOICES.map((c) => {
    const b = el('button', { class: 'btn', title: `${c.title} (L cycles)`, 'aria-pressed': 'false' }, c.label);
    b.addEventListener('click', () => {
      o.setLighting(c.id);
      b.blur();
    });
    return b;
  });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Lighting' }, ...presetBtns);
  const lightBtn = el('button', { class: 'btn icon', title: 'Brightness and lights', 'aria-label': 'Brightness and lights', 'aria-expanded': 'false' }, icon('sun'));
  const evLabel = el('span', { class: 'muted' }, '0 EV');
  const range = el('input', { type: 'range', min: '-1', max: '1', step: '0.1', value: '0', 'aria-label': 'Brightness', title: 'Double-click to reset' });
  const underBox = el('input', { type: 'checkbox' });
  const underLabel = el('label', { class: 'check' }, underBox, 'Under-cabinet lights');
  const pop = el(
    'div',
    { class: 'pr-pop', role: 'dialog', 'aria-label': 'Lighting' },
    el('div', { class: 'row' }, el('span', {}, 'Brightness'), evLabel),
    range,
    underLabel,
  );
  pop.hidden = true;
  const evText = (ev: number) => `${ev > 0 ? '+' : ''}${Math.round(ev * 10) / 10} EV`;
  const togglePop = (open: boolean = !!pop.hidden) => {
    pop.hidden = !open;
    lightBtn.classList.toggle('open', open);
    lightBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      const r = lightBtn.getBoundingClientRect();
      const h = hud.getBoundingClientRect();
      pop.style.left = `${Math.max(0, r.left - h.left + r.width / 2 - 120)}px`;
    }
    lightBtn.blur();
  };
  lightBtn.addEventListener('click', () => togglePop());
  range.addEventListener('input', () => {
    evLabel.textContent = evText(+range.value);
    o.setBrightness(+range.value, false);
  });
  range.addEventListener('change', () => {
    o.setBrightness(+range.value, true);
    range.blur();
  });
  range.addEventListener('dblclick', () => {
    range.value = '0';
    evLabel.textContent = evText(0);
    o.setBrightness(0, true);
  });
  underBox.addEventListener('change', () => {
    o.setUnderCabinet(underBox.checked);
    underBox.blur();
  });
  // Orbit | Walk.
  const modeBtns = (['orbit', 'walk'] as const).map((m) => {
    const title =
      m === 'walk' ? 'Walk through the room at eye height: drag to look, WASD or the arrows to walk, double-click the floor to go there (V)' : 'Orbit around the model (V, Esc)';
    const b = el('button', { class: 'btn', 'aria-pressed': 'false', title }, m === 'walk' ? 'Walk' : 'Orbit');
    b.addEventListener('click', () => {
      o.setMode(m);
      b.blur();
    });
    return b;
  });
  const modeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Camera' }, ...modeBtns);

  // The views strip, its menu and the caption.
  const strip = el('div', { class: 'pr-views', role: 'toolbar', 'aria-label': 'Views' });
  const caption = el('div', { class: 'pr-caption', 'aria-live': 'polite' });
  caption.hidden = true;
  const menu = el('div', { class: 'pr-menu', role: 'menu' });
  menu.hidden = true;
  let shown: readonly HudView[] = [];
  let current: string | null = null;
  let renaming: string | null = null;
  const closeMenu = () => {
    if (menu.hidden) return false;
    menu.hidden = true;
    return true;
  };
  const onDown = (e: PointerEvent) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
  };
  window.addEventListener('pointerdown', onDown, true);
  const openMenu = (v: HudView, i: number, x: number, y: number) => {
    const item = (label: string, fn: () => void, disabled = false, danger = false) => {
      const b = el('button', { role: 'menuitem', ...(danger && { class: 'danger' }) }, label);
      b.disabled = disabled;
      b.addEventListener('click', () => {
        closeMenu();
        fn();
      });
      return b;
    };
    menu.replaceChildren(
      item('Rename…', () => startRename(v.id)),
      item('Update to current view', () => o.viewAction({ id: v.id, kind: 'update' })),
      item('Move left', () => o.viewAction({ id: v.id, kind: 'move', by: -1 }), i === 0),
      item('Move right', () => o.viewAction({ id: v.id, kind: 'move', by: 1 }), i === shown.length - 1),
      item('Delete', () => o.viewAction({ id: v.id, kind: 'delete' }), false, true),
    );
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, y - r.height - 6)}px`;
  };
  function startRename(id: string) {
    renaming = id;
    renderStrip();
  }
  /** A chip turned into a name field: Enter or leaving it saves, Esc cancels. */
  function renameField(v: HudView): HTMLInputElement {
    const input = el('input', { class: 'chip', value: v.name, 'aria-label': 'View name', maxlength: '80' });
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      renaming = null;
      const name = input.value.trim();
      if (save && name && name !== v.name) o.viewAction({ id: v.id, kind: 'rename', name });
      else renderStrip();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }
  function renderStrip() {
    const chips = shown.map((v, i) => {
      if (v.id === renaming) return renameField(v);
      const on = v.id === current;
      const title = `${v.caption ? `${v.caption}\n` : ''}Go to this view${i < 9 ? ` (${i + 1})` : ''} · right-click to rename, update, move or delete it`;
      const b = el('button', { class: `chip${on ? ' on' : ''}`, title, 'aria-pressed': String(on) }, el('span', { class: 'n' }, String(i + 1)), v.name);
      b.addEventListener('click', () => {
        o.goToView(i);
        b.blur();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(v, i, e.clientX, e.clientY);
      });
      return b;
    });
    const add = el('button', { class: 'chip add', title: "Save what's on screen as a view: the camera, orbit or walk, what's open, and the lighting if it differs" }, '+ Save view');
    add.addEventListener('click', () => {
      o.saveView();
      add.blur();
    });
    strip.replaceChildren(...chips, add);
    const v = shown.find((x) => x.id === current);
    caption.hidden = !v;
    caption.replaceChildren(el('div', { class: 'nm' }, v?.name ?? ''), el('div', { class: 'cap' }, v?.caption ?? ''));
  }
  renderStrip();

  const exitBtn = el('button', { class: 'btn icon', title: 'Leave presentation (Esc)', 'aria-label': 'Exit presentation' }, icon('x'));
  const fullBtn = el('button', { class: 'btn icon', title: 'Fullscreen (F)', 'aria-label': 'Fullscreen', 'aria-pressed': 'false' }, icon('maximize'));
  const toggleFullscreen = () => {
    const done = () => undefined;
    if (document.fullscreenElement) void document.exitFullscreen().catch(done);
    else void document.documentElement.requestFullscreen?.().catch(done);
  };
  const syncFullscreen = () => {
    const on = !!document.fullscreenElement;
    fullBtn.replaceChildren(icon(on ? 'minimize' : 'maximize'));
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.title = on ? 'Leave fullscreen (F)' : 'Fullscreen (F)';
  };
  fullBtn.addEventListener('click', () => {
    fullBtn.blur();
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', syncFullscreen);
  const motionSep = el('div', { class: 'sep' });
  openBtn.addEventListener('click', () => o.openAll());
  closeBtn.addEventListener('click', () => o.closeAll());
  saveBtn.addEventListener('click', () => o.saveImage());
  photoBtn.addEventListener('click', () => {
    photoBtn.blur();
    o.photo();
  });
  quality.addEventListener('change', () => {
    o.setQuality(quality.value as Quality);
    // Back to the view, so presentation keys work again.
    quality.blur();
  });
  exitBtn.addEventListener('click', () => o.exit());
  const hud = el(
    'div',
    { class: 'pr-hud', role: 'toolbar', 'aria-label': 'Presentation' },
    openBtn,
    closeBtn,
    motionSep,
    modeSeg,
    el('div', { class: 'sep' }),
    seg,
    lightBtn,
    el('div', { class: 'sep' }),
    saveBtn,
    photoBtn,
    quality,
    el('div', { class: 'sep' }),
    fullBtn,
    exitBtn,
    pop,
  );
  parent.append(style, caption, strip, hud, menu);

  // The controls fade after a while without the pointer moving (not while a popover, the menu or a
  // rename is open), and come back on any move; H hides them until pressed again.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const busy = () => !pop.hidden || !menu.hidden || !!renaming;
  const wake = () => {
    parent.classList.remove('pr-idle');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!busy()) parent.classList.add('pr-idle');
    }, IDLE_SECONDS * 1000);
  };
  parent.addEventListener('pointermove', wake);
  parent.addEventListener('pointerdown', wake);
  wake();
  return {
    sync({ any, allOpen, noneOpen }) {
      openBtn.hidden = !any;
      closeBtn.hidden = !any;
      openBtn.disabled = allOpen;
      closeBtn.disabled = noneOpen;
      motionSep.hidden = !any;
    },
    setQuality(q, tier) {
      quality.value = q;
      quality.options[0]!.textContent = `Auto · ${TIER_LABELS[tier]}`;
      for (const opt of [...quality.options].slice(1)) opt.textContent = TIER_LABELS[opt.value as Tier];
      // The closed select shows the picked option's text; Auto names the tier it's on.
      if (q !== 'auto') quality.options[0]!.textContent = 'Auto';
    },
    setLighting(l) {
      LIGHTING_CHOICES.forEach((c, i) => {
        const on = c.id === l.preset;
        presetBtns[i]!.classList.toggle('on', on);
        presetBtns[i]!.setAttribute('aria-pressed', String(on));
      });
      // Auto names what it shows.
      presetBtns[0]!.textContent = l.preset === 'auto' ? `Auto · ${LIGHTING_CHOICES.find((c) => c.id === l.drawn)!.label}` : 'Auto';
      if (document.activeElement !== range) {
        range.value = String(l.ev);
        evLabel.textContent = evText(l.ev);
      }
      underBox.checked = l.underCabinet.on;
      underBox.disabled = !l.underCabinet.available;
      underLabel.classList.toggle('off', !l.underCabinet.available);
      underLabel.title = l.underCabinet.available ? 'Light strips under the wall cabinets' : l.drawn === 'studio' ? 'Not in the studio' : 'There are no wall cabinets';
    },
    setViews(views, cur) {
      if (renaming && !views.some((v) => v.id === renaming)) renaming = null;
      const same = views.length === shown.length && views.every((v, i) => v.id === shown[i]!.id && v.name === shown[i]!.name && v.caption === shown[i]!.caption);
      shown = views;
      if (same && cur === current) return;
      current = cur;
      if (!renaming) renderStrip();
    },
    setMode(m) {
      modeBtns.forEach((b, i) => {
        const on = (i === 1) === (m === 'walk');
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    },
    setPhoto(on) {
      if (on) {
        togglePop(false);
        closeMenu();
      }
      hud.hidden = strip.hidden = on;
      caption.hidden = on || !shown.some((v) => v.id === current);
    },
    closePopover() {
      if (closeMenu()) return true;
      if (pop.hidden) return false;
      togglePop(false);
      return true;
    },
    toggleHidden() {
      const off = parent.classList.toggle('pr-hud-off');
      if (off) {
        togglePop(false);
        closeMenu();
      } else wake();
    },
    toggleFullscreen,
    setSaving(on) {
      saveBtn.disabled = on;
      saveLabel.textContent = on ? 'Saving…' : 'Save image';
    },
    dispose() {
      window.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('fullscreenchange', syncFullscreen);
      parent.removeEventListener('pointermove', wake);
      parent.removeEventListener('pointerdown', wake);
      if (idleTimer) clearTimeout(idleTimer);
      parent.classList.remove('pr-idle', 'pr-hud-off');
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      style.remove();
      hud.remove();
      strip.remove();
      caption.remove();
      menu.remove();
    },
  };
}
