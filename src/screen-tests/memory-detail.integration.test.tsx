import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl } from '@/hooks/useMediaUrls';

import MemoryDetailScreen from '../../app/(app)/memory/[id]';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'memory-1' }),
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
  MemoryMediaCarousel: () => null,
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

const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.Mock;
const mockedUseMemory = useMemory as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseMediaUrl = useMediaUrl as jest.Mock;

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
});
