import { render, waitFor } from '@testing-library/react-native';

import OnboardingLayout from '../../app/(onboarding)/_layout';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { rootRoute } from '@/lib/routes';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest mock factories must load runtime dependencies lazily
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    Redirect: jest.fn(({ href }: { href: unknown }) => <Text>{`redirect:${JSON.stringify(href)}`}</Text>),
    Stack: Object.assign(
      ({ children }: { children: React.ReactNode }) => <>{children}</>,
      { Screen: () => null },
    ),
    useGlobalSearchParams: jest.fn(() => ({})),
    usePathname: jest.fn(() => '/welcome'),
  };
});

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  OnboardingFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;

describe('OnboardingLayout authenticated history guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ session: { user: { id: 'user-1' } }, isLoading: false } as never);
    mockedUseFamily.mockReturnValue({ memberships: [{ familyId: 'family-1' }] } as never);
    mockedUseOnboardingFlow.mockReturnValue({
      draft: {
        version: 1,
        step: 'welcome',
        kidNames: [],
        familyName: '',
        capture: null,
        notificationChoice: null,
      },
      isHydrated: true,
    } as never);
  });

  it('routes an authenticated family member out of a stale welcome entry', async () => {
    const { getByText } = render(<OnboardingLayout />);

    await waitFor(() => {
      expect(getByText(`redirect:${JSON.stringify(rootRoute)}`)).toBeTruthy();
    });
  });

  it('does not eject the authenticated user from the legitimate paywall arc', () => {
    jest.requireMock('expo-router').usePathname.mockReturnValue('/paywall');

    const { queryByText } = render(<OnboardingLayout />);

    expect(queryByText(`redirect:${JSON.stringify(rootRoute)}`)).toBeNull();
  });
});
