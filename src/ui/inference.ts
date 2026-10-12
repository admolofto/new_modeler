import * as THREE from 'three';
import { alongLine, type Ray } from '../edit/rays';
import type { Handle, V3 } from '../geometry/types';
import { UNITS_PER_INCH } from '../model/units';
import { PALETTE } from '../render/palette';
import { resolvePick } from '../render/pick';
import type { SceneSync } from '../render/sceneSync';
import type { Viewport } from '../render/viewport';

/**
 * Point inference for the tools, as SketchUp does it: the point a click would land on is the corner
 * right under the cursor (Endpoint, green), else the middle of an edge (Midpoint, cyan), else the
 * nearest point along an edge (On Edge, red), else where the cursor meets a face (On Face, blue),
 * else the floor. Corners and edges come from the parts' declared handles, so they are the same
 * ones selection picks. Parts being moved are left out (`exclude`): the point is on what stays put.
 */

export type InferKind = 'endpoint' | 'midpoint' | 'edge' | 'face' | 'ground';

export interface Inferred {
  kind: InferKind;
  /** World model units. */
  at: V3;
  /** The part it's on (null: the floor). */
  part: string | null;
  /** The face's tag, on a face. */
  tag?: string | undefined;
  /** What the cursor label says ('' on the floor). */
  label: string;
  color: number;
}

export interface FaceHit {
  part: string;
  tag: string | null;
  mesh: THREE.Mesh;
  /** Scene coordinates (inches). */
  world: THREE.Vector3;
  /** Part-local model units. */
  at: V3;
}

export interface InferOptions {
  /** Parts to look through (the ones being moved). */
  exclude?: ReadonlySet<string> | undefined;
  /** Fall back to the floor (default true). */
  ground?: boolean | undefined;
}

export interface Inference {
  /** Aims at the pointer; the other calls read the ray this leaves. */
  aim(e: MouseEvent): void;
  /** The aimed ray, in model units. */
  ray(): Ray;
  point(opts?: InferOptions): Inferred | null;
  /** The part face under the pointer, whatever is near it. */
  face(exclude?: ReadonlySet<string>): FaceHit | null;
  /** A world point (model units) in client pixels. */
  screen(p: V3): { x: number; y: number; behind: boolean };
  /** Model units per screen pixel at a world point. */
  unitsPerPx(p: V3): number;
}

/** How close (screen pixels) the cursor must be to a corner, a midpoint or an edge to land on it. */
const POINT_PX = 9;
const EDGE_PX = 6;
const U = UNITS_PER_INCH;

const STYLE: Record<InferKind, { label: string; color: number }> = {
  endpoint: { label: 'Endpoint', color: PALETTE.inferEndpoint },
  midpoint: { label: 'Midpoint', color: PALETTE.inferMidpoint },
  edge: { label: 'On Edge', color: PALETTE.inferEdge },
  face: { label: 'On Face', color: PALETTE.inferFace },
  ground: { label: '', color: PALETTE.rubber },
};

export function createInference(viewport: Viewport, sceneSync: SceneSync): Inference {
  const { camera, renderer } = viewport;
  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const occluder = new THREE.Raycaster();
  let mouse = { x: 0, y: 0 };
  let rect = canvas.getBoundingClientRect();

  const toScreen = (p: THREE.Vector3) => {
    const q = p.clone().project(camera);
    return { x: ((q.x + 1) / 2) * rect.width, y: ((1 - q.y) / 2) * rect.height, behind: q.z > 1 };
  };
  const model = (p: THREE.Vector3): V3 => [p.x * U, p.y * U, p.z * U];
  const ray = (): Ray => ({ o: model(raycaster.ray.origin), d: raycaster.ray.direction.toArray() as V3 });
  const meshes = (exclude?: ReadonlySet<string>) => {
    const all = sceneSync.pickable();
    return exclude?.size ? all.filter((m) => !exclude.has(m.userData.partId as string)) : all;
  };

  /** A point is visible if nothing (that counts) sits in front of it along the line of sight. */
  const visible = (p: THREE.Vector3, among: THREE.Mesh[]) => {
    const dir = p.clone().sub(camera.position);
    const dist = dir.length();
    occluder.set(camera.position, dir.normalize());
    const hit = occluder.intersectObjects(among, false)[0];
    return !hit || hit.distance >= dist - Math.max(0.05, dist * 0.002);
  };

  function nearHandle(among: THREE.Mesh[]): Inferred | null {
    const found: { rank: number; kind: InferKind; part: string; world: THREE.Vector3 }[] = [];
    const r = ray();
    const consider = (kind: InferKind, part: string, world: THREE.Vector3, reach: number, penalty: number) => {
      const s = toScreen(world);
      if (s.behind) return;
      const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
      if (d <= reach) found.push({ rank: d + penalty, kind, part, world });
    };
    for (const mesh of among) {
      const part = mesh.userData.partId as string;
      for (const h of (mesh.userData.handles as Handle[] | undefined) ?? []) {
        if (h.kind === 'face') continue;
        const pts = h.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(mesh.matrixWorld));
        if (h.kind === 'vertex' || pts.length < 2) {
          consider('endpoint', part, pts[0]!, POINT_PX, 0);
          continue;
        }
        const [a, b] = [pts[0]!, pts[1]!];
        consider('endpoint', part, a, POINT_PX, 0);
        consider('endpoint', part, b, POINT_PX, 0);
        consider('midpoint', part, a.clone().lerp(b, 0.5), POINT_PX, 1);
        // The edge's point nearest the line of sight (exact in 3D, unlike sliding along it on screen).
        const len = a.distanceTo(b) * U;
        if (len < 1e-6) continue;
        const dir = b.clone().sub(a).normalize();
        const t = alongLine(r, model(a), dir.toArray() as V3);
        if (t !== null) consider('edge', part, a.clone().lerp(b, Math.max(0, Math.min(1, t / len))), EDGE_PX, POINT_PX + 1);
      }
    }
    found.sort((p, q) => p.rank - q.rank);
    for (const c of found.slice(0, 10)) {
      if (visible(c.world, among)) return { kind: c.kind, at: model(c.world), part: c.part, ...STYLE[c.kind] };
    }
    return null;
  }

  function face(exclude?: ReadonlySet<string>): FaceHit | null {
    const hit = raycaster.intersectObjects(meshes(exclude), false)[0];
    if (!hit) return null;
    const mesh = hit.object as THREE.Mesh;
    const at = mesh.worldToLocal(hit.point.clone());
    return { part: mesh.userData.partId as string, tag: resolvePick(hit)?.tag ?? null, mesh, world: hit.point.clone(), at: [Math.round(at.x), Math.round(at.y), Math.round(at.z)] };
  }

  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  return {
    aim(e) {
      rect = canvas.getBoundingClientRect();
      mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      raycaster.setFromCamera(new THREE.Vector2((mouse.x / rect.width) * 2 - 1, -(mouse.y / rect.height) * 2 + 1), camera);
    },
    ray,
    face,
    point(opts) {
      const among = meshes(opts?.exclude);
      const near = nearHandle(among);
      if (near) return near;
      const f = face(opts?.exclude);
      if (f) return { kind: 'face', at: model(f.world), part: f.part, tag: f.tag ?? undefined, ...STYLE.face };
      if (opts?.ground === false) return null;
      const p = raycaster.ray.intersectPlane(floor, new THREE.Vector3());
      if (!p || !viewport.grid.contains(p.x, p.z)) return null;
      return { kind: 'ground', at: [p.x * U, 0, p.z * U], part: null, ...STYLE.ground };
    },
    screen(p) {
      const s = toScreen(new THREE.Vector3(p[0] / U, p[1] / U, p[2] / U));
      return { x: s.x + rect.left, y: s.y + rect.top, behind: s.behind };
    },
    unitsPerPx: (p) => viewport.unitsPerPx(new THREE.Vector3(p[0] / U, p[1] / U, p[2] / U)),
  };
}
