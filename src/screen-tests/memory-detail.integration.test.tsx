import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Animated, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FullScreenMediaViewer } from '@/components/full-screen-media-viewer';
import { MemoryCommentsDrawer } from '@/components/memory-comments-drawer';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
import { hasFloorTrace, SILENT_WAVEFORM } from '@/components/audio/trace-test-utils';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { trackEvent } from '@/services/analytics';

import MemoryDetailScreen from '../../app/(app)/memory/[id]';

// react-native-svg renders as RNSVG* host nodes in the test renderer.
function findByType(node: any, typeName: string): any[] {
  const json = node?.type ? node : node?.toJSON?.();
  const found: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n === 'string') return;
    if (n.type === typeName) found.push(n);
    for (const child of n.children ?? []) walk(child);
  };
  walk(json);
  return found;
}

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
  FullScreenMediaViewer: jest.fn(() => null),
}));

jest.mock('@/components/memory-comments-drawer', () => ({
  MemoryCommentsDrawer: jest.fn(() => null),
}));

jest.mock('@/components/memory-engagement-bar', () => ({
  MemoryEngagementBar: jest.fn(() => null),
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
  useMediaUrls: jest.fn(),
}));
jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: jest.fn(),
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
const mockedUseMediaUrls = useMediaUrls as jest.Mock;
const mockedUseAudioClipPlayback = useAudioClipPlayback as jest.Mock;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

const taggedMember = {
  id: 'member-1',
  name: 'Tomás',
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

      expect(screen.getByText('Tomás, 2y 8m')).toBeTruthy();
      expect(screen.queryByText('Tomás, 3y 8m')).toBeNull();
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

describe('MemoryDetailScreen artwork variant (docs/plans/artwork-scanning-v2.md)', () => {
  const assets = [
    { id: 'asset-1', object_key: 'scan-1.jpg', content_type: 'image/jpeg', position: 0, aspect_ratio: 0.75 },
    { id: 'asset-2', object_key: 'scan-2.jpg', content_type: 'image/jpeg', position: 1, aspect_ratio: 1.5 },
    { id: 'asset-3', object_key: 'scan-3.jpg', content_type: 'image/jpeg', position: 2, aspect_ratio: 1 },
  ];
  const refetchUrls = jest.fn();

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
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'scan-1.jpg': 'https://r2.test/scan-1.jpg',
        'scan-2.jpg': 'https://r2.test/scan-2.jpg',
        'scan-3.jpg': 'https://r2.test/scan-3.jpg',
      },
      refetch: refetchUrls,
    });
  });

  function mockMemory(overrides: Record<string, unknown>, mediaAssets = assets.slice(0, 1)) {
    mockedUseMemory.mockReturnValue({
      data: { ...baseMemory, mediaAssets, ...overrides },
      isLoading: false,
      isError: false,
    });
  }

  function lastEngagementProps() {
    const calls = (MemoryEngagementBar as jest.Mock).mock.calls;
    return calls[calls.length - 1]?.[0];
  }

  describe('single piece', () => {
    it('hangs the piece on the gallery wall from a nail, with no photo carousel', () => {
      mockMemory({ media_variant: 'artwork', artwork_medium: 'watercolor', emotion: 'joy' });

      const screen = renderScreen();

      expect(screen.getByTestId('memory-detail-gallery-wall')).toBeTruthy();
      expect(screen.getByTestId('memory-detail-artwork-frame')).toBeTruthy();
      expect(screen.getByTestId('memory-media-image-asset-1')).toBeTruthy();
      expect(MemoryMediaCarousel).not.toHaveBeenCalled();
      expect(screen.queryByTestId('memory-detail-gallery-walk')).toBeNull();
      // Nail + string: the frame SVG draws the nail dot and its highlight.
      const frame = screen.getByTestId('memory-detail-artwork-frame');
      expect(findByType(frame, 'RNSVGCircle')).toHaveLength(2);
    });

    it('shows the museum placard: caption title, artist with full age, medium and date', () => {
      mockMemory({
        media_variant: 'artwork',
        artwork_medium: 'crayon',
        content: 'A dragon for Daddy',
        memory_date: '2026-07-10',
        taggedMembers: [{ ...taggedMember, date_of_birth: '2022-11-10' }],
      });

      const screen = renderScreen();

      expect(screen.getByTestId('memory-detail-artwork-placard-title')).toHaveTextContent('A dragon for Daddy');
      expect(screen.getByTestId('memory-detail-artwork-placard-artist')).toHaveTextContent(
        'Tomás, 3 years 8 months',
      );
      expect(screen.getByTestId('memory-detail-artwork-placard-detail')).toHaveTextContent(
        'Crayon on paper · July 10, 2026',
      );
      // The caption is the placard title, not repeated as body text.
      expect(screen.queryByTestId('memory-detail-section-content')).toBeNull();
    });

    it('shows the medium chip instead of the emotion chip, and the engagement row', () => {
      mockMemory({ media_variant: 'artwork', artwork_medium: 'watercolor', emotion: 'joy' });

      const screen = renderScreen();

      expect(screen.getByTestId('artwork-medium-chip')).toHaveTextContent('watercolor');
      expect(screen.queryByText('joy')).toBeNull();
      expect(screen.getByTestId('memory-detail-section-engagement')).toBeTruthy();
    });

    it('falls back to the "Artwork" badge while the medium is not yet known', () => {
      mockMemory({ media_variant: 'artwork', artwork_medium: null, emotion: 'joy' });

      const screen = renderScreen();

      expect(screen.getByTestId('artwork-badge')).toHaveTextContent('Artwork');
      expect(screen.queryByTestId('artwork-medium-chip')).toBeNull();
      expect(screen.queryByText('joy')).toBeNull();
      // No medium: the placard detail drops it and keeps the date.
      expect(screen.getByTestId('memory-detail-artwork-placard-detail')).toHaveTextContent('July 10, 2026');
    });

    it('keeps the tagged-member age pills for artwork', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-09T12:00:00'));
      try {
        mockMemory({
          media_variant: 'artwork',
          memory_date: '2026-07-10',
          taggedMembers: [{ ...taggedMember, date_of_birth: '2022-11-10' }],
        });

        const screen = renderScreen();

        expect(screen.getByText('Tomás, 3y 8m')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('opens the existing comments drawer from the engagement bar (no inline comment preview)', () => {
      mockMemory({ media_variant: 'artwork' });

      const screen = renderScreen();

      const drawer = MemoryCommentsDrawer as jest.Mock;
      expect(drawer.mock.calls[drawer.mock.calls.length - 1][0]).toEqual(
        expect.objectContaining({ visible: false }),
      );
      expect(lastEngagementProps()).toEqual(
        expect.objectContaining({ enableShare: true, onOpenComments: expect.any(Function) }),
      );
      expect(screen.queryByTestId('memory-detail-comment-preview')).toBeNull();

      act(() => lastEngagementProps().onOpenComments());

      expect(drawer.mock.calls[drawer.mock.calls.length - 1][0]).toEqual(
        expect.objectContaining({ visible: true }),
      );
    });

    it('opens the full-screen viewer when the piece is tapped', () => {
      mockMemory({ media_variant: 'artwork' });

      const screen = renderScreen();
      expect(FullScreenMediaViewer).not.toHaveBeenCalled();

      fireEvent.press(screen.getByLabelText('View artwork full screen'));

      const viewer = FullScreenMediaViewer as jest.Mock;
      expect(viewer.mock.calls[viewer.mock.calls.length - 1][0]).toEqual(
        expect.objectContaining({
          initialIndex: 0,
          items: [expect.objectContaining({ id: 'asset-1', objectKey: 'scan-1.jpg' })],
        }),
      );
    });

    it('lays the frame out inside the screen width and the 480px height clamp', () => {
      // A tall scan (ratio clamps at 0.5) must shrink rather than overflow.
      mockMemory(
        { media_variant: 'artwork' },
        [{ ...assets[0], aspect_ratio: 0.5 }],
      );

      const screen = renderScreen();

      const frame = StyleSheet.flatten(screen.getByTestId('memory-detail-artwork-frame').props.style);
      expect(frame.height).toBeLessThanOrEqual(480);
      expect(frame.width).toBeLessThanOrEqual(390);
    });
  });

  describe('batch gallery walk', () => {
    function mockBatch(overrides: Record<string, unknown> = {}) {
      mockMemory(
        { media_variant: 'artwork', artwork_medium: 'mixed media', content: 'From art camp', ...overrides },
        assets,
      );
    }

    it('renders a horizontal walk with every piece and the current frame testID', () => {
      mockBatch();

      const screen = renderScreen();

      const walk = screen.getByTestId('memory-detail-gallery-walk');
      expect(walk.props.horizontal).toBe(true);
      expect(walk.props.data).toHaveLength(3);
      expect(screen.getAllByTestId(/^memory-media-image-/)).toHaveLength(3);
      // Only the current slide carries the shared frame testID.
      expect(screen.getAllByTestId('memory-detail-artwork-frame')).toHaveLength(1);
      expect(MemoryMediaCarousel).not.toHaveBeenCalled();
      // No per-piece "1 of 3" labels on the detail page.
      expect(screen.queryByText(/\d of 3/)).toBeNull();
    });

    it('shows the batch placard: medium, piece count and date', () => {
      mockBatch({ memory_date: '2026-10-06' });

      const screen = renderScreen();

      expect(screen.getByTestId('memory-detail-artwork-placard-detail')).toHaveTextContent(
        'Mixed media · 3 pieces · October 6, 2026',
      );
    });

    it('opens on the piece named by the route and points share at it', () => {
      mockSearchParams.mediaIndex = '2';
      mockBatch();

      const screen = renderScreen();

      expect(screen.getByTestId('memory-detail-gallery-walk').props.initialScrollIndex).toBe(2);
      expect(lastEngagementProps()).toEqual(
        expect.objectContaining({ currentMediaAssetId: 'asset-3' }),
      );
    });

    it('starts at the first piece when no page is passed', () => {
      mockBatch();

      const screen = renderScreen();

      expect(screen.getByTestId('memory-detail-gallery-walk').props.initialScrollIndex).toBeUndefined();
      expect(lastEngagementProps()).toEqual(
        expect.objectContaining({ currentMediaAssetId: 'asset-1' }),
      );
    });

    it('updates the share target when the walk settles on another piece', () => {
      mockBatch();

      const screen = renderScreen();
      const walk = screen.getByTestId('memory-detail-gallery-walk');
      const spacing = Math.round(390 * 0.67);

      fireEvent(walk, 'momentumScrollEnd', {
        nativeEvent: { contentOffset: { x: spacing, y: 0 } },
      });

      expect(lastEngagementProps()).toEqual(
        expect.objectContaining({ currentMediaAssetId: 'asset-2' }),
      );
      expect(screen.getByTestId('memory-detail-artwork-frame')).toBeTruthy();
    });

    it('opens the full-screen viewer at the current piece when it is tapped', () => {
      mockSearchParams.mediaIndex = '1';
      mockBatch();

      const screen = renderScreen();

      fireEvent.press(screen.getByLabelText('View artwork full screen'));

      const viewer = FullScreenMediaViewer as jest.Mock;
      expect(viewer.mock.calls[viewer.mock.calls.length - 1][0]).toEqual(
        expect.objectContaining({ initialIndex: 1 }),
      );
    });

    it('tapping a peeking piece scrolls to it instead of opening the viewer', () => {
      mockBatch();

      const screen = renderScreen();

      fireEvent.press(screen.getByLabelText('Show piece 2 of 3'));

      expect(FullScreenMediaViewer).not.toHaveBeenCalled();
      expect(lastEngagementProps()).toEqual(
        expect.objectContaining({ currentMediaAssetId: 'asset-2' }),
      );
    });
  });

  it('renders regular photo memories without the frame and with the emotion chip', () => {
    mockMemory({ media_variant: null, emotion: 'joy' });

    const screen = renderScreen();

    expect(screen.queryByTestId('memory-detail-artwork-frame')).toBeNull();
    expect(screen.queryByTestId('memory-detail-gallery-wall')).toBeNull();
    expect(screen.queryByTestId('artwork-badge')).toBeNull();
    expect(screen.getByText('joy')).toBeTruthy();
  });
});

// P0.1 forward-compat fallback (docs/plans/audio-memories-v1.md) -- an old
// installed client fetching a memory_type it doesn't recognize yet (e.g. a
// hypothetical future type -- 'audio' itself is now known, so the fixture
// below uses a never-real string instead) must never fall into the
// illustration branch's permanent "generating" placeholder.
describe('MemoryDetailScreen unknown memory_type', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('renders the text-style layout with the update notice, never the generating overlay', () => {
    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        memory_type: 'hologram',
        content: 'A giggle worth keeping',
        illustration_status: 'none',
      },
      isLoading: false,
      isError: false,
    });

    const screen = renderScreen();

    expect(screen.getByTestId('memory-detail-section-unavailable')).toHaveTextContent(
      'Update Momora to play this memory.',
    );
    expect(screen.getByTestId('memory-detail-section-content')).toHaveTextContent(
      'A giggle worth keeping',
    );
    expect(screen.queryByText('Illustration pending')).toBeNull();
    expect(screen.queryByText('Illustrated memory')).toBeNull();
  });

  it('disables the share button', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    mockedUseMemory.mockReturnValue({
      data: {
        ...baseMemory,
        memory_type: 'hologram',
        content: 'A giggle worth keeping',
        illustration_status: 'none',
      },
      isLoading: false,
      isError: false,
    });

    renderScreen();

    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: false }),
    );
  });
});

// P3.2 (docs/plans/audio-memories-v1.md) -- the real, known `audio` variant:
// playback is the hero, not the P0.1 fallback exercised above.
describe('MemoryDetailScreen audio variant', () => {
  const audioMemory = (overrides: Record<string, unknown> = {}) => ({
    ...baseMemory,
    memory_type: 'audio',
    content: 'Lila singing Twinkle Twinkle in the bath.',
    media_key: 'user-1/memories/memory-1/media/clip-1.m4a',
    mediaAssets: [
      {
        id: 'clip-1',
        object_key: 'user-1/memories/memory-1/media/clip-1.m4a',
        content_type: 'audio/mp4',
        duration_ms: 42_000,
        position: 0,
      },
    ],
    ...overrides,
  });

  const idlePlayback = {
    playing: false,
    position: 0,
    duration: 0,
    progress: 0,
    loading: false,
    error: null,
    toggle: jest.fn(),
    seekTo: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockedUseAudioClipPlayback.mockReturnValue(idlePlayback);
  });

  it('shows the idle "tap to listen" affordance and hides share', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    const screen = renderScreen();

    expect(screen.getByText('tap to listen')).toBeTruthy();
    expect(screen.getByTestId('memory-detail-sound-seal')).toBeTruthy();
    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: false }),
    );
  });

  it('draws the clip\'s real waveform on the stage when the media row has one', () => {
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    const base = audioMemory();

    mockedUseMemory.mockReturnValue({ data: base, isLoading: false, isError: false });
    const seeded = renderScreen();
    expect(hasFloorTrace(seeded.toJSON())).toBe(false);
    seeded.unmount();

    mockedUseMemory.mockReturnValue({
      data: audioMemory({ mediaAssets: [{ ...base.mediaAssets[0], waveform: SILENT_WAVEFORM }] }),
      isLoading: false,
      isError: false,
    });
    expect(hasFloorTrace(renderScreen().toJSON())).toBe(true);
  });

  it('shows the "getting the sound" loading state while the signed URL is still resolving', () => {
    mockedUseMediaUrl.mockReturnValue({ url: undefined, isLoading: true, isError: false });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    const screen = renderScreen();

    expect(screen.getByText('getting the sound')).toBeTruthy();
  });

  it('shows the calm "Not on this phone yet" state when the clip URL fails to resolve', () => {
    mockedUseMediaUrl.mockReturnValue({ url: undefined, isLoading: false, isError: true });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    const screen = renderScreen();

    expect(screen.getByText('Not on this phone yet')).toBeTruthy();
  });

  it('shows the calm unavailable state on a playback error even when the URL resolved fine', () => {
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseAudioClipPlayback.mockReturnValue({ ...idlePlayback, error: 'decode failed' });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    const screen = renderScreen();

    expect(screen.getByText('Not on this phone yet')).toBeTruthy();
  });

  it('renders no note block at all for a clip with no description (owner decision 2026-08-20)', () => {
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseMemory.mockReturnValue({
      data: audioMemory({ content: null }),
      isLoading: false,
      isError: false,
    });

    const screen = renderScreen();

    expect(screen.queryByTestId('memory-detail-section-content')).toBeNull();
    expect(screen.queryByText('No note — just the sound.')).toBeNull();
  });

  it('animates the note/engagement/footer block toward 32% opacity while playing (words step back)', () => {
    const timingSpy = jest.spyOn(Animated, 'timing');
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseAudioClipPlayback.mockReturnValue({ ...idlePlayback, playing: true, position: 5, progress: 5 / 42 });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    renderScreen();

    expect(timingSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 0.32, duration: 380 }),
    );

    timingSpy.mockRestore();
  });

  it('animates back toward full opacity once playback stops', () => {
    const timingSpy = jest.spyOn(Animated, 'timing');
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseAudioClipPlayback.mockReturnValue(idlePlayback);
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    renderScreen();

    expect(timingSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 1, duration: 380 }),
    );

    timingSpy.mockRestore();
  });

  it('toggles playback via the seal', () => {
    const toggle = jest.fn();
    mockedUseMediaUrl.mockReturnValue({ url: 'https://example.com/clip.m4a', isLoading: false, isError: false });
    mockedUseAudioClipPlayback.mockReturnValue({ ...idlePlayback, toggle });
    mockedUseMemory.mockReturnValue({ data: audioMemory(), isLoading: false, isError: false });

    const screen = renderScreen();
    fireEvent.press(screen.getByTestId('memory-detail-sound-seal'));

    expect(toggle).toHaveBeenCalledTimes(1);
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
