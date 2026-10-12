import * as THREE from 'three';
import type { V3 } from '../../geometry/types';
import { isSolid } from '../../model/decor';
import { roomShell } from '../../model/room';
import type { Doc } from '../../model/schema';
import { direction, yawPitch, type Pose } from '../../render/present/flight';
import { buildGrid, move, WALK_GRID, type Grid } from '../../render/present/occupancy';
import { WALK_KEYS } from './keys';

/**
 * Walk mode (B6): a person standing in the room, at the eye height (62", or the presentation's), a
 * 60° lens. Drag to look (0.25°/px, the pitch held within ±75°); WASD or the arrows walk at 54 in/s
 * (Shift doubles it), easing in and out (τ 0.12 s); the wheel steps 12" forward or back. The
 * occupancy grid keeps you off walls, cabinets and open doors (you slide along them) and on the
 * floor. Doors and drawers still open on a click (the session's), and nothing is cut away.
 */

export const WALK_FOV = 60;
export const WALK_NEAR = 2;
export const WALK_SPEED = 54;
const LOOK_DEG_PER_PX = 0.25;
const MAX_PITCH = (75 * Math.PI) / 180;
const TAU = 0.12;
const WHEEL_STEP = 12;
/** How far ahead a walking pose's target is (inches): only its direction matters. */
export const LOOK_AHEAD = 60;
/** The area you can walk around a model with no room floor: its bounds and this much more (inches). */
const OPEN_FLOOR_MARGIN = 120;

export interface WalkOptions {
  camera: THREE.PerspectiveCamera;
  surface: HTMLElement;
  /** The eye height now (inches). */
  eyeHeight(): number;
  /** The camera moved (the pipeline redraws). */
  onMove(): void;
}

export interface Walk {
  /** Walking (after the flight in): input drives the camera. */
  readonly active: boolean;
  /** Starts walking from a pose (its position at the eye height, facing its target). */
  start(p: Pose): void;
  stop(): void;
  /** Where it stands and looks now. */
  pose(): Pose;
  setGrid(g: Grid | null): void;
  readonly grid: Grid | null;
  /** One frame of walking (dt in seconds). */
  frame(dt: number): void;
  /** A walk key went down or up (the session's key owner hands them over); true when it walks. */
  key(e: KeyboardEvent, down: boolean): boolean;
  dispose(): void;
}

export function createWalk(o: WalkOptions): Walk {
  const { camera, surface } = o;
  let active = false;
  let grid: Grid | null = null;
  let yaw = 0;
  let pitch = 0;
  let x = 0;
  let z = 0;
  let vx = 0;
  let vz = 0;
  /** Inches still to glide from wheel steps (+ forward). */
  let glide = 0;
  const keys = new Set<string>();
  let shift = false;
  let drag: { x: number; y: number } | null = null;

  const place = () => {
    const eye = o.eyeHeight();
    const d = direction(yaw, pitch);
    camera.position.set(x, eye, z);
    camera.lookAt(x + d[0], eye + d[1], z + d[2]);
  };

  const listen = <T extends Event>(target: EventTarget, type: string, fn: (e: T) => void) => {
    target.addEventListener(type, fn as EventListener);
    return () => target.removeEventListener(type, fn as EventListener);
  };
  const clear = () => {
    keys.clear();
    shift = false;
    drag = null;
  };
  const offs = [
    listen<PointerEvent>(surface, 'pointerdown', (e) => {
      if (!active || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY };
    }),
    listen<PointerEvent>(surface, 'pointermove', (e) => {
      if (!active || !drag || !(e.buttons & 1)) return;
      const k = (LOOK_DEG_PER_PX * Math.PI) / 180;
      // Grab the view: dragging right turns you left, dragging down looks up (as orbiting does).
      yaw += (e.clientX - drag.x) * k;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + (e.clientY - drag.y) * k));
      drag = { x: e.clientX, y: e.clientY };
      place();
      o.onMove();
    }),
    listen<PointerEvent>(window, 'pointerup', () => {
      drag = null;
    }),
    listen<WheelEvent>(surface, 'wheel', (e) => {
      if (!active) return;
      e.preventDefault();
      glide += e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
    }),
    // Shift on its own passes the modal key owner untouched, so it's watched here.
    listen<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.key === 'Shift') shift = true;
    }),
    listen<KeyboardEvent>(window, 'keyup', (e) => {
      if (e.key === 'Shift') shift = false;
    }),
    listen(window, 'blur', clear),
  ];

  return {
    get active() {
      return active;
    },
    get grid() {
      return grid;
    },
    start(p) {
      const g = yawPitch([p.target[0] - p.position[0], p.target[1] - p.position[1], p.target[2] - p.position[2]]);
      yaw = g.yaw;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, g.pitch));
      [x, , z] = p.position;
      vx = vz = glide = 0;
      active = true;
      place();
    },
    stop() {
      active = false;
      clear();
      vx = vz = glide = 0;
    },
    pose() {
      const eye = o.eyeHeight();
      const d = direction(yaw, pitch);
      return { position: [x, eye, z], target: [x + d[0] * LOOK_AHEAD, eye + d[1] * LOOK_AHEAD, z + d[2] * LOOK_AHEAD], fov: WALK_FOV };
    },
    setGrid(g) {
      grid = g;
    },
    frame(dt) {
      if (!active) return;
      const fwd: V3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const right: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const ahead = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
      const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      let wx = fwd[0] * ahead + right[0] * side;
      let wz = fwd[2] * ahead + right[2] * side;
      const l = Math.hypot(wx, wz);
      const speed = WALK_SPEED * (shift ? 2 : 1);
      if (l > 0) {
        wx = (wx / l) * speed;
        wz = (wz / l) * speed;
      }
      const k = 1 - Math.exp(-dt / TAU);
      vx += (wx - vx) * k;
      vz += (wz - vz) * k;
      if (Math.hypot(vx, vz) < 0.05 && !l) vx = vz = 0;
      let dx = vx * dt;
      let dz = vz * dt;
      if (glide) {
        const step = Math.sign(glide) * Math.min(Math.abs(glide), Math.max(WALK_SPEED * 2, Math.abs(glide) * 6) * dt);
        glide -= step;
        if (Math.abs(glide) < 1e-3) glide = 0;
        dx += fwd[0] * step;
        dz += fwd[2] * step;
      }
      if (!dx && !dz) return;
      const [nx, nz] = grid ? move(grid, [x, z], [dx, dz]) : [x + dx, z + dz];
      // Walked into something: what's against it stops (no pushing on the spot).
      if (Math.abs(nx - x) < Math.abs(dx) * 0.5) vx = 0;
      if (Math.abs(nz - z) < Math.abs(dz) * 0.5) vz = 0;
      if (nx === x && nz === z) {
        glide = 0;
        return;
      }
      x = nx;
      z = nz;
      place();
      o.onMove();
    },
    key(e, down) {
      const k = e.key.toLowerCase();
      if (!WALK_KEYS.has(k)) return false;
      shift = e.shiftKey;
      if (down) keys.add(k);
      else keys.delete(k);
      return true;
    },
    dispose() {
      for (const off of offs) off();
    },
  };
}

/**
 * The occupancy grid for the scene as drawn now (inches): the solid parts' triangles (open doors
 * where they stand; hidden and taken-away parts left out), on the room's floor — or, with no room
 * floor drawn, an open area around the model.
 */
export function sceneGrid(doc: Doc, meshes: readonly THREE.Mesh[], model: { min: V3; max: V3 }): Grid {
  const floors = new Set(roomShell(doc).floors);
  const ceilings = new Set(roomShell(doc).ceilings.flatMap((c) => c.ids));
  const tris: number[] = [];
  const floorTris: number[] = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const id = mesh.userData.partId as string | undefined;
    const part = id ? doc.parts[id] : undefined;
    if (!part || ceilings.has(part.id)) continue;
    const floor = floors.has(part.id);
    if (!floor && !isSolid(part)) continue;
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const out = floor ? floorTris : tris;
    const n = index ? index.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  if (!floorTris.length) {
    const [x0, z0, x1, z1] = [model.min[0] - OPEN_FLOOR_MARGIN, model.min[2] - OPEN_FLOOR_MARGIN, model.max[0] + OPEN_FLOOR_MARGIN, model.max[2] + OPEN_FLOOR_MARGIN];
    const y = model.min[1];
    floorTris.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
  }
  // The band is measured from the floor the model stands on.
  const base = model.min[1];
  return buildGrid(base ? tris.map((c, i) => (i % 3 === 1 ? c - base : c)) : tris, { ...WALK_GRID, floorTris });
}
