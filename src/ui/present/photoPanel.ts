import { formatSeconds, PHOTO_LEVELS, type PhotoLevel, type PhotoProgress } from '../../render/present/photoPlan';
import { el } from '../dom';

/**
 * The photo panel (B8): while a path-traced photo renders, it takes the HUD's place at the bottom of
 * the view — the quality (Draft 64 / Good 256 / Best 1024 samples; changing it keeps going or stops
 * sooner), the progress (samples against the target, the time taken and left, "Preparing renderer…"
 * while the shader compiles), Save PNG (once there's a sample) and Cancel (Close when it's done).
 */

export type PhotoPanelState = 'preparing' | 'rendering' | 'done';

export interface PhotoPanel {
  readonly element: HTMLElement;
  show(level: PhotoLevel): void;
  hide(): void;
  update(state: PhotoPanelState, p: PhotoProgress): void;
  setSaving(on: boolean): void;
  dispose(): void;
}

export interface PhotoPanelOptions {
  setLevel(level: PhotoLevel): void;
  save(): void;
  cancel(): void;
}

const CSS = `
/* It's also a .pr-hud (the pill's look, its buttons, and shown while presenting). */
.pr-hud.pr-photo { gap: 8px; overflow: hidden; }
.pr-hud.pr-photo[hidden] { display: none; }
.pr-photo .btn:disabled { opacity: .45; }
.pr-photo .status { min-width: 220px; padding: 0 6px; font-size: var(--fs-sm); color: #d6d6d2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pr-photo .bar { position: absolute; left: 0; bottom: 0; height: 2px; background: #f2f2f0; opacity: .7; transition: width .2s; }
`;

export function mountPhotoPanel(parent: HTMLElement, o: PhotoPanelOptions): PhotoPanel {
  const style = el('style', {}, CSS);
  const levelBtns = PHOTO_LEVELS.map((l) => {
    const b = el('button', { class: 'btn', title: `${l.samples} samples`, 'aria-pressed': 'false' }, l.label);
    b.addEventListener('click', () => {
      o.setLevel(l.id);
      setLevel(l.id);
      b.blur();
    });
    return b;
  });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Photo quality' }, ...levelBtns);
  const status = el('span', { class: 'status', 'aria-live': 'polite' }, 'Preparing renderer…');
  const saveLabel = el('span', {}, 'Save PNG');
  const save = el('button', { class: 'btn', title: 'Save the photo as it is now as a PNG' }, saveLabel);
  const cancel = el('button', { class: 'btn', title: 'Back to the live view (Esc, or click the view)' }, 'Cancel');
  const bar = el('div', { class: 'bar' });
  save.addEventListener('click', () => {
    o.save();
    save.blur();
  });
  cancel.addEventListener('click', () => o.cancel());
  const panel = el('div', { class: 'pr-hud pr-photo', role: 'toolbar', 'aria-label': 'Photo' }, seg, status, save, cancel, bar);
  panel.hidden = true;
  parent.append(style, panel);

  let saving = false;
  let samples = 0;
  function setLevel(level: PhotoLevel) {
    PHOTO_LEVELS.forEach((l, i) => {
      levelBtns[i]!.classList.toggle('on', l.id === level);
      levelBtns[i]!.setAttribute('aria-pressed', String(l.id === level));
    });
  }
  const syncSave = () => (save.disabled = saving || samples < 1);

  return {
    element: panel,
    show(level) {
      setLevel(level);
      samples = 0;
      status.textContent = 'Preparing renderer…';
      cancel.textContent = 'Cancel';
      bar.style.width = '0';
      syncSave();
      panel.hidden = false;
    },
    hide() {
      panel.hidden = true;
    },
    update(state, p) {
      samples = p.samples;
      if (state === 'preparing' && p.samples < 1) status.textContent = 'Preparing renderer…';
      else if (state === 'done') status.textContent = `Done · ${p.samples} samples in ${formatSeconds(p.elapsed)}`;
      else status.textContent = `${p.samples} / ${p.target} samples · ${formatSeconds(p.elapsed)}${p.eta !== null ? ` · ${formatSeconds(p.eta)} left` : ''}`;
      cancel.textContent = state === 'done' ? 'Close' : 'Cancel';
      bar.style.width = `${Math.min(100, (100 * p.samples) / Math.max(1, p.target))}%`;
      syncSave();
    },
    setSaving(on) {
      saving = on;
      saveLabel.textContent = on ? 'Saving…' : 'Save PNG';
      syncSave();
    },
    dispose() {
      style.remove();
      panel.remove();
    },
  };
}
