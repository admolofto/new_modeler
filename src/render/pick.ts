import type * as THREE from 'three';
import type { Handle } from '../geometry/types';

export interface PickResult {
  partId: string;
  /** Semantic id of the hit triangle: `face:top`, `f1:wall`, … */
  tag: string;
  handle: Handle | undefined;
}

/** Resolves a raycast hit on a part mesh to its part and semantic face / feature id. */
export function resolvePick(hit: THREE.Intersection): PickResult | null {
  const mesh = hit.object as THREE.Mesh;
  const partId = mesh.userData?.partId as string | undefined;
  const { triTags, tags } = (mesh.geometry?.userData ?? {}) as { triTags?: Uint16Array; tags?: string[] };
  if (!partId || !triTags || !tags || hit.faceIndex == null) return null;
  const tag = tags[triTags[hit.faceIndex]!]!;
  const handles = mesh.userData.handles as Handle[] | undefined;
  return { partId, tag, handle: handles?.find((h) => h.id === tag) };
}
