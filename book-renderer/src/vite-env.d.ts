/// <reference types="vite/client" />

// The `shop.usemomora.com` web app's public config (memory-book-5b plan,
// Design Decision 1/Step 7 — "only public config (Supabase URL + anon key)
// reaches the bundle"). See `src/web/supabaseClient.ts`. Not used by the
// preview/print entries.
//
// `VITE_STRIPE_PUBLISHABLE_KEY` (checkout address-entry Tier 2, memory-book
// orders): Stripe's publishable key, also safe to expose client-side by
// design (same posture as the Supabase anon key above). See
// `src/web/order/stripeClient.ts`. Optional: an unset/empty value just
// selects the manual `AddressForm` fallback rather than crashing anything —
// see that file's header comment.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
