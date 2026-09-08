import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // The Docker/PII proof test shells out to a real `docker build` + `docker
    // run` (see test/pii-image.test.ts) — that alone can take minutes on a
    // cold image-layer cache.
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
  },
});
