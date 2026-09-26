import type { TaggedMesh } from '../geometry/types';

// Mesh checks shared by the geometry tests.

/** Every edge shared by exactly two triangles, in opposite directions (closed + consistently wound). */
export function isWatertight(m: TaggedMesh): boolean {
  const key = (i: number) => `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`;
  const directed = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = `${key(m.indices[t + e]!)}>${key(m.indices[t + ((e + 1) % 3)]!)}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (n !== 1 || directed.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** Signed volume (divergence theorem); positive iff triangles face outward. */
export function volume(m: TaggedMesh): number {
  let v = 0;
  const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]!), p(m.indices[t + 1]!), p(m.indices[t + 2]!)] as number[][];
    v += a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) - a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }
  return v / 6;
}

export function bounds(m: TaggedMesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, m.positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, m.positions[i]!);
  }
  return { min, max };
}


/** Total area of triangles with this tag. */
export function tagArea(m: TaggedMesh, tag: string): number {
  let area = 0;
  const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
  for (let t = 0; t < m.indices.length / 3; t++) {
    if (m.tags[m.triTags[t]!] !== tag) continue;
    const [a, b, c] = [p(m.indices[t * 3]!), p(m.indices[t * 3 + 1]!), p(m.indices[t * 3 + 2]!)] as number[][];
    const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
    const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
    area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return area;
}
