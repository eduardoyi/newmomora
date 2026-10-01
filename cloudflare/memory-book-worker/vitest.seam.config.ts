import { defineConfig } from 'vitest/config';

// Plain Node pool (NOT workerd) so the env-gated seam export in
// test/outline.everything.test.ts can write a file. Used only for:
//   SEAM_OUT=<path> npx vitest run -c vitest.seam.config.ts
// The normal `npm test` (workers pool) skips that test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/outline.everything.test.ts'],
  },
});
