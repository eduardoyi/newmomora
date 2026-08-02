import type { Session, User } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAuthUrlHandler } from '@/hooks/use-auth-url-handler';
import { supabase } from '@/lib/supabase';
import { identifyUser, resetAnalytics } from '@/services/analytics';
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
  /** Password sign-in for guarded fixture accounts and dev/E2E accounts. */
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

  // Analytics identity (docs/plans/analytics-implementation.md WP1.5).
  // CRITICAL anonymous-session guard: the app creates real Supabase sessions
  // via `signInAnonymously()` (src/lib/anonymous-session.ts) for S9 voice
  // transcription and J2 invite preview, and that throwaway session lives
  // from S9 until the email screen discards it. An anonymous session
  // appearing or disappearing must be a strict no-op -- no identify, no
  // reset -- otherwise pre-auth events get attributed to (and orphaned on) a
  // throwaway person instead of stitching to the real user at identify time.
  // Track only the last non-anonymous id we identified; every decision below
  // is driven off that, not off the raw session transition.
  const identifiedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const currentUser = session?.user ?? null;
    const isRealUser = currentUser !== null && !currentUser.is_anonymous;

    if (isRealUser) {
      if (identifiedUserIdRef.current !== currentUser.id) {
        // Switching from one identified non-anonymous user to a different
        // one -- reset first so events don't merge across two real people.
        if (identifiedUserIdRef.current !== null) {
          resetAnalytics();
        }
        identifyUser(currentUser.id);
        identifiedUserIdRef.current = currentUser.id;
      }
      return;
    }

    // `currentUser` is null (signed out) or anonymous. Only react if we
    // previously identified a real user -- an anonymous session appearing
    // or disappearing while we've never identified anyone is a no-op.
    if (identifiedUserIdRef.current !== null) {
      resetAnalytics();
      identifiedUserIdRef.current = null;
    }
  }, [session]);

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
    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }
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
