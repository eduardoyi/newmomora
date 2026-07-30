import { createClient, type User } from 'npm:@supabase/supabase-js@2';

/**
 * Resolves the caller from the request's Authorization header. Returns the
 * raw Supabase user -- including an anonymous session's user, whose
 * `is_anonymous` field is `true`. This is deliberately permissive: it is the
 * one function `process-voice-memory` depends on for its `mode: 'onboarding'`
 * branch (docs/plans/onboarding-implementation.md WP-SEC), and that file is
 * out of scope for this package, so this function's behavior for an
 * anonymous caller must not change.
 *
 * Every OTHER Edge Function must not call this directly -- use
 * `getAuthenticatedNonAnonymousUser` below instead, which is the actual
 * anonymous-rejection chokepoint for the rest of the app. The only two
 * carve-outs that call this one directly are `process-voice-memory` (already
 * shipped) and `preview-family-invite` (accepts both anonymous and permanent
 * callers by design).
 */
export async function getAuthenticatedUser(req: Request): Promise<User | null> {
  const authHeader = req.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  return user;
}

/**
 * The anonymous-lockdown chokepoint (WP-SEC,
 * docs/plans/onboarding-implementation.md). Every normal Edge Function must
 * use this instead of `getAuthenticatedUser` so an anonymous Auth session
 * (created via `ensureAnonymousSession()` for S9 voice / J2 invite preview)
 * is rejected before it can reach any normal family/paid-AI surface -- with
 * exactly two carve-outs, which call `getAuthenticatedUser` directly instead:
 * `process-voice-memory`'s `mode: 'onboarding'` branch, and
 * `preview-family-invite`.
 *
 * Returns `null` (matching `getAuthenticatedUser`'s "unauthenticated" shape)
 * for a missing/invalid JWT AND for a validly-authenticated anonymous
 * session alike, so every existing "no user -> 401" call site rejects both
 * the same way with no further change.
 */
export async function getAuthenticatedNonAnonymousUser(req: Request): Promise<User | null> {
  const user = await getAuthenticatedUser(req);

  if (!user || user.is_anonymous === true) {
    return null;
  }

  return user;
}
