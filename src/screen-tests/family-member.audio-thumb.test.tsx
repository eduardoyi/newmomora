import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ViewFamilyMemberScreen from '../../app/(app)/family/[id]';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemberMemories } from '@/hooks/useMemories';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'member-1' }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('@/components/cast-card', () => ({ CastCard: () => null }));
jest.mock('@/components/content-action-sheet', () => ({ ContentActionSheet: () => null }));
jest.mock('@/components/content-hidden-notice', () => ({ ContentHiddenNotice: () => null }));
jest.mock('@/components/full-screen-media-viewer', () => ({ FullScreenMediaViewer: () => null }));
jest.mock('@/components/report-sheet', () => ({ ReportSheet: () => null }));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemories', () => ({ useMemberMemories: jest.fn() }));
jest.mock('@/hooks/usePortraitVersions', () => ({ usePortraitVersions: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: null })) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: jest.fn(() => null) }));
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isTargetReported: () => false,
    hasActiveReport: () => false,
    isUserBlocked: () => false,
    revealTarget: jest.fn(),
    refetch: jest.fn(),
  }),
}));

const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemberMemories = useMemberMemories as jest.Mock;
const mockedUsePortraitVersions = usePortraitVersions as jest.Mock;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ViewFamilyMemberScreen />
    </SafeAreaProvider>,
  );
}

// P3.3 (docs/plans/audio-memories-v1.md) -- the member-profile memory row's
// SoundTile thumb instead of the camera-icon media fallback.
describe('ViewFamilyMemberScreen audio memory-row thumb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' });
    mockedUsePortraitVersions.mockReturnValue({ versions: [] });
    mockedUseFamilyMembers.mockReturnValue({
      members: [
        {
          id: 'member-1',
          name: 'Lila',
          nicknames: [],
          resolvedPortraitVersion: null,
          avatarUpdatedAt: null,
          updated_at: '2026-08-19T00:00:00.000Z',
        },
      ],
      isLoading: false,
      deleteMember: jest.fn(),
      isDeleting: false,
    });
  });

  it('renders a SoundTile and the "Sound" subtitle for a caption-less audio memory', () => {
    mockedUseMemberMemories.mockReturnValue({
      memories: [
        {
          id: 'memory-1',
          memory_type: 'audio',
          memory_date: '2026-08-10',
          content: null,
          emotion: null,
          media_key: null,
          media_content_type: null,
          mediaAssets: [
            { id: 'clip-1', object_key: 'clip.m4a', content_type: 'audio/mp4', duration_ms: 20_000, position: 0 },
          ],
          link_previews: {},
          user_id: 'user-1',
        },
      ],
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    const screen = renderScreen();

    expect(screen.getByTestId('member-memory-memory-1-sound')).toBeTruthy();
    expect(screen.getByText('Sound')).toBeTruthy();
  });
});
