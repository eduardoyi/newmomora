import { render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import InviteLinkScreen from '../../app/invite';
import { onboardingJoinFoundRoute } from '@/lib/onboarding-routes';
import { sharingRedeemRoute } from '@/lib/routes';
import { useAuth } from '@/hooks/use-auth';
import { setPendingInviteCode } from '@/utils/pending-invite-code';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
  },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/utils/pending-invite-code', () => ({
  setPendingInviteCode: jest.fn().mockResolvedValue(undefined),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<
  typeof useLocalSearchParams
>;
const mockedSetPendingInviteCode = setPendingInviteCode as jest.MockedFunction<
  typeof setPendingInviteCode
>;

function makeSession(isAnonymous: boolean): NonNullable<ReturnType<typeof useAuth>['session']> {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: 'test-user-id',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-01-01T00:00:00.000Z',
      is_anonymous: isAnonymous,
    },
  };
}

function authState(isAnonymous: boolean | null): ReturnType<typeof useAuth> {
  const session = isAnonymous === null ? null : makeSession(isAnonymous);

  return {
    session,
    user: session?.user ?? null,
    isLoading: false,
    requestSignInOtp: jest.fn(),
    requestSignUpOtp: jest.fn(),
    verifyOtp: jest.fn(),
    signInWithPassword: jest.fn(),
    signOut: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseLocalSearchParams.mockReturnValue({ code: 'falafel-frost-plum' });
  mockedUseAuth.mockReturnValue(authState(null));
});

describe('InviteLinkScreen', () => {
  it('routes an anonymous session through onboarding instead of redemption', async () => {
    mockedUseAuth.mockReturnValue(authState(true));

    render(<InviteLinkScreen />);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingJoinFoundRoute);
    });
    expect(mockedSetPendingInviteCode).toHaveBeenCalledWith('falafel-frost-plum');
  });

  it('routes a permanent session directly to redemption', async () => {
    mockedUseAuth.mockReturnValue(authState(false));

    render(<InviteLinkScreen />);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(sharingRedeemRoute);
    });
  });
});
