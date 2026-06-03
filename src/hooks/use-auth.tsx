import type { Session, User } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuthUrlHandler } from '@/hooks/use-auth-url-handler';
import { getAuthRedirectUri } from '@/lib/auth-redirect';
import { supabase } from '@/lib/supabase';
import {
  getDeviceTimezone,
  mapAuthError,
  type AuthError,
  type SignInInput,
  type SignUpInput,
  type SignUpResult,
} from '@/services/auth';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  signIn: (input: SignInInput) => Promise<{ error: AuthError | null }>;
  signUp: (input: SignUpInput) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: AuthError | null }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useAuthUrlHandler();

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (isMounted) {
        setSession(data.session);
        setIsLoading(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (input: SignInInput) => {
    const { error } = await supabase.auth.signInWithPassword(input);
    return { error: error ? mapAuthError(error) : null };
  }, []);

  const signUp = useCallback(async (input: SignUpInput): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        emailRedirectTo: getAuthRedirectUri(),
        data: {
          name: input.name.trim(),
          timezone: getDeviceTimezone(),
        },
      },
    });

    if (error) {
      return { error: mapAuthError(error), needsEmailConfirmation: false };
    }

    return {
      error: null,
      needsEmailConfirmation: Boolean(data.user && !data.session),
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: getAuthRedirectUri(),
    });

    return { error: error ? mapAuthError(error) : null };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isLoading,
      signIn,
      signUp,
      signOut,
      resetPassword,
    }),
    [session, isLoading, signIn, signUp, signOut, resetPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}
