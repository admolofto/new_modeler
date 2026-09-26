import * as THREE from 'three';
import type { V3 } from '../geometry/types';
import type { Doc } from '../model/schema';
import { UNITS_PER_INCH } from '../model/units';
import { apply, nodeAffine } from '../model/world';

/**
 * Block names floating over each block's top, so the layout reads at a glance — and in the
 * screenshots sent to the AI. Sprites at a constant screen size, hidden behind other geometry.
 */
export interface BlockLabels {
  update(doc: Doc): void;
}

const H = 40;
const FONT = '600 24px system-ui, sans-serif';

function labelTexture(text: string): { tex: THREE.Texture; aspect: number } {
  const g0 = document.createElement('canvas').getContext('2d')!;
  g0.font = FONT;
  const w = Math.ceil(g0.measureText(text).width) + 26;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: H });
  const g = c.getContext('2d')!;
  g.fillStyle = '#141518d9';
  g.beginPath();
  g.roundRect(1, 1, w - 2, H - 2, 8);
  g.fill();
  g.strokeStyle = '#5d626b';
  g.lineWidth = 2;
  g.setLineDash([6, 4]);
  g.stroke();
  g.fillStyle = '#e6e7e9';
  g.font = FONT;
  g.textBaseline = 'middle';
  g.fillText(text, 13, H / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / H };
}

export function createBlockLabels(scene: THREE.Scene): BlockLabels {
  const group = new THREE.Group();
  group.name = 'block labels';
  scene.add(group);
  const S = 1 / UNITS_PER_INCH;
  const textures = new Map<string, { tex: THREE.Texture; aspect: number }>();
  let mats: THREE.SpriteMaterial[] = [];

  return {
    update(doc) {
      group.clear();
      mats.forEach((m) => m.dispose());
      mats = [];
      const names = new Set<string>();
      for (const part of Object.values(doc.parts)) {
        if (!part.block) continue;
        const p = part.shape.params as { x: number; y: number; z: number };
        const top: V3 = apply(nodeAffine(doc, part.id), [p.x / 2, p.y, p.z / 2]);
        names.add(part.name);
        let lab = textures.get(part.name);
        if (!lab) textures.set(part.name, (lab = labelTexture(part.name || 'Block')));
        const mat = new THREE.SpriteMaterial({ map: lab.tex, transparent: true, sizeAttenuation: false });
        mats.push(mat);
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(top[0] * S, top[1] * S + 0.4, top[2] * S);
        sprite.center.set(0.5, 0);
        sprite.scale.set(0.022 * lab.aspect, 0.022, 1);
        sprite.renderOrder = 5;
        group.add(sprite);
      }
      if (textures.size > 64) {
        for (const [k, v] of textures) if (!names.has(k)) (v.tex.dispose(), textures.delete(k));
      }
    },
  };
}
