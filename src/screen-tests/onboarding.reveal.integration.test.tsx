// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers WP6's S17: the two CTA branches (a sibling still needs a photo vs.
// none do) and that "Later" goes straight to the family roster tab -- the
// owner's explicit decision against building the design brief's
// `CastWaitingState` cast card (docs/features/onboarding.md).
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingRevealScreen from '../../app/(onboarding)/reveal';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { onboardingPortraitRouteForMember } from '@/lib/onboarding-routes';
import { familyRosterRoute, timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(),
}));

const mockedUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;

const LILA_MEMBER = {
  id: 'member-lila',
  name: 'Lila',
  resolvedPortraitVersion: { illustrated_profile_key: 'portraits/lila.webp' },
  avatarUpdatedAt: 'portraits/lila.webp',
  updated_at: '2026-07-30T00:00:00.000Z',
  portraitVersions: [{ id: 'version-1', illustrated_profile_status: 'ready' }],
};

const MIGUEL_MEMBER_UNPAINTED = {
  id: 'member-miguel',
  name: 'Miguel',
  updated_at: '2026-07-30T00:00:00.000Z',
};

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OnboardingRevealScreen />
    </SafeAreaProvider>,
  );
}

describe('OnboardingRevealScreen (S17)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseLocalSearchParams.mockReturnValue({ memberId: 'member-lila' });
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/lila-portrait.webp', isLoading: false, isError: false });
  });

  it('shows "{next}\'s turn. Pick a photo" and a quiet "Later" when an unpainted sibling remains', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER, MIGUEL_MEMBER_UNPAINTED],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);

    const { getByText, getByTestId, queryByTestId } = renderScreen();

    expect(getByText('Meet Lila.')).toBeTruthy();
    expect(getByTestId('onb-reveal-portrait-image-loading')).toBeTruthy();
    expect(queryByTestId('onb-reveal-portrait-image-unavailable')).toBeNull();
    expect(getByText("Miguel's turn. Pick a photo")).toBeTruthy();
    expect(queryByTestId('onb-reveal-done-button')).toBeNull();

    fireEvent.press(getByTestId('onb-reveal-next-sibling-button'));
    expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRouteForMember('member-miguel'));

    fireEvent.press(getByTestId('onb-reveal-later-link'));
    expect(router.replace).toHaveBeenCalledWith(familyRosterRoute);
  });

  it('shows a single "Take me to the journal" CTA when no unpainted siblings remain', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);

    const { getByText, getByTestId, queryByTestId } = renderScreen();

    expect(getByText('Meet Lila.')).toBeTruthy();
    expect(queryByTestId('onb-reveal-next-sibling-button')).toBeNull();
    expect(queryByTestId('onb-reveal-later-link')).toBeNull();

    fireEvent.press(getByTestId('onb-reveal-done-button'));
    expect(router.replace).toHaveBeenCalledWith(timelineRoute);
  });

  it('does not count a sibling who already has a portrait version in progress as "unpainted"', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [
        LILA_MEMBER,
        {
          id: 'member-teo',
          name: 'Teo',
          updated_at: '2026-07-30T00:00:00.000Z',
          portraitVersions: [{ id: 'version-2', illustrated_profile_status: 'generating' }],
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('onb-reveal-next-sibling-button')).toBeNull();
  });

  it('bounces to the journal when the memberId param does not resolve to a real member', async () => {
    mockedUseLocalSearchParams.mockReturnValue({ memberId: 'member-unknown' });
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);

    renderScreen();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });
  });

  it('labels the portrait as unavailable until its signed URL is available', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockedUseMediaUrl.mockReturnValue({ url: null, isLoading: true, isError: false });

    const { getByTestId, queryByTestId } = renderScreen();

    expect(getByTestId('onb-reveal-portrait-image-unavailable')).toBeTruthy();
    expect(queryByTestId('onb-reveal-portrait-image-loading')).toBeNull();
  });

  it('exposes a ready selector only after the signed portrait image loads', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);

    const { getByTestId, findByTestId } = renderScreen();

    fireEvent(getByTestId('onb-reveal-portrait-image-loading'), 'load', {
      nativeEvent: {},
    });

    expect(await findByTestId('onb-reveal-portrait-image-loaded')).toBeTruthy();
  });
});
