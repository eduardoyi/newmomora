export interface Env {
  ASSETS: Fetcher;
}

/**
 * Static-assets Worker for `book.usemomora.com` (memory-book-5b plan Step
 * 7). Serves `book-renderer`'s dedicated `dist-web/` build (see
 * `wrangler.jsonc`'s header comment for the PII-safety chain this depends
 * on) with SPA fallback: any request the asset store can't resolve
 * (`/`, `/b/<bookId>`, a hard reload/deep link on either — this app's own
 * `src/web/router.ts` handles those paths client-side) serves `web.html`
 * instead of a 404, so client-side routing works on a fresh load.
 *
 * Deliberately NOT using Cloudflare's built-in
 * `assets.not_found_handling: "single-page-application"` config option:
 * that convention specifically serves whatever is named `index.html` at
 * the asset directory's root, but this app's single Vite entry is named
 * `web.html` (plan Step 6's own naming) — `dist-web/` intentionally has no
 * `index.html` at all (the bundle check in `book-renderer/scripts/
 * check-web-bundle.mjs` asserts exactly that, since `index.html` is the
 * OTHER Vite config's preview entry name). A few lines of explicit
 * fallback logic here is simpler and more honest than renaming the entry
 * just to fit a convention that assumes a different filename.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) {
      return response;
    }

    const fallbackUrl = new URL('/web.html', request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  },
};
