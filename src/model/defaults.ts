import { pluginVersions } from '../plugins';
import { MATERIAL_LIBRARY } from './materialLibrary';
import { applyOps, type Op } from './ops';
import { SCHEMA_VERSION, type Doc, type Material } from './schema';
import { inches } from './units';

/** Actual (not nominal) thicknesses: 3/4" ply is 23/32", 1/2" is 15/32", 1/4" is 7/32". More in the library. */
export function defaultMaterials(): Material[] {
  const ids = ['ply-3-4', 'ply-1-2', 'ply-1-4', 'maple-4-4'];
  return ids.map((id) => structuredClone(MATERIAL_LIBRARY.find((m) => m.id === id)!));
}

export function emptyDoc(): Doc {
  return {
    version: SCHEMA_VERSION,
    pluginVersions: pluginVersions(),
    materials: Object.fromEntries(defaultMaterials().map((m) => [m.id, m])),
    parts: {},
    assemblies: {},
    joints: {},
    annotations: {},
    variables: {},
    roots: [],
  };
}

export const DEFAULT_CARCASS = {
  width: inches(36),
  height: inches(34.5),
  depth: inches(24),
  material: 'ply-3-4',
  back: 'inset',
  backMaterial: 'ply-1-4',
  toeKick: { height: inches(4), depth: inches(3) },
  shelves: 1,
  joinery: 'dado',
} as const;

/**
 * Starter scene: a 36" base cabinet (1" through hole in the right side, shelf-pin rows on both
 * inner faces), a maple tabletop with rounded corners and a roundover on it, and a door beside
 * it with hinge-cup bores and a small roundover around its face.
 */
export function demoDoc(): Doc {
  const W = DEFAULT_CARCASS.width;
  const H = DEFAULT_CARCASS.height;
  const shelfPins: Op[] = [];
  for (const [part, face] of [
    ['a1.side-left', 'face:right'],
    ['a1.side-right', 'face:left'],
  ] as const) {
    for (const z of [inches(2), inches(22)]) {
      for (let y = inches(10); y <= inches(26); y += inches(1.25)) {
        shelfPins.push({ op: 'addFeature', part, feature: { type: 'hole', params: { face, at: [z, y], d: inches(13 / 64), depth: inches(3 / 8) } } });
      }
    }
  }
  const topW = W + inches(1.5);
  const topD = DEFAULT_CARCASS.depth + inches(1);
  const result = applyOps(emptyDoc(), [
    { op: 'add', entity: { kind: 'assembly', id: 'a1', name: 'Base cabinet', generator: { type: 'carcass', params: { ...DEFAULT_CARCASS } } } },
    {
      op: 'addFeature',
      part: 'a1.side-right',
      feature: { type: 'hole', params: { face: 'face:right', at: [inches(12), inches(24)], d: inches(1) } },
    },
    ...shelfPins,
    {
      op: 'add',
      entity: {
        kind: 'part',
        id: 'tabletop',
        name: 'Tabletop',
        material: 'maple-4-4',
        grain: 'x',
        transform: { position: [-inches(0.75), H, 0], rotation: [0, 0, 0] },
        shape: {
          type: 'outline',
          params: {
            axis: 'y',
            thickness: 48,
            points: [
              { id: 'bl', at: [0, 0], r: inches(1) },
              { id: 'br', at: [topW, 0], r: inches(1) },
              { id: 'fr', at: [topW, topD], r: inches(1) },
              { id: 'fl', at: [0, topD], r: inches(1) },
            ],
          },
        },
        features: [{ type: 'edgeProfile', params: { edges: ['edge:top-bl', 'edge:top-br', 'edge:top-fr', 'edge:top-fl'], profile: 'roundover', r: inches(1 / 4) } }],
      },
    },
    {
      op: 'add',
      entity: {
        kind: 'part',
        id: 'door',
        name: 'Door',
        material: 'ply-3-4',
        grain: 'y',
        transform: { position: [W + inches(6), inches(4), inches(6)], rotation: [0, 0, 0] },
        shape: { type: 'box', params: { x: inches(17.75), y: inches(30.25), z: 46 } },
        features: [
          { type: 'edgeProfile', params: { edges: ['edge:top-front', 'edge:bottom-front', 'edge:front-left', 'edge:front-right'], profile: 'roundover', r: inches(1 / 8) } },
          // 35mm cups, 22.5mm from the hinge edge, 1/2" deep.
          { type: 'hole', params: { face: 'face:back', at: [57, inches(3)], d: 88, depth: inches(1 / 2) } },
          { type: 'hole', params: { face: 'face:back', at: [57, inches(27.25)], d: 88, depth: inches(1 / 2) } },
        ],
      },
    },
  ]);
  if (!result.ok) throw new Error(`demo doc failed: ${result.error}`);
  return result.doc;
}
