import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';

/**
 * What the move, rotate, push / pull and tape tools draw while you work: inference marks (a dot
 * where a click would land, in the inference's color), rubber bands in an axis' color, dashed guides
 * and the protractor. World model units in, drawn over everything.
 */
export interface DraftMark {
  at: V3;
  color: number;
}

export interface DraftLine {
  a: V3;
  b: V3;
  color: number;
  dashed?: boolean;
}

export interface ToolDraft {
  set(d: { marks?: DraftMark[]; lines?: DraftLine[] } | null): void;
}

const S = 1 / UNITS_PER_INCH;

function dotTexture(color: number): THREE.Texture {
  const c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(16, 16, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.beginPath();
  g.arc(16, 16, 8, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createToolDraft(scene: THREE.Scene, renderer: THREE.WebGLRenderer): ToolDraft {
  const group = new THREE.Group();
  group.name = 'tool draft';
  scene.add(group);

  const marks = new Map<number, THREE.SpriteMaterial>();
  const solid = new Map<number, LineMaterial>();
  const dashed = new Map<number, THREE.LineDashedMaterial>();
  const cached = <M>(map: Map<number, M>, color: number, make: () => M): M => {
    let m = map.get(color);
    if (!m) map.set(color, (m = make()));
    return m;
  };
  const disposable: { dispose(): void }[] = [];

  return {
    set(d) {
      group.clear();
      disposable.splice(0).forEach((x) => x.dispose());
      if (!d) return;
      const v = (p: V3) => new THREE.Vector3(p[0] * S, p[1] * S, p[2] * S);
      const size = renderer.getSize(new THREE.Vector2());
      const byColor = new Map<number, number[]>();
      for (const l of d.lines ?? []) {
        if (l.dashed) {
          const g = new THREE.BufferGeometry().setFromPoints([v(l.a), v(l.b)]);
          disposable.push(g);
          const mat = cached(dashed, l.color, () => new THREE.LineDashedMaterial({ color: l.color, dashSize: 0.5, gapSize: 0.35, depthTest: false, transparent: true, opacity: 0.9 }));
          const line = new THREE.Line(g, mat);
          line.computeLineDistances();
          line.renderOrder = 18;
          group.add(line);
        } else {
          const pts = byColor.get(l.color) ?? [];
          pts.push(...v(l.a).toArray(), ...v(l.b).toArray());
          byColor.set(l.color, pts);
        }
      }
      for (const [color, pts] of byColor) {
        const g = new LineSegmentsGeometry().setPositions(pts);
        disposable.push(g);
        const mat = cached(solid, color, () => new LineMaterial({ color, linewidth: 2.5, depthTest: false, transparent: true }));
        mat.resolution.copy(size);
        const lines = new LineSegments2(g, mat);
        lines.renderOrder = 18;
        group.add(lines);
      }
      for (const m of d.marks ?? []) {
        const mat = cached(marks, m.color, () => new THREE.SpriteMaterial({ map: dotTexture(m.color), depthTest: false, transparent: true, sizeAttenuation: false }));
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(v(m.at));
        sprite.scale.set(0.022, 0.022, 1);
        sprite.renderOrder = 21;
        group.add(sprite);
      }
    },
  };
}
