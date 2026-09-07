/// <reference types="vite/client" />

// The `shop.usemomora.com` web app's public config (memory-book-5b plan,
// Design Decision 1/Step 7 — "only public config (Supabase URL + anon key)
// reaches the bundle"). See `src/web/supabaseClient.ts`. Not used by the
// preview/print entries.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
