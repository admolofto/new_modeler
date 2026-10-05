import earcut from 'earcut';
import type { V3 } from '../geometry/types';
import { buildPart } from '../plugins/pipeline';
import type { Doc } from '../model/schema';
import { UNITS_PER_INCH } from '../model/units';
import { mul, rotation, transpose, type Mat3 } from '../model/world';
import { child, childrenNamed, escapeXml, localTag, parseXml, XmlError, type XmlElement } from './xml';

/**
 * COLLADA 1.4 (.dae), the 3D format SketchUp imports and exports natively (File › Import, File ›
 * Export › 3D Model). Files are written Z-up in inches, the way SketchUp writes them: model X stays
 * X, model height (Y) becomes SketchUp's blue Z axis, and the model front (+Z) faces SketchUp's −Y,
 * so the Front view shows the front. Pure: no DOM.
 */

export class ColladaError extends Error {}

const BLOCK_COLOR = '#a9aeb7';
/** Material name blockouts are exported with; importing it back makes blockouts again. */
export const BLOCKOUT_MATERIAL = 'Blockout';

/** Model frame → SketchUp frame: (x, y, z) → (x, −z, y). A proper rotation, so it conjugates transforms cleanly. */
const C: Mat3 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
const su = (v: ArrayLike<number>, i = 0): V3 => [v[i]!, -v[i + 2]!, v[i + 1]!];

const num = (n: number) => String(Number(n.toFixed(6)));
const rgb = (hex: string) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

/** The whole model (hidden parts included) as a COLLADA document SketchUp can import. */
export function exportCollada(doc: Doc, title = 'Model'): string {
  const effects: string[] = [];
  const materials: string[] = [];
  const geometries: string[] = [];
  const matIds = new Map<string, string>();
  const geoIds = new Map<string, string>();

  const material = (key: string, name: string, color: string) => {
    let id = matIds.get(key);
    if (id) return id;
    id = `mat${matIds.size + 1}`;
    matIds.set(key, id);
    effects.push(
      `<effect id="${id}-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${rgb(color)} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`,
    );
    materials.push(`<material id="${id}" name="${escapeXml(name)}"><instance_effect url="#${id}-fx"/></material>`);
    return id;
  };

  const geometry = (partId: string) => {
    const part = doc.parts[partId]!;
    const key = JSON.stringify([part.shape, part.features, part.joinery ?? []]);
    let id = geoIds.get(key);
    if (id) return id;
    id = `geo${geoIds.size + 1}`;
    geoIds.set(key, id);
    const { positions, normals, indices } = buildPart(part).mesh;
    const pos: string[] = [];
    const nrm: string[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      pos.push(su(positions, i).map((c) => num(c / UNITS_PER_INCH)).join(' '));
      nrm.push(su(normals, i).map(num).join(' '));
    }
    const n = positions.length / 3;
    geometries.push(
      `<geometry id="${id}"><mesh>` +
        `<source id="${id}-pos"><float_array id="${id}-pos-a" count="${n * 3}">${pos.join(' ')}</float_array>` +
        `<technique_common><accessor source="#${id}-pos-a" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>` +
        `<source id="${id}-nrm"><float_array id="${id}-nrm-a" count="${n * 3}">${nrm.join(' ')}</float_array>` +
        `<technique_common><accessor source="#${id}-nrm-a" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>` +
        `<vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-pos"/><input semantic="NORMAL" source="#${id}-nrm"/></vertices>` +
        `<triangles material="m" count="${indices.length / 3}"><input semantic="VERTEX" source="#${id}-vtx" offset="0"/><p>${Array.from(indices).join(' ')}</p></triangles>` +
        `</mesh></geometry>`,
    );
    return id;
  };

  let nodeCount = 0;
  const node = (id: string): string => {
    const part = doc.parts[id];
    const asm = doc.assemblies[id];
    const n = part ?? asm;
    if (!n) return '';
    // Conjugate by C so each node's own axes map to SketchUp's (its height runs along blue).
    const m = mulC(rotation(n.transform.rotation));
    const t = su(n.transform.position).map((c) => c / UNITS_PER_INCH);
    const matrix = [0, 1, 2].flatMap((r) => [...m[r]!, t[r]!]).concat([0, 0, 0, 1]).map(num).join(' ');
    const open = `<node id="node${++nodeCount}" name="${escapeXml(n.name || (part ? 'Part' : 'Assembly'))}"><matrix>${matrix}</matrix>`;
    if (asm) return `${open}${asm.children.map(node).join('')}</node>`;
    const mat = part!.block
      ? material('block', BLOCKOUT_MATERIAL, BLOCK_COLOR)
      : (() => {
          const m = doc.materials[part!.material!];
          return material(`m:${part!.material}`, m?.name ?? 'Material', m?.color ?? BLOCK_COLOR);
        })();
    let geo: string;
    try {
      geo = geometry(id);
    } catch {
      return `${open}</node>`; // Unbuildable part: keep its place in the hierarchy.
    }
    return `${open}<instance_geometry url="#${geo}"><bind_material><technique_common><instance_material symbol="m" target="#${mat}"/></technique_common></bind_material></instance_geometry></node>`;
  };
  const scene = doc.roots.map(node).join('\n');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    `<asset><contributor><authoring_tool>Modeler</authoring_tool></contributor><created>${now}</created><modified>${now}</modified><unit name="inch" meter="0.0254"/><up_axis>Z_UP</up_axis></asset>`,
    `<library_effects>${effects.join('\n')}</library_effects>`,
    `<library_materials>${materials.join('\n')}</library_materials>`,
    `<library_geometries>${geometries.join('\n')}</library_geometries>`,
    `<library_visual_scenes><visual_scene id="scene" name="${escapeXml(title)}">${scene}</visual_scene></library_visual_scenes>`,
    '<scene><instance_visual_scene url="#scene"/></scene>',
    '</COLLADA>',
    '',
  ].join('\n');
}

/** C · m · Cᵀ. */
const mulC = (m: Mat3): Mat3 => mul(mul(C, m), transpose(C));

// ── Reading ──────────────────────────────────────────────────────────────

export interface ColladaMaterial {
  name: string;
  /** `#rrggbb`, when the material has a plain diffuse color (not a texture). */
  color?: string;
}

export interface ColladaMesh {
  /** Triangle soup in the node's own frame and file units: 9 numbers per triangle. */
  tris: number[];
  material: ColladaMaterial | null;
}

export interface ColladaNode {
  name: string;
  /** Node → parent, row-major 4×4. */
  matrix: number[];
  meshes: ColladaMesh[];
  children: ColladaNode[];
}

export interface ColladaScene {
  /** Inches per file unit. */
  inches: number;
  up: 'X' | 'Y' | 'Z';
  nodes: ColladaNode[];
}

const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const numbers = (s: string) => (s.trim() ? s.trim().split(/\s+/).map(Number) : []);

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c]! += a[r * 4 + k]! * b[k * 4 + c]!;
  return out;
}

function axisAngle4([x, y, z, deg]: number[]): number[] {
  const len = Math.hypot(x!, y!, z!) || 1;
  const [ux, uy, uz] = [x! / len, y! / len, z! / len];
  const a = (deg! * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const t = 1 - c;
  return [
    t * ux * ux + c, t * ux * uy - s * uz, t * ux * uz + s * uy, 0,
    t * ux * uy + s * uz, t * uy * uy + c, t * uy * uz - s * ux, 0,
    t * ux * uz - s * uy, t * uy * uz + s * ux, t * uz * uz + c, 0,
    0, 0, 0, 1,
  ];
}

/** Parses a .dae file into a node tree with triangulated meshes. Throws ColladaError. */
export function parseCollada(text: string): ColladaScene {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (err) {
    throw new ColladaError(err instanceof XmlError ? `not a readable .dae file (${err.message})` : String(err));
  }
  if (localTag(root) !== 'COLLADA') throw new ColladaError('not a COLLADA (.dae) file');

  const byId = new Map<string, XmlElement>();
  const index = (e: XmlElement) => {
    if (e.attrs.id) byId.set(e.attrs.id, e);
    e.children.forEach(index);
  };
  index(root);
  const ref = (url: string | undefined) => (url?.startsWith('#') ? byId.get(url.slice(1)) : undefined);

  const asset = child(root, 'asset');
  const meter = Number(child(asset, 'unit')?.attrs.meter ?? 1) || 1;
  const upText = child(asset, 'up_axis')?.text.trim().toUpperCase() ?? 'Y_UP';
  const up = upText[0] === 'Z' ? 'Z' : upText[0] === 'X' ? 'X' : 'Y';

  const materials = new Map<XmlElement, ColladaMaterial>();
  const readMaterial = (e: XmlElement | undefined): ColladaMaterial | null => {
    if (!e || localTag(e) !== 'material') return null;
    const hit = materials.get(e);
    if (hit) return hit;
    const mat: ColladaMaterial = { name: e.attrs.name ?? e.attrs.id ?? 'Material' };
    const effect = ref(child(e, 'instance_effect')?.attrs.url);
    const technique = child(child(effect, 'profile_COMMON'), 'technique');
    const shader = technique?.children.find((c) => ['lambert', 'phong', 'blinn', 'constant'].includes(localTag(c)));
    const color = child(child(shader, 'diffuse'), 'color') ?? child(child(shader, 'emission'), 'color');
    if (color) {
      const [r, g, b] = numbers(color.text);
      if ([r, g, b].every((v) => v !== undefined && Number.isFinite(v))) {
        mat.color = `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v!)) * 255).toString(16).padStart(2, '0')).join('')}`;
      }
    }
    materials.set(e, mat);
    return mat;
  };

  const sources = new Map<XmlElement, { data: number[]; stride: number; offset: number }>();
  const readSource = (e: XmlElement | undefined) => {
    if (!e) return null;
    const hit = sources.get(e);
    if (hit) return hit;
    const acc = child(child(e, 'technique_common'), 'accessor');
    const arr = ref(acc?.attrs.source) ?? child(e, 'float_array');
    if (!arr) return null;
    const out = { data: numbers(arr.text), stride: Number(acc?.attrs.stride ?? 3) || 3, offset: Number(acc?.attrs.offset ?? 0) || 0 };
    sources.set(e, out);
    return out;
  };

  type Prim = { symbol: string | undefined; tris: number[] };
  const geometries = new Map<XmlElement, Prim[]>();
  const readGeometry = (g: XmlElement): Prim[] => {
    const hit = geometries.get(g);
    if (hit) return hit;
    const mesh = child(g, 'mesh');
    const prims: Prim[] = [];
    for (const p of mesh?.children ?? []) {
      const kind = localTag(p);
      if (!['triangles', 'polylist', 'polygons', 'trifans', 'tristrips'].includes(kind)) continue;
      const inputs = childrenNamed(p, 'input');
      const stride = Math.max(0, ...inputs.map((i) => Number(i.attrs.offset ?? 0))) + 1;
      const vin = inputs.find((i) => i.attrs.semantic === 'VERTEX') ?? inputs.find((i) => i.attrs.semantic === 'POSITION');
      if (!vin) continue;
      let src = ref(vin.attrs.source);
      if (src && localTag(src) === 'vertices') src = ref(childrenNamed(src, 'input').find((i) => i.attrs.semantic === 'POSITION')?.attrs.source);
      const pos = readSource(src);
      if (!pos) continue;
      const vOff = Number(vin.attrs.offset ?? 0);
      const corner = (list: number[], c: number): V3 => {
        const k = pos.offset + list[c * stride + vOff]! * pos.stride;
        return [pos.data[k]!, pos.data[k + 1]!, pos.data[k + 2]!];
      };
      const tris: number[] = [];
      const polygon = (pts: V3[]) => {
        if (pts.length === 3) return void tris.push(...pts[0]!, ...pts[1]!, ...pts[2]!);
        for (const [a, b, c] of triangulate(pts)) tris.push(...pts[a]!, ...pts[b]!, ...pts[c]!);
      };
      const lists = childrenNamed(p, 'p').map((e) => numbers(e.text));
      // <polygons> can hold <ph> (polygon with holes); its outer <p> is enough for fitting.
      for (const ph of childrenNamed(p, 'ph')) {
        const outer = child(ph, 'p');
        if (outer) lists.push(numbers(outer.text));
      }
      if (kind === 'triangles') {
        const l = lists.flat();
        for (let c = 0; c + 2 < l.length / stride; c += 3) polygon([corner(l, c), corner(l, c + 1), corner(l, c + 2)]);
      } else if (kind === 'polylist') {
        const l = lists.flat();
        let c = 0;
        for (const n of numbers(child(p, 'vcount')?.text ?? '')) {
          polygon(Array.from({ length: n }, (_, k) => corner(l, c + k)));
          c += n;
        }
      } else if (kind === 'polygons') {
        for (const l of lists) polygon(Array.from({ length: l.length / stride }, (_, k) => corner(l, k)));
      } else {
        for (const l of lists) {
          const pts = Array.from({ length: l.length / stride }, (_, k) => corner(l, k));
          for (let k = 2; k < pts.length; k++) {
            const [a, b, c] = kind === 'trifans' ? [0, k - 1, k] : k % 2 ? [k - 1, k - 2, k] : [k - 2, k - 1, k];
            tris.push(...pts[a]!, ...pts[b]!, ...pts[c]!);
          }
        }
      }
      prims.push({ symbol: p.attrs.material, tris });
    }
    geometries.set(g, prims);
    return prims;
  };

  const readNode = (e: XmlElement, depth: number): ColladaNode => {
    if (depth > 64) throw new ColladaError('nodes nest too deeply (a component may contain itself)');
    let matrix = IDENTITY4;
    const out: ColladaNode = { name: e.attrs.name ?? '', matrix, meshes: [], children: [] };
    for (const c of e.children) {
      const tag = localTag(c);
      const v = numbers(c.text);
      if (tag === 'matrix' && v.length === 16) matrix = mul4(matrix, v);
      else if (tag === 'translate' && v.length === 3) matrix = mul4(matrix, [1, 0, 0, v[0]!, 0, 1, 0, v[1]!, 0, 0, 1, v[2]!, 0, 0, 0, 1]);
      else if (tag === 'scale' && v.length === 3) matrix = mul4(matrix, [v[0]!, 0, 0, 0, 0, v[1]!, 0, 0, 0, 0, v[2]!, 0, 0, 0, 0, 1]);
      else if (tag === 'rotate' && v.length === 4) matrix = mul4(matrix, axisAngle4(v));
      else if (tag === 'node') out.children.push(readNode(c, depth + 1));
      else if (tag === 'instance_node') {
        const lib = ref(c.attrs.url);
        if (lib) out.children.push(readNode(lib, depth + 1));
      } else if (tag === 'instance_geometry') {
        const g = ref(c.attrs.url);
        if (!g) continue;
        const bound = new Map<string, XmlElement | undefined>();
        for (const im of childrenNamed(child(child(c, 'bind_material'), 'technique_common'), 'instance_material')) {
          if (im.attrs.symbol) bound.set(im.attrs.symbol, ref(im.attrs.target));
        }
        for (const prim of readGeometry(g)) {
          if (!prim.tris.length) continue;
          const target = prim.symbol === undefined ? undefined : bound.has(prim.symbol) ? bound.get(prim.symbol) : byId.get(prim.symbol);
          out.meshes.push({ tris: prim.tris, material: readMaterial(target) });
        }
      }
    }
    out.matrix = matrix;
    return out;
  };

  const scene = ref(child(child(root, 'scene'), 'instance_visual_scene')?.attrs.url) ?? childrenNamed(child(root, 'library_visual_scenes'), 'visual_scene')[0];
  if (!scene) throw new ColladaError('the file has no scene');
  return { inches: meter / 0.0254, up, nodes: childrenNamed(scene, 'node').map((n) => readNode(n, 0)) };
}

/** Triangulates a planar 3D polygon (projected onto its dominant plane). */
function triangulate(pts: V3[]): [number, number, number][] {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[(i + 1) % pts.length]!];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const drop = [0, 1, 2].reduce((best, k) => (Math.abs(n[k]!) > Math.abs(n[best]!) ? k : best), 0);
  const [i, j] = [0, 1, 2].filter((k) => k !== drop) as [number, number];
  const flat = pts.flatMap((p) => [p[i]!, p[j]!]);
  const idx = earcut(flat, null, 2);
  const out: [number, number, number][] = [];
  for (let k = 0; k < idx.length; k += 3) out.push([idx[k]!, idx[k + 1]!, idx[k + 2]!]);
  return out;
}
