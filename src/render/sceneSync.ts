import * as THREE from 'three';
import type { TaggedMesh } from '../geometry/types';
import { motionDelta } from '../model/motion';
import type { Doc, Part, Transform } from '../model/schema';
import { UNITS_PER_INCH } from '../model/units';
import { buildPart } from '../plugins/pipeline';
import { unclickableNodes } from '../model/visibility';
import { affineOf, composeAffine, type Affine } from '../model/world';
import { PALETTE } from './palette';

/**
 * Mirrors the doc into the scene: one Group per assembly (nested, parent-relative),
 * one Mesh per part. Meshes are rebuilt only when their shape, features or material
 * change; moving a part just updates its transform. Blocks (placeholders) are drawn in
 * clay gray with a lighter front face and an arrow on top pointing to the front.
 * What motions move is drawn at its open amount (a view: the doc keeps it closed).
 *
 * Pick data: `mesh.userData.partId`, `mesh.userData.handles`, and
 * `geometry.userData.{triTags, tags}` (see pick.ts).
 */
export interface SceneSync {
  root: THREE.Group;
  /**
   * `highlight`: part ids drawn with a tint (e.g. what an AI proposal adds or changes).
   * `amount`: how far each motion is open (0 … 1); omitted, everything is drawn closed.
   */
  update(doc: Doc, opts?: { highlight?: ReadonlySet<string>; amount?: (motionId: string) => number }): void;
  /** Redraws what motions move at their open amounts, without rebuilding (every frame something moves). */
  pose(doc: Doc, amount: (motionId: string) => number): void;
  /** Parts tinted warn-yellow: an opening door or drawer and what it hits. */
  setWarn(ids: ReadonlySet<string>): void;
  /** The mesh currently drawn for a part (after the last update). */
  meshOf(partId: string): THREE.Mesh | undefined;
  meshes(): THREE.Mesh[];
  /** The drawn meshes viewport clicks can pick (skips unclickable parts and folders). */
  pickable(): THREE.Mesh[];
}

const DEG = Math.PI / 180;

/** An emissive tint: what an AI proposal changes, or what an opening door or drawer hits. */
type Tint = 'ai' | 'clash' | null;

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

const basis = new THREE.Matrix4();
/** Places an object by an affine (rows of a rotation + a translation, model units). */
function applyAffine(obj: THREE.Object3D, a: Affine): void {
  const [r0, r1, r2] = a.m;
  basis.set(r0[0], r0[1], r0[2], 0, r1[0], r1[1], r1[2], 0, r2[0], r2[1], r2[2], 0, 0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(basis);
  obj.position.set(...a.t);
}

export function createSceneSync(scene: THREE.Scene): SceneSync {
  const root = new THREE.Group();
  root.name = 'model';
  root.scale.setScalar(1 / UNITS_PER_INCH); // model units → inches
  scene.add(root);

  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x3b2f22, transparent: true, opacity: 0.55 });
  const surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>();
  const surface = (color: string, tint: Tint) => {
    const key = `${color}:${tint ?? ''}`;
    let m = surfaceMaterials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      if (tint) {
        m.emissive.set(PALETTE[tint]);
        m.emissiveIntensity = 0.5;
      }
      surfaceMaterials.set(key, m);
    }
    return m;
  };

  const cache = new Map<string, { key: string; mesh: THREE.Mesh }>();
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.blockMark, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  /** Blocks: the sides, and the lighter front (geometry group 1). */
  const materials = (doc: Doc, part: Part, tint: Tint): THREE.Material | THREE.Material[] =>
    part.block ? [surface(PALETTE.blockCss, tint), surface(PALETTE.blockFrontCss, tint)] : surface((part.material && doc.materials[part.material]?.color) || '#ff00ff', tint);

  /** The doc last drawn, what it tints for an AI proposal, and what hits something as it opens. */
  let drawn: Doc | null = null;
  let aiTint: ReadonlySet<string> | undefined;
  let warn: ReadonlySet<string> = new Set();
  const tintOf = (id: string): Tint => (warn.has(id) ? 'clash' : aiTint?.has(id) ? 'ai' : null);

  const partMesh = (doc: Doc, part: Part, tint: Tint): THREE.Mesh | null => {
    const key = JSON.stringify([part.shape, part.features, !!part.block]);
    const hit = cache.get(part.id);
    if (hit && hit.key === key) {
      hit.mesh.material = materials(doc, part, tint);
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
    const mesh = new THREE.Mesh(geometry, materials(doc, part, tint));
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
  let unclickable = new Set<string>();
  /** Every drawn part and folder, by node id (folders' groups are made afresh on each update). */
  const objects = new Map<string, THREE.Object3D>();

  const pose = (doc: Doc, amount: (motionId: string) => number) => {
    for (const m of Object.values(doc.motions)) {
      const t = amount(m.id);
      let delta: Affine | null = null;
      if (t > 0) {
        try {
          delta = motionDelta(doc, m, t);
        } catch (err) {
          console.error(`can't open ${m.id}`, err);
        }
      }
      for (const id of m.nodes) {
        const obj = objects.get(id);
        const node = doc.parts[id] ?? doc.assemblies[id];
        if (!obj || !node) continue;
        if (delta) applyAffine(obj, composeAffine(delta, affineOf(node.transform)));
        else applyTransform(obj, node.transform);
      }
    }
  };

  return {
    root,
    meshOf: (id) => (live.has(id) ? cache.get(id)?.mesh : undefined),
    meshes: () => [...live].map((id) => cache.get(id)!.mesh),
    pickable: () => [...live].filter((id) => !unclickable.has(id)).map((id) => cache.get(id)!.mesh),
    pose,
    setWarn(ids) {
      if (ids.size === warn.size && [...ids].every((id) => warn.has(id))) return;
      warn = new Set(ids);
      if (!drawn) return;
      for (const id of live) {
        const part = drawn.parts[id];
        const mesh = cache.get(id)?.mesh;
        if (part && mesh) mesh.material = materials(drawn, part, tintOf(id));
      }
    },
    update(doc, opts) {
      root.clear();
      live.clear();
      objects.clear();
      drawn = doc;
      aiTint = opts?.highlight;
      unclickable = unclickableNodes(doc);
      const addNode = (id: string, parent: THREE.Object3D) => {
        if ((doc.parts[id] ?? doc.assemblies[id])?.hidden) return;
        const part = doc.parts[id];
        if (part) {
          const mesh = partMesh(doc, part, tintOf(id));
          if (!mesh) return;
          mesh.name = part.name;
          applyTransform(mesh, part.transform);
          parent.add(mesh);
          live.add(id);
          objects.set(id, mesh);
          return;
        }
        const asm = doc.assemblies[id];
        if (!asm) return;
        const group = new THREE.Group();
        group.name = asm.name;
        group.userData = { assemblyId: id };
        applyTransform(group, asm.transform);
        parent.add(group);
        objects.set(id, group);
        for (const c of asm.children) addNode(c, group);
      };
      for (const id of doc.roots) addNode(id, root);
      if (opts?.amount) pose(doc, opts.amount);
      // Hidden parts keep their meshes, so showing them again (or leaving an isolated folder) is quick.
      for (const [id, entry] of cache) {
        if (!doc.parts[id]) {
          dispose(entry.mesh);
          cache.delete(id);
        }
      }
    },
  };
}
