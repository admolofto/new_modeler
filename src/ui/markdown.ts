import { el } from './dom';

/**
 * The bit of Markdown the AI writes in chat: headings, paragraphs, lists, tables, code blocks, rules,
 * and inline code / bold / italic. Builds DOM nodes directly (never innerHTML), so model text can't
 * inject markup. Anything it doesn't recognise stays as plain text.
 */

export type Inline = string | { code: string } | { b: Inline[] } | { i: Inline[] };
export type Align = 'left' | 'center' | 'right' | null;
export type Block =
  | { type: 'p'; text: Inline[] }
  | { type: 'h'; level: number; text: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const DIVIDER_CELL = /^\s*:?-+:?\s*$/;

/** Splits a table row on `|`, ignoring escaped pipes and pipes inside backticks. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isDivider = (line: string) => line.includes('-') && splitRow(line).every((c) => DIVIDER_CELL.test(c));
const alignOf = (cell: string): Align => {
  const c = cell.trim();
  return c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null;
};

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) out.push(text); text = ''; };
  let k = 0;
  while (k < s.length) {
    const rest = s.slice(k);
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) { flush(); const body = code[2] ?? ''; out.push({ code: body.trim() || body }); k += code[0].length; continue; }
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) { flush(); out.push({ b: parseInline(bold[2] ?? '') }); k += bold[0].length; continue; }
    // `_` only counts at a word start, so snake_case names stay intact.
    const italic = /^\*(?=\S)([^*]*?\S)\*/.exec(rest) ?? (/\w$/.test(text) ? null : /^_(?=\S)([^_]*?\S)_(?!\w)/.exec(rest));
    if (italic) { flush(); out.push({ i: parseInline(italic[1] ?? '') }); k += italic[0].length; continue; }
    const escaped = /^\\([\\`*_|#[\]()-])/.exec(rest);
    if (escaped) { text += escaped[1]; k += 2; continue; }
    text += rest[0];
    k++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const at = (n: number) => lines[n] ?? '';
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ type: 'p', text: parseInline(para.join('\n')) });
    para = [];
  };
  let k = 0;
  while (k < lines.length) {
    const line = at(k);
    if (!line.trim()) { endPara(); k++; continue; }
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      endPara();
      const body: string[] = [];
      k++;
      while (k < lines.length && !at(k).trim().startsWith(fence)) body.push(at(k++));
      k++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { endPara(); blocks.push({ type: 'h', level: (heading[1] ?? '#').length, text: parseInline(heading[2] ?? '') }); k++; continue; }
    if (line.includes('|') && k + 1 < lines.length && isDivider(at(k + 1))) {
      endPara();
      const head = splitRow(line);
      const align = splitRow(at(k + 1)).map(alignOf);
      k += 2;
      const rows: Inline[][][] = [];
      while (k < lines.length && at(k).trim() && at(k).includes('|')) {
        const cells = splitRow(at(k++));
        rows.push(head.map((_, c) => parseInline(cells[c] ?? '')));
      }
      blocks.push({ type: 'table', align: head.map((_, c) => align[c] ?? null), head: head.map(parseInline), rows });
      continue;
    }
    if (HR.test(line)) { endPara(); blocks.push({ type: 'hr' }); k++; continue; }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      endPara();
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (k < lines.length) {
        const m = pattern.exec(at(k));
        if (m) { items.push((ordered ? m[2] : m[1]) ?? ''); k++; continue; }
        // A wrapped item's next line: indented, not blank, and not another list item.
        const next = at(k);
        if (items.length && /^\s+\S/.test(next) && !BULLET.test(next) && !NUMBERED.test(next)) { items[items.length - 1] += `\n${next.trim()}`; k++; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items: items.map(parseInline) });
      continue;
    }
    para.push(line);
    k++;
  }
  endPara();
  return blocks;
}

function inlineNodes(spans: Inline[]): Node[] {
  return spans.map((s) =>
    typeof s === 'string' ? document.createTextNode(s)
    : 'code' in s ? el('code', {}, s.code)
    : 'b' in s ? el('strong', {}, ...inlineNodes(s.b))
    : el('em', {}, ...inlineNodes(s.i)));
}

function blockNode(b: Block): HTMLElement {
  switch (b.type) {
    case 'p': return el('p', {}, ...inlineNodes(b.text));
    case 'h': return el(`h${Math.min(6, b.level)}` as 'h1', {}, ...inlineNodes(b.text));
    case 'code': return el('pre', {}, el('code', {}, b.text));
    case 'hr': return el('hr');
    case 'list': {
      const items = b.items.map((it) => el('li', {}, ...inlineNodes(it)));
      return b.ordered ? el('ol', b.start === 1 ? {} : { start: b.start }, ...items) : el('ul', {}, ...items);
    }
    case 'table': {
      const cell = (tag: 'th' | 'td', spans: Inline[], c: number) => {
        const align = b.align[c];
        return el(tag, align ? { style: `text-align: ${align}` } : {}, ...inlineNodes(spans));
      };
      return el('div', { class: 'md-table' }, el('table', {},
        el('thead', {}, el('tr', {}, ...b.head.map((h, c) => cell('th', h, c)))),
        el('tbody', {}, ...b.rows.map((r) => el('tr', {}, ...r.map((d, c) => cell('td', d, c))))),
      ));
    }
  }
}

/** The AI's message as formatted nodes. */
export function renderMarkdown(src: string): HTMLElement {
  return el('div', { class: 'md' }, ...parseMarkdown(src).map(blockNode));
}

export const MARKDOWN_STYLE = `
.md { display: grid; gap: 8px; white-space: normal; line-height: 1.5; }
.md > * { margin: 0; }
.md p { white-space: pre-wrap; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin-top: 4px; font-size: var(--fs); font-weight: 600; }
.md h1, .md h2 { font-size: calc(var(--fs) + 2px); }
.md ul, .md ol { padding-left: 20px; }
.md li { margin: 2px 0; white-space: pre-wrap; }
.md code { padding: 1px 4px; border-radius: 4px; background: var(--hover); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; }
.md pre { padding: 8px 10px; border-radius: 6px; background: var(--field); overflow-x: auto; }
.md pre code { padding: 0; background: none; white-space: pre; }
.md hr { width: 100%; border: 0; border-top: 1px solid var(--line-2); }
.md-table { max-width: 100%; overflow-x: auto; border: 1px solid var(--line-2); border-radius: 8px; }
.md table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.md th, .md td { padding: 6px 9px; text-align: left; vertical-align: top; overflow-wrap: normal; }
.md th { border-bottom: 1px solid var(--line-2); color: var(--fg-2); font-weight: 600; white-space: nowrap; }
.md tbody tr + tr td { border-top: 1px solid var(--line); }
`;
