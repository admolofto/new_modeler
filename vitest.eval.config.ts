import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Live AI evals (npm run eval). Separate from unit tests: they call Claude (Claude Code login or API key).
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    env: loadEnv('', process.cwd(), ''),
    testTimeout: 10 * 60_000,
    maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 3,
  },
});
