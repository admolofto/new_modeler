import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { easeInOut, motionDelta, motionName, motionSeconds } from '../model/motion';
import type { Doc, Transform } from '../model/schema';
import { hiddenNodes } from '../model/visibility';
import { affineOf, composeAffine, type Affine } from '../model/world';
import { buildPart } from '../plugins/pipeline';
import { PALETTE } from './palette';

/**
 * The model for other 3D apps (Blender, Windows 3D Viewer, web viewers): glTF binary (.glb), Y up,
 * meters, as the model has it (closed). One node per part and folder, named as in the tree, materials
 * by color; then an animation clip per door, drawer and lid ("Open — Left door") and one that opens
 * everything a beat apart, like the Open button ("Open all"). What's hidden stays out.
 */

/** Meters per model unit (1/64"). */
const METERS = 0.0254 / 64;
/** Keyframes per clip; glTF interpolates linearly between them, so the easing is baked in. */
const SAMPLES = 24;
/** "Open all": starts a beat apart, the whole spread at most this long (as in the viewport). */
const STAGGER = 0.06;
const SPREAD = 0.6;

const DEG = Math.PI / 180;
const basis = new THREE.Matrix4();
const quaternionOf = (a: Affine) => {
  const [r0, r1, r2] = a.m;
  basis.set(r0[0], r0[1], r0[2], 0, r1[0], r1[1], r1[2], 0, r2[0], r2[1], r2[2], 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
};
const place = (obj: THREE.Object3D, t: Transform) => {
  obj.position.set(...t.position);
  obj.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
};

export function exportScene(doc: Doc): { scene: THREE.Scene; clips: THREE.AnimationClip[] } {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = 'Model';
  root.scale.setScalar(METERS);
  scene.add(root);

  const hidden = hiddenNodes(doc);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (name: string, color: string) => {
    const key = `${name}|${color}`;
    let m = materials.get(key);
    if (!m) materials.set(key, (m = new THREE.MeshStandardMaterial({ name, color, roughness: 0.85 })));
    return m;
  };
  const objects = new Map<string, THREE.Object3D>();
  const add = (id: string, parent: THREE.Object3D) => {
    if (hidden.has(id)) return;
    const part = doc.parts[id];
    if (part) {
      let built;
      try {
        built = buildPart(part);
      } catch {
        return; // doesn't build: it's missing from the view too
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(built.mesh.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(built.mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(built.mesh.indices, 1));
      const mat = part.block ? material('Block', PALETTE.blockCss) : material(doc.materials[part.material ?? '']?.name ?? 'Part', doc.materials[part.material ?? '']?.color ?? '#cccccc');
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = part.name;
      place(mesh, part.transform);
      parent.add(mesh);
      objects.set(id, mesh);
      return;
    }
    const asm = doc.assemblies[id];
    if (!asm) return;
    const group = new THREE.Group();
    group.name = asm.name;
    place(group, asm.transform);
    parent.add(group);
    objects.set(id, group);
    for (const c of asm.children) add(c, group);
  };
  for (const id of doc.roots) add(id, root);

  // One clip per motion: each moved node's position and turn, sampled along the eased path.
  const clips: THREE.AnimationClip[] = [];
  const all: THREE.KeyframeTrack[] = [];
  const motions = Object.values(doc.motions).filter((m) => m.nodes.some((id) => objects.has(id)));
  const step = motions.length ? Math.min(STAGGER, SPREAD / motions.length) : 0;
  motions.forEach((m, i) => {
    const seconds = motionSeconds(m);
    const tracks: THREE.KeyframeTrack[] = [];
    const delayed: THREE.KeyframeTrack[] = [];
    let ok = true;
    for (const id of m.nodes) {
      const obj = objects.get(id);
      const node = doc.parts[id] ?? doc.assemblies[id];
      if (!obj || !node) continue;
      const times: number[] = [];
      const positions: number[] = [];
      const turns: number[] = [];
      for (let k = 0; k <= SAMPLES; k++) {
        let a: Affine;
        try {
          a = composeAffine(motionDelta(doc, m, easeInOut(k / SAMPLES)), affineOf(node.transform));
        } catch {
          ok = false;
          break;
        }
        times.push((k / SAMPLES) * seconds);
        positions.push(...a.t);
        turns.push(...quaternionOf(a).toArray());
      }
      if (!ok) break;
      tracks.push(new THREE.VectorKeyframeTrack(`${obj.uuid}.position`, times, positions), new THREE.QuaternionKeyframeTrack(`${obj.uuid}.quaternion`, times, turns));
      // In "Open all" it waits, closed, until its turn.
      const delay = i * step;
      const wait = delay > 0 ? [0] : [];
      const later = times.map((t) => t + delay);
      delayed.push(
        new THREE.VectorKeyframeTrack(`${obj.uuid}.position`, [...wait, ...later], [...(delay > 0 ? positions.slice(0, 3) : []), ...positions]),
        new THREE.QuaternionKeyframeTrack(`${obj.uuid}.quaternion`, [...wait, ...later], [...(delay > 0 ? turns.slice(0, 4) : []), ...turns]),
      );
    }
    if (!ok || !tracks.length) return;
    clips.push(new THREE.AnimationClip(`Open — ${motionName(doc, m)}`, -1, tracks));
    all.push(...delayed);
  });
  if (clips.length > 1) clips.push(new THREE.AnimationClip('Open all', -1, all));
  return { scene, clips };
}

/** The model as a .glb file's bytes. */
export async function exportGlb(doc: Doc): Promise<ArrayBuffer> {
  const { scene, clips } = exportScene(doc);
  return (await new GLTFExporter().parseAsync(scene, { binary: true, animations: clips })) as ArrayBuffer;
}
