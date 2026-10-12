/**
 * Where reference pictures go (pure): rows of equal height, each row stretched to one width, like a
 * photo wall — no arranging by hand. The wall's width is picked so the whole grid comes out about the
 * shape of the screen, so "fit" shows every picture as large as it can be. Plus the pan / zoom maths.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Wall {
  /** One rect per picture, in the order given. */
  rects: Rect[];
  w: number;
  h: number;
}

/** The view: screen = world × scale + (x, y). */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export const ROW_HEIGHT = 320;
export const GAP = 16;
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;

const aspect = (s: Size) => (s.w > 0 && s.h > 0 ? s.w / s.h : 1);

/**
 * Lays pictures out in justified rows about `rowHeight` tall. Each row but the last is scaled to
 * fill `width` exactly; the last keeps `rowHeight` unless it would overflow. `width` defaults to one
 * that makes the wall about `screenAspect` (width / height).
 */
export function layoutWall(sizes: Size[], o: { screenAspect?: number; width?: number; rowHeight?: number; gap?: number } = {}): Wall {
  const rowHeight = o.rowHeight ?? ROW_HEIGHT;
  const gap = o.gap ?? GAP;
  if (!sizes.length) return { rects: [], w: 0, h: 0 };
  const aspects = sizes.map(aspect);
  const ar = (i: number) => aspects[i] ?? 1;
  const widest = Math.max(...aspects) * rowHeight;
  const area = aspects.reduce((a, r) => a + r * rowHeight * (rowHeight + gap), 0);
  const width = Math.max(widest, o.width ?? Math.sqrt(area * (o.screenAspect ?? 16 / 10)));

  const rects: Rect[] = [];
  let y = 0;
  let row: number[] = [];
  const place = (items: number[], last: boolean) => {
    const natural = items.reduce((a, i) => a + ar(i) * rowHeight, 0);
    const room = width - gap * (items.length - 1);
    const h = last && natural <= room ? rowHeight : (rowHeight * room) / natural;
    let x = 0;
    for (const i of items) {
      const w = ar(i) * h;
      rects[i] = { x, y, w, h };
      x += w + gap;
    }
    y += h + gap;
  };
  for (let i = 0; i < aspects.length; i++) {
    row.push(i);
    const natural = row.reduce((a, j) => a + ar(j) * rowHeight, 0) + gap * (row.length - 1);
    if (natural >= width) {
      // Close the row at whichever break lands nearer the full width: with this picture, or without it.
      const without = natural - ar(i) * rowHeight - gap;
      if (row.length > 1 && width - without < natural - width) {
        row.pop();
        place(row, false);
        row = [i];
      } else {
        place(row, false);
        row = [];
      }
    }
  }
  if (row.length) place(row, true);
  return { rects, w: width, h: y - gap };
}

/** The view that shows the whole wall centred in a `screen`, with `margin` pixels around it. */
export function fitView(wall: Pick<Wall, 'w' | 'h'>, screen: Size, margin = 32, maxScale = 2): View {
  if (!wall.w || !wall.h) return { x: screen.w / 2, y: screen.h / 2, scale: 1 };
  const scale = clampScale(Math.min((screen.w - 2 * margin) / wall.w, (screen.h - 2 * margin) / wall.h, maxScale));
  return { x: (screen.w - wall.w * scale) / 2, y: (screen.h - wall.h * scale) / 2, scale };
}

/** The view that frames one rect (a picture) in the screen. */
export function focusView(r: Rect, screen: Size, margin = 32): View {
  const v = fitView(r, screen, margin, MAX_SCALE);
  return { scale: v.scale, x: v.x - r.x * v.scale, y: v.y - r.y * v.scale };
}

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Zooms by `factor` keeping the world point under screen point (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** Which rect is under a screen point, or -1. */
export function hit(rects: Rect[], v: View, px: number, py: number): number {
  const wx = (px - v.x) / v.scale;
  const wy = (py - v.y) / v.scale;
  return rects.findIndex((r) => wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h);
}
