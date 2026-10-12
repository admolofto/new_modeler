import * as THREE from 'three';
import type { PhotoFloor, Softbox } from './photoPlan';
import { floorAlpha } from './photoPlan';

/**
 * The scene the path tracer renders (B8): a stand-in built from the presentation scene as it is drawn
 * now — the lighting preset's lights, what the view hides, the cutaway — without changing it. Building
 * a separate scene makes "put everything back" structural: the live scene's materials, visibility,
 * environment and background are never touched, so a cancelled or failed photo leaves nothing behind.
 *
 * It's also needed: three-gpu-pathtracer 0.0.26 merges every mesh whole and gives each mesh one
 * material (a multi-material mesh's groups would get the wrong materials, and a part's see-through
 * child shares its parent's triangles), so each geometry group becomes a mesh of its own (sharing the
 * buffers; the index is a slice).
 *
 * - Left out: hidden objects, cut-away walls (`visible = false` in effect, as B8 asks; the path tracer
 *   has no "invisible but casting" material), and what the path tracer can't draw — the Sky.js shader,
 *   the unlit outdoor ground, the shadow catcher and the studio floor's shader fade (`skip`). The
 *   environment and background take their place, and `floor` stands in for the floor.
 * - Glass gets a transmissive stand-in (`transmission 1`, opaque) that casts no shadow
 *   (`castShadow = false` on the material, which the path tracer reads), so the sun comes through.
 * - Surfaces drawn by meshes that cast no shadow in the raster (glowing bulbs and lenses) keep not
 *   casting: a bulb would otherwise block the light inside it.
 * - Lights are copied as they're set now, in world space (zero-intensity ones are left out; the
 *   hemisphere fill isn't supported — the environment does its work).
 */

export interface PhotoSceneInput {
  /** The presentation scene (read, never changed). */
  live: THREE.Scene;
  /** Objects never copied: the sky, the outdoor ground, the shadow catcher, the studio floor. */
  skip: ReadonlySet<THREE.Object3D>;
  /** Whether a mesh is cut away now (drawn shadow-only in the raster): left out. */
  isCut(o: THREE.Object3D): boolean;
  /** The environment (lights the scene) and the background (what the camera sees past everything). */
  environment: THREE.Texture;
  background: THREE.Texture | THREE.Color;
  /** A floor fading into the background, or none (a room has its own). */
  floor: PhotoFloor | null;
  /** Extra area lights (the studio's softboxes). */
  softboxes: readonly Softbox[];
}

export interface PhotoScene {
  readonly scene: THREE.Scene;
  /** What went in, for the console and tests. */
  readonly stats: { meshes: number; lights: number; glass: number; skipped: number };
  /** Frees what it made (shared buffers and the live scene's materials are left alone). */
  dispose(): void;
}

/** A material the path tracer reads `castShadow` from (three's materials don't have one). */
type Traced = THREE.Material & { castShadow?: boolean };

/** Glass in the raster: see-through by opacity (the present look's glass is transparent, opacity < 1). */
export const isGlass = (m: THREE.Material): boolean => m.transparent && m.opacity < 1 && !(m as THREE.ShadowMaterial).isShadowMaterial;

/** A transmissive stand-in for raster glass: its tint and roughness (frosted), thin, clear through. */
function glassFor(m: THREE.Material): Traced {
  const src = m as THREE.MeshStandardMaterial;
  const g: Traced = new THREE.MeshPhysicalMaterial({
    color: src.color?.clone() ?? new THREE.Color(1, 1, 1),
    roughness: src.roughness ?? 0,
    metalness: 0,
    transmission: 1,
    ior: 1.5,
    transparent: false,
    opacity: 1,
  });
  g.name = `${m.name}:photo-glass`;
  g.castShadow = false;
  return g;
}

/** A material that doesn't cast (a glowing bulb): a clone, so the live one is left as it is. */
function quietFor(m: THREE.Material): Traced {
  const q: Traced = m.clone();
  q.name = `${m.name}:photo-quiet`;
  q.castShadow = false;
  return q;
}

/** A light as it stands now, in world space, detached from the live scene. */
function copyLight(l: THREE.Light, add: (...o: THREE.Object3D[]) => void): boolean {
  if (!(l.intensity > 0)) return false;
  const at = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
  const aimed = (out: THREE.DirectionalLight | THREE.SpotLight, src: THREE.DirectionalLight | THREE.SpotLight) => {
    out.position.copy(at);
    out.target.position.setFromMatrixPosition(src.target.matrixWorld);
    add(out, out.target);
  };
  if ((l as THREE.DirectionalLight).isDirectionalLight) {
    const src = l as THREE.DirectionalLight;
    aimed(new THREE.DirectionalLight(src.color, src.intensity), src);
  } else if ((l as THREE.SpotLight).isSpotLight) {
    const src = l as THREE.SpotLight;
    aimed(new THREE.SpotLight(src.color, src.intensity, src.distance, src.angle, src.penumbra, src.decay), src);
  } else if ((l as THREE.PointLight).isPointLight) {
    const src = l as THREE.PointLight;
    const p = new THREE.PointLight(src.color, src.intensity, src.distance, src.decay);
    p.position.copy(at);
    add(p);
  } else if ((l as THREE.RectAreaLight).isRectAreaLight) {
    const src = l as THREE.RectAreaLight;
    const r = new THREE.RectAreaLight(src.color, src.intensity, src.width, src.height);
    const scale = new THREE.Vector3();
    src.matrixWorld.decompose(r.position, r.quaternion, scale);
    r.width *= scale.x;
    r.height *= scale.y;
    add(r);
  } else return false;
  return true;
}

/** The floor's disc: rings, so its alpha (vertex colors) fades smoothly. */
function floorMesh(f: PhotoFloor): THREE.Mesh {
  const geometry = new THREE.RingGeometry(0, f.radius, 96, 32);
  const pos = geometry.attributes.position!;
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) colors.set([1, 1, 1, floorAlpha(f, Math.hypot(pos.getX(i), pos.getY(i)))], i * 4);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true, transparent: true });
  material.color.setRGB(...f.color, THREE.LinearSRGBColorSpace);
  material.name = 'photo floor';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'photo floor';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(...f.center);
  return mesh;
}

export function buildPhotoScene(input: PhotoSceneInput): PhotoScene {
  const { live, skip, isCut } = input;
  live.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  scene.environment = input.environment;
  scene.background = input.background;
  const made = { geometries: [] as THREE.BufferGeometry[], materials: [] as THREE.Material[], lights: [] as THREE.Light[] };
  const glassOf = new Map<THREE.Material, Traced>();
  const quietOf = new Map<THREE.Material, Traced>();
  const stats = { meshes: 0, lights: 0, glass: 0, skipped: 0 };

  /** What the path tracer draws for a material on this mesh. */
  const traced = (m: THREE.Material, casts: boolean): THREE.Material => {
    if (isGlass(m)) {
      let g = glassOf.get(m);
      if (!g) {
        g = glassFor(m);
        glassOf.set(m, g);
        made.materials.push(g);
        stats.glass++;
      }
      return g;
    }
    if (casts) return m;
    let q = quietOf.get(m);
    if (!q) {
      q = quietFor(m);
      quietOf.set(m, q);
      made.materials.push(q);
    }
    return q;
  };

  /** One stand-in mesh: the geometry's buffers, an index slice, one material, the world matrix. */
  const addPiece = (src: THREE.Mesh, material: THREE.Material, start: number, count: number) => {
    const g = src.geometry;
    const piece = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) piece.setAttribute(name, attr);
    const index = g.getIndex();
    if (index) {
      const end = Math.min(index.count, start + count);
      if (end <= start) return;
      piece.setIndex(new THREE.BufferAttribute(index.array.subarray(start, end), 1));
    } else {
      // Unindexed: the range's vertices, as an index.
      const n = g.attributes.position!.count;
      const end = Math.min(n, start + count);
      if (end <= start) return;
      piece.setIndex(Array.from({ length: end - start }, (_, i) => start + i));
    }
    made.geometries.push(piece);
    const mesh = new THREE.Mesh(piece, material);
    mesh.name = src.name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(src.matrixWorld);
    mesh.matrixWorld.copy(src.matrixWorld);
    scene.add(mesh);
    stats.meshes++;
  };

  live.traverseVisible((o) => {
    if ((o as THREE.Light).isLight) {
      if (copyLight(o as THREE.Light, (...objs) => {
        scene.add(...objs);
        for (const x of objs) if ((x as THREE.Light).isLight) made.lights.push(x as THREE.Light);
      }))
        stats.lights++;
      return;
    }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (skip.has(mesh) || isCut(mesh) || !mesh.geometry?.attributes.position) {
      stats.skipped++;
      return;
    }
    const casts = mesh.castShadow;
    const total = mesh.geometry.getIndex()?.count ?? mesh.geometry.attributes.position.count;
    const mats = mesh.material;
    if (Array.isArray(mats)) {
      // Each group with its material; triangles in no group aren't drawn (a see-through child's parent).
      for (const grp of mesh.geometry.groups) {
        const m = mats[grp.materialIndex ?? 0];
        if (m && m.visible) addPiece(mesh, traced(m, casts), grp.start, Math.min(grp.count, total - grp.start));
      }
    } else if (mats.visible) {
      const groups = mesh.geometry.groups;
      if (groups.length) for (const grp of groups) addPiece(mesh, traced(mats, casts), grp.start, Math.min(grp.count, total - grp.start));
      else addPiece(mesh, traced(mats, casts), 0, total);
    }
  });

  for (const s of input.softboxes) {
    const l = new THREE.RectAreaLight(0xffffff, s.intensity, s.width, s.height);
    l.name = 'photo softbox';
    l.position.set(...s.position);
    // A light's lookAt turns its −Z (the side a RectAreaLight shines from) toward the target.
    l.lookAt(...s.target);
    scene.add(l);
    made.lights.push(l);
    stats.lights++;
  }

  if (input.floor) {
    const f = floorMesh(input.floor);
    scene.add(f);
    made.geometries.push(f.geometry);
    made.materials.push(f.material as THREE.Material);
    stats.meshes++;
  }

  scene.updateMatrixWorld(true);
  return {
    scene,
    stats,
    dispose() {
      // The stand-ins are never drawn by the renderer (the path tracer copies them), so this frees
      // nothing on the GPU; the attributes they share stay with the live meshes.
      for (const g of made.geometries) g.dispose();
      for (const m of made.materials) m.dispose();
      for (const l of made.lights) l.dispose();
      scene.clear();
      scene.environment = null;
      scene.background = null;
    },
  };
}
