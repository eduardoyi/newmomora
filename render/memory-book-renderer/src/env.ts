/**
 * Environment/config surface for the render worker (memory-book-5c plan,
 * Step 3). Read once at process start (`src/index.ts`) and threaded through
 * explicitly rather than read ad hoc from `process.env` all over the
 * codebase — fail loudly, once, at boot if something required is missing,
 * matching the repo-wide "report rather than guess" posture (see e.g.
 * `supabase/functions/_shared/r2.ts`'s `getR2Config`).
 *
 * This worker never holds a Prodigi key or a DB credential (Decision 2/3's
 * "blast-radius control" — see plan §Risks "Render worker compromise blast
 * radius") — only R2 read/write creds and its own HMAC secret.
 */

export interface RenderWorkerEnv {
  port: number;
  /** Shared secret for the timestamp+nonce+raw-body HMAC scheme (crypto.ts) gating every public op except /health. */
  hmacSecret: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
  };
  /**
   * Absolute path to book-renderer's PII-safe print build
   * (`vite.print.config.ts`'s `dist-print/` output — see that file and the
   * Dockerfile). Defaults to the path the Dockerfile COPYs it to; overridable
   * for local dev/tests against a manually-built dist-print.
   */
  servedDistDir: string;
  /** Puppeteer page-render worker pool size — forwarded to renderBookPdfs(). */
  concurrency: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`memory-book-renderer: missing required env var ${name}`);
  }
  return value;
}

export function loadEnv(): RenderWorkerEnv {
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 8080,
    hmacSecret: requireEnv('RENDER_WORKER_HMAC_SECRET'),
    r2: {
      accountId: requireEnv('R2_ACCOUNT_ID'),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      endpoint: requireEnv('R2_ENDPOINT'),
      bucket: requireEnv('R2_BUCKET'),
    },
    servedDistDir: process.env.BOOK_RENDERER_DIST_DIR ?? '/app/book-renderer/dist-print',
    concurrency: process.env.RENDER_CONCURRENCY ? Number(process.env.RENDER_CONCURRENCY) : 4,
  };
}
