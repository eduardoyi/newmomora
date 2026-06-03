import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { supabase } from '@/lib/supabase';

jest.mock('@/hooks/use-auth-url-handler', () => ({
  useAuthUrlHandler: jest.fn(),
}));

jest.mock('@/lib/auth-redirect', () => ({
  getAuthRedirectUri: jest.fn(() => 'momora://auth/callback'),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
      resetPasswordForEmail: jest.fn(),
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

  it('exposes sign-in errors from Supabase', async () => {
    mockedSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials', code: 'invalid_credentials' } as never,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.signIn({
      email: 'parent@example.com',
      password: 'password123',
    });

    expect(response.error?.message).toBe('Invalid login credentials');
  });

  it('passes signup metadata for profile creation', async () => {
    mockedSupabase.auth.signUp.mockResolvedValue({
      data: { session: null, user: { id: 'user-1' } as never, session: null },
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const response = await result.current.signUp({
      name: 'Alex',
      email: 'alex@example.com',
      password: 'password123',
    });

    expect(response.needsEmailConfirmation).toBe(true);
    expect(mockedSupabase.auth.signUp).toHaveBeenCalledWith({
      email: 'alex@example.com',
      password: 'password123',
      options: {
        emailRedirectTo: 'momora://auth/callback',
        data: expect.objectContaining({
          name: 'Alex',
          timezone: expect.any(String),
        }),
      },
    });
  });
});
