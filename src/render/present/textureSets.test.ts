import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { proceduralMap } from './procedural';
import { fileSets, TEXTURE_SETS, type MapKind } from './textureSets';

const ROOT = join(__dirname, '..', '..', '..', 'public', 'textures');

describe('texture sets', () => {
  it('have every file they list on disk, credited', () => {
    for (const s of fileSets()) {
      for (const file of Object.values(s.files)) expect(existsSync(join(ROOT, s.id, file)), `${s.id}/${file}`).toBe(true);
      expect(s.license).toBe('CC0');
    }
    expect(fileSets().length).toBe(11);
  });

  it('give real sizes, a grain direction and means in range', () => {
    for (const s of Object.values(TEXTURE_SETS)) {
      expect(s.size.every((x) => x > 0 && x < 200), s.id).toBe(true);
      expect(s.roughnessMean > 0 && s.roughnessMean <= 1, s.id).toBe(true);
      expect(s.avg).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(TEXTURE_SETS['wood-oak']!.grain).toBe('v');
    expect(TEXTURE_SETS['wood-maple']!.grain).toBe('u');
  });

  it('draws the procedural sets: tiling, the maps they list, roughness averaging to the manifest', () => {
    for (const s of Object.values(TEXTURE_SETS).filter((x) => x.procedural)) {
      for (const kind of ['color', 'normal', 'roughness'] as MapKind[]) {
        const px = proceduralMap(s.procedural!, kind);
        expect(!!px, `${s.id}/${kind}`).toBe(!!s.files[kind]);
        if (!px) continue;
        expect(px.data.length).toBe(px.width * px.height * 4);
        if (kind === 'roughness') {
          let sum = 0;
          for (let i = 1; i < px.data.length; i += 4) sum += px.data[i]!;
          expect(sum / (px.width * px.height) / 255).toBeCloseTo(s.roughnessMean, 2);
        }
        if (kind === 'normal') {
          // Flat on average, pointing out of the surface.
          let z = 0;
          for (let i = 2; i < px.data.length; i += 4) z += px.data[i]!;
          expect(z / (px.width * px.height)).toBeGreaterThan(200);
        }
      }
    }
  });
});
