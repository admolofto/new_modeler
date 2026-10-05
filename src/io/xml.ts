/**
 * Minimal XML reader for interchange files (COLLADA): elements, attributes and text. No DTDs,
 * namespaces are kept as part of the tag name. Pure, so it runs in tests without a DOM.
 */
export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.includes('&')
    ? s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) =>
        e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
      )
    : s;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`);
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parses a document and returns its root element. Throws XmlError on malformed markup. */
export function parseXml(text: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const textParts = new Map<XmlElement, string[]>();
  const pushText = (s: string) => {
    const top = stack[stack.length - 1];
    if (top && s) textParts.get(top)!.push(s);
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('unterminated CDATA section');
      pushText(text.slice(lt + 9, end));
      i = end + 3;
    } else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated declaration');
      i = end + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated closing tag');
      const tag = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new XmlError(`unexpected </${tag}>`);
      open.text = textParts.get(open)!.join('');
      textParts.delete(open);
      i = end + 1;
    } else {
      // Find the tag's end, skipping `>` inside quoted attribute values.
      let j = lt + 1;
      let quote = '';
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= text.length) throw new XmlError('unterminated tag');
      const selfClosing = text[j - 1] === '/';
      const body = text.slice(lt + 1, selfClosing ? j - 1 : j);
      const tag = /^[^\s/>]+/.exec(body)?.[0];
      if (!tag) throw new XmlError('empty tag name');
      const attrs: Record<string, string> = {};
      for (const m of body.slice(tag.length).matchAll(ATTR)) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
      const elem: XmlElement = { tag, attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(elem);
      else if (root) throw new XmlError('more than one root element');
      else root = elem;
      if (!selfClosing) {
        stack.push(elem);
        textParts.set(elem, []);
      }
      i = j + 1;
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1]!.tag}> is never closed`);
  if (!root) throw new XmlError('no root element');
  return root;
}

/** Tag without a namespace prefix. */
const local = (tag: string) => tag.slice(tag.indexOf(':') + 1);

export function child(e: XmlElement | undefined, tag: string): XmlElement | undefined {
  return e?.children.find((c) => local(c.tag) === tag);
}

export function childrenNamed(e: XmlElement | undefined, tag: string): XmlElement[] {
  return e ? e.children.filter((c) => local(c.tag) === tag) : [];
}

/** Every descendant (depth first) with this tag. */
export function findAll(e: XmlElement, tag: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of e.children) {
    if (local(c.tag) === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

export function localTag(e: XmlElement): string {
  return local(e.tag);
}
