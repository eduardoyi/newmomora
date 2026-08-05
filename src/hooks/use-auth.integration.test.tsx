import type { Session } from '@supabase/supabase-js';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { clearPersistedQueryCache } from '@/lib/query-persistence';
import { supabase } from '@/lib/supabase';
import { identifyUser, resetAnalytics } from '@/services/analytics';

jest.mock('@/hooks/use-auth-url-handler', () => ({
  useAuthUrlHandler: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  identifyUser: jest.fn(),
  resetAnalytics: jest.fn(),
}));

jest.mock('@/lib/query-persistence', () => ({
  clearPersistedQueryCache: jest.fn().mockResolvedValue(undefined),
}));

const mockedClearPersistedQueryCache = clearPersistedQueryCache as jest.Mock;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    },
  },
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedIdentifyUser = identifyUser as jest.Mock;
const mockedResetAnalytics = resetAnalytics as jest.Mock;

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    mockedSupabase.auth.onAuthStateChange.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: jest.fn(),
        },
      },
    } as never);
  });

  it('requests a sign-in OTP without creating a new account', async () => {
    mockedSupabase.auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.requestSignInOtp('parent@example.com');

    expect(response.error).toBeNull();
    expect(response.userNotFound).toBe(false);
    expect(mockedSupabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'parent@example.com',
      options: {
        shouldCreateUser: false,
      },
    });
  });

  it('flags the user-not-found case so the caller can route to signup', async () => {
    mockedSupabase.auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: { message: 'Signups not allowed for otp', code: 'otp_disabled' } as never,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.requestSignInOtp('newperson@example.com');

    expect(response.userNotFound).toBe(true);
    expect(response.error?.message).toBe('Signups not allowed for otp');
  });

  it('exposes other sign-in OTP errors without flagging user-not-found', async () => {
    mockedSupabase.auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: { message: 'Email rate limit exceeded', code: 'over_email_send_rate_limit' } as never,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.requestSignInOtp('parent@example.com');

    expect(response.userNotFound).toBe(false);
    expect(response.error?.message).toBe('Email rate limit exceeded');
  });

  it('requests a sign-up OTP with name and timezone metadata', async () => {
    mockedSupabase.auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.requestSignUpOtp({
      name: 'Alex',
      email: 'alex@example.com',
    });

    expect(response.error).toBeNull();
    expect(mockedSupabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'alex@example.com',
      options: {
        shouldCreateUser: true,
        data: expect.objectContaining({
          name: 'Alex',
          timezone: expect.any(String),
        }),
      },
    });
  });

  it('verifies an OTP code against the email', async () => {
    mockedSupabase.auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.verifyOtp({ email: 'alex@example.com', token: '123456' });

    expect(response.error).toBeNull();
    expect(mockedSupabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'alex@example.com',
      token: '123456',
      type: 'email',
    });
  });

  it('exposes verifyOtp errors', async () => {
    mockedSupabase.auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null } as never,
      error: { message: 'Token has expired or is invalid', code: 'otp_expired' } as never,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.verifyOtp({ email: 'alex@example.com', token: '000000' });

    expect(response.error?.message).toBe('Token has expired or is invalid');
  });

  it('review/dev path: signs in with a password', async () => {
    mockedSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null } as never,
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.signInWithPassword({
      email: 'parent@example.com',
      password: 'password123',
    });

    expect(response.error).toBeNull();
    expect(mockedSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'parent@example.com',
      password: 'password123',
    });
  });

  it('maps password sign-in failures for the reviewer UI', async () => {
    mockedSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null } as never,
      error: { message: 'Invalid login credentials', code: 'invalid_credentials' } as never,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.signInWithPassword({
      email: 'reviewer@example.com',
      password: 'incorrect-password',
    });

    expect(response.error).toEqual({
      message: 'Invalid login credentials',
      code: 'invalid_credentials',
    });
  });

  it('throws when Supabase cannot sign out', async () => {
    mockedSupabase.auth.signOut.mockResolvedValue({
      error: { message: 'session unavailable' },
    } as never);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await expect(result.current.signOut()).rejects.toEqual(
      expect.objectContaining({ message: 'session unavailable' }),
    );
    // The persisted cache must NOT be purged on a failed sign-out -- the
    // session is still live.
    expect(mockedClearPersistedQueryCache).not.toHaveBeenCalled();
  });

  it('purges the persisted query cache after a successful sign-out (O4, docs/plans/offline-awareness-and-share-cards.md)', async () => {
    mockedSupabase.auth.signOut.mockResolvedValue({ error: null } as never);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.signOut();

    expect(mockedClearPersistedQueryCache).toHaveBeenCalledTimes(1);
  });
});

// docs/plans/analytics-implementation.md WP1.5 -- the anonymous-session
// guard is the critical piece: anonymous sessions (created for S9 voice
// transcription / J2 invite preview via signInAnonymously()) must never
// trigger identify/reset, only non-anonymous sessions may.
describe('useAuth analytics identity', () => {
  let authChangeCallback: (event: string, session: Session | null) => void = () => undefined;

  function fakeSession(userId: string, isAnonymous: boolean): Session {
    return {
      access_token: 'token',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'bearer',
      user: {
        id: userId,
        is_anonymous: isAnonymous,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
      },
    } as unknown as Session;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    mockedSupabase.auth.onAuthStateChange.mockImplementation((callback) => {
      authChangeCallback = callback as unknown as (event: string, session: Session | null) => void;
      return {
        data: {
          subscription: {
            unsubscribe: jest.fn(),
          },
        },
      } as never;
    });
  });

  it('is a no-op when an anonymous session appears, then a strict no-op when it is discarded', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('anon-1', true));
    });

    expect(mockedIdentifyUser).not.toHaveBeenCalled();
    expect(mockedResetAnalytics).not.toHaveBeenCalled();

    act(() => {
      // discardAnonymousSession() drops the throwaway session before the
      // real OTP sign-in.
      authChangeCallback('SIGNED_OUT', null);
    });

    expect(mockedIdentifyUser).not.toHaveBeenCalled();
    expect(mockedResetAnalytics).not.toHaveBeenCalled();
  });

  it('identifies with the real user id once a non-anonymous session arrives after an anonymous one', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('anon-1', true));
    });
    act(() => {
      authChangeCallback('SIGNED_OUT', null);
    });
    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-1', false));
    });

    expect(mockedIdentifyUser).toHaveBeenCalledTimes(1);
    expect(mockedIdentifyUser).toHaveBeenCalledWith('real-user-1');
    // No prior identified user, so no reset is expected on first identify.
    expect(mockedResetAnalytics).not.toHaveBeenCalled();
  });

  it('resets analytics when a real (non-anonymous) session signs out', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-1', false));
    });
    expect(mockedIdentifyUser).toHaveBeenCalledWith('real-user-1');

    act(() => {
      authChangeCallback('SIGNED_OUT', null);
    });

    expect(mockedResetAnalytics).toHaveBeenCalledTimes(1);
  });

  it('purges the persisted query cache when a real session ends WITHOUT going through signOut() (O4) -- e.g. a revoked token, or an eventually hard-deleted account', async () => {
    // This is the backstop the explicit signOut()-path test above doesn't
    // cover: supabase-js can flip the session to null on its own (a
    // forced sign-out) via onAuthStateChange, never calling this hook's
    // signOut() function. A device must still never keep serving a real
    // user's cached family/memories after their session is gone, however
    // that happened.
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-1', false));
    });
    expect(mockedClearPersistedQueryCache).not.toHaveBeenCalled();

    act(() => {
      authChangeCallback('SIGNED_OUT', null);
    });

    expect(mockedClearPersistedQueryCache).toHaveBeenCalledTimes(1);
  });

  it('does not purge when an anonymous session appears and disappears with no prior real session', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('anon-1', true));
    });
    act(() => {
      authChangeCallback('SIGNED_OUT', null);
    });

    expect(mockedClearPersistedQueryCache).not.toHaveBeenCalled();
  });

  it('resets then re-identifies when switching between two different non-anonymous users', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-1', false));
    });
    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-2', false));
    });

    expect(mockedResetAnalytics).toHaveBeenCalledTimes(1);
    expect(mockedIdentifyUser).toHaveBeenNthCalledWith(1, 'real-user-1');
    expect(mockedIdentifyUser).toHaveBeenNthCalledWith(2, 'real-user-2');
  });

  it('does not re-identify or reset on a repeated auth event for the same real user', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      authChangeCallback('SIGNED_IN', fakeSession('real-user-1', false));
    });
    act(() => {
      // e.g. a token refresh firing onAuthStateChange again for the same user.
      authChangeCallback('TOKEN_REFRESHED', fakeSession('real-user-1', false));
    });

    expect(mockedIdentifyUser).toHaveBeenCalledTimes(1);
    expect(mockedResetAnalytics).not.toHaveBeenCalled();
  });
});
