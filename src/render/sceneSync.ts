import * as THREE from 'three';
import type { TaggedMesh } from '../geometry/types';
import { editorColors, isGlass, partLook } from '../model/look';
import { motionDelta } from '../model/motion';
import type { Doc, Part, Transform } from '../model/schema';
import { UNITS_PER_INCH } from '../model/units';
import { buildPart, type BuiltPart } from '../plugins/pipeline';
import { unclickableNodes } from '../model/visibility';
import { affineOf, composeAffine, type Affine } from '../model/world';
import { PALETTE } from './palette';

/**
 * Mirrors the doc into the scene: one Group per assembly (nested, parent-relative),
 * one Mesh per part. Meshes are rebuilt only when their shape or features change; moving a
 * part just updates its transform, and a new look just swaps its materials. The editor look
 * is flat (binding note 9, from model/look.ts): a part in its material's color, or its finish's
 * swatch when a finish was set on purpose; decor in one color per surface (glass see-through);
 * blocks (placeholders) in clay gray with a lighter front face and an arrow on top pointing to
 * the front. What motions move is drawn at its open amount (a view: the doc keeps it closed).
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
  /** The object drawn for a part (its mesh) or folder (its group), after the last update. */
  objectOf(id: string): THREE.Object3D | undefined;
  meshes(): THREE.Mesh[];
  /** The drawn meshes viewport clicks can pick (skips unclickable parts and folders, and what's cut away). */
  pickable(): THREE.Mesh[];
  /**
   * Takes these parts and folders out of the view and out of picking (room walls between the camera
   * and the room: render/cutaway.ts). Kept across updates until it's set again.
   */
  setCutaway(ids: ReadonlySet<string>): void;
  /** Frees every mesh it made and takes its root out of the scene (a presentation ending). */
  dispose(): void;
}

const DEG = Math.PI / 180;

/** An emissive tint: what an AI proposal changes, or what an opening door or drawer hits. */
export type Tint = 'ai' | 'clash' | null;

/** A built part's tagged mesh as three.js geometry, with its pick data (`triTags`, `tags`). */
export function toGeometry(m: TaggedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.userData = { triTags: m.triTags, tags: m.tags };
  g.computeBoundingSphere();
  return g;
}

/**
 * Geometry groups for a part drawn with several materials (a block's lighter front, decor's
 * surfaces): each run of triangles whose tag draws with one slot (`tagSlots[tag]`) is a group with
 * that material. Triangles keep their order, so picking by `triTags` stays valid.
 */
export function slotGroups(g: THREE.BufferGeometry, tagSlots: readonly number[]): void {
  const { triTags } = g.userData as { triTags: Uint16Array };
  const slot = (i: number) => tagSlots[triTags[i]!] ?? 0;
  let start = 0;
  for (let i = 1; i <= triTags.length; i++) {
    if (i < triTags.length && slot(i) === slot(start)) continue;
    g.addGroup(start * 3, (i - start) * 3, slot(start));
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

/**
 * How parts are drawn (B1): the editor's flat look, or presentation's materials. `key` adds to the
 * mesh cache key (a mesh is rebuilt when it changes); `build` makes a part's mesh from its built
 * geometry; `paint` gives a kept mesh its materials for the doc now; `dispose` frees a mesh's GPU data.
 */
export interface Look {
  key(doc: Doc, part: Part): string;
  build(doc: Doc, part: Part, built: BuiltPart, tint: Tint): THREE.Mesh;
  paint(mesh: THREE.Mesh, doc: Doc, part: Part, tint: Tint): void;
  dispose(mesh: THREE.Mesh): void;
}

/** The editor's look: flat colors (binding note 9), edge lines, and blocks' front arrows. */
export function editorLook(): Look {
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x3b2f22, transparent: true, opacity: 0.55 });
  const surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>();
  /** One flat material per color, tint and see-through-ness, shared by every part drawn with it. */
  const surface = (color: string, tint: Tint, glass = false) => {
    const key = `${color}:${tint ?? ''}${glass ? ':glass' : ''}`;
    let m = surfaceMaterials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      if (glass) Object.assign(m, { transparent: true, opacity: 0.35, depthWrite: false });
      if (tint) {
        m.emissive.set(PALETTE[tint]);
        m.emissiveIntensity = 0.5;
      }
      surfaceMaterials.set(key, m);
    }
    return m;
  };

  const arrowMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.blockMark, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  /**
   * A part's materials for a mesh with these tags: one for a stock part; one per slot (geometry
   * group) for blocks (the sides, the lighter front) and decor (its surfaces).
   */
  const materials = (doc: Doc, part: Part, tags: readonly string[], tint: Tint): THREE.Material | THREE.Material[] => {
    const look = partLook(doc, part, tags);
    const colors = editorColors(doc, part, look);
    const mats = look.slots.map((s, i) => surface(colors[i]!, tint, isGlass(s.finish)));
    return look.kind === 'stock' ? mats[0]! : mats;
  };

  return {
    key: () => '',
    build(doc, part, built, tint) {
      const geometry = toGeometry(built.mesh);
      const look = partLook(doc, part, built.mesh.tags);
      if (look.kind !== 'stock') slotGroups(geometry, look.tagSlots);
      const mesh = new THREE.Mesh(geometry, materials(doc, part, built.mesh.tags, tint));
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), edgeMaterial));
      if (part.block) mesh.add(frontArrow(part.shape.params as { x: number; y: number; z: number }, arrowMaterial));
      return mesh;
    },
    paint(mesh, doc, part, tint) {
      mesh.material = materials(doc, part, tagsOf(mesh), tint);
    },
    dispose(mesh) {
      mesh.geometry.dispose();
      for (const child of mesh.children) (child as THREE.Mesh).geometry.dispose();
    },
  };
}

const tagsOf = (mesh: THREE.Mesh) => (mesh.geometry.userData as { tags: string[] }).tags;

export function createSceneSync(scene: THREE.Scene, look: Look = editorLook()): SceneSync {
  const root = new THREE.Group();
  root.name = 'model';
  root.scale.setScalar(1 / UNITS_PER_INCH); // model units → inches
  scene.add(root);

  const cache = new Map<string, { key: string; mesh: THREE.Mesh }>();

  /** The doc last drawn, what it tints for an AI proposal, and what hits something as it opens. */
  let drawn: Doc | null = null;
  let aiTint: ReadonlySet<string> | undefined;
  let warn: ReadonlySet<string> = new Set();
  const tintOf = (id: string): Tint => (warn.has(id) ? 'clash' : aiTint?.has(id) ? 'ai' : null);

  const partMesh = (doc: Doc, part: Part, tint: Tint): THREE.Mesh | null => {
    const key = JSON.stringify([part.shape, part.features, !!part.block]) + look.key(doc, part);
    const hit = cache.get(part.id);
    if (hit && hit.key === key) {
      look.paint(hit.mesh, doc, part, tint);
      return hit.mesh;
    }
    let built;
    try {
      built = buildPart(part);
    } catch (err) {
      console.error(`failed to build part ${part.id}`, err);
      return null;
    }
    if (hit) look.dispose(hit.mesh);
    const mesh = look.build(doc, part, built, tint);
    mesh.userData = { partId: part.id, handles: built.handles };
    cache.set(part.id, { key, mesh });
    return mesh;
  };

  const live = new Set<string>();
  let unclickable = new Set<string>();
  /** Every drawn part and folder, by node id (folders' groups are made afresh on each update). */
  const objects = new Map<string, THREE.Object3D>();
  /** Taken out of the view (the cutaway), and whether a mesh is drawn at all (nothing above it is). */
  let cut: ReadonlySet<string> = new Set();
  const applyCut = () => {
    for (const [id, obj] of objects) obj.visible = !cut.has(id);
  };
  const onScreen = (obj: THREE.Object3D) => {
    for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent) if (!o.visible) return false;
    return true;
  };

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
    objectOf: (id) => objects.get(id),
    meshes: () => [...live].map((id) => cache.get(id)!.mesh).filter(onScreen),
    pickable: () => [...live].filter((id) => !unclickable.has(id)).map((id) => cache.get(id)!.mesh).filter(onScreen),
    setCutaway(ids) {
      cut = new Set(ids);
      applyCut();
    },
    pose,
    dispose() {
      for (const entry of cache.values()) look.dispose(entry.mesh);
      cache.clear();
      live.clear();
      objects.clear();
      root.clear();
      root.removeFromParent();
      drawn = null;
    },
    setWarn(ids) {
      if (ids.size === warn.size && [...ids].every((id) => warn.has(id))) return;
      warn = new Set(ids);
      if (!drawn) return;
      for (const id of live) {
        const part = drawn.parts[id];
        const mesh = cache.get(id)?.mesh;
        if (part && mesh) look.paint(mesh, drawn, part, tintOf(id));
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
      // Kept meshes may still be hidden from an earlier cutaway.
      applyCut();
      if (opts?.amount) pose(doc, opts.amount);
      // Hidden parts keep their meshes, so showing them again (or leaving an isolated folder) is quick.
      for (const [id, entry] of cache) {
        if (!doc.parts[id]) {
          look.dispose(entry.mesh);
          cache.delete(id);
        }
      }
    },
  };
}
