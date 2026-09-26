import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const stubs = fileURLToPath(new URL('./test/helpers/cloudflare-stubs.ts', import.meta.url));

export default defineConfig({
  resolve: {
    // workerd-only modules; the Workflow class needs them to load in Node.
    alias: {
      'cloudflare:workers': stubs,
      'cloudflare:workflows': stubs,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
