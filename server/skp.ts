import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { ColladaMaterial, ColladaMesh, ColladaNode, ColladaScene } from '../src/io/collada.ts';

/**
 * Native SketchUp (.skp) reading through SketchUpAPI.dll, the SketchUp C SDK library that ships inside
 * every SketchUp install (no SDK download or license needed). The model's groups and components come
 * back as the same scene tree a .dae export produces, so the browser imports it with importSketchUp.
 * Windows only; SKETCHUP_API_DLL can point at another copy of the DLL.
 */

const MAX_BYTES = 300 * 1024 * 1024;

export class SkpError extends Error {}

/** SketchUp's column-major SUTransformation (w may carry a uniform scale) → row-major 4×4. */
export function rowMajor(v: ArrayLike<number>): number[] {
  const w = v[15] || 1;
  const out: number[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push(v[c * 4 + r]! / w);
  out[15] = 1;
  return out;
}

/** The newest SketchUp install's SketchUpAPI.dll, or null. */
export function findSketchUpDll(env: Record<string, string | undefined> = process.env): string | null {
  if (env.SKETCHUP_API_DLL) return existsSync(env.SKETCHUP_API_DLL) ? env.SKETCHUP_API_DLL : null;
  if (process.platform !== 'win32') return null;
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
    const root = join(base, 'SketchUp');
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).filter((d) => /^SketchUp \d{4}$/.test(d)).sort().reverse();
    for (const v of versions) {
      const dll = join(root, v, 'SketchUp', 'SketchUpAPI.dll');
      if (existsSync(dll)) return dll;
    }
  }
  return null;
}

type Fn = (...args: unknown[]) => number;
type Api = Record<string, Fn>;
let api: Promise<Api> | null = null;

/** Every C API ref is a one-pointer struct, passed and returned in a register on x64 like a void*. */
const SIGNATURES = [
  'int SUInitialize()',
  'int SUModelCreateFromFileWithStatus(_Out_ void **model, const char *path, _Out_ int *status)',
  'int SUModelRelease(_Inout_ void **model)',
  'int SUModelGetEntities(void *model, _Out_ void **entities)',
  'int SUEntitiesGetNumFaces(void *entities, _Out_ size_t *n)',
  'int SUEntitiesGetFaces(void *entities, size_t len, _Out_ void **faces, _Out_ size_t *n)',
  'int SUEntitiesGetNumGroups(void *entities, _Out_ size_t *n)',
  'int SUEntitiesGetGroups(void *entities, size_t len, _Out_ void **groups, _Out_ size_t *n)',
  'int SUEntitiesGetNumInstances(void *entities, _Out_ size_t *n)',
  'int SUEntitiesGetInstances(void *entities, size_t len, _Out_ void **instances, _Out_ size_t *n)',
  'int SUGroupGetEntities(void *group, _Out_ void **entities)',
  'int SUGroupGetTransform(void *group, _Out_ double *values)',
  'int SUGroupGetName(void *group, _Inout_ void **name)',
  'void *SUGroupToDrawingElement(void *group)',
  'int SUComponentInstanceGetDefinition(void *instance, _Out_ void **definition)',
  'int SUComponentInstanceGetTransform(void *instance, _Out_ double *values)',
  'int SUComponentInstanceGetName(void *instance, _Inout_ void **name)',
  'void *SUComponentInstanceToDrawingElement(void *instance)',
  'int SUComponentDefinitionGetEntities(void *definition, _Out_ void **entities)',
  'int SUComponentDefinitionGetName(void *definition, _Inout_ void **name)',
  'void *SUFaceToDrawingElement(void *face)',
  'int SUFaceGetFrontMaterial(void *face, _Out_ void **material)',
  'int SUDrawingElementGetHidden(void *element, _Out_ bool *hidden)',
  'int SUDrawingElementGetMaterial(void *element, _Out_ void **material)',
  'int SUDrawingElementGetLayer(void *element, _Out_ void **layer)',
  'int SULayerGetVisibility(void *layer, _Out_ bool *visible)',
  'int SUMaterialGetName(void *material, _Inout_ void **name)',
  'int SUMaterialGetColor(void *material, _Out_ uint8_t *rgba)',
  'int SUMaterialGetType(void *material, _Out_ int *type)',
  'int SUMeshHelperCreate(_Out_ void **mesh, void *face)',
  'int SUMeshHelperRelease(_Inout_ void **mesh)',
  'int SUMeshHelperGetNumTriangles(void *mesh, _Out_ size_t *n)',
  'int SUMeshHelperGetNumVertices(void *mesh, _Out_ size_t *n)',
  'int SUMeshHelperGetVertexIndices(void *mesh, size_t len, _Out_ size_t *indices, _Out_ size_t *n)',
  'int SUMeshHelperGetVertices(void *mesh, size_t len, _Out_ double *points, _Out_ size_t *n)',
  'int SUStringCreate(_Out_ void **str)',
  'int SUStringRelease(_Inout_ void **str)',
  'int SUStringGetUTF8Length(void *str, _Out_ size_t *n)',
  'int SUStringGetUTF8(void *str, size_t len, _Out_ uint8_t *out, _Out_ size_t *n)',
];

function loadApi(): Promise<Api> {
  api ??= (async () => {
    const dll = findSketchUpDll();
    if (!dll) throw new SkpError('Opening .skp files needs SketchUp installed on this PC. Or, in SketchUp: File › Export › 3D Model › COLLADA (.dae), and import that.');
    // Plain require: the config's module runner is closed by the time a request arrives.
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
    const lib = koffi.load(dll);
    const out: Api = {};
    for (const sig of SIGNATURES) {
      const fn = lib.func(sig) as Fn;
      out[sig.match(/(\w+)\(/)![1]!] = fn;
    }
    out.SUInitialize!();
    return out;
  })();
  api.catch(() => (api = null));
  return api;
}

/** SUResult codes worth naming. */
const LOAD_ERRORS: Record<number, string> = {
  7: "the file couldn't be read",
  12: "it isn't a SketchUp model, or the file is damaged",
  13: 'it was saved by a newer SketchUp than the one installed on this PC',
};

/** Reads a .skp file into the scene tree the importer understands (inches, Z up). */
export async function readSkp(path: string): Promise<ColladaScene> {
  const su = await loadApi();
  const check = (r: number, what: string) => {
    if (r !== 0) throw new SkpError(LOAD_ERRORS[r] ?? `SketchUp couldn't read the model (${what}, error ${r})`);
  };
  const ptr = () => [null] as unknown[];
  const size = () => [0] as number[];

  const text = (get: Fn, ref: unknown): string => {
    const s = ptr();
    if (su.SUStringCreate!(s) !== 0) return '';
    try {
      if (get(ref, s) !== 0) return '';
      const n = size();
      su.SUStringGetUTF8Length!(s[0], n);
      const buf = Buffer.alloc(n[0]! + 1);
      su.SUStringGetUTF8!(s[0], buf.length, buf, size());
      return buf.subarray(0, n[0]).toString('utf8');
    } finally {
      su.SUStringRelease!(s);
    }
  };

  const list = (count: Fn, get: Fn, entities: unknown): unknown[] => {
    const n = size();
    if (count(entities, n) !== 0 || !n[0]) return [];
    const items: unknown[] = new Array(n[0]).fill(null);
    const got = size();
    get(entities, n[0], items, got);
    return items.slice(0, got[0]);
  };

  const materials = new Map<string, ColladaMaterial>();
  const material = (ref: unknown): ColladaMaterial | null => {
    if (!ref) return null;
    const name = text(su.SUMaterialGetName!, ref) || 'Material';
    let hit = materials.get(name);
    if (!hit) {
      hit = { name };
      const type = [0];
      const rgba = new Uint8Array(4);
      // 0 = plain color; textured materials have no single color to match on.
      if (su.SUMaterialGetType!(ref, type) === 0 && type[0] === 0 && su.SUMaterialGetColor!(ref, rgba) === 0) {
        hit.color = `#${[...rgba.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      }
      materials.set(name, hit);
    }
    return hit;
  };
  const elementMaterial = (element: unknown): ColladaMaterial | null => {
    const m = ptr();
    return su.SUDrawingElementGetMaterial!(element, m) === 0 ? material(m[0]) : null;
  };
  const visible = (element: unknown): boolean => {
    const hidden = [false];
    if (su.SUDrawingElementGetHidden!(element, hidden) === 0 && hidden[0]) return false;
    const layer = ptr();
    const shown = [true];
    return !(su.SUDrawingElementGetLayer!(element, layer) === 0 && layer[0] && su.SULayerGetVisibility!(layer[0], shown) === 0 && !shown[0]);
  };

  const faceTris = (face: unknown): number[] => {
    const mesh = ptr();
    if (su.SUMeshHelperCreate!(mesh, face) !== 0) return [];
    try {
      const [nt, nv] = [size(), size()];
      su.SUMeshHelperGetNumTriangles!(mesh[0], nt);
      su.SUMeshHelperGetNumVertices!(mesh[0], nv);
      if (!nt[0] || !nv[0]) return [];
      const idx: number[] = new Array(nt[0] * 3).fill(0);
      const pts = new Float64Array(nv[0] * 3);
      su.SUMeshHelperGetVertexIndices!(mesh[0], idx.length, idx, size());
      su.SUMeshHelperGetVertices!(mesh[0], nv[0], pts, size());
      const tris: number[] = [];
      for (const i of idx) tris.push(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
      return tris;
    } finally {
      su.SUMeshHelperRelease!(mesh);
    }
  };

  /** Faces of one entities collection, grouped by material; faces with none take the container's. */
  const contents = (entities: unknown, inherited: ColladaMaterial | null, depth: number): Pick<ColladaNode, 'meshes' | 'children'> => {
    if (depth > 64) throw new SkpError('components nest too deeply (a component may contain itself)');
    const byMaterial = new Map<ColladaMaterial | null, ColladaMesh>();
    for (const face of list(su.SUEntitiesGetNumFaces!, su.SUEntitiesGetFaces!, entities)) {
      if (!visible(su.SUFaceToDrawingElement!(face))) continue;
      const m = ptr();
      const mat = su.SUFaceGetFrontMaterial!(face, m) === 0 && m[0] ? material(m[0]) : inherited;
      const tris = faceTris(face);
      if (!tris.length) continue;
      const mesh = byMaterial.get(mat) ?? { tris: [], material: mat };
      byMaterial.set(mat, mesh);
      for (const v of tris) mesh.tris.push(v);
    }
    const children: ColladaNode[] = [];
    for (const g of list(su.SUEntitiesGetNumGroups!, su.SUEntitiesGetGroups!, entities)) {
      const el = su.SUGroupToDrawingElement!(g);
      if (!visible(el)) continue;
      const [sub, t] = [ptr(), new Float64Array(16)];
      if (su.SUGroupGetEntities!(g, sub) !== 0) continue;
      su.SUGroupGetTransform!(g, t);
      children.push({ name: text(su.SUGroupGetName!, g) || 'Group', matrix: rowMajor(t), ...contents(sub[0], elementMaterial(el) ?? inherited, depth + 1) });
    }
    for (const inst of list(su.SUEntitiesGetNumInstances!, su.SUEntitiesGetInstances!, entities)) {
      const el = su.SUComponentInstanceToDrawingElement!(inst);
      if (!visible(el)) continue;
      const [def, sub, t] = [ptr(), ptr(), new Float64Array(16)];
      if (su.SUComponentInstanceGetDefinition!(inst, def) !== 0 || su.SUComponentDefinitionGetEntities!(def[0], sub) !== 0) continue;
      su.SUComponentInstanceGetTransform!(inst, t);
      const name = text(su.SUComponentInstanceGetName!, inst) || text(su.SUComponentDefinitionGetName!, def[0]) || 'Component';
      children.push({ name, matrix: rowMajor(t), ...contents(sub[0], elementMaterial(el) ?? inherited, depth + 1) });
    }
    return { meshes: [...byMaterial.values()], children };
  };

  const model = ptr();
  const status = [0];
  check(su.SUModelCreateFromFileWithStatus!(model, path, status), 'open');
  try {
    const entities = ptr();
    check(su.SUModelGetEntities!(model[0], entities), 'entities');
    const root = contents(entities[0], null, 0);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const nodes = root.meshes.length ? [{ name: 'Loose geometry', matrix: identity, meshes: root.meshes, children: [] }, ...root.children] : root.children;
    return { inches: 1, up: 'Z', nodes };
  } finally {
    su.SUModelRelease!(model);
  }
}

/** POST /api/skp with the file's bytes → { scene } or { error: { message } }. */
export function skpImport(): Plugin {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const localOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };

  async function convert(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += (c as Buffer).length;
      if (bytes > MAX_BYTES) return json(res, 413, { error: { message: 'that file is too large' } });
      chunks.push(c as Buffer);
    }
    const dir = await mkdtemp(join(tmpdir(), 'modeler-skp-'));
    try {
      const file = join(dir, 'model.skp');
      await writeFile(file, Buffer.concat(chunks));
      json(res, 200, { scene: await readSkp(file) });
    } catch (err) {
      json(res, err instanceof SkpError ? 422 : 500, { error: { message: (err as Error).message } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    name: 'skp-import',
    configureServer(server) {
      server.middlewares.use('/api/skp', (req, res) => {
        if (!localOrigin(req)) return json(res, 403, { error: { message: 'forbidden origin' } });
        if (req.method !== 'POST') return json(res, 405, { error: { message: 'POST the .skp file' } });
        void convert(req, res);
      });
    },
  };
}
