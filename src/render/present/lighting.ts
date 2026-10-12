import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { V3 } from '../../geometry/types';
import { sceneLights } from '../../model/look';
import { roomInterior, roomOf, roomShell } from '../../model/room';
import { hiddenNodes } from '../../model/visibility';
import type { Doc } from '../../model/schema';
import {
  autoFixtures,
  autoSun,
  fitOrtho,
  fixtureIntensity,
  fixturesFrom,
  balancedKelvin,
  lightDir,
  planLights,
  PRESETS,
  presetExposure,
  resolvePreset,
  underCabinetOn,
  underCabinetStrips,
  type Bounds,
  type FixtureLight,
  type PresetId,
  type PresetSpec,
  type Strip,
  type SunAngles,
} from './lightPlan';
import { linearOf, PHOTO_ENV, studioSoftboxes, type PhotoEnv, type PhotoFloor, type Softbox } from './photoPlan';
import { untoneMapped } from './pipeline';

/**
 * Presentation's lighting rig (B2, B7): one fixed set of lights per session, which the presets only
 * re-color and re-weigh — so switching presets never recompiles a shader.
 *
 * - **Sun / key:** one shadowed DirectionalLight. The studio's key (front-right, 50° up) or the sun
 *   (shining in through the largest window, `autoSun`), its shadow camera fitted to the room (or the
 *   model). The pipeline softens it while the view is still.
 * - **Fill:** a hemisphere light (sky over ground).
 * - **Environment:** the studio's RoomEnvironment, or a probe of the scene itself (`captureProbe`,
 *   taken from the middle of the room with the cutaway lifted): reflections of the room, and its
 *   sunlit patches as bounce light.
 * - **Outside:** three's Sky (following the camera, at the far plane), an unlit ground disc fading
 *   into the haze, and — without a room floor — a shadow catcher under the model.
 * - **Studio:** a warm gray backdrop and a floor disc fading into it (no fog: toggling fog
 *   recompiles); the backdrop is pre-compensated for the tone mapping, so it shows exactly as
 *   `BACKGROUND` (and matches the "Preparing…" veil).
 * - **Fixtures:** the doc's light fixtures (`sceneLights`: pendants, cans, strips, hood lamps), planned
 *   into the tier's budget — spots (the first casts on High), points that never cast, and area lights —
 *   or, in a room with none of its own, stand-in ceiling spots; plus RectAreaLight strips under the
 *   wall cabinets.
 *
 * The number of lights changes only when the plan does (a room added, cabinets hung, a tier change).
 */

export const BACKGROUND = '#ebe9e5';

/** The studio preset's numbers (kept for the floor's albedo; see `PRESETS.studio`). */
export const STUDIO = {
  exposure: PRESETS.studio.exposure,
  environment: PRESETS.studio.env.intensity,
  key: { azimuth: PRESETS.studio.sun.azimuth!, elevation: PRESETS.studio.sun.elevation, intensity: PRESETS.studio.sun.intensity },
  /** PCF filter radius (shadow-map texels): the edge while moving; still frames soften further. */
  shadowRadius: 4,
  bloom: PRESETS.studio.bloom,
};

/**
 * RoomEnvironment's light on an upward-facing matte surface, per unit of environment intensity
 * (measured): with the key light's share, it gives the floor the albedo that shows exactly as the
 * backdrop, so the floor's fade is invisible and only shadows and occlusion show on it.
 */
const ROOM_ENV_UP = 1.47;

/** Room for drawers and doors to open inside the shadow camera (inches). */
const OPEN_MARGIN = 24;
/** The probe's far plane and size. */
const PROBE = { near: 1, far: 3000, size: 256 };
/** The probe hangs at most this high in a room (inches): about eye height. */
const PROBE_HEIGHT = 54;
/** Shadow biases (inches: the shadow cameras' units). */
const SUN_BIAS = { bias: -0.0002, normalBias: 0.06 };
const SPOT_SHADOW = { size: 1024, bias: -0.0005, normalBias: 0.05, near: 2, far: 400 };
/** The hemisphere fill's share without a room around the model. */
const OUTDOOR_FILL = 0.3;
/** Spot penumbra (0…1 of the cone) and the widest half-angle three allows us. */
const SPOT_PENUMBRA = 0.6;
const MAX_HALF_ANGLE = Math.PI / 2.2;

export interface LightingInput {
  doc: Doc;
  /** The model's bounds (inches; the room left out). */
  model: Bounds;
  /** The tier's fixture budget, and whether the strongest spot casts a shadow (High). */
  budget: number;
  spotShadow: boolean;
}

/** What a path-traced photo (B8) needs to know about the rig as it is now. */
export interface PhotoRig {
  preset: PresetId;
  /** Drawn by shaders the path tracer can't run, or stood in for: the sky, the outdoor ground, the catcher, the studio floor. */
  skip: THREE.Object3D[];
  env: PhotoEnv;
  /** The studio's backdrop color, or the sky (the environment). */
  background: THREE.Color | 'env';
  /** The floor that fades into the background (the studio's, or the ground under a model outdoors); none in a room. */
  floor: PhotoFloor | null;
  softboxes: Softbox[];
}

export interface LightingChange {
  /** The probe should be taken again (lighting or the plan changed; the caller also does on model edits). */
  probe: boolean;
  /** Lights were added or removed: shaders recompile on the next frame. */
  relit: boolean;
}

export interface Lighting {
  /** The preset drawn (`auto` resolved). */
  readonly preset: PresetId;
  /** Tone-mapping exposure: the preset's, times the user's brightness. */
  readonly exposure: number;
  readonly bloom: number;
  /** Glowing finishes' level (fixtures on or off). */
  readonly fixtureLevel: number;
  /** Whether the room shell shows (the studio hides it). */
  readonly showRoom: boolean;
  /** Whether the environment is the probe (so it's worth re-capturing). */
  readonly usesProbe: boolean;
  /** Re-plans the rig for the doc (room, cabinets, saved lighting) and the model's bounds. */
  update(input: LightingInput): LightingChange;
  /** The exposure for a brightness (EV) on the current preset, while the slider moves. */
  exposureAt(ev: number): number;
  /** Before each frame: the sky and the ground stay around the camera. */
  follow(camera: THREE.PerspectiveCamera): void;
  /** Captures the probe now (the caller lifts the cutaway around it). */
  captureProbe(): void;
  /** The rig as a path-traced photo should stand it in (`model`: the model's bounds, inches). */
  photo(model: Bounds): PhotoRig;
  /** The lights, for the dev console. */
  readonly debug: { key: THREE.DirectionalLight; hemi: THREE.HemisphereLight; sky: Sky; spots: THREE.SpotLight[]; points: THREE.PointLight[]; areas: THREE.RectAreaLight[]; strips: THREE.RectAreaLight[]; probe: THREE.Vector3 };
  dispose(): void;
}

const FLOOR_VERTEX = /* glsl */ `
varying vec2 vFloorXZ;`;
const FLOOR_FRAGMENT = /* glsl */ `
uniform vec3 uFadeColor;
uniform vec2 uFade;
uniform vec2 uCenter;
varying vec2 vFloorXZ;`;

const linear = (hex: string) => new THREE.Color(hex);
const kelvin = (k: number, balance: number, out = new THREE.Color()) => out.setRGB(...balancedKelvin(k, balance), THREE.LinearSRGBColorSpace);
const toInches = (v: readonly number[]): V3 => [v[0]! / 64, v[1]! / 64, v[2]! / 64];

let rectAreaReady = false;

/** The brightest the sky draws (linear): the sun stays a bright dot with a modest bloom. */
const SKY_MAX = 3;

/** Sky.js with a gain, a ceiling and an added tint (night's deep blue) on its radiance. */
function makeSky(): Sky {
  const sky = new Sky();
  sky.name = 'sky';
  const m = sky.material as THREE.ShaderMaterial;
  m.uniforms.skyGain = { value: 1 };
  m.uniforms.skyTint = { value: new THREE.Color(0, 0, 0) };
  m.fragmentShader = m.fragmentShader
    .replace('uniform float time;', 'uniform float time;\nuniform float skyGain;\nuniform vec3 skyTint;')
    // Clamped: the sun's disc and glow would otherwise bloom over half the view.
    .replace('gl_FragColor = vec4( texColor, 1.0 );', `gl_FragColor = vec4( min( texColor * skyGain, vec3( ${SKY_MAX.toFixed(1)} ) ) + skyTint, 1.0 );`);
  sky.frustumCulled = false;
  sky.castShadow = sky.receiveShadow = false;
  sky.userData.noAO = true;
  sky.renderOrder = -1;
  sky.visible = false;
  return sky;
}

/** The outdoor ground: unlit, its color fading to the haze toward the rim (vertex colors per ring). */
function makeGround(): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const geometry = new THREE.RingGeometry(0, 1, 96, 16);
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position!.count * 3), 3));
  const ground = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  ground.name = 'outdoor ground';
  ground.rotation.x = -Math.PI / 2;
  ground.userData.noAO = true;
  ground.visible = false;
  return ground;
}

function paintGround(ground: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>, near: string, far: string): void {
  const pos = ground.geometry.attributes.position!;
  const col = ground.geometry.attributes.color!;
  const [a, b] = [linear(near), linear(far)];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    const t = THREE.MathUtils.smoothstep(r, 0.12, 0.85);
    c.copy(a).lerp(b, t);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

export function createLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Lighting {
  // The backdrop: linear values that tone-map to the picked color.
  const bg = new THREE.Color(BACKGROUND);
  const shown = untoneMapped([bg.r, bg.g, bg.b], STUDIO.exposure);
  const backdrop = new THREE.Color().setRGB(...shown, THREE.LinearSRGBColorSpace);
  scene.background = backdrop;

  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  // The render target, not just its texture: disposing only the texture leaks it.
  const studioEnv = pmrem.fromScene(room, 0.04);
  room.dispose();
  let probeEnv: THREE.WebGLRenderTarget | null = null;
  scene.environment = studioEnv.texture;
  scene.environmentIntensity = STUDIO.environment;

  const key = new THREE.DirectionalLight(0xffffff, STUDIO.key.intensity);
  key.name = 'key';
  key.castShadow = true;
  key.shadow.radius = STUDIO.shadowRadius;
  key.shadow.bias = SUN_BIAS.bias;
  key.shadow.normalBias = SUN_BIAS.normalBias;
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
  hemi.name = 'fill';
  scene.add(key, key.target, hemi);

  const sky = makeSky();
  const ground = makeGround();
  const catcher = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.ShadowMaterial({ opacity: 0.45 }));
  catcher.name = 'shadow catcher';
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  catcher.visible = false;
  scene.add(sky, ground, catcher);

  // The studio floor: lit (shadows and AO land on it) and fading to the backdrop with distance.
  const uniforms = {
    uFadeColor: { value: backdrop.clone() },
    uFade: { value: new THREE.Vector2(100, 300) },
    uCenter: { value: new THREE.Vector2() },
  };
  const lit = (STUDIO.key.intensity * Math.sin((STUDIO.key.elevation * Math.PI) / 180)) / Math.PI + STUDIO.environment * ROOM_ENV_UP;
  const floorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  floorMaterial.color.setRGB(backdrop.r / lit, backdrop.g / lit, backdrop.b / lit, THREE.LinearSRGBColorSpace);
  floorMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${FLOOR_VERTEX}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFloorXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FLOOR_FRAGMENT}`)
      .replace(
        '#include <tonemapping_fragment>',
        'gl_FragColor.rgb = mix(gl_FragColor.rgb, uFadeColor, smoothstep(uFade.x, uFade.y, distance(vFloorXZ, uCenter)));\n#include <tonemapping_fragment>',
      );
  };
  floorMaterial.customProgramCacheKey = () => 'present-floor';
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96), floorMaterial);
  floor.name = 'studio floor';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Fixtures: pools grown or shrunk to the plan (that alone recompiles).
  const spots: THREE.SpotLight[] = [];
  const points: THREE.PointLight[] = [];
  const areas: THREE.RectAreaLight[] = [];
  const strips: THREE.RectAreaLight[] = [];
  const resize = <L extends THREE.Light>(pool: L[], n: number, make: () => L): boolean => {
    if (pool.length === n) return false;
    while (pool.length > n) {
      const l = pool.pop()!;
      scene.remove(l);
      if ((l as unknown as THREE.SpotLight).isSpotLight) scene.remove((l as unknown as THREE.SpotLight).target);
      l.dispose();
    }
    while (pool.length < n) {
      const l = make();
      pool.push(l);
      scene.add(l);
      if ((l as unknown as THREE.SpotLight).isSpotLight) scene.add((l as unknown as THREE.SpotLight).target);
    }
    return true;
  };

  const probeAt = new THREE.Vector3();
  let state = {
    preset: 'studio' as PresetId,
    ev: 0,
    exposure: STUDIO.exposure,
    bloom: STUDIO.bloom,
    fixtureLevel: 0,
    showRoom: false,
    usesProbe: false,
  };
  let probeKey = '';

  const placeSpot = (l: THREE.SpotLight, f: FixtureLight, level: number, balance: number) => {
    l.position.set(...f.at);
    const d = f.dir ?? [0, -1, 0];
    l.target.position.set(f.at[0] + d[0] * 100, f.at[1] + d[1] * 100, f.at[2] + d[2] * 100);
    l.angle = Math.min(MAX_HALF_ANGLE, ((f.beam ?? 60) * Math.PI) / 360 / (1 - SPOT_PENUMBRA / 2));
    l.penumbra = SPOT_PENUMBRA;
    l.decay = 2;
    l.distance = 0;
    kelvin(f.kelvin, balance, l.color);
    l.intensity = fixtureIntensity(f) * level;
  };
  const placePoint = (l: THREE.PointLight, f: FixtureLight, level: number, balance: number) => {
    l.position.set(...f.at);
    l.decay = 2;
    l.distance = 0;
    kelvin(f.kelvin, balance, l.color);
    l.intensity = fixtureIntensity(f) * level;
  };
  /** An area fixture: its width along `along`, shining along `dir` (its −Z side). */
  const placeArea = (l: THREE.RectAreaLight, f: FixtureLight, level: number, balance: number) => {
    const [w, h] = f.size ?? [1, 1];
    l.width = Math.max(0.1, w);
    l.height = Math.max(0.1, h);
    l.position.set(...f.at);
    const z = new THREE.Vector3(...(f.dir ?? [0, -1, 0])).negate().normalize();
    const x = new THREE.Vector3(...(f.along ?? [1, 0, 0]));
    x.addScaledVector(z, -x.dot(z)).normalize();
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    const y = new THREE.Vector3().crossVectors(z, x);
    l.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    kelvin(f.kelvin, balance, l.color);
    l.intensity = fixtureIntensity(f) * level;
  };
  const placeStrip = (l: THREE.RectAreaLight, s: Strip, on: boolean, balance: number) => {
    l.width = s.length;
    l.height = s.width;
    l.position.set(...s.center);
    // Local x along the run, local −z (the side that shines) down.
    const x = new THREE.Vector3(...s.along);
    const z = new THREE.Vector3(0, 1, 0);
    const y = new THREE.Vector3().crossVectors(z, x);
    l.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    kelvin(s.kelvin, balance, l.color);
    l.intensity = on ? fixtureIntensity({ kind: 'area', lumens: s.lumens, size: [s.length, s.width] }) : 0;
  };

  const fitKey = (dir: V3, box: Bounds, floorShadows: boolean) => {
    const f = fitOrtho(dir, box, { floorShadows });
    key.position.set(...f.position);
    key.target.position.set(...f.target);
    Object.assign(key.shadow.camera, { left: f.left, right: f.right, top: f.top, bottom: f.bottom, near: f.near, far: f.far });
    key.shadow.camera.updateProjectionMatrix();
  };

  const studioFloor = (b: Bounds) => {
    const center: V3 = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2];
    const span = Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    floor.scale.setScalar(Math.max(800, span * 8));
    floor.position.set(center[0], b.min[1] - 0.02, center[2]);
    uniforms.uCenter.value.set(center[0], center[2]);
    uniforms.uFade.value.set(Math.max(30, span * 0.7), Math.max(120, span * 2.5));
    catcher.scale.setScalar(Math.max(120, span * 2));
    catcher.position.set(center[0], b.min[1] - 0.02, center[2]);
  };

  /** The sun's angles for a preset: fixed (studio), saved, or through the largest window. */
  const sunFor = (spec: PresetSpec, saved: SunAngles | undefined, auto: SunAngles): SunAngles => {
    if (spec.sun.azimuth !== undefined) return { azimuth: spec.sun.azimuth, elevation: spec.sun.elevation };
    const from = saved ?? auto;
    // Day takes the saved elevation as it is; evening and night keep their own (a low sun, none).
    return { azimuth: from.azimuth, elevation: spec === PRESETS.day ? from.elevation : spec.sun.elevation };
  };

  return {
    get preset() {
      return state.preset;
    },
    get exposure() {
      return state.exposure;
    },
    get bloom() {
      return state.bloom;
    },
    get fixtureLevel() {
      return state.fixtureLevel;
    },
    get showRoom() {
      return state.showRoom;
    },
    get usesProbe() {
      return state.usesProbe;
    },
    debug: { key, hemi, sky, spots, points, areas, strips, probe: probeAt },

    update({ doc, model, budget, spotShadow: wantSpotShadow }) {
      const saved = doc.presentation?.lighting;
      const shell = roomShell(doc);
      const inside = roomInterior(doc);
      // A hidden room counts as none.
      const theRoom = roomOf(doc);
      const hasRoom = !!shell.bounds && !!theRoom && !hiddenNodes(doc).has(theRoom.id);
      const id = resolvePreset(saved, hasRoom);
      const spec = PRESETS[id];
      const inRoom = hasRoom && spec.room;
      const roomBox: Bounds | null = hasRoom && shell.bounds ? { min: toInches(shell.bounds.min), max: toInches(shell.bounds.max) } : null;
      const interior: Bounds | null = hasRoom && inside ? { min: toInches(inside.min), max: toInches(inside.max) } : null;

      // The plan: the doc's fixtures (stand-in ceiling spots in a room without any), and under-cabinet strips.
      const own = fixturesFrom(sceneLights(doc));
      const fixtures = planLights(own.length ? own : interior ? autoFixtures(interior) : [], budget);
      const of = (kind: FixtureLight['kind']) => fixtures.filter((f) => f.kind === kind);
      const [spotPlan, pointPlan, areaPlan] = [of('spot'), of('point'), of('area')];
      const stripPlan = underCabinetStrips(doc);
      let relit = resize(spots, spotPlan.length, () => new THREE.SpotLight());
      // Points never cast (B7): pendants with a globe, sconces.
      relit = resize(points, pointPlan.length, () => Object.assign(new THREE.PointLight(), { castShadow: false })) || relit;
      if ((stripPlan.length || areaPlan.length) && !rectAreaReady) {
        RectAreaLightUniformsLib.init();
        rectAreaReady = true;
      }
      relit = resize(areas, areaPlan.length, () => new THREE.RectAreaLight()) || relit;
      relit = resize(strips, stripPlan.length, () => new THREE.RectAreaLight()) || relit;
      // The strongest spot casts on High (a tier change, so a recompile then anyway).
      spots.forEach((l, i) => {
        const cast = wantSpotShadow && i === 0;
        if (l.castShadow !== cast) relit = true;
        l.castShadow = cast;
        if (cast) {
          l.shadow.mapSize.set(SPOT_SHADOW.size, SPOT_SHADOW.size);
          Object.assign(l.shadow, { bias: SPOT_SHADOW.bias, normalBias: SPOT_SHADOW.normalBias });
          Object.assign(l.shadow.camera, { near: SPOT_SHADOW.near, far: SPOT_SHADOW.far });
        }
      });

      // The sun or key.
      const middle: V3 | undefined = inside ? [(inside.min[0] + inside.max[0]) / 2, 0, (inside.min[2] + inside.max[2]) / 2] : undefined;
      const sun = sunFor(spec, saved?.sun, autoSun(hasRoom ? shell.windows : [], middle));
      const dir = lightDir(sun.azimuth, sun.elevation);
      key.color.set(spec.sun.color);
      key.intensity = spec.sun.intensity;
      if (inRoom && roomBox) fitKey(dir, roomBox, false);
      else fitKey(dir, { min: [model.min[0] - OPEN_MARGIN, model.min[1], model.min[2] - OPEN_MARGIN], max: [model.max[0] + OPEN_MARGIN, model.max[1], model.max[2] + OPEN_MARGIN] }, true);

      hemi.color.set(spec.hemi.sky);
      hemi.groundColor.set(spec.hemi.ground);
      // Outdoors (no room) the sky probe already fills the shadows: the fill is for rooms.
      hemi.intensity = spec.hemi.intensity * (inRoom || !spec.sky ? 1 : OUTDOOR_FILL);

      spotPlan.forEach((f, i) => placeSpot(spots[i]!, f, spec.fixtures, spec.whiteBalance));
      pointPlan.forEach((f, i) => placePoint(points[i]!, f, spec.fixtures, spec.whiteBalance));
      areaPlan.forEach((f, i) => placeArea(areas[i]!, f, spec.fixtures, spec.whiteBalance));
      const under = underCabinetOn(id, saved);
      stripPlan.forEach((s, i) => placeStrip(strips[i]!, s, under, spec.whiteBalance));

      // Outside: the sky, the ground, the catcher; or the studio.
      const outdoor = !!spec.sky;
      sky.visible = outdoor;
      ground.visible = outdoor;
      floor.visible = !outdoor;
      studioFloor(model);
      if (spec.sky) {
        const u = (sky.material as THREE.ShaderMaterial).uniforms;
        u.turbidity!.value = spec.sky.turbidity;
        u.rayleigh!.value = spec.sky.rayleigh;
        u.mieCoefficient!.value = spec.sky.mieCoefficient;
        u.mieDirectionalG!.value = spec.sky.mieDirectionalG;
        u.cloudCoverage!.value = spec.sky.cloudCoverage;
        u.skyGain!.value = spec.sky.gain;
        (u.skyTint!.value as THREE.Color).set(spec.sky.tint);
        (u.sunPosition!.value as THREE.Vector3).set(...lightDir(sun.azimuth, spec.sky.elevation ?? sun.elevation));
        paintGround(ground, spec.ground, spec.horizon);
        ground.position.y = (inRoom && roomBox ? roomBox.min[1] : model.min[1]) - 0.05;
      }
      catcher.visible = outdoor && !(inRoom && shell.floors.length);
      scene.background = outdoor ? null : backdrop;

      // The probe: from the middle of the room at about eye height, else above the model.
      if (inRoom && interior) probeAt.set((interior.min[0] + interior.max[0]) / 2, Math.min(interior.min[1] + PROBE_HEIGHT, (interior.min[1] + interior.max[1]) / 2), (interior.min[2] + interior.max[2]) / 2);
      else probeAt.set((model.min[0] + model.max[0]) / 2, model.max[1] + 24, (model.min[2] + model.max[2]) / 2);
      const usesProbe = spec.env.source === 'probe';
      scene.environment = usesProbe && probeEnv ? probeEnv.texture : studioEnv.texture;
      scene.environmentIntensity = spec.env.intensity;

      const ev = saved?.exposure ?? 0;
      state = { preset: id, ev, exposure: presetExposure(id, ev), bloom: spec.bloom, fixtureLevel: spec.fixtures, showRoom: inRoom, usesProbe };
      const nextKey = JSON.stringify([id, sun, under, fixtures, stripPlan, roomBox, probeAt.toArray()]);
      const probe = usesProbe && (nextKey !== probeKey || !probeEnv);
      probeKey = nextKey;
      return { probe, relit };
    },

    exposureAt(ev) {
      return presetExposure(state.preset, ev);
    },

    follow(camera) {
      sky.position.copy(camera.position);
      sky.scale.setScalar(camera.far * 0.5);
      ground.scale.setScalar(camera.far * 0.9);
      ground.position.x = camera.position.x;
      ground.position.z = camera.position.z;
    },

    captureProbe() {
      const before = { env: scene.environment, background: scene.background, skyAt: sky.position.clone(), skyScale: sky.scale.x, disc: (sky.material as THREE.ShaderMaterial).uniforms.showSunDisc!.value };
      // Direct light only (no feedback from the last probe), no sun disc (the sun light is already
      // there), the sky around the probe.
      scene.environment = null;
      scene.background = new THREE.Color(0, 0, 0);
      (sky.material as THREE.ShaderMaterial).uniforms.showSunDisc!.value = 0;
      sky.position.copy(probeAt);
      sky.scale.setScalar(PROBE.far * 0.5);
      const shadowUpdate = renderer.shadowMap.needsUpdate;
      try {
        const next = pmrem.fromScene(scene, 0, PROBE.near, PROBE.far, { size: PROBE.size, position: probeAt });
        probeEnv?.dispose();
        probeEnv = next;
      } finally {
        scene.background = before.background;
        sky.position.copy(before.skyAt);
        sky.scale.setScalar(before.skyScale);
        (sky.material as THREE.ShaderMaterial).uniforms.showSunDisc!.value = before.disc;
        renderer.shadowMap.needsUpdate = shadowUpdate;
      }
      scene.environment = state.usesProbe && probeEnv ? probeEnv.texture : (before.env ?? studioEnv.texture);
    },

    photo(model) {
      const spec = PRESETS[state.preset];
      let plan: PhotoFloor | null = null;
      if (floor.visible) {
        const color = floorMaterial.color;
        plan = { center: floor.position.toArray(), radius: floor.scale.x, near: uniforms.uFade.value.x, far: uniforms.uFade.value.y, color: [color.r, color.g, color.b] };
      } else if (catcher.visible) {
        // Outdoors without a room floor: the ground's color under the model, fading out far off.
        const r = catcher.scale.x;
        plan = { center: catcher.position.toArray(), radius: r * 4, near: r * 0.75, far: r * 4, color: linearOf(spec.ground) };
      }
      return {
        preset: state.preset,
        skip: [sky, ground, catcher, floor],
        env: PHOTO_ENV[state.preset],
        background: sky.visible ? 'env' : scene.background instanceof THREE.Color ? scene.background.clone() : backdrop.clone(),
        floor: plan,
        softboxes: state.preset === 'studio' ? studioSoftboxes(model) : [],
      };
    },

    dispose() {
      scene.remove(key, key.target, hemi, sky, ground, catcher, floor);
      for (const l of spots) scene.remove(l, l.target);
      for (const l of [...points, ...areas, ...strips]) scene.remove(l);
      for (const l of [key, hemi, ...spots, ...points, ...areas, ...strips]) l.dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      catcher.geometry.dispose();
      (catcher.material as THREE.Material).dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      studioEnv.dispose();
      probeEnv?.dispose();
      pmrem.dispose();
      scene.environment = null;
      scene.background = null;
    },
  };
}
