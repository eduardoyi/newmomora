import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';

import EditMemoryScreen from '../../app/(app)/memory/[id]/edit';

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'memory-1' }),
}));

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));

jest.mock('@/components/date-picker-field', () => ({
  DatePickerField: () => null,
}));

jest.mock('@/components/memory-media-picker', () => ({
  MemoryMediaPicker: () => null,
}));

jest.mock('@/components/memory-media-preview', () => ({
  MemoryMediaPreview: () => null,
}));

jest.mock('@/components/memory-tag-picker', () => ({
  MemoryTagPicker: () => null,
}));

jest.mock('@/components/voice-speak-it-modal', () => ({
  VoiceSpeakItModal: () => null,
}));

jest.mock('@/hooks/useAutoMemoryTags', () => ({
  useAutoMemoryTags: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@/hooks/useMemories', () => ({
  useMemory: jest.fn(),
  useMemoryMutations: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(),
  useMediaUrls: jest.fn(),
}));

const mockedUseAutoMemoryTags = useAutoMemoryTags as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemory = useMemory as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseMediaUrl = useMediaUrl as jest.Mock;
const mockedUseMediaUrls = useMediaUrls as jest.Mock;

const initializeTags = jest.fn();

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <EditMemoryScreen />
    </SafeAreaProvider>,
  );
}

describe('EditMemoryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseFamily.mockReturnValue({ role: 'manager' });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemory.mockReturnValue({
      data: {
        id: 'memory-1',
        content: 'A text-only memory',
        memory_date: '2026-07-14',
        memory_type: 'text_only',
        media_key: null,
        media_content_type: null,
        mediaAssets: [],
        taggedMembers: [],
        illustration_key: null,
        updated_at: '2026-07-14T09:00:00.000Z',
      },
      isLoading: false,
      isPlaceholderData: false,
    });
    mockedUseMemoryMutations.mockReturnValue({
      updateMemory: jest.fn(),
      isUpdating: false,
    });
    mockedUseMediaUrl.mockReturnValue({ url: undefined });
    // A disabled media query has no data. This used to create a fresh `{}` on
    // every render and retrigger the attachment URL synchronization effect.
    mockedUseMediaUrls.mockReturnValue({ data: undefined });
    mockedUseAutoMemoryTags.mockReturnValue({
      selectedMemberIds: [],
      initializeTags,
      applyForContent: jest.fn(),
      toggleMember: jest.fn(),
      applyVoiceResult: jest.fn(),
    });
  });

  it('initializes a text memory without entering a media URL update loop', () => {
    const screen = renderScreen();

    expect(screen.getByTestId('edit-memory-content').props.value).toBe(
      'A text-only memory',
    );
    expect(mockedUseMediaUrls.mock.calls.length).toBeLessThan(5);
  });
});
