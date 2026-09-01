import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Required secret names are declared in wrangler.jsonc. These are test-only
// values so Wrangler can instantiate the local Worker without a .dev.vars file.
process.env.DISPATCH_SIGNING_SECRET ??= 'test-dispatch-secret';
process.env.SUPABASE_BRIDGE_HMAC_SECRET ??= 'test-bridge-secret';
process.env.OPENAI_API_KEY ??= 'test-openai-key';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          DISPATCH_SIGNING_SECRET: 'test-dispatch-secret',
          SUPABASE_BRIDGE_HMAC_SECRET: 'test-bridge-secret',
          OPENAI_API_KEY: 'test-openai-key',
        },
      },
    }),
  ],
  test: {
    pool: '@cloudflare/vitest-pool-workers',
    include: ['test/**/*.test.ts'],
  },
});
