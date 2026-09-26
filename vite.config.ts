import { defineConfig, loadEnv } from 'vite';
import { aiProxy } from './server/aiProxy.ts';

export default defineConfig(({ mode }) => ({
  server: { port: 5173, strictPort: true },
  // '' prefix: the proxy reads ANTHROPIC_API_KEY / AI_* / CLAUDE_CODE_* server-side; none of it is exposed to the page.
  plugins: [aiProxy({ ...process.env, ...loadEnv(mode, process.cwd(), '') })],
}));
