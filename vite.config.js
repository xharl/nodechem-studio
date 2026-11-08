import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // The queue and runner suites drive real child processes and wait on files
    // landing in the run folder. Vitest's 5 s default is a statement about the
    // speed of the CI runner, not about the code, and windows-latest loses that
    // bet: the crash-recovery test timed out waiting for a persisted state that
    // does arrive. Assertions are unchanged; only the patience is.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
