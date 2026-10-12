import { describe, expect, it } from 'vitest';
import { FINISHES, finishDef } from '../../model/finishes';
import { FINISH_RENDER, finishRender } from './finishDefs';
import { TEXTURE_SETS } from './textureSets';

describe('finish render params', () => {
  it('cover every preset in the vocabulary, and nothing else', () => {
    for (const f of FINISHES) expect(FINISH_RENDER[f.id], f.id).toBeDefined();
    for (const id of Object.keys(FINISH_RENDER)) expect(finishDef(id), id).toBeDefined();
  });

  it('only name texture sets the manifest has', () => {
    for (const [id, r] of Object.entries(FINISH_RENDER)) if (r.textureSet) expect(TEXTURE_SETS[r.textureSet], id).toBeDefined();
  });

  it('keep the families apart: wood textured with a clearcoat, metals metallic, glass and light casting no shadow', () => {
    for (const f of FINISHES) {
      const r = FINISH_RENDER[f.id]!;
      expect(r.roughness, f.id).toBeGreaterThanOrEqual(0);
      expect(r.roughness, f.id).toBeLessThanOrEqual(1);
      if (f.family === 'wood') expect([r.textureSet?.startsWith('wood-'), r.clearcoat! > 0]).toEqual([true, true]);
      if (f.family === 'metal') expect(r.metalness).toBeGreaterThanOrEqual(0.5);
      if (f.family === 'glass') expect([r.castsShadow, r.glass?.opacity! > 0]).toEqual([false, true]);
      if (f.family === 'light') expect([r.castsShadow, !!r.emissive]).toEqual([false, true]);
    }
    expect(finishRender('wood:birch-ply').textureSet).toBe('wood-maple');
    expect(finishRender('wood:red-oak').textureSet).toBe('wood-oak');
    expect(finishRender('wood:red-oak').tint).not.toBe(finishRender('wood:white-oak').tint);
  });

  it('falls back to paint for an unknown preset', () => {
    expect(finishRender('nope:nothing')).toBe(FINISH_RENDER.paint);
  });
});
