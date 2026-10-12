import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAppearance, HOVER_LIFT } from './appearance';
import { configureTexture, type TextureProvider } from './textures';
import { TEXTURE_SETS, type MapKind } from './textureSets';

/** Every set's maps, as the real provider configures them (no images: nothing is drawn). */
function fakeTextures(): TextureProvider & { made: Map<string, THREE.Texture> } {
  const made = new Map<string, THREE.Texture>();
  return {
    made,
    get(id, kind: MapKind) {
      const set = TEXTURE_SETS[id];
      if (!set?.files[kind]) return null;
      const key = `${id}/${kind}`;
      if (!made.has(key)) made.set(key, configureTexture(new THREE.Texture(), set, kind, 8));
      return made.get(key)!;
    },
  };
}

const phys = (m: THREE.Material) => m as THREE.MeshPhysicalMaterial;

describe('appearance', () => {
  const textures = fakeTextures();
  const look = createAppearance(textures);

  it('textures wood from its set: sRGB color, linear data maps, repeat per real size, turned when the grain runs along u', () => {
    const oak = phys(look.material({ finish: { preset: 'wood:white-oak' } }));
    expect(oak.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(oak.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(oak.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(oak.map!.wrapS).toBe(THREE.RepeatWrapping);
    expect(oak.map!.repeat.x).toBeCloseTo(1 / TEXTURE_SETS['wood-oak']!.size[0]);
    expect(oak.map!.rotation).toBe(0);
    expect(oak.map!.anisotropy).toBe(8);
    const maple = phys(look.material({ finish: { preset: 'wood:maple' } }));
    expect(maple.map!.rotation).toBeCloseTo(Math.PI / 2);
    // The roughness map is scaled so its mean lands on the finish's roughness.
    expect(oak.roughness * TEXTURE_SETS['wood-oak']!.roughnessMean).toBeCloseTo(0.5);
    expect(oak.clearcoat).toBeGreaterThan(0);
  });

  it('stains a photo by the finish color; red oak is the oak photo, warmer', () => {
    const plain = phys(look.material({ finish: { preset: 'wood:white-oak' } }));
    const stained = phys(look.material({ finish: { preset: 'wood:white-oak', color: '#808080' } }));
    expect(stained).not.toBe(plain);
    expect(stained.map).toBe(plain.map);
    expect(stained.color.r).toBeLessThan(plain.color.r);
    const red = phys(look.material({ finish: { preset: 'wood:red-oak' } }));
    expect(red.map).toBe(plain.map);
    expect(red.color.r / red.color.b).toBeGreaterThan(plain.color.r / plain.color.b);
  });

  it('paints in the paint color over a fine normal, no color map', () => {
    const p = phys(look.material({ finish: { preset: 'paint', color: '#1f2a44' } }));
    expect(`#${p.color.getHexString()}`).toBe('#1f2a44');
    expect(p.map).toBeNull();
    expect(p.normalMap?.name).toBe('paint-micro/normal');
    expect(p.normalScale.x).toBeCloseTo(0.07);
  });

  it('makes metals metallic and brushed, glass see-through, light glow', () => {
    const nickel = phys(look.material({ finish: { preset: 'metal:brushed-nickel' } }));
    expect([nickel.metalness, nickel.anisotropy]).toEqual([1, 0.5]);
    expect(phys(look.material({ finish: { preset: 'metal:chrome' } })).metalness).toBe(1);
    const glass = phys(look.material({ finish: { preset: 'glass:clear' } }));
    expect([glass.transparent, glass.depthWrite, glass.opacity]).toEqual([true, false, 0.12]);
    const bulb = phys(look.material({ finish: { preset: 'light' } }));
    expect(bulb.emissiveIntensity).toBeCloseTo(6);
    look.setFixtureLevel(0.5);
    expect(bulb.emissiveIntensity).toBeCloseTo(3);
    look.setFixtureLevel(1);
  });

  it('shares a material per look, and its hover clone shares the maps', () => {
    const a = look.material({ finish: { preset: 'wood:walnut' } });
    expect(look.material({ finish: { preset: 'wood:walnut' } })).toBe(a);
    const h = phys(look.hover(a));
    expect(h).not.toBe(a);
    expect(look.hover(a)).toBe(h);
    expect(h.map).toBe(phys(a).map);
    expect(h.normalMap).toBe(phys(a).normalMap);
    expect(h.emissiveIntensity).toBeCloseTo(HOVER_LIFT);
  });

  it('has a shadow-only material that writes no color or depth', () => {
    expect([look.shadowOnly.colorWrite, look.shadowOnly.depthWrite]).toEqual([false, false]);
  });

  it('makes standard materials on the Fast tier, and drops its cache on a switch', () => {
    const before = look.material({ finish: { preset: 'stone:quartz-white' } });
    expect(before).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    look.setPhysical(false);
    const after = look.material({ finish: { preset: 'stone:quartz-white' } });
    expect(after).not.toBe(before);
    expect(after).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(after).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((after as THREE.MeshStandardMaterial).map).toBe(textures.made.get('stone-quartz/color'));
    look.setPhysical(true);
  });

  it('draws a finish flat in its swatch until its textures arrive', () => {
    const none = createAppearance({ get: () => null });
    const oak = phys(none.material({ finish: { preset: 'wood:walnut' } }));
    expect([oak.map, `#${oak.color.getHexString()}`]).toEqual([null, '#6b4a33']);
  });
});
