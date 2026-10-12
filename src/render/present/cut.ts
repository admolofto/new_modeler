import * as THREE from 'three';

/**
 * Presentation's cutaway (B6, binding note 10): the room walls and ceiling between the camera and the
 * room (`render/cutaway.ts` picks them) are drawn with a shadow-only material — invisible, yet still
 * casting, so sunlight keeps the shape of the windows — and marked `userData.cutaway`, which the AO
 * pass and picking skip. (Layers won't do: r186's shadow pass layer-tests against the main camera.)
 *
 * Repainting a mesh (a model change, hover) puts its real material back, so the caller sets the cut
 * again afterwards; `set` is cheap when nothing changed.
 */
export interface PresentCut {
  /** Cuts every mesh under these objects; what was cut and isn't any more comes back. True when something changed. */
  set(objects: Iterable<THREE.Object3D>): boolean;
  /** Whether a mesh (or something above it) is cut away. */
  isCut(obj: THREE.Object3D): boolean;
  /** Runs `fn` with every cut mesh drawn normally (the room probe sees the whole room). */
  lifted<T>(fn: () => T): T;
  /** Puts everything back. */
  clear(): void;
}

type Mat = THREE.Material | THREE.Material[];

export function createCut(shadowOnly: THREE.Material): PresentCut {
  /** Cut meshes and their real materials. */
  const cut = new Map<THREE.Mesh, Mat>();

  const restore = (mesh: THREE.Mesh) => {
    const real = cut.get(mesh);
    if (real && mesh.material === shadowOnly) mesh.material = real;
    delete mesh.userData.cutaway;
  };
  const apply = (mesh: THREE.Mesh) => {
    if (mesh.material !== shadowOnly) cut.set(mesh, mesh.material);
    mesh.material = shadowOnly;
    mesh.userData.cutaway = true;
  };

  return {
    set(objects) {
      const next = new Set<THREE.Mesh>();
      for (const o of objects)
        o.traverse((m) => {
          if ((m as THREE.Mesh).isMesh) next.add(m as THREE.Mesh);
        });
      let changed = false;
      for (const mesh of [...cut.keys()])
        if (!next.has(mesh)) {
          restore(mesh);
          cut.delete(mesh);
          changed = true;
        }
      for (const mesh of next) {
        if (mesh.material === shadowOnly && cut.has(mesh)) continue;
        changed ||= !cut.has(mesh);
        apply(mesh);
      }
      return changed;
    },
    isCut(obj) {
      for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o.userData.cutaway) return true;
      return false;
    },
    lifted(fn) {
      const meshes = [...cut.keys()];
      for (const mesh of meshes) restore(mesh);
      try {
        return fn();
      } finally {
        for (const mesh of meshes) apply(mesh);
      }
    },
    clear() {
      for (const mesh of cut.keys()) restore(mesh);
      cut.clear();
    },
  };
}
