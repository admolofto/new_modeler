import * as THREE from 'three';
import type { TaggedMesh } from '../geometry/types';
import type { Doc, Part, Transform } from '../model/schema';
import { UNITS_PER_INCH } from '../model/units';
import { buildPart } from '../plugins/pipeline';
import { PALETTE } from './palette';

/**
 * Mirrors the doc into the scene: one Group per assembly (nested, parent-relative),
 * one Mesh per part. Meshes are rebuilt only when their shape, features or material
 * change; moving a part just updates its transform. Blocks (placeholders) are drawn in
 * clay gray with a lighter front face and an arrow on top pointing to the front.
 *
 * Pick data: `mesh.userData.partId`, `mesh.userData.handles`, and
 * `geometry.userData.{triTags, tags}` (see pick.ts).
 */
export interface SceneSync {
  root: THREE.Group;
  /** `highlight`: part ids drawn with a tint (e.g. what an AI proposal adds or changes). */
  update(doc: Doc, opts?: { highlight?: ReadonlySet<string> }): void;
  /** The mesh currently drawn for a part (after the last update). */
  meshOf(partId: string): THREE.Mesh | undefined;
  meshes(): THREE.Mesh[];
}

const DEG = Math.PI / 180;

function toGeometry(m: TaggedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.userData = { triTags: m.triTags, tags: m.tags };
  g.computeBoundingSphere();
  return g;
}

/** Geometry groups for a block: its front face's triangles draw with material 1, the rest with 0. */
function frontGroups(g: THREE.BufferGeometry): void {
  const { triTags, tags } = g.userData as { triTags: Uint16Array; tags: string[] };
  const front = tags.indexOf('face:front');
  let start = 0;
  for (let i = 1; i <= triTags.length; i++) {
    const cur = triTags[start] === front ? 1 : 0;
    if (i < triTags.length && (triTags[i] === front ? 1 : 0) === cur) continue;
    g.addGroup(start * 3, (i - start) * 3, cur);
    start = i;
  }
}

/** A flat arrow on a block's top, pointing to its front (+Z), in model units. */
function frontArrow(size: { x: number; y: number; z: number }, material: THREE.Material): THREE.Mesh {
  const s = Math.min(size.x, size.z, 6 * UNITS_PER_INCH) * 0.45;
  const shape = new THREE.Shape([new THREE.Vector2(0, s * 0.6), new THREE.Vector2(-s * 0.5, -s * 0.4), new THREE.Vector2(0, -s * 0.15), new THREE.Vector2(s * 0.5, -s * 0.4)]);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  // Shape XY → the top face: +Y of the shape points to the block's front (+Z).
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(size.x / 2, size.y + 0.5, size.z / 2 + Math.min(size.z * 0.18, s * 0.6));
  mesh.raycast = () => {};
  return mesh;
}

function applyTransform(obj: THREE.Object3D, t: Transform): void {
  obj.position.set(...t.position);
  obj.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
}

export function createSceneSync(scene: THREE.Scene): SceneSync {
  const root = new THREE.Group();
  root.name = 'model';
  root.scale.setScalar(1 / UNITS_PER_INCH); // model units → inches
  scene.add(root);

  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x3b2f22, transparent: true, opacity: 0.55 });
  const surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>();
  const surface = (color: string, highlight = false) => {
    const key = `${color}${highlight ? ':hi' : ''}`;
    let m = surfaceMaterials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      if (highlight) {
        m.emissive.set(PALETTE.ai);
        m.emissiveIntensity = 0.5;
      }
      surfaceMaterials.set(key, m);
    }
    return m;
  };

  const cache = new Map<string, { key: string; mesh: THREE.Mesh }>();
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.blockMark, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  /** Blocks: the sides, and the lighter front (geometry group 1). */
  const materials = (doc: Doc, part: Part, highlight: boolean): THREE.Material | THREE.Material[] =>
    part.block ? [surface(PALETTE.blockCss, highlight), surface(PALETTE.blockFrontCss, highlight)] : surface((part.material && doc.materials[part.material]?.color) || '#ff00ff', highlight);

  const partMesh = (doc: Doc, part: Part, highlight: boolean): THREE.Mesh | null => {
    const key = JSON.stringify([part.shape, part.features, !!part.block]);
    const hit = cache.get(part.id);
    if (hit && hit.key === key) {
      hit.mesh.material = materials(doc, part, highlight);
      return hit.mesh;
    }
    let built;
    try {
      built = buildPart(part);
    } catch (err) {
      console.error(`failed to build part ${part.id}`, err);
      return null;
    }
    if (hit) dispose(hit.mesh);
    const geometry = toGeometry(built.mesh);
    if (part.block) frontGroups(geometry);
    const mesh = new THREE.Mesh(geometry, materials(doc, part, highlight));
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), edgeMaterial));
    if (part.block) mesh.add(frontArrow(part.shape.params as { x: number; y: number; z: number }, arrowMaterial));
    mesh.userData = { partId: part.id, handles: built.handles };
    cache.set(part.id, { key, mesh });
    return mesh;
  };

  const dispose = (mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    for (const child of mesh.children) (child as THREE.Mesh).geometry.dispose();
  };

  const live = new Set<string>();
  return {
    root,
    meshOf: (id) => (live.has(id) ? cache.get(id)?.mesh : undefined),
    meshes: () => [...live].map((id) => cache.get(id)!.mesh),
    update(doc, opts) {
      root.clear();
      live.clear();
      const addNode = (id: string, parent: THREE.Object3D) => {
        const part = doc.parts[id];
        if (part) {
          const mesh = partMesh(doc, part, opts?.highlight?.has(id) ?? false);
          if (!mesh) return;
          mesh.name = part.name;
          applyTransform(mesh, part.transform);
          parent.add(mesh);
          live.add(id);
          return;
        }
        const asm = doc.assemblies[id];
        if (!asm) return;
        const group = new THREE.Group();
        group.name = asm.name;
        group.userData = { assemblyId: id };
        applyTransform(group, asm.transform);
        parent.add(group);
        for (const c of asm.children) addNode(c, group);
      };
      for (const id of doc.roots) addNode(id, root);
      for (const [id, entry] of cache) {
        if (!live.has(id)) {
          dispose(entry.mesh);
          cache.delete(id);
        }
      }
    },
  };
}
