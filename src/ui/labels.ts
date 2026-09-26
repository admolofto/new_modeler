import { isGround, type Target } from '../edit/targets';
import type { Doc } from '../model/schema';
import { WORDS } from '../plugins/shapes/box';

/**
 * Plain names for what's selected or noted: "Top face", "Top-front edge", "Hole wall", "Dado for
 * Bottom". `describeTarget` (edit/targets.ts) keeps the exact ids for the AI.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SIDES = new Set<string>(Object.values(WORDS).flat());
const boxy = (parts: string[]) => parts.every((p) => SIDES.has(p));

function faceLabel(name: string): string {
  const side = /^side-(.+)$/.exec(name);
  if (side) return `Side face (${side[1]})`;
  const corner = /^corner-(.+)$/.exec(name);
  if (corner) return `Rounded corner (${corner[1]})`;
  return `${cap(name.replace(/-/g, ' '))} face`;
}

function edgeLabel(name: string): string {
  const parts = name.split('-');
  if (boxy(parts)) return `${cap(name)} edge`;
  if (parts[0] === 'corner') return `Corner edge (${parts.slice(1).join('-')})`;
  return `${cap(parts[0]!)} edge (${parts.slice(1).join('-')})`;
}

function vertexLabel(name: string): string {
  const parts = name.split('-');
  return boxy(parts) ? `${cap(name)} corner` : `Corner (${parts.slice(1).join('-')})`;
}

const SURFACE: Record<string, string> = { wall: 'wall', floor: 'bottom', center: 'center' };

/** What on the part a handle is, e.g. "Top face" (empty for a whole part). */
export function handleLabel(doc: Doc, t: Target): string {
  const h = t.handle;
  if (!h) return '';
  if (h.startsWith('face:')) return faceLabel(h.slice(5));
  if (h.startsWith('edge:')) return edgeLabel(h.slice(5));
  if (h.startsWith('vertex:')) return vertexLabel(h.slice(7));
  const i = h.indexOf(':');
  const [source, rest] = [h.slice(0, i), h.slice(i + 1)];
  const part = doc.parts[t.node];
  const cut = part?.joinery?.find((c) => c.id === source);
  const joint = cut && doc.joints[cut.joint];
  if (joint) return `${cap(joint.type)} for ${doc.parts[joint.parts[1]]?.name ?? 'a removed part'}`;
  const f = part?.features.find((x) => x.id === source);
  if (f?.type === 'edgeProfile') return `${cap(String(f.params.profile))} on the ${edgeLabel(rest.replace(/^edge:/, '')).toLowerCase()}`;
  return `${f ? cap(f.type) : 'Cut'} ${SURFACE[rest] ?? rest.replace(/-/g, ' ')}`;
}

/** "Right side", or "Right side · Top face" for part of it. */
export function targetLabel(doc: Doc, t: Target): string {
  if (isGround(t)) return 'Ground';
  const node = doc.parts[t.node] ?? doc.assemblies[t.node];
  if (!node) return 'A removed part';
  return t.handle ? `${node.name} · ${handleLabel(doc, t)}` : node.name;
}
