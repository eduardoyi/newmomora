import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';

/**
 * Session state + the OTP auth idiom (mirrors the app's `src/hooks/use-auth.tsx`
 * `requestSignInOtp`/`verifyOtp`, and the flow in `app/(auth)/verify-otp.tsx`).
 * `shouldCreateUser: false` — this web app is a sign-IN surface for an
 * existing Momora account (the app is where a family signs up); a parent who
 * hasn't onboarded in the app yet is told so, not silently signed up here.
 */
export function useAuthSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session);
        setLoading(false);
      }
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

export async function requestSignInOtp(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false },
  });
  return { error: error?.message ?? null };
}

export async function verifyEmailOtp(email: string, token: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
