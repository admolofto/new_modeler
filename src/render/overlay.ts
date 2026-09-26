import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';
import { PALETTE } from './palette';
import type { SceneSync } from './sceneSync';

/**
 * Hover / selection highlights and note pins, drawn over the model. Items name a part and
 * what on it to light up: the whole part, the triangles of one face tag, or an edge / vertex
 * given by its part-local handle points. Pins are numbered sprites (so they show up in
 * screenshots sent to the AI) with dashed links to a note's other targets.
 */

export type Highlight = 'hover' | 'selected';

export interface OverlayItem {
  partId: string;
  kind: 'part' | 'face' | 'edge' | 'vertex';
  /** face: the triangle tag. */
  tag?: string | undefined;
  /** edge: [a, b]; vertex: [p]. Part-local model units. */
  points?: V3[] | undefined;
  style: Highlight;
}

export interface Pin {
  noteId: string;
  label: string;
  /** World model units. */
  at: V3;
  /** Other targets of the note (world model units). */
  links: V3[];
  active?: boolean;
  /** A voice note still being spoken or tidied: dashed and see-through, never picked. */
  draft?: boolean;
  /** 0–1 (drafts: how sure the hover match is). */
  opacity?: number;
}

export interface Overlay {
  setItems(items: OverlayItem[]): void;
  setPins(pins: Pin[]): void;
  /** Rebuilds against the meshes sceneSync drew last; call after every scene update. */
  refresh(): void;
  /** Note id of the pin under the ray, if any. */
  pinAt(raycaster: THREE.Raycaster): string | null;
}

const COLORS: Record<Highlight, number> = { hover: PALETTE.hover, selected: PALETTE.selected };
const S = 1 / UNITS_PER_INCH;

function circleTexture(): THREE.Texture {
  const c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

function pinTexture(label: string, active: boolean, draft: boolean): THREE.Texture {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d')!;
  g.fillStyle = active ? PALETTE.selectedCss : PALETTE.noteCss;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  if (draft) g.setLineDash([7, 5]);
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createOverlay(scene: THREE.Scene, sceneSync: SceneSync, renderer: THREE.WebGLRenderer): Overlay {
  const group = new THREE.Group();
  group.name = 'overlay';
  const pinGroup = new THREE.Group();
  pinGroup.name = 'pins';
  scene.add(group, pinGroup);

  const surface = Object.fromEntries(
    (['hover', 'selected'] as const).map((s) => [
      s,
      new THREE.MeshBasicMaterial({
        color: COLORS[s],
        transparent: true,
        opacity: s === 'hover' ? 0.28 : 0.4,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ]),
  ) as Record<Highlight, THREE.MeshBasicMaterial>;
  const lines = Object.fromEntries(
    (['hover', 'selected'] as const).map((s) => [s, new LineMaterial({ color: COLORS[s], linewidth: 4, depthTest: false, transparent: true })]),
  ) as Record<Highlight, LineMaterial>;
  const dot = circleTexture();
  const points = Object.fromEntries(
    (['hover', 'selected'] as const).map((s) => [
      s,
      new THREE.PointsMaterial({ color: COLORS[s], size: 13, sizeAttenuation: false, depthTest: false, transparent: true, map: dot, alphaTest: 0.5 }),
    ]),
  ) as Record<Highlight, THREE.PointsMaterial>;
  const linkMaterial = new THREE.LineDashedMaterial({ color: PALETTE.note, dashSize: 0.6, gapSize: 0.4, depthTest: false, transparent: true });

  // Per-geometry subsets of triangles by tag, rebuilt when sceneSync rebuilds a mesh.
  const subsets = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
  const faceGeometry = (g: THREE.BufferGeometry, tag: string): THREE.BufferGeometry | null => {
    let byTag = subsets.get(g);
    if (!byTag) subsets.set(g, (byTag = new Map()));
    let sub = byTag.get(tag);
    if (!sub) {
      const { triTags, tags } = g.userData as { triTags: Uint16Array; tags: string[] };
      const t = tags.indexOf(tag);
      if (t < 0) return null;
      const src = g.index!.array;
      const idx: number[] = [];
      for (let i = 0; i < triTags.length; i++) if (triTags[i] === t) idx.push(src[i * 3]!, src[i * 3 + 1]!, src[i * 3 + 2]!);
      sub = new THREE.BufferGeometry();
      sub.setAttribute('position', g.getAttribute('position'));
      sub.setIndex(idx);
      byTag.set(tag, sub);
    }
    return sub;
  };

  const pinTextures = new Map<string, THREE.Texture>();
  const pinMaterial = (label: string, active: boolean, draft: boolean, opacity: number) => {
    const key = `${label}:${active}:${draft}`;
    let tex = pinTextures.get(key);
    if (!tex) pinTextures.set(key, (tex = pinTexture(label, active, draft)));
    return new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true, opacity });
  };

  let items: OverlayItem[] = [];
  let pins: Pin[] = [];
  const disposable: { dispose(): void }[] = [];

  const refresh = () => {
    group.clear();
    pinGroup.clear();
    disposable.splice(0).forEach((d) => d.dispose());
    const size = renderer.getSize(new THREE.Vector2());
    for (const m of Object.values(lines)) m.resolution.copy(size);

    // Selected on top of hover.
    for (const it of [...items].sort((a, b) => (a.style === b.style ? 0 : a.style === 'hover' ? -1 : 1))) {
      const mesh = sceneSync.meshOf(it.partId);
      if (!mesh) continue;
      mesh.updateWorldMatrix(true, false);
      const world = (p: V3) => new THREE.Vector3(...p).applyMatrix4(mesh.matrixWorld);
      let obj: THREE.Object3D | null = null;
      if (it.kind === 'part' || it.kind === 'face') {
        const g = it.kind === 'part' ? mesh.geometry : it.tag ? faceGeometry(mesh.geometry, it.tag) : null;
        if (!g) continue;
        obj = new THREE.Mesh(g, surface[it.style]);
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(mesh.matrixWorld);
      } else if (it.kind === 'edge' && it.points?.length === 2) {
        const g = new LineSegmentsGeometry().setPositions(it.points.flatMap((p) => world(p).toArray()));
        disposable.push(g);
        obj = new LineSegments2(g, lines[it.style]);
      } else if (it.kind === 'vertex' && it.points?.length) {
        const g = new THREE.BufferGeometry().setFromPoints(it.points.map(world));
        disposable.push(g);
        obj = new THREE.Points(g, points[it.style]);
      }
      if (!obj) continue;
      obj.renderOrder = it.style === 'selected' ? 11 : 10;
      group.add(obj);
    }

    for (const pin of pins) {
      const at = new THREE.Vector3(...pin.at).multiplyScalar(S);
      const mat = pinMaterial(pin.label, !!pin.active, !!pin.draft, pin.opacity ?? 1);
      disposable.push(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(at);
      sprite.scale.set(0.045, 0.045, 1);
      sprite.center.set(0.5, 0.5);
      sprite.renderOrder = 20;
      sprite.userData.noteId = pin.noteId;
      sprite.userData.draft = !!pin.draft;
      pinGroup.add(sprite);
      for (const link of pin.links) {
        const g = new THREE.BufferGeometry().setFromPoints([at, new THREE.Vector3(...link).multiplyScalar(S)]);
        disposable.push(g);
        const line = new THREE.Line(g, linkMaterial);
        line.computeLineDistances();
        line.renderOrder = 19;
        pinGroup.add(line);
        const end = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...link).multiplyScalar(S)]), points.selected);
        disposable.push(end.geometry);
        end.renderOrder = 19;
        pinGroup.add(end);
      }
    }
  };

  return {
    setItems(next) {
      items = next;
      refresh();
    },
    setPins(next) {
      pins = next;
      refresh();
    },
    refresh,
    pinAt(raycaster) {
      const sprites = pinGroup.children.filter((c): c is THREE.Sprite => (c as THREE.Sprite).isSprite && !c.userData.draft);
      return (raycaster.intersectObjects(sprites, false)[0]?.object.userData.noteId as string | undefined) ?? null;
    },
  };
}
