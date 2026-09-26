import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';
import { PALETTE } from './palette';

/**
 * What the block tool draws while you sketch: the snap cursor (a dot where a click would land),
 * dashed guides to what it lined up with, and the rectangle being drawn on the floor or a face. The
 * box itself previews as a real block in the model. World model units in, drawn over everything.
 */
export interface BlockDraft {
  set(d: { cursor?: V3 | undefined; guides?: [V3, V3][] | undefined; rect?: V3[] | undefined } | null): void;
}

const S = 1 / UNITS_PER_INCH;

export function createBlockDraft(scene: THREE.Scene, renderer: THREE.WebGLRenderer): BlockDraft {
  const group = new THREE.Group();
  group.name = 'block draft';
  scene.add(group);

  const dot = (() => {
    const c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(16, 16, 12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = PALETTE.hoverCss;
    g.beginPath();
    g.arc(16, 16, 8, 0, Math.PI * 2);
    g.fill();
    return new THREE.CanvasTexture(c);
  })();
  const cursorMat = new THREE.SpriteMaterial({ map: dot, depthTest: false, transparent: true, sizeAttenuation: false });
  const guideMat = new THREE.LineDashedMaterial({ color: PALETTE.hover, dashSize: 0.5, gapSize: 0.35, depthTest: false, transparent: true, opacity: 0.9 });
  const fillMat = new THREE.MeshBasicMaterial({ color: PALETTE.hover, transparent: true, opacity: 0.22, depthTest: false, side: THREE.DoubleSide });
  const edgeMat = new LineMaterial({ color: PALETTE.hover, linewidth: 2.5, depthTest: false, transparent: true });
  const disposable: { dispose(): void }[] = [];

  return {
    set(d) {
      group.clear();
      disposable.splice(0).forEach((x) => x.dispose());
      if (!d) return;
      const v = (p: V3) => new THREE.Vector3(p[0] * S, p[1] * S, p[2] * S);
      if (d.rect?.length === 4) {
        const [a, b, c, e] = d.rect.map(v) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        const fill = new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, e]);
        disposable.push(fill);
        const mesh = new THREE.Mesh(fill, fillMat);
        mesh.renderOrder = 17;
        group.add(mesh);
        const outline = new LineSegmentsGeometry().setPositions([a, b, b, c, c, e, e, a].flatMap((p) => p.toArray()));
        disposable.push(outline);
        edgeMat.resolution.copy(renderer.getSize(new THREE.Vector2()));
        const lines = new LineSegments2(outline, edgeMat);
        lines.renderOrder = 18;
        group.add(lines);
      }
      for (const [p, q] of d.guides ?? []) {
        const g = new THREE.BufferGeometry().setFromPoints([v(p), v(q)]);
        disposable.push(g);
        const line = new THREE.Line(g, guideMat);
        line.computeLineDistances();
        line.renderOrder = 18;
        group.add(line);
      }
      if (d.cursor) {
        const sprite = new THREE.Sprite(cursorMat);
        sprite.position.copy(v(d.cursor));
        sprite.scale.set(0.022, 0.022, 1);
        sprite.renderOrder = 21;
        group.add(sprite);
      }
    },
  };
}
