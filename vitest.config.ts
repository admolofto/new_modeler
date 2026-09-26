import { defineConfig } from 'vitest/config';

// Unit tests. Kept apart from vite.config.ts so tests don't load the dev server's AI plugin.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
