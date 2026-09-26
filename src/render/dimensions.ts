import * as THREE from 'three';
import type { DimLine } from '../edit/dimensions';
import type { V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';
import { PALETTE } from './palette';

/**
 * Draws dimension lines like a shop drawing: extension lines off the measured edge, the dimension
 * line with architectural ticks, and a label with a true stacked fraction (34½″) — a sprite, so it
 * shows in screenshots sent to the AI. Drawn over the model (no depth test).
 */
export interface DimensionView {
  set(lines: DimLine[], fmt: (u: number) => string): void;
}

const H = 44;
const BIG = '600 27px system-ui, sans-serif';
const SMALL = '600 17px system-ui, sans-serif';
/** `34 1/2"` / `23/32"` → whole, numerator, denominator, rest. Metric labels don't match. */
const FRACTION = /^(?:(\d+) )?(\d+)\/(\d+)(.*)$/;

function labelTexture(text: string): { tex: THREE.Texture; aspect: number } {
  const g0 = document.createElement('canvas').getContext('2d')!;
  const width = (font: string, s: string) => ((g0.font = font), g0.measureText(s).width);
  const m = FRACTION.exec(text);
  const rest = (m ? m[4]! : text).replace(/"/g, '″');
  const parts = m ? { whole: m[1] ?? '', num: m[2]!, den: m[3]! } : null;
  const SLASH = 9;
  const inner = parts
    ? (parts.whole ? width(BIG, parts.whole) + 3 : 0) + width(SMALL, parts.num) + SLASH + width(SMALL, parts.den) + width(BIG, rest)
    : width(BIG, rest);
  const w = Math.ceil(inner) + 24;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: H });
  const g = c.getContext('2d')!;
  g.fillStyle = '#141518e6';
  g.beginPath();
  g.roundRect(1, 1, w - 2, H - 2, 9);
  g.fill();
  g.strokeStyle = '#3b4048';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#e6e7e9';
  g.textBaseline = 'middle';
  let x = 12;
  const put = (font: string, s: string, y: number) => {
    g.font = font;
    g.fillText(s, x, y);
    x += g.measureText(s).width;
  };
  if (parts) {
    if (parts.whole) {
      put(BIG, parts.whole, 23);
      x += 3;
    }
    put(SMALL, parts.num, 15);
    g.strokeStyle = '#e6e7e9';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + 1, 34);
    g.lineTo(x + SLASH - 1, 10);
    g.stroke();
    x += SLASH;
    put(SMALL, parts.den, 30);
  }
  put(BIG, rest, 23);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / H };
}

export function createDimensionView(scene: THREE.Scene): DimensionView {
  const group = new THREE.Group();
  group.name = 'dimensions';
  scene.add(group);
  // Scene units are inches; sprites can't sit under a scaled group (their screen size would shrink too).
  const S = 1 / UNITS_PER_INCH;
  const lineMat = new THREE.LineBasicMaterial({ color: PALETTE.dimension, depthTest: false, transparent: true, opacity: 0.8 });
  const labels = new Map<string, { tex: THREE.Texture; aspect: number }>();
  let geometry: THREE.BufferGeometry | null = null;
  let sprites: THREE.SpriteMaterial[] = [];

  return {
    set(lines, fmt) {
      group.clear();
      geometry?.dispose();
      sprites.forEach((m) => m.dispose());
      sprites = [];
      geometry = null;
      if (!lines.length) return;
      const pts: number[] = [];
      const seg = (p: V3, q: V3) => pts.push(...p.map((c) => c * S), ...q.map((c) => c * S));
      const at = (p: V3, d: V3, s: number): V3 => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
      for (const l of lines) {
        const dir = [l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]].map((c) => c / l.value) as V3;
        const gap = Math.min(16, l.offset * 0.15);
        const over = Math.min(24, l.offset * 0.25);
        seg(at(l.a, l.out, gap), at(l.a, l.out, l.offset + over));
        seg(at(l.b, l.out, gap), at(l.b, l.out, l.offset + over));
        const [p, q] = [at(l.a, l.out, l.offset), at(l.b, l.out, l.offset)];
        seg(p, q);
        const tick = Math.min(20, l.offset * 0.2);
        const slash: V3 = [(dir[0] + l.out[0]) * tick, (dir[1] + l.out[1]) * tick, (dir[2] + l.out[2]) * tick];
        for (const e of [p, q]) seg(at(e, slash, -0.5), at(e, slash, 0.5));

        const text = fmt(l.value);
        let lab = labels.get(text);
        if (!lab) labels.set(text, (lab = labelTexture(text)));
        const mat = new THREE.SpriteMaterial({ map: lab.tex, depthTest: false, transparent: true, sizeAttenuation: false });
        sprites.push(mat);
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(((p[0] + q[0]) / 2) * S, ((p[1] + q[1]) / 2) * S, ((p[2] + q[2]) / 2) * S);
        sprite.scale.set(0.025 * lab.aspect, 0.025, 1);
        sprite.renderOrder = 16;
        group.add(sprite);
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const segs = new THREE.LineSegments(geometry, lineMat);
      segs.renderOrder = 15;
      group.add(segs);
      if (labels.size > 64) {
        for (const [k, v] of labels) if (!lines.some((l) => fmt(l.value) === k)) (v.tex.dispose(), labels.delete(k));
      }
    },
  };
}
