import * as THREE from 'three';
import { UNITS_PER_INCH } from '../model/units';
import type { Box3 } from '../model/world';
import { PALETTE } from './palette';

/**
 * The floor grid (Y = 0, inches): 1' squares with a bolder line every 4' and the axis lines through
 * the origin. Unbounded it runs to the horizon, fading with distance from the camera and thinning
 * out where its lines would crowd on screen, so a whole room fits on it. Bounded (an isolated
 * folder) it stops at a rectangle, like a small floor of its own.
 *
 * It's one transparent plane that follows the camera, drawn first (renderOrder -1) without writing
 * depth: the model hides it, and every overlay draws over it — they're all transparent with a
 * renderOrder of 0 or more, and must stay that way.
 */

/** A floor rectangle, in inches. */
export interface GridRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Grid {
  readonly mesh: THREE.Mesh;
  /** Follows the camera (call every frame, after the controls update). */
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void;
  /** Stops the grid at a rectangle (null: runs to the horizon again). */
  setBounds(rect: GridRect | null): void;
  readonly bounds: GridRect | null;
  /** Whether a floor point (inches) is on the drawn grid: inside the bounds, else not faded out. */
  contains(x: number, z: number): boolean;
}

const FOOT = 12;
/** An isolated folder's floor: at least 12' a side, 2' clear of what's on it. */
const MIN_SIDE = 144;
const MARGIN = 24;
/** Distance fade: reaches a few times the orbit distance, never closer than 25', never to the far plane. */
const FADE_MIN = 300;
const FADE_PER_DISTANCE = 5;
const FADE_FAR_SHARE = 0.8;

/** The floor under an isolated folder, from its world bounds (1/64"): whole feet, covering it with room to spare. */
export function isolateGridRect(box: Box3): GridRect {
  const span = (lo: number, hi: number): [number, number] => {
    let a = lo / UNITS_PER_INCH - MARGIN;
    let b = hi / UNITS_PER_INCH + MARGIN;
    if (b - a < MIN_SIDE) {
      const c = (a + b) / 2;
      [a, b] = [c - MIN_SIDE / 2, c + MIN_SIDE / 2];
    }
    return [Math.floor(a / FOOT) * FOOT, Math.ceil(b / FOOT) * FOOT];
  };
  const [minX, maxX] = span(box.min[0], box.max[0]);
  const [minZ, maxZ] = span(box.min[2], box.max[2]);
  return { minX, minZ, maxX, maxZ };
}

const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uAxis;
uniform float uFade;
uniform float uBounded;
uniform vec4 uBounds;
varying vec3 vWorld;

// Coverage of the lines every 'cell' inches, about 'width' px wide, per axis (x: the lines of constant x).
// A set fades out as its cells shrink to a few pixels on screen, so the distance doesn't shimmer.
vec2 lines(vec2 p, float cell, float width) {
  vec2 coord = p / cell;
  vec2 fw = max(fwidth(coord), vec2(1e-6));
  vec2 dist = abs(fract(coord - 0.5) - 0.5) / fw;
  vec2 cover = clamp(width * 0.5 + 0.5 - dist, 0.0, 1.0);
  return cover * (1.0 - smoothstep(0.1, 0.25, fw));
}

void main() {
  vec2 p = vWorld.xz;
  vec2 fw = fwidth(p);
  if (uBounded > 0.5 && (any(lessThan(p, uBounds.xy - fw)) || any(greaterThan(p, uBounds.zw + fw)))) discard;
  vec2 minor = lines(p, 12.0, 1.0);
  vec2 major = lines(p, 48.0, 1.6);
  vec2 axis = clamp(1.25 - abs(p) / max(fw, vec2(1e-6)), 0.0, 1.0);
  // Layered: 1' lines, then 4' lines over them, then the axes on top.
  vec4 acc = vec4(uMinor, 1.0) * max(minor.x, minor.y);
  float a = max(major.x, major.y);
  acc = vec4(uMajor, 1.0) * a + acc * (1.0 - a);
  a = max(axis.x, axis.y);
  acc = vec4(uAxis, 1.0) * a + acc * (1.0 - a);
  float alpha = acc.a * (1.0 - smoothstep(0.4 * uFade, uFade, distance(cameraPosition, vWorld)));
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(acc.rgb / acc.a, alpha);
  #include <colorspace_fragment>
}
`;

export function createGrid(): Grid {
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const uniforms = {
    uMinor: { value: new THREE.Color(PALETTE.gridMinor) },
    uMajor: { value: new THREE.Color(PALETTE.gridMajor) },
    uAxis: { value: new THREE.Color(PALETTE.gridAxis) },
    uFade: { value: FADE_MIN },
    uBounded: { value: 0 },
    uBounds: { value: new THREE.Vector4() },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'grid';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};

  let bounds: GridRect | null = null;
  let fade = FADE_MIN;
  const eye = new THREE.Vector3(0, 1, 0);

  return {
    mesh,
    get bounds() {
      return bounds;
    },
    update(camera, target) {
      fade = Math.min(Math.max(FADE_PER_DISTANCE * camera.position.distanceTo(target), FADE_MIN), FADE_FAR_SHARE * camera.far);
      eye.copy(camera.position);
      mesh.position.set(eye.x, 0, eye.z);
      mesh.scale.set(2 * fade, 1, 2 * fade);
      uniforms.uFade.value = fade;
    },
    setBounds(rect) {
      bounds = rect ? { ...rect } : null;
      uniforms.uBounded.value = rect ? 1 : 0;
      if (rect) uniforms.uBounds.value.set(rect.minX, rect.minZ, rect.maxX, rect.maxZ);
    },
    contains(x, z) {
      if (bounds) return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
      return Math.hypot(x - eye.x, eye.y, z - eye.z) <= fade;
    },
  };
}
