import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import type { V3 } from '../../geometry/types';

/**
 * Presentation's rendering (B2): an HDR composer — the scene, ambient occlusion, a little bloom (off
 * in the studio), Neutral tone mapping — drawn on demand. While the view moves, each frame is drawn
 * once and smoothed with SMAA; once it holds still, jittered frames are averaged into a clean,
 * anti-aliased image, and after that nothing is drawn at all until something changes. Shadows are
 * re-rendered only when asked (`invalidate({ shadows: true })`: a door moving, the model changing).
 *
 * Quality tiers trade resolution, shadow detail, AO and material richness for speed: picked from the
 * GPU's name, overridable (remembered), and stepped down while moving frames are slow on Auto.
 * `still()` renders a large image with the same passes for "Save image".
 */

export type Tier = 'fast' | 'balanced' | 'high';
export type Quality = Tier | 'auto';

export interface TierSpec {
  /** Device pixel ratio cap. */
  dprCap: number;
  shadowMap: number;
  /** Ambient occlusion: still frames only (half resolution), half resolution, or full. */
  ao: 'still' | 'half' | 'full';
  bloom: boolean;
  /** Frames averaged once the view is still. */
  samples: number;
  /** Soft shadows while still: the key light's direction jittered over a small disk per sample. */
  softShadows: boolean;
  /** Physically based materials (clearcoat, sheen, anisotropy); standard ones on Fast. */
  physical: boolean;
  /** Fixture lights (phase 7). */
  fixtures: number;
}

export const TIERS: Readonly<Record<Tier, TierSpec>> = {
  fast: { dprCap: 1, shadowMap: 1024, ao: 'still', bloom: false, samples: 8, softShadows: false, physical: false, fixtures: 4 },
  balanced: { dprCap: 1.25, shadowMap: 2048, ao: 'half', bloom: true, samples: 16, softShadows: true, physical: true, fixtures: 8 },
  high: { dprCap: 2, shadowMap: 4096, ao: 'full', bloom: true, samples: 32, softShadows: true, physical: true, fixtures: 12 },
};
export const TIER_LABELS: Record<Tier, string> = { fast: 'Fast', balanced: 'Balanced', high: 'High' };

/** Moving frames slower than this on average (ms) step Auto down a tier. */
export const SLOW_MS = 28;
/** Moving frames averaged before deciding. */
const SLOW_WINDOW = 40;
/** Jittered samples averaged before the still image replaces the last moving frame. */
const SHOW_AFTER = 4;
/**
 * The key light's apparent radius while still (radians, ~3.4°): shadows soften with distance from
 * what casts them, like under a softbox, and stay crisp where things touch the floor.
 */
export const SOFT_SHADOW_ANGLE = 0.06;
const QUALITY_KEY = 'new-modeler.present.quality';

// ── Pure helpers ─────────────────────────────────────────────────────────

/** The tier a GPU gets on Auto, from its renderer string: software → Fast, integrated → Balanced. */
export function pickTier(gpu: string): Tier {
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu)) return 'fast';
  if (/intel|uhd|iris|mali|adreno|powervr|videocore/i.test(gpu)) return 'balanced';
  return 'high';
}

/** The next tier down (null below Fast). */
export const lowerTier = (t: Tier): Tier | null => (t === 'high' ? 'balanced' : t === 'balanced' ? 'fast' : null);

/** The radical inverse of `index` in `base` (Halton sequence), in [0, 1). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

/** Sample k's sub-pixel offset (pixels, each in [-0.5, 0.5)): Halton(2, 3). */
export const jitter = (k: number): [number, number] => [halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5];

/** How much sample n (0-based) weighs into the running average: mix(history, current, 1/(n+1)). */
export const accumulationWeight = (n: number): number => 1 / (n + 1);

/** Sample k of n spread evenly over the unit disk (a Vogel spiral). */
export function diskSample(k: number, n: number): [number, number] {
  const r = Math.sqrt((k + 0.5) / n);
  const a = k * 2.399963229728653; // the golden angle
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * Tilts every shadow-casting directional light by a disk sample (radius `angle`, radians) around its
 * target; returns a function putting them back. Averaging samples taken this way gives area-light
 * soft shadows.
 */
function jitterLights(scene: THREE.Scene, sample: [number, number], angle: number): () => void {
  const moved: [THREE.DirectionalLight, THREE.Vector3][] = [];
  const t = Math.tan(angle);
  scene.traverse((o) => {
    const light = o as THREE.DirectionalLight;
    if (!light.isDirectionalLight || !light.castShadow) return;
    const target = light.target.position;
    const d = light.position.clone().sub(target);
    const dist = d.length();
    d.normalize();
    const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(d, u);
    moved.push([light, light.position.clone()]);
    d.addScaledVector(u, sample[0] * t).addScaledVector(v, sample[1] * t).normalize();
    light.position.copy(target).addScaledVector(d, dist);
  });
  return () => {
    for (const [light, p] of moved) light.position.copy(p);
  };
}

/** A saved image's size: about twice the view, its longer side at most min(4096, the GPU's limit). */
export function stillSize(width: number, height: number, maxTexture: number, scale = 2): [number, number] {
  const cap = Math.min(4096, maxTexture);
  const k = Math.min(scale, cap / Math.max(width, height, 1));
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

/** Watches moving frames: true once the last `window` of them average slower than `limit` ms. */
export function slowWatch(limit = SLOW_MS, window = SLOW_WINDOW) {
  let times: number[] = [];
  return {
    add(ms: number): boolean {
      times.push(ms);
      if (times.length > window) times.shift();
      return times.length === window && times.reduce((a, b) => a + b, 0) / window > limit;
    },
    reset() {
      times = [];
    },
  };
}

/** three's Neutral tone mapping (Khronos PBR Neutral), linear in → linear out (0…1). */
export function neutral(c: V3, exposure = 1): V3 {
  let [r, g, b] = c.map((v) => v * exposure) as V3;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  [r, g, b] = [r - offset, g - offset, b - offset];
  const peak = Math.max(r, g, b);
  const start = 0.8 - 0.04;
  if (peak < start) return [r, g, b];
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  const k = newPeak / peak;
  [r, g, b] = [r * k, g * k, b * k];
  const desat = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return [r + (newPeak - r) * desat, g + (newPeak - g) * desat, b + (newPeak - b) * desat];
}

/** The linear color that tone-maps (Neutral, at this exposure) to `target`: a background that shows exactly as picked. */
export function untoneMapped(target: V3, exposure = 1): V3 {
  let c: V3 = [...target];
  for (let i = 0; i < 40; i++) {
    const out = neutral(c, exposure);
    c = c.map((v, k) => Math.max(0, v + (target[k]! - out[k]!))) as V3;
  }
  return c;
}

/** The quality the user picked last (Auto when none, or storage is unavailable). */
export function savedQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    return q === 'fast' || q === 'balanced' || q === 'high' ? q : 'auto';
  } catch {
    return 'auto';
  }
}

function saveQuality(q: Quality): void {
  try {
    if (q === 'auto') localStorage.removeItem(QUALITY_KEY);
    else localStorage.setItem(QUALITY_KEY, q);
  } catch {
    // storage unavailable: the choice lasts this session
  }
}

/** The GPU's name, as the browser reports it. */
export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    return '';
  }
}

// ── Passes ───────────────────────────────────────────────────────────────

/** GTAO, in inches, optionally at reduced resolution, skipping glass, glows, the sky and cut-away walls. */
class AOPass extends GTAOPass {
  /** Resolution relative to the frame (half on Fast and Balanced). */
  scale = 1;

  constructor(scene: THREE.Scene, camera: THREE.Camera, scale: number) {
    super(scene, camera, 1, 1);
    this.scale = scale;
    this.blendIntensity = 1;
    this.updateGtaoMaterial({ radius: 12, thickness: 36, distanceExponent: 1, distanceFallOff: 1, scale: 1, samples: scale < 1 ? 12 : 16 });
    this.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: scale < 1 ? 4 : 8, rings: 2, samples: 16 });
    // GTAO's noise is fixed per pixel; shifted per still sample, its grain averages away.
    for (const m of [this.gtaoMaterial, this.pdMaterial]) {
      m.uniforms.noiseShift = { value: new THREE.Vector2() };
      m.fragmentShader = m.fragmentShader
        .replace('uniform sampler2D tNoise;', 'uniform sampler2D tNoise;\nuniform vec2 noiseShift;')
        .replace('vec2 noiseUv = vUv * resolution / noiseResolution;', 'vec2 noiseUv = vUv * resolution / noiseResolution + noiseShift;');
    }
  }

  /** Which still sample this is (its noise shifted), or -1 for a moving frame. */
  setSample(k: number): void {
    const shift = k < 0 ? [0, 0] : [halton(k + 1, 5), halton(k + 1, 7)];
    for (const m of [this.gtaoMaterial, this.pdMaterial]) (m.uniforms.noiseShift!.value as THREE.Vector2).set(shift[0]!, shift[1]!);
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  /** Called by GTAOPass around its normal/depth render. */
  _overrideVisibility(): void {
    (GTAOPass.prototype as unknown as { _overrideVisibility(this: GTAOPass): void })._overrideVisibility.call(this);
    const cache = (this as unknown as { _visibilityCache: THREE.Object3D[] })._visibilityCache;
    this.scene.traverse((o) => {
      if (o.visible && (o.userData.noAO || o.userData.cutaway)) {
        o.visible = false;
        cache.push(o);
      }
    });
  }
}

const BlendShader = {
  uniforms: { tCurrent: { value: null as THREE.Texture | null }, tHistory: { value: null as THREE.Texture | null }, weight: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform float weight;
    varying vec2 vUv;
    void main() { gl_FragColor = mix(texture2D(tHistory, vUv), texture2D(tCurrent, vUv), weight); }`,
};

/** The running average of jittered frames: mix(history, current, weight); drawn out when `show`. */
class AccumulatePass extends Pass {
  weight = 1;
  show = true;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private latest = 0;
  private blend = new THREE.ShaderMaterial({ ...BlendShader, uniforms: THREE.UniformsUtils.clone(BlendShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  private copy = new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  private quad = new FullScreenQuad();

  constructor(width = 1, height = 1) {
    super();
    const rt = () => new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.targets = [rt(), rt()];
  }

  /** The average so far. */
  get result(): THREE.Texture {
    return this.targets[this.latest]!.texture;
  }

  override setSize(width: number, height: number): void {
    for (const t of this.targets) t.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const prev = this.targets[this.latest]!;
    const next = this.targets[1 - this.latest]!;
    this.blend.uniforms.tCurrent!.value = readBuffer.texture;
    this.blend.uniforms.tHistory!.value = prev.texture;
    this.blend.uniforms.weight!.value = this.weight;
    renderer.setRenderTarget(next);
    this.quad.material = this.blend;
    this.quad.render(renderer);
    this.latest = 1 - this.latest;
    if (!this.show) return;
    this.copy.uniforms.tDiffuse!.value = next.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.copy;
    this.quad.render(renderer);
  }

  override dispose(): void {
    for (const t of this.targets) t.dispose();
    this.blend.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}

// ── The pipeline ─────────────────────────────────────────────────────────

export interface Pipeline {
  readonly tier: Tier;
  readonly quality: Quality;
  /** Draws a frame if anything changed, or one more still sample; else nothing. */
  frame(dt: number): void;
  /** Something in the scene changed (the camera is watched on its own); `shadows` re-renders shadow maps. */
  invalidate(o?: { shadows?: boolean }): void;
  /** The view's size in CSS pixels, and the device pixel ratio (capped per tier). */
  setSize(width: number, height: number, dpr: number): void;
  setQuality(q: Quality): void;
  /** Bloom strength (0 = off; the studio has none). */
  setBloom(strength: number): void;
  /** Where ambient occlusion applies (the model and the floor under it), inches. */
  setBounds(min: V3, max: V3): void;
  /** A PNG of the current view at this size, averaged over `samples` jittered frames. */
  still(o: { width: number; height: number; samples: number }): Promise<Blob>;
  /**
   * The still image being accumulated (display-ready: tone-mapped and encoded), or null while the view
   * moves; the photo fades from it.
   */
  readonly image: THREE.Texture | null;
  /** Frees everything and puts the renderer's settings back. */
  dispose(): void;
  /** The passes, for the dev console. */
  readonly debug: { composer: EffectComposer; ao: GTAOPass; bloom: UnrealBloomPass; smaa: SMAAPass };
}

export interface PipelineOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  dpr: number;
  quality?: Quality;
  /** The tier changed (or was picked): materials, texture sizes. */
  onTier?(tier: Tier, spec: TierSpec): void;
}

export function createPipeline(o: PipelineOptions): Pipeline {
  const { renderer, scene, camera } = o;
  const saved = {
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    pixelRatio: renderer.getPixelRatio(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    shadow: { enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type, autoUpdate: renderer.shadowMap.autoUpdate },
  };
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const auto = pickTier(gpuName(renderer));
  let quality: Quality = o.quality ?? 'auto';
  let tier: Tier = quality === 'auto' ? auto : quality;
  let spec = TIERS[tier];
  let size = { width: o.width, height: o.height, dpr: o.dpr };

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const renderPass = new RenderPass(scene, camera);
  const ao = new AOPass(scene, camera, spec.ao === 'full' ? 1 : 0.5);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.4, 1.0);
  const output = new OutputPass();
  const smaa = new SMAAPass();
  const accumulate = new AccumulatePass();
  for (const p of [renderPass, ao, bloom, output, smaa, accumulate]) composer.addPass(p);
  let bloomStrength = 0;
  let bounds: THREE.Box3 | null = null;

  let version = 0;
  let drawnVersion = -1;
  let lastSig = '';
  let samples = 0;
  let wasMoving = false;
  /** The shadow maps hold a jittered light (a still sample): redraw them for the next moving frame. */
  let shadowsJittered = false;
  let busy = false;
  let disposed = false;
  const slow = slowWatch();

  const signature = () => {
    camera.updateMatrixWorld();
    return `${camera.matrixWorld.elements.join()}|${camera.fov}|${camera.aspect}|${camera.near}|${camera.far}|${camera.zoom}`;
  };

  const applySize = () => {
    const pr = Math.min(size.dpr, spec.dprCap);
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
    composer.setSize(size.width, size.height);
    bloom.resolution.set(size.width * pr, size.height * pr);
  };

  const applyTier = () => {
    spec = TIERS[tier];
    ao.scale = spec.ao === 'full' ? 1 : 0.5;
    ao.updateGtaoMaterial({ samples: ao.scale < 1 ? 12 : 16 });
    ao.updatePdMaterial({ radius: ao.scale < 1 ? 4 : 8 });
    applySize();
    scene.traverse((obj) => {
      const light = obj as THREE.DirectionalLight;
      if (!light.isLight || !light.castShadow || !light.shadow) return;
      if (light.shadow.mapSize.x === spec.shadowMap) return;
      light.shadow.mapSize.set(spec.shadowMap, spec.shadowMap);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    });
    slow.reset();
    o.onTier?.(tier, spec);
    invalidate({ shadows: true });
  };

  function invalidate(opts?: { shadows?: boolean }) {
    version++;
    if (opts?.shadows) renderer.shadowMap.needsUpdate = true;
  }

  const configure = (moving: boolean) => {
    smaa.enabled = moving;
    accumulate.enabled = !moving;
    ao.enabled = !moving || spec.ao !== 'still';
    bloom.enabled = spec.bloom && bloomStrength > 0;
    bloom.strength = bloomStrength;
  };

  applyTier();

  return {
    debug: { composer, ao, bloom, smaa },
    get tier() {
      return tier;
    },
    get quality() {
      return quality;
    },
    get image() {
      return !wasMoving && samples >= Math.min(SHOW_AFTER, spec.samples) ? accumulate.result : null;
    },
    frame(dt) {
      if (busy) return;
      const sig = signature();
      if (sig !== lastSig || version !== drawnVersion) {
        // Moving: one frame, as is, smoothed by SMAA. On Auto, slow motion steps the tier down.
        if (wasMoving && quality === 'auto' && slow.add(dt * 1000)) {
          const down = lowerTier(tier);
          if (down) {
            tier = down;
            applyTier();
            console.info(`presentation: quality stepped down to ${TIER_LABELS[tier]} (moving frames over ${SLOW_MS} ms)`);
          }
        }
        wasMoving = true;
        if (shadowsJittered) {
          renderer.shadowMap.needsUpdate = true;
          shadowsJittered = false;
        }
        lastSig = sig;
        drawnVersion = version;
        samples = 0;
        configure(true);
        ao.setSample(-1);
        composer.render(dt);
        return;
      }
      wasMoving = false;
      if (samples >= spec.samples) return; // converged: the canvas keeps the last image
      configure(false);
      const pr = renderer.getPixelRatio();
      const [w, h] = [Math.round(size.width * pr), Math.round(size.height * pr)];
      const [jx, jy] = jitter(samples);
      camera.setViewOffset(w, h, jx, jy, w, h);
      const restore = spec.softShadows ? jitterLights(scene, diskSample(samples, spec.samples), SOFT_SHADOW_ANGLE) : null;
      if (restore) renderer.shadowMap.needsUpdate = shadowsJittered = true;
      ao.setSample(samples);
      accumulate.weight = accumulationWeight(samples);
      accumulate.show = samples + 1 >= Math.min(SHOW_AFTER, spec.samples);
      composer.render(dt);
      restore?.();
      camera.clearViewOffset();
      samples++;
    },
    invalidate,
    setSize(width, height, dpr) {
      size = { width, height, dpr };
      applySize();
      invalidate();
    },
    setQuality(q) {
      quality = q;
      saveQuality(q);
      const next = q === 'auto' ? auto : q;
      if (next !== tier) {
        tier = next;
        applyTier();
      } else invalidate();
    },
    setBloom(strength) {
      bloomStrength = strength;
      invalidate();
    },
    setBounds(min, max) {
      bounds = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
      ao.setSceneClipBox(bounds);
      invalidate();
    },
    async still({ width, height, samples: count }) {
      busy = true;
      const cam = camera.clone();
      cam.aspect = width / height;
      cam.clearViewOffset();
      const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
      const comp = new EffectComposer(renderer, target);
      comp.renderToScreen = false;
      comp.setPixelRatio(1);
      comp.setSize(width, height);
      const stillAO = new AOPass(scene, cam, 1);
      if (bounds) stillAO.setSceneClipBox(bounds);
      const stillBloom = spec.bloom && bloomStrength > 0 ? new UnrealBloomPass(new THREE.Vector2(width, height), bloomStrength, 0.4, 1.0) : null;
      const stillOutput = new OutputPass();
      const acc = new AccumulatePass(width, height);
      acc.show = false;
      for (const p of [new RenderPass(scene, cam), stillAO, ...(stillBloom ? [stillBloom] : []), stillOutput, acc]) comp.addPass(p);
      const bytes = new THREE.WebGLRenderTarget(width, height);
      const copy = new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
      const quad = new FullScreenQuad(copy);
      try {
        let breath = performance.now();
        for (let k = 0; k < count; k++) {
          if (disposed) throw new Error('the presentation ended');
          const [jx, jy] = jitter(k);
          cam.setViewOffset(width, height, jx, jy, width, height);
          const restore = jitterLights(scene, diskSample(k, count), SOFT_SHADOW_ANGLE);
          renderer.shadowMap.needsUpdate = shadowsJittered = true;
          stillAO.setSample(k);
          acc.weight = accumulationWeight(k);
          comp.render(0);
          restore();
          // Let the page breathe between samples.
          if (performance.now() - breath > 40) {
            await new Promise((r) => setTimeout(r, 0));
            breath = performance.now();
          }
        }
        copy.uniforms.tDiffuse!.value = acc.result;
        const before = renderer.getRenderTarget();
        renderer.setRenderTarget(bytes);
        quad.render(renderer);
        const px = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(bytes, 0, 0, width, height, px);
        renderer.setRenderTarget(before);
        // GL rows run bottom-up.
        const img = new ImageData(width, height);
        const row = width * 4;
        for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        const canvas = Object.assign(document.createElement('canvas'), { width, height });
        canvas.getContext('2d')!.putImageData(img, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't encode the image"))), 'image/png'));
      } finally {
        for (const p of comp.passes) p.dispose();
        comp.dispose();
        bytes.dispose();
        copy.dispose();
        quad.dispose();
        busy = false;
        // The view redraws (its shadows unjittered) and settles again.
        invalidate({ shadows: true });
      }
    },
    dispose() {
      disposed = true;
      for (const p of composer.passes) p.dispose();
      composer.dispose();
      camera.clearViewOffset();
      renderer.toneMapping = saved.toneMapping;
      renderer.toneMappingExposure = saved.exposure;
      if (renderer.getPixelRatio() !== saved.pixelRatio) renderer.setPixelRatio(saved.pixelRatio);
      renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      Object.assign(renderer.shadowMap, saved.shadow);
    },
  };
}
