type Attrs = Record<string, string | number | boolean>;

/** Tiny element builder: boolean attrs set as properties (`disabled`, `checked`), the rest as attributes. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'boolean') (e as unknown as Record<string, boolean>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  e.append(...kids);
  return e;
}
