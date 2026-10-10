import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ARTWORK_INTRO_SEEN_STORAGE_KEY } from '@/components/artwork-scan-button';
import { ClipChip } from '@/components/audio/clip-chip';
import { hasFloorTrace, SILENT_WAVEFORM } from '@/components/audio/trace-test-utils';
import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { trackEvent } from '@/services/analytics';

import { MediaAssetUploadError } from '@/services/memory-posting';

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

let mockMediaPickerProps: { onSelect: (attachments: unknown[]) => void } | null = null;
jest.mock('@/components/memory-media-picker', () => ({
  MemoryMediaPicker: (props: { onSelect: (attachments: unknown[]) => void }) => {
    mockMediaPickerProps = props;
    return null;
  },
}));

let mockMediaPreviewProps: {
  attachments: { id: string; uri: string; source?: string; objectKey?: string }[];
  headerLabel?: string;
  onRemove: (attachmentId: string) => void;
} | null = null;
jest.mock('@/components/memory-media-preview', () => ({
  MemoryMediaPreview: (props: NonNullable<typeof mockMediaPreviewProps>) => {
    mockMediaPreviewProps = props;
    return null;
  },
}));

// iOS (the jest default platform) checks camera permission before the
// scanner opens.
jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
}));

// The native scanner boundary (wrapper has its own suite). Unavailable by
// default -- the OTA-only-binary case; artwork tests flip it on.
const mockScanArtwork = jest.fn();
const mockIsArtworkScannerAvailable = jest.fn(() => false);
jest.mock('@/services/artwork-scanner', () => ({
  isArtworkScannerAvailable: () => mockIsArtworkScannerAvailable(),
  scanArtwork: (...args: unknown[]) => mockScanArtwork(...args),
}));

const mockDeleteArtworkScanFile = jest.fn().mockResolvedValue(undefined);
jest.mock('@/utils/artwork-scan-custody', () => ({
  deleteArtworkScanFile: (...args: unknown[]) => mockDeleteArtworkScanFile(...args),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
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

// Post-save trim (docs/plans/audio-trim-import.md addendum). The native
// module, the file download, transcription, the backfill write and the sheet
// are mocked at their boundary; the screen + useSavedAudioTrim run for real.
// `isAvailable` defaults to false (an older binary) so every suite above keeps
// exercising today's edit screen; the trim suite flips it on.
const mockAudioIsAvailable = jest.fn(() => false);
const mockAudioAnalyze = jest.fn();
const mockAudioRender = jest.fn();
jest.mock('../../modules/momora-audio', () => ({
  isAvailable: () => mockAudioIsAvailable(),
  analyze: (...args: unknown[]) => mockAudioAnalyze(...args),
  render: (...args: unknown[]) => mockAudioRender(...args),
  probe: jest.fn(),
}));

const mockDownloadAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  downloadAsync: (...args: unknown[]) => mockDownloadAsync(...args),
}));

const mockDiscardAudioClip = jest.fn().mockResolvedValue(undefined);
const mockNewAudioRecordingUri = jest.fn();
jest.mock('@/utils/audio-clip-custody', () => ({
  discardAudioClip: (...args: unknown[]) => mockDiscardAudioClip(...args),
  newAudioRecordingUri: (...args: unknown[]) => mockNewAudioRecordingUri(...args),
}));

const mockTranscribeClip = jest.fn();
jest.mock('@/services/voice-transcription', () => ({
  transcribeClip: (...args: unknown[]) => mockTranscribeClip(...args),
}));

const mockPatchAudioDescriptionIfEmpty = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/memories', () => ({
  ...jest.requireActual('@/services/memories'),
  patchAudioDescriptionIfEmpty: (...args: unknown[]) => mockPatchAudioDescriptionIfEmpty(...args),
}));

type MockTrimSheetProps = {
  visible: boolean;
  sourceUri: string;
  durationMs: number;
  initialRange: { startMs: number; endMs: number };
  suggested: boolean;
  maxSelectionMs: number;
  mustTrim: boolean;
  hasUserNote: boolean;
  onCancel: () => void;
  onDone: (range: { startMs: number; endMs: number }) => void;
  onDismissed?: () => void;
};
let mockTrimSheetProps: MockTrimSheetProps | undefined;
let mockTrimSheetMounted = false;
jest.mock('@/components/audio/trim-sheet', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    TrimSheet: (props: MockTrimSheetProps) => {
      mockTrimSheetProps = props;
      // The real sheet owns an audio player while mounted: the screen must
      // mount it only for a trim session.
      useEffect(() => {
        mockTrimSheetMounted = true;
        return () => {
          mockTrimSheetMounted = false;
        };
      }, []);
      return null;
    },
  };
});

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

  describe('adding a video to a media memory', () => {
    beforeEach(() => {
      mockedUseMemory.mockReturnValue({
        data: {
          id: 'memory-1',
          content: 'Caption',
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
    });

    function addVideo() {
      act(() => {
        mockMediaPickerProps?.onSelect([
          { id: 'new-video', uri: 'file:///clip.mp4', contentType: 'video/mp4', sizeBytes: 1 },
        ]);
      });
    }

    it('shows compress/upload progress for the new item while saving', async () => {
      let reportProgress: ((index: number, phase: string, fraction: number) => void) | undefined;
      updateMemory.mockImplementationOnce(
        (input: { onMediaProgress: typeof reportProgress }) =>
          new Promise(() => {
            reportProgress = input.onMediaProgress;
          }),
      );
      const screen = renderScreen();
      addVideo();

      await act(async () => {
        fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
      });
      expect(screen.getByText('Uploading video… 0%')).toBeTruthy();

      act(() => reportProgress?.(1, 'preparing', 0.5));
      expect(screen.getByText('Compressing video… 20%')).toBeTruthy();

      act(() => reportProgress?.(1, 'uploading', 0.5));
      expect(screen.getByText('Uploading video… 70%')).toBeTruthy();

      act(() => reportProgress?.(1, 'done', 1));
      expect(screen.getByText('Saving…')).toBeTruthy();
    });

    it('names the item that failed and clears the progress row', async () => {
      updateMemory.mockRejectedValueOnce(new MediaAssetUploadError('Media upload failed', 1));
      const screen = renderScreen();
      addVideo();

      await act(async () => {
        fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
      });

      expect(screen.getByTestId('edit-memory-error').props.children).toBe(
        "Couldn't upload video 2. Media upload failed.",
      );
      expect(screen.queryByTestId('edit-memory-upload-progress')).toBeNull();
    });
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

  it('draws the clip\'s real waveform in the recessed chip when the media row has one', () => {
    const seeded = renderScreen();
    expect(hasFloorTrace(seeded.toJSON())).toBe(false);
    seeded.unmount();

    const base = audioMemoryData();
    mockedUseMemory.mockReturnValue({
      data: audioMemoryData({ mediaAssets: [{ ...base.mediaAssets[0], waveform: SILENT_WAVEFORM }] }),
      isLoading: false,
      isPlaceholderData: false,
    });
    expect(hasFloorTrace(renderScreen().toJSON())).toBe(true);
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

// docs/plans/audio-trim-import.md "Addendum: post-save trim".
describe('EditMemoryScreen audio post-save trim', () => {
  const SIGNED_URL = 'https://signed.test/clip.m4a';
  const DOWNLOAD_URI = 'file:///documents/audio-recordings/download-1.m4a';
  const RENDER_OUT_URI = 'file:///documents/audio-recordings/out-1.m4a';
  const RENDERED_URI = 'file:///documents/audio-recordings/trim-1.m4a';
  const RENDERED_URI_2 = 'file:///documents/audio-recordings/trim-2.m4a';
  const SAVED_RANGE = { startMs: 1750, endMs: 8250 };

  const audioMemory = {
    id: 'memory-1',
    content: 'Lila singing in the bath.',
    memory_date: '2026-07-14',
    memory_type: 'audio',
    media_key: 'user-1/memories/memory-1/media/clip-1.m4a',
    media_content_type: 'audio/mp4',
    mediaAssets: [
      {
        id: 'clip-1',
        object_key: 'user-1/memories/memory-1/media/clip-1.m4a',
        content_type: 'audio/mp4',
        duration_ms: 10_000,
        aspect_ratio: null,
      },
    ],
    taggedMembers: [],
    illustration_key: null,
    illustration_status: 'none',
    updated_at: '2026-07-14T09:00:00.000Z',
  };

  // 10 s at 100 ms buckets: quiet edges, loud middle, so suggestTrim offers
  // roughly 1.75 s..8.25 s.
  function energiesFixture(durationMs = 10_000) {
    const count = durationMs / 100;
    return {
      durationMs,
      bucketMs: 100,
      energies: Array.from({ length: count }, (_, i) => (i >= 20 && i < count - 20 ? 0.1 : 1e-9)),
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mockPipeline(renderedUri = RENDERED_URI, durationMs = 6500) {
    mockNewAudioRecordingUri
      .mockResolvedValueOnce(DOWNLOAD_URI)
      .mockResolvedValue(RENDER_OUT_URI);
    mockDownloadAsync.mockResolvedValue({ status: 200, uri: DOWNLOAD_URI });
    mockAudioRender.mockResolvedValue({ uri: renderedUri, durationMs, sizeBytes: 90_000 });
    mockAudioAnalyze.mockImplementation(async (uri: string) =>
      uri === renderedUri ? energiesFixture(durationMs) : energiesFixture(),
    );
  }

  async function openSheet(screen: ReturnType<typeof renderScreen>) {
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-audio-clip-trim'));
    });
    await flush();
  }

  async function trimTo(screen: ReturnType<typeof renderScreen>, range = SAVED_RANGE) {
    await openSheet(screen);
    expect(mockTrimSheetProps?.visible).toBe(true);
    await act(async () => {
      mockTrimSheetProps?.onDone(range);
    });
    await flush();
  }

  function discardedUris() {
    return mockDiscardAudioClip.mock.calls.map((call) => call[0]);
  }

  function pressSave(screen: ReturnType<typeof renderScreen>) {
    return act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });
  }

  /** Presses the named button of the most recent Alert.alert call. */
  async function pressAlertButton(label: string) {
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    const button = buttons?.find((b) => b.text === label);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.onPress?.();
    });
    await flush();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    onlineManager.setOnline(true);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockTrimSheetProps = undefined;
    mockTrimSheetMounted = false;
    mockAudioIsAvailable.mockReturnValue(true);
    mockDownloadAsync.mockReset();
    mockAudioRender.mockReset();
    mockAudioAnalyze.mockReset();
    mockNewAudioRecordingUri.mockReset();
    mockTranscribeClip.mockResolvedValue({
      cleanedText: 'trimmed transcript',
      description: 'Trimmed description',
      mentionedMemberIds: [],
    });
    updateMemory.mockResolvedValue(undefined);

    mockedUseFamily.mockReturnValue({ role: 'manager', familyId: 'family-1' });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ updateMemory, isUpdating: false });
    mockedUseMediaUrl.mockReturnValue({ url: SIGNED_URL });
    mockedUseMediaUrls.mockReturnValue({ data: undefined });
    mockedUseAutoMemoryTags.mockReturnValue({
      selectedMemberIds: [],
      initializeTags,
      applyForContent: jest.fn(),
      toggleMember: jest.fn(),
      applyVoiceResult: jest.fn(),
    });
    mockedUseMemory.mockReturnValue({ data: audioMemory, isLoading: false, isPlaceholderData: false });
  });

  afterEach(() => {
    act(() => {
      onlineManager.setOnline(true);
    });
    jest.restoreAllMocks();
  });

  // ── Gating ──────────────────────────────────────────────────────────

  it('offers the scissors when the module is available, the user can edit, and the device is online', () => {
    const screen = renderScreen();
    expect(screen.getByTestId('edit-memory-audio-clip-trim')).toBeTruthy();
    expect(screen.getByText('Kept as recorded')).toBeTruthy();
    expect(screen.getByText('This sound cannot be re-recorded.')).toBeTruthy();
  });

  it('hides the scissors on a binary without the native module', () => {
    mockAudioIsAvailable.mockReturnValue(false);
    const screen = renderScreen();
    expect(screen.getByTestId('edit-memory-audio-clip')).toBeTruthy();
    expect(screen.queryByTestId('edit-memory-audio-clip-trim')).toBeNull();
  });

  it('hides the scissors when the user cannot edit', () => {
    mockedUseFamily.mockReturnValue({ role: 'viewer', familyId: 'family-1' });
    const screen = renderScreen();
    expect(screen.queryByTestId('edit-memory-audio-clip-trim')).toBeNull();
  });

  it('hides the scissors while offline', () => {
    onlineManager.setOnline(false);
    const screen = renderScreen();
    expect(screen.queryByTestId('edit-memory-audio-clip-trim')).toBeNull();
  });

  it('says trimming needs a connection when connectivity drops before the tap lands', async () => {
    const screen = renderScreen();
    const staleOnTrim = screen.UNSAFE_getByType(ClipChip).props.onTrim as () => void;

    act(() => {
      onlineManager.setOnline(false);
    });
    await act(async () => {
      staleOnTrim();
    });

    expect(screen.getByTestId('edit-memory-error').props.children).toBe('Trimming needs a connection.');
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  // ── Download -> sheet -> Done -> preview ─────────────────────────────

  it('downloads the clip, analyses it, opens the sheet with the suggested range, then previews the render', async () => {
    mockPipeline();
    const screen = renderScreen();

    await openSheet(screen);

    expect(mockNewAudioRecordingUri).toHaveBeenCalledWith('m4a');
    expect(mockDownloadAsync).toHaveBeenCalledWith(SIGNED_URL, DOWNLOAD_URI);
    expect(mockAudioAnalyze).toHaveBeenCalledWith(DOWNLOAD_URI, { maxBuckets: 4000, minBucketMs: 20 });
    expect(mockTrimSheetMounted).toBe(true);
    expect(mockTrimSheetProps).toMatchObject({
      visible: true,
      sourceUri: DOWNLOAD_URI,
      durationMs: 10_000,
      suggested: true,
      maxSelectionMs: 300_000,
      mustTrim: false,
      hasUserNote: true,
    });
    expect(mockTrimSheetProps?.initialRange.startMs).toBeGreaterThan(1000);
    expect(mockTrimSheetProps?.initialRange.endMs).toBeLessThanOrEqual(10_000);
    expect(trackEvent).toHaveBeenCalledWith('audio_trim_opened', { source: 'saved', suggested: true });

    await act(async () => {
      mockTrimSheetProps?.onDone(SAVED_RANGE);
    });
    await flush();

    expect(mockAudioRender).toHaveBeenCalledWith(DOWNLOAD_URI, {
      ...SAVED_RANGE,
      outputUri: RENDER_OUT_URI,
      bitrate: 96_000,
    });
    expect(screen.getByText('Trimmed — saves when you tap Save')).toBeTruthy();
    expect(screen.queryByText('Kept as recorded')).toBeNull();
    // The chip now plays the local render, not the saved clip's signed URL.
    const playbackSources = (useAudioClipPlayback as jest.Mock).mock.calls.map((call) => call[0]);
    expect(playbackSources.at(-1)).toBe(RENDERED_URI);
    // Nothing is uploaded or saved by trimming alone.
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('tells the sheet there is no note to keep when the note is empty', async () => {
    mockPipeline();
    mockedUseMemory.mockReturnValue({
      data: { ...audioMemory, content: null },
      isLoading: false,
      isPlaceholderData: false,
    });
    const screen = renderScreen();
    await openSheet(screen);
    expect(mockTrimSheetProps?.hasUserNote).toBe(false);
  });

  it('shows the spinner and disables Save while the clip downloads and while it renders', async () => {
    mockPipeline();
    const download = deferred<{ status: number }>();
    mockDownloadAsync.mockReturnValue(download.promise);
    const screen = renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-audio-clip-trim'));
    });
    expect(screen.getByTestId('edit-memory-audio-clip-trim-busy')).toBeTruthy();
    expect(screen.getByTestId('edit-memory-save-btn').props.accessibilityState?.disabled).toBe(true);

    await act(async () => {
      download.resolve({ status: 200 });
    });
    await flush();
    expect(screen.queryByTestId('edit-memory-audio-clip-trim-busy')).toBeNull();
    expect(screen.getByTestId('edit-memory-save-btn').props.accessibilityState?.disabled).toBeFalsy();

    const renderGate = deferred<{ uri: string; durationMs: number; sizeBytes: number }>();
    mockAudioRender.mockReturnValue(renderGate.promise);
    await act(async () => {
      mockTrimSheetProps?.onDone(SAVED_RANGE);
    });
    expect(screen.getByTestId('edit-memory-audio-clip-trim-busy')).toBeTruthy();
    expect(screen.getByTestId('edit-memory-save-btn').props.accessibilityState?.disabled).toBe(true);

    await act(async () => {
      renderGate.resolve({ uri: RENDERED_URI, durationMs: 6500, sizeBytes: 90_000 });
    });
    await flush();
    expect(screen.queryByTestId('edit-memory-audio-clip-trim-busy')).toBeNull();
  });

  it('reuses the downloaded original when the sheet is reopened, starting at the pending range', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);

    await openSheet(screen);

    expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
    expect(mockTrimSheetProps?.sourceUri).toBe(DOWNLOAD_URI);
    expect(mockTrimSheetProps?.initialRange).toEqual(SAVED_RANGE);
    expect(mockTrimSheetProps?.suggested).toBe(false);
  });

  it('Done with the full range clears the pending trim and discards its render', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);
    expect(screen.getByText('Trimmed — saves when you tap Save')).toBeTruthy();

    await openSheet(screen);
    await act(async () => {
      mockTrimSheetProps?.onDone({ startMs: 0, endMs: 10_000 });
    });
    await flush();

    expect(screen.getByText('Kept as recorded')).toBeTruthy();
    expect(discardedUris()).toContain(RENDERED_URI);
    expect(mockAudioRender).toHaveBeenCalledTimes(1);

    await pressSave(screen);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(updateMemory).toHaveBeenCalledWith(expect.objectContaining({ audioClip: undefined }));
  });

  it('re-trimming replaces the pending render and discards the superseded one', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);

    mockAudioRender.mockResolvedValue({ uri: RENDERED_URI_2, durationMs: 4000, sizeBytes: 50_000 });
    mockAudioAnalyze.mockImplementation(async (uri: string) =>
      uri === RENDERED_URI_2 ? energiesFixture(4000) : energiesFixture(),
    );
    await openSheet(screen);
    await act(async () => {
      mockTrimSheetProps?.onDone({ startMs: 3000, endMs: 7000 });
    });
    await flush();

    expect(discardedUris()).toContain(RENDERED_URI);
    expect(discardedUris()).not.toContain(RENDERED_URI_2);
    expect(mockDiscardAudioClip).not.toHaveBeenCalledWith(DOWNLOAD_URI);
  });

  // ── Failures ────────────────────────────────────────────────────────

  it('reports an expired link (non-2xx) as "Couldn\'t load this sound" and discards the file', async () => {
    mockPipeline();
    mockDownloadAsync.mockResolvedValue({ status: 403, uri: DOWNLOAD_URI });
    const screen = renderScreen();

    await openSheet(screen);

    expect(screen.getByTestId('edit-memory-error').props.children).toBe("Couldn't load this sound. Try again.");
    expect(mockTrimSheetProps).toBeUndefined();
    expect(discardedUris()).toContain(DOWNLOAD_URI);
    expect(mockAudioAnalyze).not.toHaveBeenCalled();
  });

  it('reports a missing signed URL gracefully', async () => {
    mockPipeline();
    mockedUseMediaUrl.mockReturnValue({ url: undefined });
    const screen = renderScreen();

    await openSheet(screen);

    expect(screen.getByTestId('edit-memory-error').props.children).toBe("Couldn't load this sound. Try again.");
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('reports a failed render and leaves the clip as saved', async () => {
    mockPipeline();
    mockAudioRender.mockRejectedValue(new Error('decode_failed'));
    const screen = renderScreen();

    await trimTo(screen);

    expect(screen.getByTestId('edit-memory-error').props.children).toBe("Couldn't trim that sound. Try again.");
    expect(screen.getByText('Kept as recorded')).toBeTruthy();
  });

  // ── Save ────────────────────────────────────────────────────────────

  it('Save with a pending trim asks for confirmation first, with the exact copy', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);

    await pressSave(screen);

    expect(Alert.alert).toHaveBeenCalledWith(
      'Trim this sound?',
      'The part you cut will be gone for good.',
      [
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Trim and save' }),
      ],
      expect.anything(),
    );
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('Cancel in the confirmation saves nothing and keeps the pending trim', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);
    await pressSave(screen);

    await pressAlertButton('Cancel');

    expect(updateMemory).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByText('Trimmed — saves when you tap Save')).toBeTruthy();

    // A second Save asks again.
    await pressSave(screen);
    expect(Alert.alert).toHaveBeenCalledTimes(2);
  });

  it('a confirmed save sends the trimmed clip, keeps the note, and navigates back', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);
    await pressSave(screen);

    await pressAlertButton('Trim and save');

    expect(updateMemory).toHaveBeenCalledTimes(1);
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: 'memory-1',
        content: 'Lila singing in the bath.',
        memoryType: 'audio',
        mediaAssets: undefined,
        audioClip: {
          fileUri: RENDERED_URI,
          durationMs: 6500,
          waveform: expect.any(Array),
        },
      }),
    );
    expect(router.back).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('audio_trim_applied', {
      source: 'saved',
      removed_bucket: '0_5s',
    });
  });

  it('transcribes the new clip after saving, backfills the description/transcript, and only then deletes the local files', async () => {
    mockPipeline();
    const transcription = deferred<{
      cleanedText: string;
      description: string;
      mentionedMemberIds: string[];
    } | null>();
    mockTranscribeClip.mockReturnValue(transcription.promise);
    const screen = renderScreen();
    await trimTo(screen);
    await pressSave(screen);
    await pressAlertButton('Trim and save');

    expect(mockTranscribeClip).toHaveBeenCalledWith(RENDERED_URI, [], 'family-1', {
      durationMs: 6500,
      sizeBytes: 90_000,
    });
    // Navigation did not wait, and the render (which transcription reads) is still on disk.
    expect(router.back).toHaveBeenCalled();
    expect(discardedUris()).not.toContain(RENDERED_URI);

    await act(async () => {
      transcription.resolve({
        cleanedText: 'trimmed transcript',
        description: 'Trimmed description',
        mentionedMemberIds: [],
      });
    });
    await flush();

    expect(mockPatchAudioDescriptionIfEmpty).toHaveBeenCalledWith('memory-1', {
      description: 'Trimmed description',
      transcript: 'trimmed transcript',
    });
    expect(discardedUris()).toEqual(expect.arrayContaining([RENDERED_URI, DOWNLOAD_URI]));
  });

  it('still deletes the local files when transcription fails, and never patches', async () => {
    mockPipeline();
    mockTranscribeClip.mockResolvedValue(null);
    const screen = renderScreen();
    await trimTo(screen);
    await pressSave(screen);
    await pressAlertButton('Trim and save');
    await flush();

    expect(mockPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();
    expect(discardedUris()).toEqual(expect.arrayContaining([RENDERED_URI, DOWNLOAD_URI]));
  });

  it('keeps the pending trim and shows the error when the save fails, then a retry can succeed', async () => {
    mockPipeline();
    updateMemory.mockRejectedValueOnce(new Error('Could not update memory'));
    const screen = renderScreen();
    await trimTo(screen);
    await pressSave(screen);
    await pressAlertButton('Trim and save');

    expect(router.back).not.toHaveBeenCalled();
    expect(mockTranscribeClip).not.toHaveBeenCalled();
    expect(discardedUris()).not.toContain(RENDERED_URI);
    expect(screen.getByText('Trimmed — saves when you tap Save')).toBeTruthy();

    await pressSave(screen);
    await pressAlertButton('Trim and save');
    expect(updateMemory).toHaveBeenCalledTimes(2);
    expect(router.back).toHaveBeenCalled();
  });

  it('Save without a pending trim behaves exactly as before: no confirm, no clip, no transcription', async () => {
    const screen = renderScreen();
    fireEvent.changeText(screen.getByTestId('edit-memory-content'), 'Only the note changed');

    await pressSave(screen);

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Only the note changed',
        memoryType: 'audio',
        mediaAssets: undefined,
        audioClip: undefined,
      }),
    );
    expect(mockTranscribeClip).not.toHaveBeenCalled();
  });

  // ── Leaving ─────────────────────────────────────────────────────────

  it('leaving without saving discards the downloaded original and the pending render', async () => {
    mockPipeline();
    const screen = renderScreen();
    await trimTo(screen);
    expect(discardedUris()).not.toContain(RENDERED_URI);

    screen.unmount();

    expect(discardedUris()).toEqual(expect.arrayContaining([RENDERED_URI, DOWNLOAD_URI]));
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('a render that finishes after the screen was left is discarded, never applied', async () => {
    mockPipeline();
    const screen = renderScreen();
    await openSheet(screen);
    const renderGate = deferred<{ uri: string; durationMs: number; sizeBytes: number }>();
    mockAudioRender.mockReturnValue(renderGate.promise);
    await act(async () => {
      mockTrimSheetProps?.onDone(SAVED_RANGE);
    });

    screen.unmount();
    expect(discardedUris()).toContain(DOWNLOAD_URI);

    await act(async () => {
      renderGate.resolve({ uri: RENDERED_URI, durationMs: 6500, sizeBytes: 90_000 });
    });
    await flush();

    expect(discardedUris()).toEqual(expect.arrayContaining([RENDER_OUT_URI, RENDERED_URI]));
    expect(mockTranscribeClip).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('a download that finishes after the screen was left is discarded', async () => {
    mockPipeline();
    const download = deferred<{ status: number }>();
    mockDownloadAsync.mockReturnValue(download.promise);
    const screen = renderScreen();
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-audio-clip-trim'));
    });

    screen.unmount();
    await act(async () => {
      download.resolve({ status: 200 });
    });
    await flush();

    expect(discardedUris()).toContain(DOWNLOAD_URI);
    expect(mockAudioAnalyze).not.toHaveBeenCalled();
    expect(mockTrimSheetProps).toBeUndefined();
  });

  it('unmounts the trim sheet (and its audio player) once its session has dismissed', async () => {
    mockPipeline();
    const screen = renderScreen();
    await openSheet(screen);
    expect(mockTrimSheetMounted).toBe(true);

    await act(async () => {
      mockTrimSheetProps?.onCancel();
    });
    expect(mockTrimSheetProps?.visible).toBe(false);
    expect(mockTrimSheetMounted).toBe(true);

    await act(async () => {
      mockTrimSheetProps?.onDismissed?.();
    });
    expect(mockTrimSheetMounted).toBe(false);
    expect(screen.getByText('Kept as recorded')).toBeTruthy();
  });
});

describe('EditMemoryScreen artwork variant (docs/plans/artwork-scanning.md)', () => {
  const mediaMemoryData = (overrides: Record<string, unknown> = {}) => ({
    id: 'memory-1',
    content: 'Rainbow house',
    memory_date: '2026-07-14',
    memory_type: 'media',
    media_variant: 'artwork',
    media_key: 'user-1/memories/memory-1/media/scan-1.jpg',
    media_content_type: 'image/jpeg',
    mediaAssets: [
      {
        id: 'scan-1',
        object_key: 'user-1/memories/memory-1/media/scan-1.jpg',
        content_type: 'image/jpeg',
        duration_ms: null,
        aspect_ratio: 1.33,
      },
    ],
    taggedMembers: [],
    illustration_key: null,
    illustration_status: 'none',
    updated_at: '2026-07-14T09:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Returning user: the first-time artwork intro sheet has been seen.
    await AsyncStorage.setItem(ARTWORK_INTRO_SEEN_STORAGE_KEY, '1');
    mockMediaPickerProps = null;
    mockMediaPreviewProps = null;
    mockIsArtworkScannerAvailable.mockReturnValue(false);
    mockScanArtwork.mockReset();
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
  });

  it('renders no media picker, a disabled scan placeholder, and the "Artwork" type pill', () => {
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData(),
      isLoading: false,
      isPlaceholderData: false,
    });

    const screen = renderScreen();

    expect(mockMediaPickerProps).toBeNull();
    const placeholder = screen.getByTestId('edit-memory-scan-artwork-disabled');
    expect(placeholder.props.accessibilityHint).toBe('Update the app to scan more artwork');
    expect(placeholder.props.accessibilityState).toEqual({ disabled: true });
    expect(screen.getByText('· Artwork')).toBeTruthy();
    expect(mockMediaPreviewProps?.headerLabel).toBe('Artwork');
    expect(screen.queryByTestId('edit-memory-ai-toggle')).toBeNull();
  });

  function scannedPage(id: string) {
    return {
      id,
      uri: `file:///documents/artwork-scans/${id}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      aspectRatio: 1.33,
      source: 'scan' as const,
    };
  }

  async function runScan(screen: ReturnType<typeof render>, ids: string[]) {
    mockScanArtwork.mockResolvedValueOnce({
      status: 'success',
      attachments: ids.map(scannedPage),
      droppedCount: 0,
      rejectedCount: 0,
      validationError: null,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-scan-artwork'));
    });
  }

  it('renders the live scan button (not the placeholder) when the native scanner is available', () => {
    mockIsArtworkScannerAvailable.mockReturnValue(true);
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData(),
      isLoading: false,
      isPlaceholderData: false,
    });

    const screen = renderScreen();

    expect(screen.getByTestId('edit-memory-scan-artwork')).toBeTruthy();
    expect(screen.queryByTestId('edit-memory-scan-artwork-disabled')).toBeNull();
    expect(mockMediaPickerProps).toBeNull();
  });

  it('appends scanned pages and uploads them through the normal edit save, never sending media_variant', async () => {
    mockIsArtworkScannerAvailable.mockReturnValue(true);
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData(),
      isLoading: false,
      isPlaceholderData: false,
    });
    const screen = renderScreen();

    await runScan(screen, ['scan-2', 'scan-3']);

    expect(mockScanArtwork).toHaveBeenCalledWith({ remainingSlots: 9 });
    expect(mockMediaPreviewProps?.attachments.map((a) => a.id)).toEqual(['scan-1', 'scan-2', 'scan-3']);

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });

    expect(updateMemory).toHaveBeenCalledTimes(1);
    const input = updateMemory.mock.calls[0][0];
    expect(input.memoryType).toBe('media');
    expect(input.mediaAssets).toHaveLength(3);
    expect(input.mediaAssets[1]).toMatchObject({
      fileUri: 'file:///documents/artwork-scans/scan-2.jpg',
      mediaAssetId: 'scan-2',
    });
    expect(JSON.stringify(input)).not.toContain('media_variant');
    expect(JSON.stringify(input)).not.toContain('mediaVariant');
    // Uploaded: the scan files are no longer needed.
    expect(mockDeleteArtworkScanFile).toHaveBeenCalledWith('file:///documents/artwork-scans/scan-2.jpg');
    expect(mockDeleteArtworkScanFile).toHaveBeenCalledWith('file:///documents/artwork-scans/scan-3.jpg');
  });

  it('keeps the scan files when the save fails, and deletes them when the screen is left unsaved', async () => {
    mockIsArtworkScannerAvailable.mockReturnValue(true);
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData(),
      isLoading: false,
      isPlaceholderData: false,
    });
    updateMemory.mockRejectedValueOnce(new Error('offline'));
    const screen = renderScreen();
    await runScan(screen, ['scan-2']);

    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-memory-save-btn'));
    });
    expect(mockDeleteArtworkScanFile).not.toHaveBeenCalled();

    screen.unmount();
    expect(mockDeleteArtworkScanFile).toHaveBeenCalledWith('file:///documents/artwork-scans/scan-2.jpg');
  });

  it('deletes the file of a removed scanned tile but never an uploaded one', async () => {
    mockIsArtworkScannerAvailable.mockReturnValue(true);
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData(),
      isLoading: false,
      isPlaceholderData: false,
    });
    const screen = renderScreen();
    await runScan(screen, ['scan-2']);

    act(() => {
      mockMediaPreviewProps?.onRemove('scan-2');
    });
    expect(mockDeleteArtworkScanFile).toHaveBeenCalledWith('file:///documents/artwork-scans/scan-2.jpg');

    mockDeleteArtworkScanFile.mockClear();
    act(() => {
      mockMediaPreviewProps?.onRemove('scan-1');
    });
    expect(mockDeleteArtworkScanFile).not.toHaveBeenCalled();
  });

  it('still renders the media picker for a regular photo memory', () => {
    mockedUseMemory.mockReturnValue({
      data: mediaMemoryData({ media_variant: null }),
      isLoading: false,
      isPlaceholderData: false,
    });

    const screen = renderScreen();

    expect(mockMediaPickerProps).not.toBeNull();
    expect(screen.queryByTestId('edit-memory-scan-artwork-disabled')).toBeNull();
    expect(screen.getByText('· Photo')).toBeTruthy();
  });
});
