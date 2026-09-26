import { GeometryError, realizePrism } from '../geometry/prism';
import { tessellate } from '../geometry/tessellate';
import type { Geom, Handle, TaggedMesh } from '../geometry/types';
import type { Part } from '../model/schema';
import { features, PluginError, shapes } from './registry';

export interface BuiltPart {
  mesh: TaggedMesh;
  handles: Handle[];
  geom: Geom;
}

/** Built parts keyed by shape + features, so validation and rendering share the work. */
const cache = new Map<string, BuiltPart>();
const CACHE_SIZE = 500;

/**
 * Part data → shape (with channels, or profile features → facets) → cut features → tagged mesh
 * + handles. Joint cuts (`part.joinery`) run with the part's own features. Throws PluginError with
 * a readable reason when the part can't be built.
 */
export function buildPart(part: Part): BuiltPart {
  const key = JSON.stringify([part.shape, part.features, part.joinery ?? []]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let built: BuiltPart;
  try {
    built = build(part);
  } catch (err) {
    if (err instanceof GeometryError) throw new PluginError(err.message);
    throw err;
  }
  cache.set(key, built);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return built;
}

function build(part: Part): BuiltPart {
  const shape = shapes.get(part.shape.type);
  const all = [...part.features, ...(part.joinery ?? [])];
  const dup = all.find((f, i) => all.findIndex((g) => g.id === f.id) !== i);
  if (dup) throw new PluginError(`"${part.name}" has two features with id ${dup.id}`);
  const steps = all.map((f) => ({ f, def: features.get(f.type), ctx: { part, featureId: f.id } }));

  let geom: Geom;
  const channels = steps.filter((s) => s.def.channel);
  const profiled = steps.find((s) => s.def.profile);
  if (channels.length) {
    const c = channels[0]!;
    if (!shape.buildChanneled) throw new PluginError(`${c.f.type} ${c.f.id} can't go on a ${part.shape.type} part (box parts only)`);
    if (profiled) throw new PluginError(`"${part.name}" has dados or rabbets, so it can't also take ${profiled.f.type} ${profiled.f.id} yet`);
    geom = shape.buildChanneled(
      part.shape.params,
      channels.map((s) => s.def.channel!(s.f.params, s.ctx)),
      part.name,
    );
  } else {
    const out = shape.build(part.shape.params);
    if ('prism' in out) {
      for (const { f, def, ctx } of steps) def.profile?.(out.prism, f.params, ctx);
      geom = realizePrism(out.prism);
    } else {
      if (profiled) throw new PluginError(`${profiled.f.type} ${profiled.f.id} can't go on a ${part.shape.type} part`);
      geom = out.geom;
    }
  }
  for (const { f, def, ctx } of steps) def.cut?.(geom, f.params, ctx);

  const handles = [...shape.handles(part.shape.params)];
  for (const { f, def, ctx } of steps) handles.push(...def.handles(f.params, { ...ctx, geom }));
  return { mesh: tessellate(geom), handles, geom };
}
