import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CalendarScreen from '../../app/(app)/(tabs)/calendar';
import { useFamily } from '@/hooks/use-family';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('@/components/pending-memory-uploads-banner', () => ({
  PendingMemoryUploadsBanner: () => null,
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useCalendarMemories', () => ({
  useCalendarMemoriesInRange: jest.fn(() => ({
    data: [],
    isRefetching: false,
    refetch: jest.fn(),
  })),
  useOldestMemoryDate: jest.fn(() => ({
    data: null,
    isRefetching: false,
    refetch: jest.fn(),
  })),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: null })),
}));

jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: jest.fn(() => null),
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;

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

describe('Calendar role gating', () => {
  it('hides the new-memory FAB from viewers', () => {
    mockedUseFamily.mockReturnValue({ role: 'viewer' } as never);

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('new-memory-fab')).toBeNull();
  });

  it('shows the new-memory FAB to managers', () => {
    mockedUseFamily.mockReturnValue({ role: 'manager' } as never);

    const { getByTestId } = renderScreen();

    expect(getByTestId('new-memory-fab')).toBeTruthy();
  });
});
