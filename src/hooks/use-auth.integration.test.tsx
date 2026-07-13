import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { supabase } from '@/lib/supabase';

jest.mock('@/hooks/use-auth-url-handler', () => ({
  useAuthUrlHandler: jest.fn(),
}));

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

  it('dev/E2E path: signs in with a password', async () => {
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
  });
});
