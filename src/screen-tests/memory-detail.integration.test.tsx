import { fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { trackEvent } from '@/services/analytics';

import MemoryDetailScreen from '../../app/(app)/memory/[id]';

// Mutable so a test can exercise the route params the screen reads (e.g. the
// `mediaIndex` a timeline carousel tap passes through).
const mockSearchParams: { id: string; comments?: string; mediaIndex?: string } = {
  id: 'memory-1',
};

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: () => null,
}));

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

jest.mock('@/components/full-screen-media-viewer', () => ({
  FullScreenMediaViewer: () => null,
}));

jest.mock('@/components/memory-comments-drawer', () => ({
  MemoryCommentsDrawer: () => null,
}));

jest.mock('@/components/memory-engagement-bar', () => ({
  MemoryEngagementBar: () => null,
}));

jest.mock('@/components/memory-media-carousel', () => ({
  MemoryMediaCarousel: jest.fn(() => null),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMemberProfiles', () => ({
  useFamilyMemberProfiles: jest.fn(),
  resolveAttributionName: (
    profiles: { user_id: string; name: string }[],
    userId: string | null | undefined,
  ) => profiles.find((profile) => profile.user_id === userId)?.name ?? 'a former member',
}));

jest.mock('@/hooks/useMemories', () => ({
  useMemory: jest.fn(),
  useMemoryMutations: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(),
}));
jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false, isReporting: false,
    isTargetReported: () => false, hasActiveReport: () => false,
    isUserBlocked: () => false, revealTarget: jest.fn(), revealBlockedUser: jest.fn(),
    report: jest.fn(), refetch: jest.fn(),
  }),
}));

const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.Mock;
const mockedUseMemory = useMemory as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseMediaUrl = useMediaUrl as jest.Mock;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

const taggedMember = {
  id: 'member-1',
  name: 'Enzo',
  date_of_birth: '2022-11-10',
};

const baseMemory = {
  id: 'memory-1',
  user_id: 'user-1',
  content: 'A small family moment worth remembering.',
  memory_date: '2026-07-10',
  memory_type: 'media',
  emotion: 'joy',
  illustration_key: null,
  illustration_status: 'none',
  link_previews: {},
  mediaAssets: [],
  taggedMembers: [taggedMember],
  updated_at: '2026-07-14T09:00:00.000Z',
};

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <MemoryDetailScreen />
    </SafeAreaProvider>,
  );
}

describe('MemoryDetailScreen hierarchy', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    delete mockSearchParams.comments;
    delete mockSearchParams.mediaIndex;
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' });
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [{ user_id: 'user-1', name: 'Eduardo' }],
    });
    mockedUseMemoryMutations.mockReturnValue({
      deleteMemory: jest.fn(),
      retryIllustration: jest.fn(),
      regenerateIllustration: jest.fn(),
      isDeleting: false,
      isRetrying: false,
      isRegenerating: false,
    });
    mockedUseMediaUrl.mockReturnValue({ url: undefined });
  });

  it.each(['media', 'text_only'] as const)(
    'uses the intended detail hierarchy for %s memories',
    (memoryType) => {
      mockedUseMemory.mockReturnValue({
        data: {
          ...baseMemory,
          memory_type: memoryType,
          illustration_status: memoryType === 'text_only' ? 'none' : baseMemory.illustration_status,
        },
        isLoading: false,
        isError: false,
      });

      const screen = renderScreen();
      const sectionOrder = screen
        .getAllByTestId(/memory-detail-section-/)
        .map((section) => section.props.testID);

      expect(sectionOrder).toEqual(
        memoryType === 'text_only'
          ? [
              'memory-detail-section-content',
              'memory-detail-section-members',
              'memory-detail-section-engagement',
              'memory-detail-section-metadata',
            ]
          : [
              'memory-detail-section-engagement',
              'memory-detail-section-content',
              'memory-detail-section-members',
              'memory-detail-section-metadata',
            ],
      );
      expect(screen.getByTestId('memory-detail-attribution')).toHaveTextContent('Added by Eduardo');
      expect(screen.getByTestId('memory-detail-attribution')).toHaveStyle({
        color: '#9A8B79',
        fontSize: 10.5,
      });
    },
  );

  it('shows tagged member age at the memory date', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00'));

    try {
      mockedUseMemory.mockReturnValue({
        data: {
          ...baseMemory,
          memory_date: '2025-07-10',
          taggedMembers: [{ ...taggedMember, date_of_birth: '2022-11-10' }],
        },
        isLoading: false,
        isError: false,
      });

      const screen = renderScreen();

      expect(screen.getByText('Enzo, 2y 8m')).toBeTruthy();
      expect(screen.queryByText('Enzo, 3y 8m')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['opens the media carousel on the page named by the route', '2', 2],
    ['opens on the first asset when no page was passed', undefined, 0],
    ['opens on the first asset when the page is unparseable', 'nope', 0],
  ])('%s', (_label, routeMediaIndex, expectedInitialIndex) => {
    const mockedCarousel = MemoryMediaCarousel as jest.Mock;
    mockSearchParams.mediaIndex = routeMediaIndex;
    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        mediaAssets: [
          { id: 'asset-1', object_key: 'photo-1.jpg', content_type: 'image/jpeg', position: 0 },
          { id: 'asset-2', object_key: 'photo-2.jpg', content_type: 'image/jpeg', position: 1 },
          { id: 'asset-3', object_key: 'photo-3.jpg', content_type: 'image/jpeg', position: 2 },
        ],
      },
      isLoading: false,
      isError: false,
    });

    renderScreen();

    expect(mockedCarousel.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ initialIndex: expectedInitialIndex }),
    );
  });
});

// docs/plans/analytics-implementation.md WP3 item 3 --
// `illustration_retry_requested` at the two client-initiated buttons
// (docs/plans/analytics-tracking.md Tier 2).
describe('MemoryDetailScreen -- illustration_retry_requested analytics', () => {
  const retryIllustration = jest.fn();
  const regenerateIllustration = jest.fn().mockResolvedValue({ deferredForPortraits: false });

  beforeEach(() => {
    jest.clearAllMocks();
    delete mockSearchParams.comments;
    delete mockSearchParams.mediaIndex;
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' });
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [{ user_id: 'user-1', name: 'Eduardo' }],
    });
    mockedUseMemoryMutations.mockReturnValue({
      deleteMemory: jest.fn(),
      retryIllustration,
      regenerateIllustration,
      isDeleting: false,
      isRetrying: false,
      isRegenerating: false,
    });
    mockedUseMediaUrl.mockReturnValue({ url: undefined });
  });

  it('reports intent: recovery when the failed-state retry button is pressed', () => {
    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        memory_type: 'text_illustration',
        illustration_status: 'failed',
      },
      isLoading: false,
      isError: false,
    });

    const screen = renderScreen();
    fireEvent.press(screen.getByTestId('memory-detail-retry-illustration'));

    expect(mockedTrackEvent).toHaveBeenCalledWith('illustration_retry_requested', { intent: 'recovery' });
    expect(retryIllustration).toHaveBeenCalledWith('memory-1');
  });

  it('reports intent: manual_regenerate when the regenerate button is confirmed', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const confirm = buttons?.find((button) => button.text === 'Regenerate');
      confirm?.onPress?.();
    });

    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        memory_type: 'text_illustration',
        illustration_status: 'ready',
      },
      isLoading: false,
      isError: false,
    });

    const screen = renderScreen();
    fireEvent.press(screen.getByTestId('memory-detail-regenerate-illustration'));

    expect(mockedTrackEvent).toHaveBeenCalledWith('illustration_retry_requested', {
      intent: 'manual_regenerate',
    });
    expect(regenerateIllustration).toHaveBeenCalledWith('memory-1');

    alertSpy.mockRestore();
  });

  it('does not report anything when the regenerate confirmation is cancelled', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        memory_type: 'text_illustration',
        illustration_status: 'ready',
      },
      isLoading: false,
      isError: false,
    });

    const screen = renderScreen();
    fireEvent.press(screen.getByTestId('memory-detail-regenerate-illustration'));

    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect(regenerateIllustration).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});
