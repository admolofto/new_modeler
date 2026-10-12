import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DenoiseMaterial, GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import type { V3 } from '../../geometry/types';
import { denoiseSigma, envAt, MATCH_AT, matchGain, nextTilesPerFrame, PHOTO_BOUNCES, PHOTO_TRANSMISSIVE_BOUNCES, photoProgress, photoTiles, type PhotoEnv, type PhotoFloor, type PhotoProgress, type Softbox } from './photoPlan';
import { buildPhotoScene, type PhotoScene } from './photoScene';

/**
 * Path-traced photo stills (B8; a lazy chunk, loaded by the presentation session on first use).
 *
 * A small adapter around three-gpu-pathtracer's `WebGLPathTracer` — deprecated upstream in favor of
 * its WebGPU tracer, so nothing outside this file touches the library. One path tracer per session:
 * its shader (a long compile, more so on ANGLE) is built once and reused by every photo.
 *
 * A photo renders the scene as it is drawn now (a stand-in scene, `photoScene.ts`: the lighting
 * preset, what the view hides, the cutaway) from the camera as it stands, frozen. The path tracer
 * draws into its own float target a tile at a time (tiles sized to the photo, so no single GPU job
 * runs long), as many tiles per frame as keep frames quick. Once a whole sample is in, it shows: tone
 * mapped (Neutral, the preset's exposure) into an 8-bit target, lightly denoised while grainy, and
 * cross-faded over the raster image. `saveBlob()` reads that target back as a PNG.
 *
 * A room lit only through its windows comes out darker and bluer than the presentation's tuned look,
 * so as samples arrive (`MATCH_AT`) the photo's exposure and white balance are matched to the live
 * view's average color (`matchGain`): it reads as the same room, rendered better.
 */

export type PhotoState = 'idle' | 'preparing' | 'rendering' | 'done';

/** What the session hands over about the scene as it is drawn now. */
export interface PhotoSceneSpec {
  live: THREE.Scene;
  skip: ReadonlySet<THREE.Object3D>;
  isCut(o: THREE.Object3D): boolean;
  env: PhotoEnv;
  /** A color (the studio's backdrop) or the environment itself (the sky). */
  background: THREE.Color | 'env';
  floor: PhotoFloor | null;
  softboxes: readonly Softbox[];
}

export interface PhotoStart {
  /** The view (copied: the photo keeps this pose). */
  camera: THREE.PerspectiveCamera;
  /** The scene as drawn now (called when the stand-in is (re)built). */
  scene(): PhotoSceneSpec;
  /** Changes whenever the scene does; the same version as the last photo reuses its stand-in. */
  version: number;
  /** Samples to stop at. */
  target: number;
  /** The photo's size (pixels). */
  size: [number, number];
  /** The raster image now on screen (display-ready), to fade from; null fades from nothing. */
  raster(): THREE.Texture | null;
}

export interface Photo {
  readonly state: PhotoState;
  readonly progress: PhotoProgress;
  /** Whether the photo is on screen (the raster pipeline needn't draw). */
  readonly showing: boolean;
  /** Starts a photo (a running one is replaced). */
  start(o: PhotoStart): void;
  /** A new target: rendering resumes past a finished one, or stops at a lower one. */
  setTarget(samples: number): void;
  /** Things moved (a door finishing its swing): the stand-in is rebuilt and sampling starts over. */
  sceneChanged(): void;
  /** Samples and draws; call every frame. */
  frame(dt: number): void;
  /** Stops; the raster view takes over again. */
  cancel(): void;
  /** The photo so far as a PNG. */
  saveBlob(): Promise<Blob>;
  dispose(): void;
  /** For the dev console: the path tracer, the stand-in and the tiles per frame. */
  readonly debug: { pathTracer: WebGLPathTracer; readonly standIn: PhotoScene | null; readonly tilesPerFrame: number; readonly samplesPerSecond: number; readonly match: { gain: V3; live: V3 | null; rounds: number } };
}

export interface PhotoOptions {
  /** The photo failed (the shader didn't compile, the BVH build threw, the GPU went away). */
  onError(err: Error): void;
}

/** The fade from the raster image to the photo (seconds). */
const FADE_SECONDS = 0.4;
/** The environment's equirect size (it's a smooth gradient). */
const ENV_SIZE = 128;

const DisplayShader = {
  uniforms: { tRaster: { value: null as THREE.Texture | null }, tPhoto: { value: null as THREE.Texture | null }, fade: { value: 0 }, hasRaster: { value: false } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tRaster;
    uniform sampler2D tPhoto;
    uniform float fade;
    uniform bool hasRaster;
    varying vec2 vUv;
    void main() {
      vec4 photo = texture2D(tPhoto, vUv);
      gl_FragColor = hasRaster ? mix(texture2D(tRaster, vUv), photo, fade) : photo;
      gl_FragColor.a = 1.0;
    }`,
};

/** Tone mapping as three's Neutral (Khronos PBR Neutral), with per-channel gains, to sRGB bytes. */
const DevelopShader = {
  uniforms: { tHDR: { value: null as THREE.Texture | null }, gain: { value: new THREE.Vector3(1, 1, 1) }, exposure: { value: 1 } },
  vertexShader: DisplayShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tHDR;
    uniform vec3 gain;
    uniform float exposure;
    varying vec2 vUv;
    vec3 neutral(vec3 color) {
      const float StartCompression = 0.8 - 0.04;
      const float Desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < StartCompression) return color;
      float d = 1. - StartCompression;
      float newPeak = 1. - d * d / (peak + d - StartCompression);
      color *= newPeak / peak;
      float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);
      return mix(color, vec3(newPeak), g);
    }
    vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
    void main() {
      vec3 c = max(texture2D(tHDR, vUv).rgb, 0.0) * gain * exposure;
      gl_FragColor = vec4(srgb(clamp(neutral(c), 0.0, 1.0)), 1.0);
    }`,
};

/** The average of a region per output pixel (8 x 8 taps): an image's mean color from a tiny target. */
const MeanShader = {
  uniforms: { tSrc: { value: null as THREE.Texture | null }, cells: { value: new THREE.Vector2(16, 9) } },
  vertexShader: DisplayShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 cells;
    varying vec2 vUv;
    void main() {
      vec3 sum = vec3(0.0);
      for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
        vec2 o = (vec2(float(i), float(j)) + 0.5) / 8.0 - 0.5;
        sum += texture2D(tSrc, vUv + o / cells).rgb;
      }
      gl_FragColor = vec4(sum / 64.0, 1.0);
    }`,
};
const MEAN_W = 16;
const MEAN_H = 9;

const ldrTarget = () =>
  new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });

/** An equirect gradient sky (zenith, horizon, ground) for the path tracer's environment. */
function envTexture(env: PhotoEnv): GradientEquirectTexture {
  const tex = new GradientEquirectTexture(ENV_SIZE);
  const dir = new THREE.Vector3();
  tex.generationCallback = (polar, _uv, _coord, color) => {
    dir.setFromSpherical(polar);
    color.setRGB(...envAt(env, dir.y), THREE.LinearSRGBColorSpace);
  };
  tex.update();
  return tex;
}

export function createPhoto(renderer: THREE.WebGLRenderer, o: PhotoOptions): Photo {
  const pt = new WebGLPathTracer(renderer);
  pt.renderToCanvas = false;
  pt.rasterizeScene = false;
  pt.dynamicLowRes = false;
  pt.renderDelay = 0;
  pt.minSamples = 1;
  pt.fadeDuration = 0;
  pt.bounces = PHOTO_BOUNCES;
  pt.transmissiveBounces = PHOTO_TRANSMISSIVE_BOUNCES;
  pt.filterGlossyFactor = 0.5;
  pt.multipleImportanceSampling = true;
  pt.synchronizeRenderSize = true;

  let worker: GenerateMeshBVHWorker | null = null;
  try {
    worker = new GenerateMeshBVHWorker();
    pt.setBVHWorker(worker);
  } catch (err) {
    console.warn('photo: building the BVH on the main thread', err);
  }

  const developMat = new THREE.ShaderMaterial({ ...DevelopShader, uniforms: THREE.UniformsUtils.clone(DevelopShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const developQuad = new FullScreenQuad(developMat);
  const meanMat = new THREE.ShaderMaterial({ ...MeanShader, uniforms: THREE.UniformsUtils.clone(MeanShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const meanQuad = new FullScreenQuad(meanMat);
  const meanTarget = new THREE.WebGLRenderTarget(MEAN_W, MEAN_H, { type: THREE.UnsignedByteType, depthBuffer: false });
  const ldr = ldrTarget();
  const denoised = ldrTarget();
  const denoise = new DenoiseMaterial({ sigma: 2, kSigma: 1.5, threshold: 0.05 });
  denoise.toneMapped = false;
  const denoiseQuad = new FullScreenQuad(denoise);
  const display = new THREE.ShaderMaterial({ ...DisplayShader, uniforms: THREE.UniformsUtils.clone(DisplayShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const displayQuad = new FullScreenQuad(display);

  let state: PhotoState = 'idle';
  let job: PhotoStart | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let standIn: PhotoScene | null = null;
  let builtVersion = -1;
  let env: { key: string; texture: GradientEquirectTexture } | null = null;
  /** Bumped by start/cancel/sceneChanged: a BVH build that finishes for an older one is ignored. */
  let generation = 0;
  let building = false;
  let rebuild = false;
  let target = 64;
  let tilesPerFrame = 1;
  let startedAt = 0;
  /** When the first sample began (after the compile), and the samples then. */
  let samplingFrom = 0;
  let shownAt = 0;
  let lastDrawnSamples = -1;
  let fade = 0;
  /** The shown image (denoised or not). */
  let shown: THREE.WebGLRenderTarget = ldr;
  let disposed = false;
  /** Matching the live view: the gains now, the live view's mean color, the rounds done, one in flight. */
  let gain: V3 = [1, 1, 1];
  let liveMean: V3 | null = null;
  let matched = 0;
  let measuring = false;
  /** The gains changed: develop again even without new samples. */
  let redevelop = false;

  const samples = () => (state === 'idle' ? 0 : pt.samples);
  /** The shader is compiling (in parallel; sampling waits). Untyped upstream. */
  const compiling = () => (pt as unknown as { isCompiling: boolean }).isCompiling;
  const fail = (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    stop();
    o.onError(e);
  };

  function stop() {
    generation++;
    state = 'idle';
    job = null;
    rebuild = false;
    fade = 0;
    lastDrawnSamples = -1;
    pt.reset();
  }

  /** The environment for the scene's sky (made again only when it changes). */
  const envFor = (spec: PhotoEnv) => {
    const key = JSON.stringify(spec);
    if (env?.key !== key) {
      env?.texture.dispose();
      env = { key, texture: envTexture(spec) };
    }
    return env.texture;
  };

  /** (Re)builds the stand-in scene and hands it to the path tracer (the BVH in a worker when it can). */
  async function build() {
    if (!job || !camera) return;
    building = true;
    rebuild = false;
    const gen = generation;
    try {
      const spec = job.scene();
      const environment = envFor(spec.env);
      standIn?.dispose();
      standIn = buildPhotoScene({ ...spec, environment, background: spec.background === 'env' ? environment : spec.background });
      if (worker) await pt.setSceneAsync(standIn.scene, camera);
      else pt.setScene(standIn.scene, camera);
      if (gen !== generation || disposed) return;
      builtVersion = job.version;
      pt.reset();
    } catch (err) {
      if (gen === generation && !disposed) fail(err);
    } finally {
      building = false;
    }
  }

  /** Tone-maps the samples so far into the shown target (denoised while grainy). */
  function develop() {
    const before = renderer.getRenderTarget();
    const [w, h] = [pt.target.width, pt.target.height];
    if (ldr.width !== w || ldr.height !== h) {
      ldr.setSize(w, h);
      denoised.setSize(w, h);
    }
    developMat.uniforms.tHDR!.value = pt.target.texture;
    (developMat.uniforms.gain!.value as THREE.Vector3).set(...gain);
    developMat.uniforms.exposure!.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(ldr);
    developQuad.render(renderer);
    const sigma = denoiseSigma(pt.samples);
    if (sigma > 0) {
      denoise.map = ldr.texture;
      denoise.sigma = sigma;
      renderer.setRenderTarget(denoised);
      denoiseQuad.render(renderer);
      shown = denoised;
    } else shown = ldr;
    renderer.setRenderTarget(before);
  }

  /** An image's mean display color (bytes), from a tiny averaged copy read back. */
  async function meanOf(texture: THREE.Texture): Promise<V3> {
    const before = renderer.getRenderTarget();
    meanMat.uniforms.tSrc!.value = texture;
    renderer.setRenderTarget(meanTarget);
    meanQuad.render(renderer);
    renderer.setRenderTarget(before);
    const px = new Uint8Array(MEAN_W * MEAN_H * 4);
    await renderer.readRenderTargetPixelsAsync(meanTarget, 0, 0, MEAN_W, MEAN_H, px);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]!;
      g += px[i + 1]!;
      b += px[i + 2]!;
    }
    const n = MEAN_W * MEAN_H;
    return [r / n, g / n, b / n];
  }
  /** One round of matching the live view: measure the photo as shown, move the gains, show it again. */
  async function match() {
    if (measuring) return;
    // The live view's settled image (the raster keeps converging until the photo shows).
    const live = liveMean ? null : (job?.raster() ?? null);
    if (!liveMean && !live) return;
    measuring = true;
    const gen = generation;
    try {
      const target = liveMean ?? (liveMean = await meanOf(live!));
      if (gen !== generation || disposed) return;
      const photo = await meanOf(shown.texture);
      if (gen !== generation || disposed) return;
      gain = matchGain(gain, photo, target);
      matched++;
      redevelop = true;
    } catch (err) {
      console.warn('photo: matching the live view failed', err);
      matched = MATCH_AT.length;
    } finally {
      measuring = false;
    }
  }

  /** The photo on screen, faded in over the raster image. */
  function present() {
    const raster = job?.raster() ?? null;
    display.uniforms.tPhoto!.value = shown.texture;
    display.uniforms.tRaster!.value = raster;
    display.uniforms.hasRaster!.value = !!raster;
    display.uniforms.fade!.value = fade;
    renderer.setRenderTarget(null);
    displayQuad.render(renderer);
  }

  const shaderErrors = () => {
    const debug = renderer.debug;
    const prev = debug.onShaderError;
    let failed = false;
    debug.onShaderError = (gl, program, vs, fs) => {
      failed = true;
      if (prev) prev(gl, program, vs, fs);
      else console.error('photo: the path tracer shader failed', gl.getProgramInfoLog(program), gl.getShaderInfoLog(fs));
    };
    return () => {
      debug.onShaderError = prev;
      return failed;
    };
  };
  let watchShaders: (() => boolean) | null = null;
  /** The shader has compiled and drawn once (later photos reuse it). */
  let compiled = false;

  return {
    get state() {
      return state;
    },
    get progress() {
      const now = performance.now();
      return photoProgress(samples(), target, state === 'idle' ? 0 : now - startedAt, samplingFrom ? now - samplingFrom : 0);
    },
    get showing() {
      return state !== 'idle' && lastDrawnSamples >= 1;
    },
    debug: {
      pathTracer: pt,
      get standIn() {
        return standIn;
      },
      get tilesPerFrame() {
        return tilesPerFrame;
      },
      get samplesPerSecond() {
        return samplingFrom && pt.samples > 0 ? pt.samples / ((performance.now() - samplingFrom) / 1000) : 0;
      },
      get match() {
        return { gain, live: liveMean, rounds: matched };
      },
    },

    start(s) {
      stop();
      generation++;
      job = s;
      target = s.target;
      camera = s.camera.clone();
      camera.clearViewOffset();
      camera.updateMatrixWorld();
      const [w, h] = s.size;
      const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
      pt.renderScale = w / Math.max(1, buffer.x);
      pt.tiles.set(...photoTiles(w, h));
      tilesPerFrame = 1;
      // The first photo compiles the shader: watch it for errors.
      if (!compiled && !watchShaders) watchShaders = shaderErrors();
      startedAt = performance.now();
      samplingFrom = 0;
      shownAt = 0;
      state = 'preparing';
      // Matched to the live view anew (read once its image has settled; the camera holds still).
      gain = [1, 1, 1];
      liveMean = null;
      matched = 0;
      redevelop = false;
      if (s.version === builtVersion && standIn) {
        // Nothing moved since the last photo: the same scene from (maybe) another pose.
        pt.setCamera(camera);
        pt.reset();
      } else void build();
    },

    setTarget(n) {
      target = n;
      if (state === 'done' && pt.samples < n) state = 'rendering';
      else if (state === 'rendering' && pt.samples >= n) state = 'done';
    },

    sceneChanged() {
      if (state === 'idle') return;
      builtVersion = -1;
      samplingFrom = 0;
      if (building) rebuild = true;
      else {
        generation++;
        void build();
      }
    },

    frame(dt) {
      if (state === 'idle' || disposed) return;
      if (building) return;
      if (rebuild) {
        generation++;
        void build();
        return;
      }
      if (builtVersion !== job?.version) return;
      if (pt.samples < target) {
        const tiles = pt.tiles.x * pt.tiles.y;
        tilesPerFrame = nextTilesPerFrame(tilesPerFrame, dt * 1000, tiles);
        for (let k = 0; k < tilesPerFrame && pt.samples < target; k++) {
          pt.renderSample();
          if (compiling()) break;
          if (!samplingFrom) samplingFrom = performance.now();
        }
        if (compiling()) {
          state = 'preparing';
          return;
        }
        // The shader's errors surface on its first draw, after the (parallel) compile.
        if (watchShaders) {
          const failed = watchShaders();
          watchShaders = null;
          if (failed) return fail(new Error("the path tracer's shader didn't compile"));
        }
        compiled = true;
        state = pt.samples >= target ? 'done' : 'rendering';
      } else state = 'done';
      // Shown once a whole sample is in; drawn again when there's more, or while fading in.
      const whole = Math.floor(pt.samples);
      if (whole < 1) return;
      if (!shownAt) shownAt = performance.now();
      const wasFading = fade < 1;
      fade = job?.raster() ? Math.min(1, (performance.now() - shownAt) / 1000 / FADE_SECONDS) : 1;
      const again = redevelop;
      redevelop = false;
      if (whole !== lastDrawnSamples || again) develop();
      if (whole !== lastDrawnSamples || wasFading || again) present();
      lastDrawnSamples = whole;
      if (matched < MATCH_AT.length && whole >= MATCH_AT[matched]!) void match();
    },

    cancel() {
      if (state === 'idle') return;
      stop();
    },

    async saveBlob() {
      if (state === 'idle' || pt.samples < 1) throw new Error('the photo has no samples yet');
      develop();
      const target = shown;
      const [w, h] = [target.width, target.height];
      const px = new Uint8Array(w * h * 4);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h, px);
      // GL rows run bottom-up.
      const img = new ImageData(w, h);
      const row = w * 4;
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
      canvas.getContext('2d')!.putImageData(img, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't encode the image"))), 'image/png'));
    },

    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      watchShaders?.();
      standIn?.dispose();
      standIn = null;
      env?.texture.dispose();
      pt.dispose();
      worker?.dispose();
      developMat.dispose();
      developQuad.dispose();
      meanMat.dispose();
      meanQuad.dispose();
      meanTarget.dispose();
      ldr.dispose();
      denoised.dispose();
      denoise.dispose();
      denoiseQuad.dispose();
      display.dispose();
      displayQuad.dispose();
    },
  };
}
