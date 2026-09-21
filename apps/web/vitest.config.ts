import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // Pure-logic tests stay in node; component tests (*.test.tsx) get a DOM.
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    testTimeout: 20_000,
    setupFiles: ['./src/testing/setup.ts'],
  },
});
