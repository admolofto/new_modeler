// Builds the hosted app in Vercel's Build Output API layout (.vercel/output): the static app,
// plus one Node function for the AI endpoints (server/hostedEntry.ts, all dependencies bundled).
// Vercel runs this as the project's build command; it also runs locally to check the output.
// Usage: node scripts/build-vercel.mjs   (after `npm run build` has produced dist/)
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel', 'output');
const FUNC = join(OUT, 'functions', 'api', 'ai.func');

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, 'dist'), join(OUT, 'static'), { recursive: true });

await build({
  root: ROOT,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: join(ROOT, 'server', 'hostedEntry.ts'),
    outDir: FUNC,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'index.mjs', codeSplitting: false } },
  },
});

await writeFile(join(FUNC, 'package.json'), JSON.stringify({ type: 'module' }));
await writeFile(
  join(FUNC, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 300 }, null, 2),
);
await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // New builds load at once: the page itself is never cached, its hashed assets are.
        { src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '/(index\\.html)?', headers: { 'cache-control': 'no-cache' }, continue: true },
        { src: '/api/ai/(.*)', dest: '/api/ai?path=$1' },
        { handle: 'filesystem' },
      ],
    },
    null,
    2,
  ),
);
console.log('Vercel output written to .vercel/output');
