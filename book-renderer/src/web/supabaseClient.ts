import { createClient } from '@supabase/supabase-js';

/**
 * The web app's Supabase client (memory-book-5b plan, Design Decision 1):
 * plain supabase-js session storage (browser `localStorage`, the default —
 * NOT httpOnly cookies), acceptable per the plan for "a first-party,
 * no-third-party-script surface; revisit before 5c payment pages."
 *
 * `book-renderer` is an isolated package (its own deps, no import of the
 * Expo app's `src/lib/supabase.ts` or `src/types/database.ts` — same
 * "copied, not imported" boundary `theme.ts`'s own header comment
 * documents) — this client is untyped (no generated `Database` generic);
 * `types.ts` in this directory hand-picks the narrow row shapes the web app
 * actually reads/writes instead.
 *
 * Env vars: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (Vite's `VITE_`
 * prefix convention — see `vite-env.d.ts` for the `ImportMetaEnv` typing).
 * Both are PUBLIC values (a Supabase anon key is safe in a public bundle by
 * design — RLS is the real boundary) — this is the "only public config
 * (Supabase URL + anon key) reaches the bundle" contract from plan Step 7.
 */

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set them in book-renderer/.env.local (see book-renderer/.env.example) for `npm run dev:web`, or as build-time env for `npm run build:web`.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    // No OAuth/magic-link redirect handoff in this app (email-code OTP
    // only, mirroring the app's own `verify-otp.tsx` flow) — nothing to
    // detect in the URL.
    detectSessionInUrl: false,
  },
});
