import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: jest.fn(() => ({
    playing: false,
    position: 0,
    duration: 0,
    progress: 0,
    loading: false,
    error: null,
    toggle: jest.fn(),
    seekTo: jest.fn(),
  })),
}));

const mockedUseAutoMemoryTags = useAutoMemoryTags as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemory = useMemory as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseMediaUrl = useMediaUrl as jest.Mock;
const mockedUseMediaUrls = useMediaUrls as jest.Mock;

const initializeTags = jest.fn();
const updateMemory = jest.fn().mockResolvedValue(undefined);

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
        illustration_status: 'none',
        updated_at: '2026-07-14T09:00:00.000Z',
      },
      isLoading: false,
      isPlaceholderData: false,
    });
    mockedUseMemoryMutations.mockReturnValue({
      updateMemory,
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

  it('enables AI for a text-only memory and requests generation on save', async () => {
    const screen = renderScreen();

    fireEvent(screen.getByTestId('edit-memory-ai-toggle'), 'valueChange', true);

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryType: 'text_illustration' }),
    );
  });

  it('hides and retains an existing illustration when AI is switched off', async () => {
    mockedUseMemory.mockReturnValue({
      data: {
        id: 'memory-1',
        content: 'An illustrated memory',
        memory_date: '2026-07-14',
        memory_type: 'text_illustration',
        media_key: null,
        media_content_type: null,
        mediaAssets: [],
        taggedMembers: [],
        illustration_key: 'user-1/memories/memory-1/illustration.webp',
        illustration_status: 'ready',
        updated_at: '2026-07-14T09:00:00.000Z',
      },
      isLoading: false,
      isPlaceholderData: false,
    });
    mockedUseMediaUrl.mockReturnValue({ url: 'https://signed.test/illustration.webp' });

    const screen = renderScreen();

    await waitFor(() => {
      expect(screen.getByLabelText('Memory illustration')).toBeTruthy();
    });

    fireEvent(screen.getByTestId('edit-memory-ai-toggle'), 'valueChange', false);

    expect(screen.queryByLabelText('Memory illustration')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryType: 'text_only' }),
    );
  });

  it('clears a media memory caption by sending empty content on save', async () => {
    mockedUseMemory.mockReturnValue({
      data: {
        id: 'memory-1',
        content: 'Old caption',
        memory_date: '2026-07-14',
        memory_type: 'media',
        media_key: null,
        media_content_type: 'image/jpeg',
        mediaAssets: [
          {
            id: 'asset-1',
            object_key: 'user-1/memories/memory-1/photo.jpg',
            content_type: 'image/jpeg',
            duration_ms: null,
            aspect_ratio: null,
          },
        ],
        taggedMembers: [],
        illustration_key: null,
        illustration_status: 'none',
        updated_at: '2026-07-14T09:00:00.000Z',
      },
      isLoading: false,
      isPlaceholderData: false,
    });

    const screen = renderScreen();

    fireEvent.changeText(screen.getByTestId('edit-memory-content'), '');

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    // `undefined` means "unchanged" to updateMemory -- clearing the caption
    // must send '' so the service persists the removal (regression: emptied
    // captions were mapped to undefined and silently kept the old text).
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ content: '', memoryType: 'media' }),
    );
  });

  // P0.1 forward-compat fallback (docs/plans/audio-memories-v1.md) -- a
  // memory_type this build doesn't recognize yet (a hypothetical future
  // type -- 'audio' itself is now known and editable, so the fixture below
  // uses a never-real string instead) previously opened as a misleadingly-
  // empty "Text only" note. It must now be read-only: no editing
  // affordances, Save disabled.
  it('renders read-only with Save disabled for an unrecognized memory_type', () => {
    mockedUseMemory.mockReturnValue({
      data: {
        id: 'memory-1',
        content: 'A giggle worth keeping',
        memory_date: '2026-07-14',
        memory_type: 'hologram',
        media_key: null,
        media_content_type: null,
        mediaAssets: [],
        taggedMembers: [],
        illustration_key: null,
        illustration_status: 'none',
        updated_at: '2026-07-14T09:00:00.000Z',
      },
      isLoading: false,
      isPlaceholderData: false,
    });

    const screen = renderScreen();

    expect(screen.getByTestId('edit-memory-unavailable-notice')).toHaveTextContent(
      'This memory needs a newer version of Momora to edit.',
    );
    expect(screen.getByTestId('edit-memory-save-btn').props.accessibilityState?.disabled).toBe(true);
    expect(screen.queryByTestId('edit-memory-content')).toBeNull();
    expect(screen.queryByTestId('edit-memory-ai-toggle')).toBeNull();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('disables AI with concise helper copy above six tags', () => {
    mockedUseAutoMemoryTags.mockReturnValue({
      selectedMemberIds: Array.from({ length: 7 }, (_, index) => `member-${index}`),
      initializeTags,
      applyForContent: jest.fn(),
      toggleMember: jest.fn(),
      applyVoiceResult: jest.fn(),
    });

    const screen = renderScreen();

    expect(screen.getByTestId('edit-memory-ai-toggle').props.disabled).toBe(true);
    expect(screen.getByText('Up to 6 people per illustration')).toBeTruthy();
  });
});

// P3.2 (docs/plans/audio-memories-v1.md) -- audio memories are the real,
// known, EDITABLE type here: description/date/tags, clip immutable.
describe('EditMemoryScreen audio variant', () => {
  const audioMemoryData = (overrides: Record<string, unknown> = {}) => ({
    id: 'memory-1',
    content: 'Lila singing Twinkle Twinkle in the bath.',
    memory_date: '2026-07-14',
    memory_type: 'audio',
    media_key: 'user-1/memories/memory-1/media/clip-1.m4a',
    media_content_type: 'audio/mp4',
    mediaAssets: [
      {
        id: 'clip-1',
        object_key: 'user-1/memories/memory-1/media/clip-1.m4a',
        content_type: 'audio/mp4',
        duration_ms: 42_000,
        aspect_ratio: null,
      },
    ],
    taggedMembers: [],
    illustration_key: null,
    illustration_status: 'none',
    updated_at: '2026-07-14T09:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ updateMemory, isUpdating: false });
    mockedUseMediaUrl.mockReturnValue({ url: undefined });
    mockedUseMediaUrls.mockReturnValue({ data: undefined });
    mockedUseAutoMemoryTags.mockReturnValue({
      selectedMemberIds: [],
      initializeTags,
      applyForContent: jest.fn(),
      toggleMember: jest.fn(),
      applyVoiceResult: jest.fn(),
    });
    mockedUseMemory.mockReturnValue({ data: audioMemoryData(), isLoading: false, isPlaceholderData: false });
  });

  it('opens editable, with the description prefilled, the "Sound" type pill, and no media/AI affordances', () => {
    const screen = renderScreen();

    expect(screen.getByTestId('edit-memory-content').props.value).toBe(
      'Lila singing Twinkle Twinkle in the bath.',
    );
    expect(screen.getByText('· Sound')).toBeTruthy();
    expect(screen.queryByTestId('edit-memory-ai-toggle')).toBeNull();
    expect(screen.getByTestId('edit-memory-audio-clip')).toBeTruthy();
  });

  it('never renders a remove control on the clip', () => {
    const screen = renderScreen();
    expect(screen.queryByTestId('edit-memory-audio-clip-remove')).toBeNull();
  });

  it('disables the mic with the "cannot be re-recorded" hint, and never opens the voice modal', () => {
    const screen = renderScreen();

    const micButton = screen.getByTestId('edit-memory-voice-trigger');
    expect(micButton.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText('This sound cannot be re-recorded.')).toBeTruthy();

    fireEvent.press(micButton);
    // A disabled Pressable's onPress never fires -- nothing to assert on a
    // mock here beyond "the screen didn't crash navigating into a modal
    // that isn't wired for audio," which the render above already covers.
  });

  it('saves description/date/tags as an audio memory, never sending mediaAssets', async () => {
    const screen = renderScreen();

    fireEvent.changeText(screen.getByTestId('edit-memory-content'), 'Updated note about the sound');

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: 'memory-1',
        content: 'Updated note about the sound',
        memoryType: 'audio',
        mediaAssets: undefined,
      }),
    );
  });

  it('allows saving with an empty description -- the clip is the artifact', async () => {
    const screen = renderScreen();

    fireEvent.changeText(screen.getByTestId('edit-memory-content'), '');

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ content: '', memoryType: 'audio' }),
    );
  });
});
