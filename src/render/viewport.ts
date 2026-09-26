import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GROUND_INCHES } from '../edit/targets';
import { PALETTE } from './palette';

/**
 * Scene convention: 1 unit = 1 inch, Y up.
 * Model frame: X = width, Y = height, Z = depth (front faces +Z).
 */
export interface Viewport {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Renders now and returns the view as a base64 JPEG, at most `maxWidth` px wide. */
  capture(maxWidth?: number): { mediaType: 'image/jpeg'; data: string };
  /** Model units (1/64") per screen pixel at a world point (scene units are inches). */
  unitsPerPx(p: THREE.Vector3): number;
  /** Runs before every frame is drawn (e.g. to keep a gizmo the same size on screen). */
  onFrame(fn: () => void): void;
  dispose(): void;
}

export function createViewport(container: HTMLElement): Viewport {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.canvas);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
  camera.position.set(70, 55, 90);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(18, 17, 12);
  controls.enableDamping = true;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(60, 100, 80);
  scene.add(sun);

  // 12' floor, 1' squares
  scene.add(new THREE.GridHelper(GROUND_INCHES, GROUND_INCHES / 12, PALETTE.gridMajor, PALETTE.gridMinor));

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const frameHooks: (() => void)[] = [];
  renderer.setAnimationLoop(() => {
    controls.update();
    for (const fn of frameHooks) fn();
    renderer.render(scene, camera);
  });

  return {
    scene,
    camera,
    renderer,
    controls,
    capture(maxWidth = 1280) {
      // Without preserveDrawingBuffer the canvas is only readable right after a render.
      renderer.render(scene, camera);
      const src = renderer.domElement;
      const k = Math.min(1, maxWidth / src.width);
      const out = Object.assign(document.createElement('canvas'), { width: Math.round(src.width * k), height: Math.round(src.height * k) });
      out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
      return { mediaType: 'image/jpeg', data: out.toDataURL('image/jpeg', 0.85).split(',')[1]! };
    },
    unitsPerPx(p) {
      const h = renderer.domElement.getBoundingClientRect().height || 1;
      return ((2 * camera.position.distanceTo(p) * Math.tan((camera.fov * Math.PI) / 360)) / h) * 64;
    },
    onFrame(fn) {
      frameHooks.push(fn);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
