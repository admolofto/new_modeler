import { motions } from '../plugins';
import { movingParts } from './doc';
import { motionBasis, motionName, movedAffines } from './motion';
import type { Doc, Motion } from './schema';
import { formatInches } from './units';
import { allAffines, localBox, penetration, transformBox, union, type Affine, type Box3 } from './world';

/**
 * Does it open clear? Each motion swings or slides its parts through their path (every 5° or 1"),
 * against every part that stays put: the first thing it hits, and how far open it is then (a door
 * hinged against a wall hits it just past 90°). Then everything open at once, for things that only
 * collide with each other (drawers meeting at an inside corner). Pairs already touching or overlapping
 * when closed don't count, nor does anything that rides along. Pure; memoized per doc.
 */

export interface Clash {
  /** The motion that hits something, and its part that does. */
  motion: string;
  part: string;
  /** What it hits: a part that stays put, or a part of `with` when both are open. */
  hits: string;
  with?: string;
  /** How far open it is when they first meet: 0 … 1. */
  at: number;
}

/** Interpenetration deeper than this (1/64") is a hit; touching is fine. */
const DEPTH = 1;
const DEG_STEP = 5;
const LENGTH_STEP = 64;
const MAX_STEPS = 72;

const meets = (a: Box3, b: Box3) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! && b.min[k]! < a.max[k]!);

const cache = new WeakMap<Doc, Clash[]>();

export function clearance(doc: Doc): Clash[] {
  const hit = cache.get(doc);
  if (hit) return hit;
  const affines = allAffines(doc);
  const locals = new Map<string, Box3 | null>();
  const local = (id: string): Box3 | null => {
    if (!locals.has(id)) {
      try {
        locals.set(id, localBox(doc, id));
      } catch {
        locals.set(id, null);
      }
    }
    return locals.get(id)!;
  };
  const parts = Object.keys(doc.parts).filter((id) => affines.has(id) && local(id));
  const bounds = new Map(parts.map((id) => [id, transformBox(affines.get(id)!, local(id)!)]));
  const overlap = (a: Affine, p: string, b: Affine, q: string) => meets(transformBox(a, local(p)!), transformBox(b, local(q)!)) && penetration(a, local(p)!, b, local(q)!) > DEPTH;
  const closedOverlap = (p: string, q: string) => overlap(affines.get(p)!, p, affines.get(q)!, q);

  const out: Clash[] = [];
  const moving = new Map<string, Set<string>>();
  const open = new Map<string, Map<string, Affine>>();
  for (const m of Object.values(doc.motions)) {
    let reach: { value: number; unit: 'deg' | 'length' };
    let pose: (t: number) => Map<string, Affine>;
    try {
      reach = motions.get(m.type).reach(m.params, motionBasis(doc, m));
      pose = (t) => movedAffines(doc, m, t);
      open.set(m.id, pose(1));
    } catch {
      continue; // can't move: nothing to check
    }
    const mine = new Set([...movingParts(doc, m.nodes)].filter((id) => bounds.has(id)));
    moving.set(m.id, mine);
    const steps = Math.min(MAX_STEPS, Math.max(2, Math.ceil(Math.abs(reach.value) / (reach.unit === 'deg' ? DEG_STEP : LENGTH_STEP))));
    const poses = Array.from({ length: steps }, (_, i) => pose((i + 1) / steps));
    // Only parts near the swept path can be hit.
    const swept = union(poses.flatMap((p) => [...p].filter(([id]) => mine.has(id)).map(([id, A]) => transformBox(A, local(id)!))));
    const near = parts.filter((id) => !mine.has(id) && meets(bounds.get(id)!, swept));
    const pairs = [...mine].flatMap((p) => near.filter((q) => !closedOverlap(p, q)).map((q) => [p, q] as const));
    const first = (t: number) => {
      const at = pose(t);
      return pairs.find(([p, q]) => overlap(at.get(p)!, p, affines.get(q)!, q)) ?? null;
    };
    for (let i = 0; i < steps; i++) {
      const hitAt = pairs.find(([p, q]) => overlap(poses[i]!.get(p)!, p, affines.get(q)!, q));
      if (!hitAt) continue;
      // Narrow down to where they first meet.
      let [lo, hi] = [i / steps, (i + 1) / steps];
      let found = hitAt;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        const f = first(mid);
        if (f) [hi, found] = [mid, f];
        else lo = mid;
      }
      out.push({ motion: m.id, part: found[0], hits: found[1], at: hi });
      break;
    }
  }

  // Everything open at once: parts of two motions that meet (neither inside the other, not already touching).
  const list = [...open.keys()].filter((id) => moving.get(id)?.size);
  const clashed = new Set(out.map((c) => c.motion));
  const openBounds = new Map(list.map((id) => [id, union([...moving.get(id)!].map((p) => transformBox(open.get(id)!.get(p)!, local(p)!)))]));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i]!, list[j]!];
      const [pa, pb] = [moving.get(a)!, moving.get(b)!];
      if (clashed.has(a) || clashed.has(b) || !meets(openBounds.get(a)!, openBounds.get(b)!) || [...pa].some((id) => pb.has(id))) continue;
      const [oa, ob] = [open.get(a)!, open.get(b)!];
      let found: [string, string] | null = null;
      for (const p of pa) {
        for (const q of pb) {
          if (overlap(oa.get(p)!, p, ob.get(q)!, q) && !closedOverlap(p, q)) {
            found = [p, q];
            break;
          }
        }
        if (found) break;
      }
      if (found) out.push({ motion: a, part: found[0], hits: found[1], with: b, at: 1 });
    }
  }
  cache.set(doc, out);
  return out;
}

/** The clashes that involve this motion (as the mover, or as the other one open). */
export function clashesOf(doc: Doc, motionId: string): Clash[] {
  return clearance(doc).filter((c) => c.motion === motionId || c.with === motionId);
}

/** `Left door hits “Wall” at 92°`, `Drawer 1 hits “Range” after 14"`, `Drawer 2 and Corner door hit each other when both are open`. */
export function clashText(doc: Doc, c: Clash, length: (u: number) => string = formatInches): string {
  const m = doc.motions[c.motion];
  if (!m) return '';
  const name = motionName(doc, m);
  if (c.with) {
    const other = doc.motions[c.with];
    return `${name} and ${other ? motionName(doc, other) : 'another'} hit each other when both are open`;
  }
  const what = `“${doc.parts[c.hits]?.name ?? c.hits}”`;
  return `${name} hits ${what} ${where(doc, m, c.at, length)}`;
}

function where(doc: Doc, m: Motion, at: number, length: (u: number) => string): string {
  try {
    const reach = motions.get(m.type).reach(m.params, motionBasis(doc, m));
    return reach.unit === 'deg' ? `at ${Math.round(reach.value * at)}°` : `after ${length(Math.round(reach.value * at))}`;
  } catch {
    return 'as it opens';
  }
}
