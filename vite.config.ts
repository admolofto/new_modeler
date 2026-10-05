import { defineConfig, loadEnv } from 'vite';
import { aiProxy } from './server/aiProxy.ts';

export default defineConfig(({ mode }) => ({
  server: { port: 5173, strictPort: true },
  // '' prefix: provider keys and CLI configuration stay server-side; none is exposed to the page.
  plugins: [aiProxy({ ...process.env, ...loadEnv(mode, process.cwd(), '') })],
}));
