/**
 * Design tokens, the app shell and the controls every panel shares. Color only means something:
 * amber = selected, violet = AI, red = notes — the same colors the viewport draws with
 * (render/palette.ts). Panels keep their own layout CSS next to their code and build on these.
 * Lengths shown as text go through `shop()` (ui/units.ts): tabular figures, and fractions in `.frac`
 * spans drawn stacked (34 ½″) — never in inputs.
 */

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23a2a7af' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

const CSS = `
:root {
  color-scheme: dark;
  --chrome: #141518; --canvas: #1d1f23; --raised: #202227; --field: #1a1c20;
  --line: #24272c; --line-2: #2e3238; --line-3: #3b4048;
  --fg: #e6e7e9; --fg-2: #a2a7af; --fg-3: #6b7079;
  --hover: #ffffff0d; --press: #ffffff17;
  --sel: #ff9f2e; --sel-soft: #ff9f2e17;
  --ai: #8b7bff; --ai-strong: #7461f5; --ai-soft: #8b7bff1a;
  --note: #e8543f;
  --bad: #f2706a; --warn: #e5c07b; --focus: #8fb4ff;
  --r: 6px;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --fs-xs: 11px; --fs-sm: 12px; --fs: 13px; --fs-lg: 15px;
}
*, *::before, *::after { box-sizing: border-box; }
* { scrollbar-width: thin; scrollbar-color: #3a3e45 transparent; }
body { font: var(--fs)/1.45 var(--font); color: var(--fg); background: var(--chrome); -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; margin: 0; }
b, strong { font-weight: 600; }
.len { font-variant-numeric: tabular-nums; }
.frac { font-variant-numeric: diagonal-fractions; }
.muted { color: var(--fg-2); }
.hint { color: var(--fg-3); font-size: var(--fs-sm); }
.err-text { color: var(--bad); }
[hidden] { display: none !important; }

/* App shell: top bar over list+inspector | 3D view | AI. */
#app { position: fixed; inset: 0; display: grid; grid-template-rows: 44px minmax(0, 1fr);
  grid-template-columns: var(--left-w, 280px) minmax(0, 1fr) var(--right-w, 340px); grid-template-areas: "top top top" "left stage right"; }
@media (max-width: 1279px) { #app { --left-w: 256px; --right-w: 304px; } }
#app.no-left { --left-w: 0px; }
#app.no-right { --right-w: 0px; }
#app.no-left > #left, #app.no-right > #right { display: none; }
#topbar { grid-area: top; }
#left { grid-area: left; min-height: 0; display: flex; flex-direction: column; background: var(--chrome); border-right: 1px solid var(--line); }
#right { grid-area: right; min-height: 0; display: flex; flex-direction: column; background: var(--chrome); border-left: 1px solid var(--line); }
#stage { grid-area: stage; position: relative; overflow: hidden; background: var(--canvas); }
#viewport { position: absolute; inset: 0; }

/* Buttons. */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; flex: none;
  border: 1px solid transparent; border-radius: var(--r); background: var(--hover); color: var(--fg); font-size: var(--fs-sm); font-weight: 500;
  white-space: nowrap; cursor: pointer; transition: background-color .12s, color .12s, border-color .12s; }
.btn:hover:not(:disabled) { background: var(--press); }
.btn:disabled { opacity: .4; cursor: default; }
.btn svg { width: 16px; height: 16px; flex: none; }
.btn.ghost { background: none; color: var(--fg-2); }
.btn.ghost:hover:not(:disabled), .btn.ghost[aria-pressed=true] { background: var(--hover); color: var(--fg); }
.btn.ghost[aria-pressed=true] { background: var(--press); }
.btn.primary { background: var(--fg); color: var(--chrome); }
.btn.primary:hover:not(:disabled) { background: #fff; }
.btn.ai { background: var(--ai-strong); color: #fff; }
.btn.ai:hover:not(:disabled) { background: var(--ai); }
.btn.danger { background: none; color: var(--bad); }
.btn.danger:hover:not(:disabled) { background: #f2706a1f; }
.btn.icon { width: 28px; padding: 0; }
.btn.sm { height: 24px; padding: 0 8px; }
.btn.icon.sm { width: 24px; padding: 0; }
.btn.sm svg { width: 14px; height: 14px; }

/* Fields. */
input[type=text], input[type=number], select, textarea { height: 28px; min-width: 0; padding: 0 8px; background: var(--field);
  border: 1px solid var(--line-2); border-radius: var(--r); outline: none; transition: border-color .12s, box-shadow .12s; }
textarea { height: auto; padding: 6px 8px; line-height: 1.45; resize: none; }
input[type=text]:hover:not(:disabled), input[type=number]:hover:not(:disabled), select:hover:not(:disabled), textarea:hover:not(:disabled) { border-color: var(--line-3); }
input[type=text]:focus, input[type=number]:focus, select:focus, textarea:focus { border-color: var(--focus); box-shadow: 0 0 0 2px #8fb4ff2e; }
input.bad, input.bad:focus { border-color: var(--bad); box-shadow: 0 0 0 2px #f2706a2e; }
input:disabled, select:disabled, textarea:disabled { opacity: .45; }
::placeholder { color: var(--fg-3); opacity: 1; }
select { appearance: none; padding-right: 24px; background: var(--field) ${CHEVRON} no-repeat right 8px center; cursor: pointer; }
option { background: var(--raised); color: var(--fg); }
input[type=checkbox] { width: 14px; height: 14px; margin: 0; accent-color: var(--fg-2); cursor: pointer; }
input[type=color] { width: 28px; height: 28px; padding: 3px; background: var(--field); border: 1px solid var(--line-2); border-radius: var(--r); cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; }

/* Label + control rows. */
.frow { display: flex; align-items: center; gap: 6px; min-height: 30px; }
.frow > .lbl { flex: none; width: 84px; color: var(--fg-2); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow input[type=text] { width: 72px; }
.frow select { flex: 1; }
.frow .check { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: var(--fs-sm); cursor: pointer; }

/* Segmented control. */
.seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--field); border: 1px solid var(--line); border-radius: 8px; }
.seg button { height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--fg-2); font-size: var(--fs-sm); font-weight: 500;
  cursor: pointer; transition: background-color .12s, color .12s; }
.seg button:hover { color: var(--fg); }
.seg button[aria-pressed=true] { background: #2d3036; color: var(--fg); box-shadow: 0 1px 1px #0005; }

/* Underline tabs. */
.tabs { display: flex; gap: 18px; padding: 0 12px; border-bottom: 1px solid var(--line); flex: none; }
.tabs > button { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0; border: 0; background: none; color: var(--fg-2);
  font-size: var(--fs-sm); font-weight: 500; cursor: pointer; transition: color .12s, box-shadow .12s; }
.tabs > button:hover { color: var(--fg); }
.tabs > button[aria-selected=true] { color: var(--fg); box-shadow: inset 0 -2px var(--fg); }

.badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--press);
  color: var(--fg); font-size: 10.5px; font-weight: 600; line-height: 1; }
.badge.note { background: var(--note); color: #fff; }

/* Panel sections; <details class="sec"> collapses. */
.sec { padding: 10px 12px 12px; border-top: 1px solid var(--line); }
.sec:first-child { border-top: 0; }
.sec-h { display: flex; align-items: center; gap: 6px; min-height: 20px; margin-bottom: 4px; color: var(--fg-2); font-size: var(--fs-sm); font-weight: 600; }
.sec-h .sp { flex: 1; }
details.sec > summary { list-style: none; cursor: pointer; user-select: none; }
details.sec > summary::-webkit-details-marker { display: none; }
details.sec > summary svg.chev { width: 14px; height: 14px; color: var(--fg-3); transition: transform .12s; }
details.sec[open] > summary svg.chev { transform: rotate(90deg); }
details.sec:not([open]) { padding-bottom: 10px; }
details.sec:not([open]) > summary { margin-bottom: 0; }

kbd { display: inline-block; min-width: 20px; padding: 2px 5px; font: 500 10.5px/1.2 var(--font); text-align: center; color: var(--fg-2);
  background: var(--field); border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 4px; }

.pop { position: absolute; z-index: 50; padding: 12px 14px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px;
  box-shadow: 0 16px 40px #000a; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

export function mountTheme(): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}
