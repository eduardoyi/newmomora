import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CalendarScreen from '../../app/(app)/(tabs)/calendar';
import { useFamily } from '@/hooks/use-family';
import { useCalendarMemoriesInRange, useOldestMemoryDate } from '@/hooks/useCalendarMemories';
import { toIsoDate } from '@/utils/dates';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('@/components/pending-memory-uploads-banner', () => ({
  PendingMemoryUploadsBanner: () => null,
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

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

jest.mock('@/hooks/useCalendarMemories', () => ({
  useCalendarMemoriesInRange: jest.fn(),
  useOldestMemoryDate: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: null })),
}));

jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: jest.fn(() => null),
}));

// The native Reanimated module cannot run in Jest -- same test double used
// by floating-tab-bar.test.tsx for the Today button's fade-in.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => ({}) },
  };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseCalendarMemoriesInRange = useCalendarMemoriesInRange as jest.MockedFunction<
  typeof useCalendarMemoriesInRange
>;
const mockedUseOldestMemoryDate = useOldestMemoryDate as jest.MockedFunction<typeof useOldestMemoryDate>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <CalendarScreen />
    </SafeAreaProvider>,
  );
}

// P3.3 (docs/plans/audio-memories-v1.md) -- the day ribbon's audio stamp
// (SoundTile from the kit) instead of the tan camera-icon media fallback.
describe('Calendar audio day stamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' } as never);
    mockedUseOldestMemoryDate.mockReturnValue({
      data: toIsoDate(new Date()),
      isRefetching: false,
      refetch: jest.fn(),
    } as never);
  });

  it('renders the SoundTile stamp for an audio memory, not the media fallback', () => {
    const today = toIsoDate(new Date());
    mockedUseCalendarMemoriesInRange.mockReturnValue({
      data: [
        {
          id: 'memory-1',
          memory_type: 'audio',
          memory_date: today,
          content: null,
          emotion: null,
          media_key: null,
          media_content_type: null,
          mediaAssets: [
            { id: 'clip-1', object_key: 'clip.m4a', content_type: 'audio/mp4', duration_ms: 20_000, position: 0 },
          ],
          taggedMembers: [],
          updated_at: '2026-08-19T00:00:00.000Z',
        },
      ],
      isRefetching: false,
      refetch: jest.fn(),
    } as never);

    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('calendar-memory-memory-1-sound')).toBeTruthy();
    expect(getByText('Sound')).toBeTruthy();
  });
});
