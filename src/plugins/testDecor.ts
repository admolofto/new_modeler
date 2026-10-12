import { z } from 'zod';
import type { V3 } from '../geometry/types';
import { registerGenerator, registerShape, shapes, type GenFace, type GenFaceDrive } from './registry';
import type { BoxParams } from './shapes/box';

/**
 * Decor fixtures shared by the tests (the real decor shapes come with hardware, the room and props).
 * Importing this registers them, once: box-shaped decor with surfaces by tag, and a small room
 * generator (surroundings, locked parts, a door that swings past its casing, an action).
 */

const Box = z.object({ x: z.int().positive(), y: z.int().positive(), z: z.int().positive() });
const box = {
  version: 1,
  schema: Box,
  describe: 'test only',
  build: (p: BoxParams) => shapes.get('box').build(p),
  handles: (p: BoxParams) => shapes.get('box').handles(p),
};

export interface TestRoomParams {
  width: number;
  depth: number;
  height: number;
  windows: number;
}

if (!shapes.has('testStool')) {
  /** Exact tag, longest prefix, then base: face:top is leather, face:front glass, the other faces brass. */
  registerShape<BoxParams>({
    ...box,
    type: 'testStool',
    decor: { category: 'furniture', label: 'Test stool', defaults: { x: 960, y: 1920, z: 960 } },
    surfaces: () => ({
      base: { finish: { preset: 'metal:matte-black' } },
      tags: { 'face:top': { finish: { preset: 'fabric:leather' } } },
      prefixes: [
        ['face:', { finish: { preset: 'metal:brass' } }],
        ['face:fr', { finish: { preset: 'glass:clear' } }],
      ],
    }),
  });
  /** Two surfaces (a brass body, a frosted top), and a light at the middle of its top shining down. */
  registerShape<BoxParams>({
    ...box,
    type: 'testLamp',
    decor: { category: 'lighting', label: 'Test lamp' },
    surfaces: () => ({ base: { finish: { preset: 'metal:brass' } }, tags: { 'face:top': { finish: { preset: 'glass:frosted' }, glow: { kelvin: 2700, strength: 1 } } } }),
    lights: (p) => [{ kind: 'spot', at: [p.x / 2, p.y, p.z / 2] as V3, dir: [0, -1, 0] as V3, lumens: 800, kelvin: 2700, beam: 60, glow: 'face:top' }],
  });
  registerShape<BoxParams>({
    ...box,
    type: 'testRug',
    decor: { category: 'furniture', label: 'Test rug', solid: false },
    surfaces: () => ({ base: { finish: { preset: 'fabric:wool', color: '#7a3b2e' } } }),
  });
  registerShape<BoxParams>({
    ...box,
    type: 'testWall',
    decor: { category: 'room', label: 'Test wall', internal: true },
    surfaces: () => ({ base: { finish: { preset: 'paint', color: '#ece8df' } } }),
  });

  /**
   * A room: a back wall behind z = 0, and a doorway in a folder at the front with a leaf that swings
   * out past its casing. The back wall's front face drives `depth` (a position); everything else is locked.
   */
  registerGenerator<TestRoomParams>({
    type: 'testRoom',
    version: 1,
    schema: z.object({ width: z.int().positive(), depth: z.int().positive(), height: z.int().positive(), windows: z.int().nonnegative().default(0) }),
    describe: 'test only',
    surroundings: true,
    collapse: true,
    lockedParts: true,
    generate: (p) => ({
      groups: [{ role: 'door', name: 'Door', position: [Math.round(p.width / 2), 0, p.depth] }],
      parts: [
        { role: 'wall-back', name: 'Back wall', grain: 'none', position: [0, 0, -256], shape: { type: 'testWall', params: { x: p.width, y: p.height, z: 256 } } },
        { role: 'floor', name: 'Floor', grain: 'x', position: [0, -64, 0], unclickable: true, shape: { type: 'testRug', params: { x: p.width, y: 64, z: p.depth } } },
        { role: 'door-leaf', name: 'Door', grain: 'none', group: 'door', position: [0, 0, 0], shape: { type: 'testWall', params: { x: 768, y: 1280, z: 32 } } },
        { role: 'casing', name: 'Casing', grain: 'none', position: [Math.round(p.width / 2) + 128, 0, p.depth + 64], shape: { type: 'testWall', params: { x: 64, y: 1280, z: 64 } } },
      ],
      joints: [],
      motions: [{ role: 'door', name: 'Door', type: 'hinge', nodes: ['door'], requires: ['door-leaf'], params: { side: 'left' } }],
    }),
    faceDrive: (_p, f: GenFace): GenFaceDrive | null =>
      f.role === 'wall-back' && f.axis === 2 && f.max ? { param: 'depth', label: 'back wall', sign: -1, kind: 'position' } : null,
    actions: (p, ctx) => (ctx.role === 'wall-back' && ctx.handle === 'face:front' && ctx.at ? [{ label: 'Add window here', params: { ...p, windows: p.windows + 1 } }] : []),
    materialRefs: () => [],
  });
}
