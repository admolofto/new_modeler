// Downloads the CC0 texture sets presentation mode uses into public/textures/<set>/{color,normal,roughness}.jpg
// and writes public/textures/LICENSES.md. Existing files are kept; pass --force to fetch again.
// Sources: Poly Haven (per-map JPGs) and ambientCG (1K JPG zips; only Color, NormalGL and Roughness are kept).
// Usage: node scripts/fetch-textures.mjs [--force]
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures');
const force = process.argv.includes('--force');

/** Our set id → where it comes from. Poly Haven maps: diff, nor_gl, rough (fabric keeps no color). */
const SETS = [
  { id: 'wood-oak', polyhaven: 'oak_veneer_01', name: 'Oak Veneer 01' },
  { id: 'wood-walnut', polyhaven: 'walnut_veneer', name: 'Walnut Veneer' },
  { id: 'wood-cherry', polyhaven: 'cherry_veneer', name: 'Cherry Veneer' },
  { id: 'wood-maple', polyhaven: 'romantic_veneer', name: 'Romantic Veneer' },
  { id: 'floor-oak-plank', polyhaven: 'oak_wood_planks', name: 'Oak Wood Planks' },
  { id: 'floor-herringbone', polyhaven: 'herringbone_parquet', name: 'Herringbone Parquet' },
  { id: 'floor-concrete', polyhaven: 'brushed_concrete', name: 'Brushed Concrete' },
  { id: 'fabric-weave', polyhaven: 'rough_linen', name: 'Rough Linen', noColor: true },
  { id: 'stone-quartz', ambientcg: 'Marble021', name: 'Marble 021' },
  { id: 'stone-marble', ambientcg: 'Marble012', name: 'Marble 012' },
  { id: 'stone-marble-dark', ambientcg: 'Marble006', name: 'Marble 006' },
];

const exists = (p) => access(p).then(() => true, () => false);

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'new-modeler texture fetch' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Entries of a zip (stored or deflated, no zip64), by name. */
function unzip(buf) {
  const out = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function fetchSet(set) {
  const dir = join(ROOT, set.id);
  await mkdir(dir, { recursive: true });
  const files = set.noColor ? ['normal', 'roughness'] : ['color', 'normal', 'roughness'];
  if (!force && (await Promise.all(files.map((f) => exists(join(dir, `${f}.jpg`))))).every(Boolean)) return `${set.id}: already there`;
  if (set.polyhaven) {
    const id = set.polyhaven;
    const remote = { color: 'diff', normal: 'nor_gl', roughness: 'rough' };
    for (const f of files) {
      const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}_${remote[f]}_1k.jpg`;
      await writeFile(join(dir, `${f}.jpg`), await get(url));
    }
  } else {
    const id = set.ambientcg;
    const zip = unzip(await get(`https://ambientcg.com/get?file=${id}_1K-JPG.zip`));
    const remote = { color: 'Color', normal: 'NormalGL', roughness: 'Roughness' };
    for (const f of files) {
      const entry = zip.get(`${id}_1K-JPG_${remote[f]}.jpg`);
      if (!entry) throw new Error(`${id}: no ${remote[f]} map in the zip (has ${[...zip.keys()].join(', ')})`);
      await writeFile(join(dir, `${f}.jpg`), entry);
    }
  }
  return `${set.id}: fetched`;
}

const lines = [
  '# Texture credits',
  '',
  'All textures here are CC0 (public domain), fetched by `scripts/fetch-textures.mjs` at 1K resolution.',
  '',
  '| Folder | Source | Asset |',
  '|---|---|---|',
];
for (const set of SETS) {
  console.log(await fetchSet(set));
  lines.push(
    set.polyhaven
      ? `| \`${set.id}\` | Poly Haven (CC0) | [${set.name}](https://polyhaven.com/a/${set.polyhaven}) |`
      : `| \`${set.id}\` | ambientCG (CC0) | [${set.name}](https://ambientcg.com/view?id=${set.ambientcg}) |`,
  );
}
await writeFile(join(ROOT, 'LICENSES.md'), lines.join('\n') + '\n');
console.log('wrote public/textures/LICENSES.md');
