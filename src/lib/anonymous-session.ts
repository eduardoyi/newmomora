// Anonymous pre-auth Supabase session (docs/plans/onboarding-implementation.md
// WP0 §0.6, decision 3). Authorizes exactly two pre-auth calls -- S9's
// voice transcription and J2's invite-preview lookup -- and is never used
// for a DB write. Mirrors the `ServiceError` shape used by
// src/services/family.ts so callers can handle it the same way as any
// other service error.
import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

function mapAuthError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

/**
 * Ensures a JWT exists for pre-auth server calls. Never used for DB writes
 * -- see decision 3. A no-op when any session (anonymous or real) already
 * exists, so it is safe to call on every mount/retry without creating
 * duplicate anonymous users. Never throws: a failure (e.g. anonymous
 * sign-ins disabled on the Supabase project) is returned as a
 * `ServiceError` so callers degrade honestly instead of crashing (risk #1:
 * S9 falls back to typing with a plain message; J2 asks the user to
 * continue and confirm the family after signing in).
 */
export async function ensureAnonymousSession(): Promise<{ error: ServiceError | null }> {
  try {
    const { data, error: getSessionError } = await supabase.auth.getSession();

    if (getSessionError) {
      return { error: mapAuthError(getSessionError) };
    }

    if (data.session) {
      // Already signed in -- anonymous or real, either way a JWT exists.
      return { error: null };
    }

    const { error: signInError } = await supabase.auth.signInAnonymously();

    return { error: signInError ? mapAuthError(signInError) : null };
  } catch (error) {
    return {
      error: { message: error instanceof Error ? error.message : 'Something went wrong. Please try again.' },
    };
  }
}

/**
 * Drops the anonymous session so the real OTP sign-in starts clean -- no DB
 * writes ever happen under it, and it must not linger once the user has a
 * real account. No-op when the current session isn't anonymous, or when
 * there is no session at all.
 *
 * Best-effort and silent by design: a failed sign-out here is never fatal
 * (the anonymous session is superseded a moment later by the real OTP
 * session regardless), so this never throws and never surfaces an error --
 * matching its `Promise<void>` contract.
 */
export async function discardAnonymousSession(): Promise<void> {
  try {
    const { data, error: getSessionError } = await supabase.auth.getSession();

    if (getSessionError || !data.session || !data.session.user.is_anonymous) {
      return;
    }

    await supabase.auth.signOut();
  } catch {
    // Best-effort discard -- never blocks the caller from proceeding to
    // the real OTP sign-in.
  }
}
