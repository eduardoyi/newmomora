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
import { supabase } from '@/lib/supabase';
import {
  getDeviceTimezone,
  isUserNotFoundOtpError,
  mapAuthError,
  type AuthError,
  type PasswordSignInInput,
  type RequestSignInOtpResult,
  type RequestSignUpOtpInput,
  type VerifyOtpInput,
} from '@/services/auth';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  requestSignInOtp: (email: string) => Promise<RequestSignInOtpResult>;
  requestSignUpOtp: (input: RequestSignUpOtpInput) => Promise<{ error: AuthError | null }>;
  verifyOtp: (input: VerifyOtpInput) => Promise<{ error: AuthError | null }>;
  /** Dev/E2E only — password provider stays enabled server-side; UI access is __DEV__-gated. */
  signInWithPassword: (input: PasswordSignInInput) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
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

  const requestSignInOtp = useCallback(async (email: string): Promise<RequestSignInOtpResult> => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
      },
    });

    if (!error) {
      return { error: null, userNotFound: false };
    }

    return { error: mapAuthError(error), userNotFound: isUserNotFoundOtpError(error) };
  }, []);

  const requestSignUpOtp = useCallback(async ({ name, email }: RequestSignUpOtpInput) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        data: {
          name: name.trim(),
          timezone: getDeviceTimezone(),
        },
      },
    });

    return { error: error ? mapAuthError(error) : null };
  }, []);

  const verifyOtp = useCallback(async ({ email, token }: VerifyOtpInput) => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    });

    return { error: error ? mapAuthError(error) : null };
  }, []);

  const signInWithPassword = useCallback(async (input: PasswordSignInInput) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: input.email.trim(),
      password: input.password,
    });

    return { error: error ? mapAuthError(error) : null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isLoading,
      requestSignInOtp,
      requestSignUpOtp,
      verifyOtp,
      signInWithPassword,
      signOut,
    }),
    [session, isLoading, requestSignInOtp, requestSignUpOtp, verifyOtp, signInWithPassword, signOut],
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
