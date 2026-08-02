// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers app/index.tsx's analytics additions (docs/plans/
// analytics-implementation.md WP2.7 + WP1.6): `post_auth_destination_resolved`
// fired once per resolved `kind` from an effect (never the render path), and
// the {role, access_reason, membership_count} person properties set from the
// same resolve. The routing behavior itself (resolvePostAuthDestination) is
// already covered by src/lib/onboarding-routing.test.ts -- this suite only
// exercises the screen's own wiring around it.
import { render, waitFor } from '@testing-library/react-native';
import { Redirect } from 'expo-router';

import IndexScreen from '../../app/index';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { timelineRoute } from '@/lib/routes';
import { setPersonProperties, trackEvent } from '@/services/analytics';
import { getOnboardingDraft } from '@/utils/onboarding-progress';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    Redirect: jest.fn(({ href }: { href: unknown }) => <Text>{`redirect:${JSON.stringify(href)}`}</Text>),
  };
});

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/use-billing', () => ({
  useBilling: jest.fn(),
}));

jest.mock('@/utils/onboarding-progress', () => ({
  getOnboardingDraft: jest.fn(),
}));

jest.mock('@/utils/pending-invite-code', () => ({
  getPendingInviteCode: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
  setPersonProperties: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedGetOnboardingDraft = getOnboardingDraft as jest.MockedFunction<typeof getOnboardingDraft>;
const mockedGetPendingInviteCode = getPendingInviteCode as jest.MockedFunction<typeof getPendingInviteCode>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;
const mockedSetPersonProperties = setPersonProperties as jest.MockedFunction<typeof setPersonProperties>;
const mockedRedirect = Redirect as jest.MockedFunction<typeof Redirect>;

// Asserting directly on mock.calls (rather than toHaveBeenCalledWith) sidesteps
// any ambiguity over how many arguments React invokes a function component
// with -- only the `href` prop matters here.
function wasRedirectedTo(href: unknown): boolean {
  return mockedRedirect.mock.calls.some((call) => (call[0] as { href: unknown }).href === href);
}

describe('IndexScreen -- post_auth_destination_resolved + person properties', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetOnboardingDraft.mockResolvedValue(null);
    mockedGetPendingInviteCode.mockResolvedValue(null);
    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1', is_anonymous: false } },
      isLoading: false,
    } as never);
  });

  it('fires post_auth_destination_resolved {kind: journal, access_reason} and person properties for a paid owner', async () => {
    mockedUseFamily.mockReturnValue({
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: 'Our Family' }],
      isLoading: false,
      role: 'owner',
    } as never);
    mockedUseBilling.mockReturnValue({
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: true,
        has_ever_had_access: true,
        trial_eligible: false,
        access_reason: 'active',
      },
      billingStatusError: null,
      isLoading: false,
      refresh: jest.fn(),
    } as never);

    render(<IndexScreen />);

    await waitFor(() => {
      expect(wasRedirectedTo(timelineRoute)).toBe(true);
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith('post_auth_destination_resolved', {
      kind: 'journal',
      access_reason: 'active',
    });
    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockedSetPersonProperties).toHaveBeenCalledWith({
      membership_count: 1,
      role: 'owner',
      access_reason: 'active',
    });
  });

  it('reports a null access_reason for a brand-new user with no memberships yet', async () => {
    mockedUseFamily.mockReturnValue({
      memberships: [],
      isLoading: false,
      role: null,
    } as never);
    mockedUseBilling.mockReturnValue({
      status: null,
      billingStatusError: null,
      isLoading: false,
      refresh: jest.fn(),
    } as never);

    render(<IndexScreen />);

    await waitFor(() => {
      expect(mockedTrackEvent).toHaveBeenCalledWith('post_auth_destination_resolved', {
        kind: 'resume-onboarding',
        access_reason: null,
      });
    });
    expect(mockedSetPersonProperties).toHaveBeenCalledWith({ membership_count: 0 });
  });

  it('does not double-fire post_auth_destination_resolved across settling re-renders that resolve to the same kind', async () => {
    mockedUseFamily.mockReturnValue({
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: 'Our Family' }],
      isLoading: false,
      role: 'owner',
    } as never);
    mockedUseBilling.mockReturnValue({
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: true,
        has_ever_had_access: true,
        trial_eligible: false,
        access_reason: 'active',
      },
      billingStatusError: null,
      isLoading: false,
      refresh: jest.fn(),
    } as never);

    const { rerender } = render(<IndexScreen />);

    await waitFor(() => {
      expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
    });

    // A re-render that resolves to the SAME destination kind (e.g. a
    // membership-list identity change from a refetch) must not re-fire.
    rerender(<IndexScreen />);
    rerender(<IndexScreen />);

    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
  });

  it('never fires while auth/family/billing are still loading (loading spinner, not the render path)', () => {
    mockedUseAuth.mockReturnValue({ session: null, isLoading: true } as never);
    mockedUseFamily.mockReturnValue({ memberships: [], isLoading: true, role: null } as never);
    mockedUseBilling.mockReturnValue({
      status: null,
      billingStatusError: null,
      isLoading: true,
      refresh: jest.fn(),
    } as never);

    render(<IndexScreen />);

    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect(mockedSetPersonProperties).not.toHaveBeenCalled();
  });
});
