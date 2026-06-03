import * as QueryParams from 'expo-auth-session/build/QueryParams';

import { createSessionFromUrl } from '@/lib/create-session-from-url';
import { supabase } from '@/lib/supabase';

jest.mock('expo-auth-session/build/QueryParams', () => ({
  getQueryParams: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      setSession: jest.fn(),
    },
  },
}));

const mockedQueryParams = QueryParams as jest.Mocked<typeof QueryParams>;
const mockedSupabase = supabase as jest.Mocked<typeof supabase>;

describe('createSessionFromUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets session when tokens are present', async () => {
    mockedQueryParams.getQueryParams.mockReturnValue({
      params: {
        access_token: 'access',
        refresh_token: 'refresh',
      },
      errorCode: null,
    });
    mockedSupabase.auth.setSession.mockResolvedValue({ data: { session: null }, error: null });

    const didSetSession = await createSessionFromUrl('momora://auth/callback#access_token=access');

    expect(didSetSession).toBe(true);
    expect(mockedSupabase.auth.setSession).toHaveBeenCalledWith({
      access_token: 'access',
      refresh_token: 'refresh',
    });
  });

  it('returns false when tokens are missing', async () => {
    mockedQueryParams.getQueryParams.mockReturnValue({
      params: {},
      errorCode: null,
    });

    const didSetSession = await createSessionFromUrl('momora://auth/callback');

    expect(didSetSession).toBe(false);
    expect(mockedSupabase.auth.setSession).not.toHaveBeenCalled();
  });
});
