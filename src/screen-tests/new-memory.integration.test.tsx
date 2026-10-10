// Deliberately lives under src/screen-tests/ (the repo's home for
// screen-level tests), not app/. Expo Router's route context matches every
// .tsx under app/ (only +api/+html/+middleware are excluded, and this repo
// configures no router `ignore`), so a test file placed under app/(app)/
// would register as a phantom route and its module-scope jest.mock/describe
// calls would throw when the route module is evaluated at app startup --
// crashing release bundles. See
// docs/plans/media-exif-capture-date-prefill.md for the full rationale.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { JOURNALING_PROMPTS } from '@/constants/journaling-prompts';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useIncomingMemoryShare } from '@/hooks/use-incoming-memory-share';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useUserProfile } from '@/hooks/useUserProfile';
import { navigateBack } from '@/lib/navigation';
import { trackEvent } from '@/services/analytics';
import { getNewMemoryDraftStorageKey, saveNewMemoryDraft } from '@/utils/new-memory-draft';

// Imported with a relative path -- jest's moduleNameMapper only maps `@/` to
// `src/`, it does not resolve the Expo Router `app/` tree.
import NewMemoryScreen from '../../app/(app)/new-memory';

// The draft-autosave util (src/utils/new-memory-draft.ts) is exercised for
// real against this mock rather than stubbed out, so these tests assert
// against actual persisted JSON instead of a jest.fn() call shape.
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// MemoryTagPicker (rendered for real, not mocked) transitively imports
// @/lib/supabase -> @react-native-async-storage/async-storage via
// FamilyMemberAvatar/useMediaUrls, even with an empty member list -- the
// import graph loads at module-evaluation time regardless of what actually
// renders. Mocking the client here (same shape as other unit tests) keeps
// that native module out of this suite.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

// VoiceSpeakItModal (rendered for real) transitively imports expo-audio at
// module scope via useVoiceInput -- unrelated to capture-date prefill and
// not mockable via a native-module stub alone, so the component itself is
// stubbed out here. Voice input has its own test coverage elsewhere. The
// mock hands out the latest onKeepSound/onResult callbacks plus the
// captureMode the composer requested (module-scope vars, same pattern as
// new-memory.auto-tag.test.tsx) so the audio-mode tests below can drive the
// fork's outcome directly and assert which mode the composer asked for.
let mockLatestOnKeepSound:
  | ((clip: {
      localUri: string;
      durationMs: number;
      transcriptionStatus: 'idle' | 'transcribing' | 'done' | 'failed';
      transcriptionResult: { cleanedText: string; description: string; mentionedMemberIds: string[] } | null;
      pendingTranscription: Promise<{ cleanedText: string; description: string } | null> | null;
    }) => void)
  | undefined;
let mockLatestOnResult:
  | ((result: { cleanedText: string; description: string; mentionedMemberIds: string[] }) => void)
  | undefined;
let mockLatestCaptureMode: 'dictate' | 'fork' | 'keepOnly' | undefined;
jest.mock('@/components/voice-speak-it-modal', () => ({
  VoiceSpeakItModal: (props: {
    captureMode?: 'dictate' | 'fork' | 'keepOnly';
    onKeepSound?: (clip: unknown) => void;
    onResult: (result: unknown) => void;
  }) => {
    mockLatestCaptureMode = props.captureMode;
    mockLatestOnKeepSound = props.onKeepSound as typeof mockLatestOnKeepSound;
    mockLatestOnResult = props.onResult as typeof mockLatestOnResult;
    return null;
  },
}));

// new-memory.tsx imports useAudioClipPlayback directly for the clip-chip
// preview -- unrelated to most suites in this file, but it transitively
// pulls in expo-audio at module scope (see useAudioClipPlayback.test.ts for
// real coverage of that hook).
jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: () => ({
    playing: false,
    position: 0,
    duration: 0,
    progress: 0,
    loading: false,
    error: null,
    toggle: jest.fn(),
    seekTo: jest.fn(),
  }),
}));

const mockDiscardAudioClip = jest.fn().mockResolvedValue(undefined);
const mockNewAudioRecordingUri = jest.fn();
jest.mock('@/utils/audio-clip-custody', () => ({
  discardAudioClip: (...args: unknown[]) => mockDiscardAudioClip(...args),
  newAudioRecordingUri: (...args: unknown[]) => mockNewAudioRecordingUri(...args),
}));

// Audio trim + import (docs/plans/audio-trim-import.md). The native module,
// transcription, the import pipeline, the document picker and both sheets
// are mocked at their boundary; the composer's state machine runs for real.
// `isAvailable` defaults to false (an older binary) so every pre-existing
// suite in this file keeps exercising today's composer; the trim/import
// suite below flips it on.
const mockAudioIsAvailable = jest.fn(() => false);
const mockAudioAnalyze = jest.fn();
const mockAudioRender = jest.fn();
jest.mock('../../modules/momora-audio', () => ({
  isAvailable: () => mockAudioIsAvailable(),
  analyze: (...args: unknown[]) => mockAudioAnalyze(...args),
  render: (...args: unknown[]) => mockAudioRender(...args),
  probe: jest.fn(),
}));

const mockTranscribeClip = jest.fn();
jest.mock('@/services/voice-transcription', () => ({
  transcribeClip: (...args: unknown[]) => mockTranscribeClip(...args),
}));

const mockImportAudioFile = jest.fn();
jest.mock('@/services/audio-import', () => ({
  importAudioFile: (...args: unknown[]) => mockImportAudioFile(...args),
}));

const mockPickAudioDocument = jest.fn();
const mockIsDocumentPickerAvailable = jest.fn(() => false);
jest.mock('@/utils/document-picker', () => ({
  pickAudioDocument: (...args: unknown[]) => mockPickAudioDocument(...args),
  isDocumentPickerAvailable: () => mockIsDocumentPickerAvailable(),
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
      // The real sheet owns an audio player while mounted: the composer must
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

type MockBringInProps = {
  visible: boolean;
  onChooseFile: () => void;
  onClose: () => void;
  onDismissed?: () => void;
};
let mockBringInProps: MockBringInProps | undefined;
jest.mock('@/components/audio/bring-in-sound-sheet', () => ({
  BringInSoundSheet: (props: MockBringInProps) => {
    mockBringInProps = props;
    return null;
  },
}));

// The real picker still renders (the photo tests drive its action sheet);
// this wrapper only records whether the composer offered the sound option.
let mockPickerOnPickSound: (() => void) | undefined;
jest.mock('@/components/memory-media-picker', () => {
  const actual = jest.requireActual('@/components/memory-media-picker');
  const { createElement } = jest.requireActual('react');
  return {
    ...actual,
    MemoryMediaPicker: (props: { onPickSound?: () => void }) => {
      mockPickerOnPickSound = props.onPickSound;
      return createElement(actual.MemoryMediaPicker, props);
    },
  };
});

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  getMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

// The screen mounts DatePickerField, which renders this native picker on
// Android via an imperative `.open({ onChange })` call -- mocking it lets
// the test drive a date change by invoking the captured onChange directly,
// without a real native wheel.
jest.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
  DateTimePickerAndroid: { open: jest.fn() },
}));

jest.mock('@/lib/navigation', () => ({
  navigateBack: jest.fn(),
}));

jest.mock('expo-router', () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-billing', () => ({
  useBilling: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@/hooks/useMemories', () => ({
  useMemoryMutations: jest.fn(),
}));

jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
}));

jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  usePendingMemoryUploads: jest.fn(),
}));

// The native share-intent boundary (expo-sharing) is out of scope for this
// suite -- mocked here (like the picker-mock pattern for expo-image-picker)
// so the "incoming share replacement" scenario can be driven deterministically
// via its onPrepared callback instead of a real OS share intent.
jest.mock('@/hooks/use-incoming-memory-share', () => ({
  useIncomingMemoryShare: jest.fn(() => false),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedDateTimePickerAndroid = DateTimePickerAndroid as jest.Mocked<
  typeof DateTimePickerAndroid
>;
const mockedUseAuth = useAuth as jest.Mock;
const mockedUseBilling = useBilling as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseUserProfile = useUserProfile as jest.Mock;
const mockedUsePendingMemoryUploads = usePendingMemoryUploads as jest.Mock;
const mockedUseIncomingMemoryShare = useIncomingMemoryShare as jest.Mock;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <NewMemoryScreen />
    </SafeAreaProvider>,
  );
}

function buildImageAsset(overrides: Partial<ImagePicker.ImagePickerAsset> = {}) {
  return {
    uri: 'file:///photo.jpg',
    width: 100,
    height: 100,
    fileSize: 1024,
    mimeType: 'image/jpeg',
    ...overrides,
  } as ImagePicker.ImagePickerAsset;
}

function choosePhotoLibrary() {
  const calls = (Alert.alert as jest.Mock).mock.calls;
  const buttons = calls[calls.length - 1]?.[2] as
    | { text: string; onPress?: () => void }[]
    | undefined;
  buttons?.find((button) => button.text === 'Photo library')?.onPress?.();
}

async function attachPhoto(
  screen: ReturnType<typeof render>,
  asset: ImagePicker.ImagePickerAsset,
) {
  mockedImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [asset],
  } as ImagePicker.ImagePickerResult);

  fireEvent.press(screen.getByTestId('new-memory-attach-media'));
  choosePhotoLibrary();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(300);
  });
}

/** Drives a date change through the mocked Android DateTimePickerAndroid,
 * exercising DatePickerField exactly as the real component wires it up. */
function changeDateThroughPicker(screen: ReturnType<typeof render>, nextDate: Date) {
  fireEvent.press(screen.getByTestId('new-memory-date'));
  const openCalls = mockedDateTimePickerAndroid.open.mock.calls;
  const { onChange } = openCalls[openCalls.length - 1][0];
  act(() => {
    onChange?.({ type: 'set' } as never, nextDate);
  });
}

describe('NewMemoryScreen -- capture-date prefill integration', () => {
  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false });
    mockedUseFamily.mockReturnValue({
      role: 'manager',
      familyId: 'family-1',
      family: { id: 'family-1', name: 'Test family' },
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  it('attaching an EXIF-dated photo updates the displayed date and shows the "From media" hint', async () => {
    const screen = renderScreen();

    await attachPhoto(
      screen,
      buildImageAsset({ exif: { DateTimeOriginal: '2024:03:05 10:00:00' } }),
    );

    expect(screen.getByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText('From media', { includeHiddenElements: true })).toBeTruthy();

    const dateField = screen.getByTestId('new-memory-date');
    expect(dateField.props.accessibilityLabel).toContain('2024');
    expect(dateField.props.accessibilityHint).toBe('Suggested from media date');
  });

  it('changing the date, then attaching and removing media, preserves the user date and removes the hint', async () => {
    const screen = renderScreen();

    await attachPhoto(
      screen,
      buildImageAsset({ exif: { DateTimeOriginal: '2024:03:05 10:00:00' } }),
    );
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();

    changeDateThroughPicker(screen, new Date(2023, 0, 10));

    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();
    const userChosenLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;
    expect(userChosenLabel).toContain('2023');

    // Attaching another EXIF-dated photo must not overwrite the user's date.
    await attachPhoto(
      screen,
      buildImageAsset({
        uri: 'file:///photo2.jpg',
        exif: { DateTimeOriginal: '2024:01:01 10:00:00' },
      }),
    );
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toBe(userChosenLabel);

    // Removing all attached media must not restore the session default either.
    fireEvent.press(screen.getByTestId('memory-media-remove-1'));
    fireEvent.press(screen.getByTestId('memory-media-remove-0'));

    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toBe(userChosenLabel);
  });

  it('incoming shared capture dates suggest the date, remain user-overridable, and are not posted', async () => {
    let onPrepared:
      | ((result: { kind: 'media'; attachments: { id: string; capturedAtIso?: string }[]; errorMessage: string | null }) => void)
      | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared;
      return false;
    });

    const screen = renderScreen();

    // Shared media uses the same presentation-only scalar as a library pick.
    act(() => {
      onPrepared?.({
        kind: 'media',
        attachments: [{
          id: 'shared-1',
          uri: 'file:///shared.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
          capturedAtIso: '2024-03-05',
        } as never],
        errorMessage: null,
      });
    });

    expect(screen.getByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toContain('2024');

    // Once the user has overridden the date, a later incoming-share
    // replacement must not touch it, even when it has a different date.
    changeDateThroughPicker(screen, new Date(2022, 5, 15));
    const userChosenLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;

    act(() => {
      onPrepared?.({
        kind: 'media',
        attachments: [{
          id: 'shared-2',
          uri: 'file:///shared2.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
          capturedAtIso: '2021-01-01',
        } as never],
        errorMessage: null,
      });
    });

    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toBe(userChosenLabel);
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    const input = enqueue.mock.calls[0][0];
    expect(input.memoryDate).toBe('2022-06-15');
    expect(JSON.stringify(input)).not.toContain('capturedAtIso');
    expect(input.mediaAssets[0]).not.toHaveProperty('capturedAtIso');
  });

  it('an undated incoming share preserves the session baseline and does not show a suggestion', () => {
    let onPrepared:
      | ((result: { kind: 'media'; attachments: { id: string; capturedAtIso?: string }[]; errorMessage: string | null }) => void)
      | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared;
      return false;
    });

    const screen = renderScreen();
    const baselineLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;

    act(() => {
      onPrepared?.({
        kind: 'media',
        attachments: [{ id: 'shared-undated', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 } as never],
        errorMessage: null,
      });
    });

    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toBe(baselineLabel);
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();
  });

  it('saving passes only the final memoryDate to the posting queue, with no EXIF/capture metadata in the payload', async () => {
    const screen = renderScreen();

    await attachPhoto(
      screen,
      buildImageAsset({
        exif: {
          DateTimeOriginal: '2024:03:05 10:00:00',
          GPSLatitude: [37, 46, 26.4],
          Make: 'Apple',
        },
      }),
    );
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0];
    expect(input.memoryDate).toBe('2024-03-05');
    expect(JSON.stringify(input)).not.toContain('exif');
    expect(JSON.stringify(input)).not.toContain('GPS');
    expect(JSON.stringify(input)).not.toContain('capturedAtIso');
    for (const asset of input.mediaAssets) {
      expect(asset).not.toHaveProperty('capturedAtIso');
      expect(asset).not.toHaveProperty('exif');
    }
    expect(navigateBack).toHaveBeenCalled();
  });

  it('auto-switches to text-only when more than six members are selected', async () => {
    const memberNames = ['Alice', 'Bruno', 'Clara', 'Diego', 'Elena', 'Felix', 'Grace'];
    const members = memberNames.map((name, index) => ({
      additional_info: null,
      created_at: '2026-07-14T00:00:00.000Z',
      date_of_birth: null,
      family_id: 'family-1',
      gender: null,
      id: `member-${index}`,
      illustrated_profile_key: null,
      illustrated_profile_status: 'ready',
      is_user_profile: false,
      name,
      nicknames: [],
      profile_picture_key: null,
      updated_at: '2026-07-14T00:00:00.000Z',
      user_id: 'user-1',
    }));
    mockedUseFamilyMembers.mockReturnValue({ members });

    const screen = renderScreen();

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'The whole family gathered.');
    for (const member of members.slice(0, 3)) {
      fireEvent.press(screen.getByTestId(`memory-tag-${member.id}`));
    }
    fireEvent.press(screen.getByTestId('memory-tag-more'));
    for (const member of members.slice(3)) {
      fireEvent.press(screen.getByTestId(`roster-member-${member.id}`));
    }

    expect(screen.getByTestId('memory-tag-count').props.children).toEqual([' ', '· ', 7, '']);

    await waitFor(() => {
      expect(screen.getByTestId('new-memory-ai-toggle').props.enabled).toBe(false);
      expect(screen.getByText('Up to 6 people per illustration')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('roster-done-btn'));
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryType: 'text_only',
        taggedMemberIds: members.map((member) => member.id),
      }),
    );
  });
});

describe('NewMemoryScreen -- draft autosave and prompt placeholder integration', () => {
  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false });
    mockedUseFamily.mockReturnValue({
      role: 'manager',
      familyId: 'family-1',
      family: { id: 'family-1', name: 'Test family' },
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  it('autosaves the draft after a debounced delay and restores it on a fresh mount', async () => {
    const screen = renderScreen();
    // Let the mount-time restore attempt settle (it finds nothing to
    // restore) before typing, so the debounce timer asserted below is the
    // only in-flight timer -- otherwise the restore's own async completion
    // can re-trigger the debounce effect mid-advance and push the write
    // past a single 500ms window.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Grandma visited today');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    const stored = await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'));
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)).toMatchObject({ content: 'Grandma visited today' });

    screen.unmount();

    const secondMount = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => {
      expect(secondMount.getByDisplayValue('Grandma visited today')).toBeTruthy();
    });
  });

  it('does not restore a draft saved under a different family', async () => {
    await saveNewMemoryDraft('user-1', 'family-2', {
      content: 'Other family draft',
      taggedMemberIds: [],
      memoryDate: '2026-01-01',
      illustrationEnabled: true,
    });

    const screen = renderScreen(); // renders scoped to family-1 (default mock above)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByDisplayValue('Other family draft')).toBeNull();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('');
  });

  it('clears the saved draft once a text-only memory is successfully created', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Bedtime story time');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'))).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'))).toBeNull();
  });

  it('clears the saved draft immediately when a media memory is enqueued, without waiting for upload completion', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Beach day caption');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'))).toBeTruthy();

    await attachPhoto(screen, buildImageAsset());

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'))).toBeNull();
  });

  it('never persists attached media in the draft payload', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Zoo trip');
    await attachPhoto(screen, buildImageAsset());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    const stored = await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'));
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('attachedMedia');
    expect(parsed).not.toHaveProperty('mediaAssets');
    expect(JSON.stringify(parsed)).not.toContain('file://');
  });

  it('does not restore a stored draft once an incoming share has attached media (prefill wins)', async () => {
    await saveNewMemoryDraft('user-1', 'family-1', {
      content: 'stale draft text',
      taggedMemberIds: [],
      memoryDate: '2025-05-05',
      illustrationEnabled: true,
    });

    let capturedOnPrepared:
      | ((result: { kind: 'media'; attachments: { id: string; uri: string; contentType: string; sizeBytes: number }[]; errorMessage: string | null }) => void)
      | undefined;
    let isPreparing = true;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      capturedOnPrepared = options.onPrepared;
      return isPreparing;
    });

    const screen = renderScreen();

    // While the share is still preparing, the stored draft must not apply.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('');

    isPreparing = false;
    act(() => {
      capturedOnPrepared?.({
        kind: 'media',
        attachments: [{ id: 'shared-1', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 }],
        errorMessage: null,
      });
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    // The share prefilled media -- the stale stored draft must never
    // surface, even though `content` itself was still empty when the share
    // settled.
    expect(screen.queryByDisplayValue('stale draft text')).toBeNull();
  });

  it('restores the stored draft once a share settles with nothing to prefill', async () => {
    await saveNewMemoryDraft('user-1', 'family-1', {
      content: 'weekend recap',
      taggedMemberIds: [],
      memoryDate: '2025-05-05',
      illustrationEnabled: false,
    });

    let capturedOnPrepared:
      | ((result: { kind: 'error'; errorMessage: string }) => void)
      | undefined;
    let isPreparing = true;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      capturedOnPrepared = options.onPrepared;
      return isPreparing;
    });

    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('');

    isPreparing = false;
    act(() => {
      capturedOnPrepared?.({
        kind: 'error',
        errorMessage: 'Could not open the shared photos or videos. Try sharing them again.',
      });
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('weekend recap')).toBeTruthy();
    });
  });

  it('uses a rotating placeholder from the curated prompt list, stable across re-renders within the mount', async () => {
    const screen = renderScreen();

    const initialPlaceholder = screen.getByTestId('new-memory-content').props.placeholder;
    expect(JOURNALING_PROMPTS).toContain(initialPlaceholder);

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'typing something');
    fireEvent.changeText(screen.getByTestId('new-memory-content'), '');

    expect(screen.getByTestId('new-memory-content').props.placeholder).toBe(initialPlaceholder);
  });
});

// docs/plans/analytics-implementation.md WP3 item 2 -- `memory_saved` /
// `memory_save_failed` (docs/plans/analytics-tracking.md Tier 2).
describe('NewMemoryScreen -- memory_saved / memory_save_failed analytics', () => {
  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false });
    mockedUseFamily.mockReturnValue({
      role: 'manager',
      familyId: 'family-1',
      family: { id: 'family-1', name: 'Test family' },
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
    mockedUseLocalSearchParams.mockReturnValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  it('fires memory_saved with the default source and correct props on a text save', async () => {
    createMemory.mockResolvedValue({ id: 'memory-1' });
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Bedtime story time');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith('memory_saved', {
      memory_type: 'text_illustration',
      used_voice: false,
      has_media: false,
      tagged_count: 0,
      illustration_enabled: true,
      source: 'other',
    });
  });

  it('carries the source read from the route params (fab_timeline)', async () => {
    mockedUseLocalSearchParams.mockReturnValue({ source: 'fab_timeline' });
    createMemory.mockResolvedValue({ id: 'memory-1' });
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Park afternoon');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith(
      'memory_saved',
      expect.objectContaining({ source: 'fab_timeline' }),
    );
  });

  it('falls back to "other" for an unrecognized source param', async () => {
    mockedUseLocalSearchParams.mockReturnValue({ source: 'not-a-real-source' });
    createMemory.mockResolvedValue({ id: 'memory-1' });
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Zoo trip');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith(
      'memory_saved',
      expect.objectContaining({ source: 'other' }),
    );
  });

  it('reports illustration_enabled: false and has_media: true for a media save', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await attachPhoto(screen, buildImageAsset());
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith('memory_saved', {
      memory_type: 'media',
      used_voice: false,
      has_media: true,
      tagged_count: 0,
      illustration_enabled: false,
      source: 'other',
    });
  });

  it('fires memory_save_failed {code: network_error} when createMemory throws', async () => {
    createMemory.mockRejectedValue(new Error('network down'));
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Bedtime story time');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(mockedTrackEvent).toHaveBeenCalledWith('memory_save_failed', { code: 'network_error' });
    expect(mockedTrackEvent).not.toHaveBeenCalledWith('memory_saved', expect.anything());
  });

  it('shows the friendly offline copy (not the raw error) when Save fails while offline', async () => {
    // O6 (docs/plans/offline-awareness-and-share-cards.md): createMemory is
    // a react-query mutation pinned to networkMode 'always' (query-client.ts),
    // so it fails fast offline with a generic network error -- this screen
    // overrides that message with reassuring, draft-safe copy whenever
    // onlineManager reports offline at the moment of the catch.
    createMemory.mockRejectedValue(new Error('Network request failed'));
    act(() => {
      onlineManager.setOnline(false);
    });

    try {
      const screen = renderScreen();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });

      fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Bedtime story time');
      await act(async () => {
        fireEvent.press(screen.getByTestId('new-memory-save'));
      });

      expect(
        screen.getByText("You're offline — your draft is safe; try again when you're back"),
      ).toBeTruthy();
      expect(screen.queryByText('Network request failed')).toBeNull();
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
  });
});

// docs/plans/audio-memories-v1.md P2.3 -- the composer's emergent `audio`
// type once a clip is kept via the fork. VoiceSpeakItModal is mocked (see
// the module mock above); these tests drive it via the captured
// onKeepSound/onResult callbacks, the same pattern new-memory.auto-tag.test
// uses for onResult alone.
describe('NewMemoryScreen -- audio memories (emergent type)', () => {
  type AudioTranscriptionResult = { cleanedText: string; description: string; mentionedMemberIds: string[] };
  type KeptClip = {
    localUri: string;
    durationMs: number;
    transcriptionStatus: 'idle' | 'transcribing' | 'done' | 'failed';
    transcriptionResult: AudioTranscriptionResult | null;
    pendingTranscription: Promise<AudioTranscriptionResult | null> | null;
  };

  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  function buildKeptClip(overrides: Partial<KeptClip> = {}): KeptClip {
    return {
      localUri: 'file:///documents/audio-recordings/clip-1.m4a',
      durationMs: 4200,
      transcriptionStatus: 'done',
      transcriptionResult: { cleanedText: 'hello there', description: 'A quick hello', mentionedMemberIds: [] },
      pendingTranscription: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockLatestOnKeepSound = undefined;
    mockLatestOnResult = undefined;
    mockLatestCaptureMode = undefined;
    mockDiscardAudioClip.mockClear();

    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false });
    mockedUseFamily.mockReturnValue({
      role: 'manager',
      familyId: 'family-1',
      family: { id: 'family-1', name: 'Test family' },
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
    mockedUseLocalSearchParams.mockReturnValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  async function keepSound(screen: ReturnType<typeof render>, overrides: Partial<KeptClip> = {}) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip(overrides));
    });
  }

  it('becomes an emergent audio type once a sound is kept: media/AI hide, the description prefills, and the clip chip renders', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    expect(screen.getByText('· Sound')).toBeTruthy();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
    expect(screen.queryByTestId('new-memory-attach-media')).toBeNull();
    expect(screen.queryByTestId('new-memory-ai-toggle')).toBeNull();
  });

  // Regression coverage for a device-confirmed bug: fork mode, transcription
  // already resolved by the time the user tapped "Keep the sound" (as
  // opposed to still-in-flight, covered separately below). `buildKeptClip`'s
  // default is exactly this shape -- `transcriptionStatus: 'done'`,
  // `transcriptionResult` populated, `pendingTranscription: null` -- unlike
  // the re-record (keepOnly) path, which auto-keeps while transcription is
  // still pending and never exercises this branch. The composer must both
  // (1) prefill the note text field and (2) actually save that description
  // -- not just hold it in state invisibly (see the `key` fix + comment on
  // the content TextInput in new-memory.tsx for the display-only half of
  // this bug, which this state-level assertion can't observe on its own).
  it('fork: an already-resolved AI description prefills the note the instant the sound is kept', async () => {
    const screen = renderScreen();
    await keepSound(screen, {
      transcriptionStatus: 'done',
      transcriptionResult: { cleanedText: 'she giggled', description: 'Her giggle in the kitchen', mentionedMemberIds: [] },
      pendingTranscription: null,
    });

    expect(screen.queryByTestId('new-memory-audio-note-generating')).toBeNull();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Her giggle in the kitchen');
  });

  it('fork: an already-resolved description reaches the save payload on an immediate save (no pendingTranscription plumbing needed)', async () => {
    const screen = renderScreen();
    await keepSound(screen, {
      transcriptionStatus: 'done',
      transcriptionResult: { cleanedText: 'she giggled', description: 'Her giggle in the kitchen', mentionedMemberIds: [] },
      pendingTranscription: null,
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Her giggle in the kitchen',
        pendingTranscription: undefined,
      }),
    );
  });

  it('opens the mic in fork mode for the first recording, and keepOnly mode (no fork) once already an audio memory', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    expect(mockLatestCaptureMode).toBe('fork');

    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip());
    });

    // The toolbar's re-record mic promises a replace, never another
    // choice -- the composer must request keepOnly, not fork, once it's
    // already an audio memory (docs/plans/audio-memories-v1.md P2.3).
    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    expect(mockLatestCaptureMode).toBe('keepOnly');
  });

  it('pre-tags family members mentioned in the transcript', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [
        { id: 'member-1', name: 'Lila', nicknames: [], is_user_profile: false },
        { id: 'member-2', name: 'Theo', nicknames: [], is_user_profile: false },
      ],
    });
    const screen = renderScreen();
    await keepSound(screen, {
      transcriptionResult: { cleanedText: 'Lila laughed', description: 'Lila laughing', mentionedMemberIds: ['member-1'] },
    });

    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.selected).toBe(false);
  });

  it('never prefills over text the user already had before keeping the sound', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'my own caption');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip());
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('my own caption');
  });

  it('shows the "writing a note" treatment while a description is still generating, and applies it once it resolves (field left empty)', async () => {
    let resolveTranscription!: (value: AudioTranscriptionResult | null) => void;
    const pending = new Promise<AudioTranscriptionResult | null>((resolve) => {
      resolveTranscription = resolve;
    });

    const screen = renderScreen();
    await keepSound(screen, { transcriptionStatus: 'transcribing', transcriptionResult: null, pendingTranscription: pending });

    expect(screen.getByTestId('new-memory-audio-note-generating')).toBeTruthy();
    expect(screen.getByText('Writing a note from what you said…')).toBeTruthy();
    expect(screen.queryByTestId('new-memory-content')).toBeNull();

    await act(async () => {
      resolveTranscription({ cleanedText: 'said hello', description: 'A generated note', mentionedMemberIds: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('new-memory-audio-note-generating')).toBeNull();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A generated note');
  });

  it('skipping the generating note lets the user type immediately, and a later-arriving AI result is discarded', async () => {
    let resolveTranscription!: (value: AudioTranscriptionResult | null) => void;
    const pending = new Promise<AudioTranscriptionResult | null>((resolve) => {
      resolveTranscription = resolve;
    });

    const screen = renderScreen();
    await keepSound(screen, { transcriptionStatus: 'transcribing', transcriptionResult: null, pendingTranscription: pending });

    fireEvent.press(screen.getByTestId('new-memory-audio-note-skip'));
    expect(screen.getByTestId('new-memory-content').props.value).toBe('');

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'my own note');

    await act(async () => {
      resolveTranscription({ cleanedText: 'said hello', description: 'A generated note', mentionedMemberIds: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('my own note');
  });

  it('removing the clip shows an Undo affordance and disables Save; Undo restores it', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    fireEvent.press(screen.getByTestId('new-memory-audio-clip-remove'));

    expect(screen.getByTestId('new-memory-audio-clip-removed')).toBeTruthy();
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();
    expect(screen.getByTestId('new-memory-save').props.accessibilityState?.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('new-memory-audio-clip-undo'));

    expect(screen.queryByTestId('new-memory-audio-clip-removed')).toBeNull();
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
    expect(screen.getByTestId('new-memory-save').props.accessibilityState?.disabled).toBe(false);
  });

  it('cancel with the clip removed discards the local file', async () => {
    const screen = renderScreen();
    await keepSound(screen, { localUri: 'file:///documents/audio-recordings/removed-me.m4a' });
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-remove'));

    fireEvent.press(screen.getByTestId('new-memory-cancel'));

    expect(mockDiscardAudioClip).toHaveBeenCalledWith('file:///documents/audio-recordings/removed-me.m4a');
    expect(navigateBack).toHaveBeenCalled();
  });

  it('re-recording (a second "Keep the sound") replaces the clip and discards the old file, with no fork offered', async () => {
    const screen = renderScreen();
    await keepSound(screen, { localUri: 'file:///documents/audio-recordings/first.m4a' });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    expect(mockLatestCaptureMode).toBe('keepOnly');
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({
        localUri: 'file:///documents/audio-recordings/second.m4a',
        transcriptionResult: { cleanedText: 'second clip', description: 'Second description', mentionedMemberIds: [] },
      }));
    });

    expect(mockDiscardAudioClip).toHaveBeenCalledWith('file:///documents/audio-recordings/first.m4a');
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
    // Regression coverage (device-confirmed bug): the first clip's caption
    // was AI-authored and never touched by the user -- it describes a sound
    // that's now gone, so the new clip's caption must replace it, not sit
    // there stale (docs/features/audio-memories.md capture-flow section).
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Second description');
  });

  it('re-record: an untouched AI caption is replaced even when the new description is empty (cleared to placeholder, not left stale)', async () => {
    const screen = renderScreen();
    await keepSound(screen, { localUri: 'file:///documents/audio-recordings/first.m4a' });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({
        localUri: 'file:///documents/audio-recordings/second.m4a',
        transcriptionResult: { cleanedText: '', description: '', mentionedMemberIds: [] },
      }));
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('');
  });

  it('re-record: a user-edited caption survives the replace, and the invisible transcript still updates to the new clip', async () => {
    const screen = renderScreen();
    await keepSound(screen, { localUri: 'file:///documents/audio-recordings/first.m4a' });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    // The user edits the AI-authored caption -- it's theirs now.
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'A quick hello, edited by me');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({
        localUri: 'file:///documents/audio-recordings/second.m4a',
        transcriptionResult: { cleanedText: 'second clip transcript', description: 'Second description', mentionedMemberIds: [] },
      }));
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello, edited by me');

    // The invisible transcript describes the clip, not the user's words --
    // it must still move to the new clip's transcript even though the
    // visible caption stayed put.
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ audioTranscript: 'second clip transcript' }),
    );
  });

  it('re-record: text typed before ever recording anything stays protected across a replace too', async () => {
    const screen = renderScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'my own caption');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({ localUri: 'file:///documents/audio-recordings/first.m4a' }));
    });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('my own caption');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({
        localUri: 'file:///documents/audio-recordings/second.m4a',
        transcriptionResult: { cleanedText: 'second clip', description: 'Second description', mentionedMemberIds: [] },
      }));
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('my own caption');
  });

  it('re-record while the note is an untouched AI caption shows the generating treatment again while the new clip transcribes', async () => {
    let resolveTranscription!: (value: AudioTranscriptionResult | null) => void;
    const pending = new Promise<AudioTranscriptionResult | null>((resolve) => {
      resolveTranscription = resolve;
    });

    const screen = renderScreen();
    await keepSound(screen, { localUri: 'file:///documents/audio-recordings/first.m4a' });
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(buildKeptClip({
        localUri: 'file:///documents/audio-recordings/second.m4a',
        transcriptionStatus: 'transcribing',
        transcriptionResult: null,
        pendingTranscription: pending,
      }));
    });

    // The stale caption must not linger on screen with no indication it's
    // about to change -- the generating treatment takes over just like the
    // very first recording.
    expect(screen.getByTestId('new-memory-audio-note-generating')).toBeTruthy();
    expect(screen.queryByTestId('new-memory-content')).toBeNull();

    await act(async () => {
      resolveTranscription({ cleanedText: 'second clip', description: 'Second description', mentionedMemberIds: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('new-memory-audio-note-generating')).toBeNull();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Second description');
  });

  it('never persists the clip in the draft payload', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    const stored = await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'));
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('audioClip');
    expect(parsed).not.toHaveProperty('clip');
    expect(JSON.stringify(parsed)).not.toContain('audio-recordings');
    expect(JSON.stringify(parsed)).not.toContain('file://');
  });

  it('saves via the seam contract, firing memory_saved and audio_memory_saved with a bucketed duration', async () => {
    const screen = renderScreen();
    await keepSound(screen, { durationMs: 45000 });

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'audio',
        memoryDate: expect.any(String),
        content: 'A quick hello',
        taggedMemberIds: [],
        audioTranscript: 'hello there',
        clip: expect.objectContaining({
          fileUri: 'file:///documents/audio-recordings/clip-1.m4a',
          durationMs: 45000,
          contentType: 'audio/mp4',
        }),
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith('memory_saved', expect.objectContaining({
      memory_type: 'audio',
      used_voice: true,
      has_media: false,
    }));
    expect(trackEvent).toHaveBeenCalledWith('audio_memory_saved', {
      duration_bucket: '30_60s',
      has_description: true,
      source: 'recorded',
      trimmed: false,
    });
    expect(navigateBack).toHaveBeenCalled();
  });

  it('saving before transcription resolves stores an empty description and hands the still-pending promise to the queue, rather than patching directly', async () => {
    // Bug fix (post-review): the composer must NOT race
    // patchAudioDescriptionIfEmpty against the deferred post's insert --
    // the memories row doesn't exist until that insert completes, which
    // usually finishes AFTER transcription resolves, so a caller-side
    // patch here would silently no-op (a zero-row UPDATE succeeds with no
    // error) and permanently lose the description/transcript. The promise
    // itself is threaded through the enqueue input instead;
    // use-pending-memory-uploads.tsx fires the backfill only once its own
    // insert has succeeded (see PostAudioMemoryInput.pendingTranscription).
    let resolveTranscription!: (value: AudioTranscriptionResult | null) => void;
    const pending = new Promise<AudioTranscriptionResult | null>((resolve) => {
      resolveTranscription = resolve;
    });

    const screen = renderScreen();
    await keepSound(screen, { transcriptionStatus: 'transcribing', transcriptionResult: null, pendingTranscription: pending });

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ content: null, audioTranscript: null, pendingTranscription: pending }),
    );

    // Resolving afterward must not make the (already-closed) composer try
    // to patch anything itself.
    await act(async () => {
      resolveTranscription({ cleanedText: 'late transcript', description: 'late description', mentionedMemberIds: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('omits pendingTranscription from the enqueue input once transcription has already resolved by save time', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    const input = enqueue.mock.calls[0][0] as { pendingTranscription?: unknown };
    expect(input.pendingTranscription).toBeUndefined();
  });
});

// docs/plans/audio-trim-import.md "Composer state & flows": trim, import,
// real waveforms, and the async re-entry / file-ownership invariants. The
// native module, transcription, import pipeline, picker and sheets are mocked;
// the composer's audio state machine (src/hooks/use-composer-audio-clip.ts)
// runs for real.
describe('NewMemoryScreen -- audio trim and import', () => {
  type Transcription = { cleanedText: string; description: string; mentionedMemberIds: string[] };
  type Energies = { durationMs: number; bucketMs: number; energies: number[] };

  const CLIP_URI = 'file:///documents/audio-recordings/clip-1.m4a';
  const RENDER_OUT_URI = 'file:///documents/audio-recordings/out-1.m4a';
  const IMPORT_URI = 'file:///documents/audio-recordings/imp-1.m4a';
  const PHOTO_ERROR = 'This memory already has photos. Save it first, then share the voice note.';
  const SOUND_ERROR = 'This memory is a sound. Save it first, then share photos.';

  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  // 10 s at 100 ms buckets: quiet edges, loud middle, so suggestTrim offers
  // roughly 1.75 s..8.25 s.
  function energiesFixture(durationMs = 10_000): Energies {
    const count = durationMs / 100;
    return {
      durationMs,
      bucketMs: 100,
      energies: Array.from({ length: count }, (_, i) =>
        i >= 20 && i < count - 20 ? 0.1 : 1e-9,
      ),
    };
  }

  function transcription(overrides: Partial<Transcription> = {}): Transcription {
    return { cleanedText: 'hello there', description: 'A quick hello', mentionedMemberIds: [], ...overrides };
  }

  function keptClip(overrides: Record<string, unknown> = {}) {
    return {
      localUri: CLIP_URI,
      durationMs: 10_000,
      transcriptionStatus: 'done' as const,
      transcriptionResult: transcription(),
      pendingTranscription: null,
      pendingAnalysis: Promise.resolve(energiesFixture()),
      ...overrides,
    };
  }

  function importedClipResult(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'clip' as const,
      clip: {
        localUri: IMPORT_URI,
        durationMs: 20_000,
        sizeBytes: 200_000,
        waveform: Array.from({ length: 64 }, () => 100),
        source: 'imported' as const,
      },
      original: {
        localUri: IMPORT_URI,
        durationMs: 20_000,
        sizeBytes: 200_000,
        energies: energiesFixture(20_000),
        uploadable: true,
        transcription: null,
      },
      suggestedDateIso: null,
      ...overrides,
    };
  }

  const sharedAudio = {
    kind: 'audio' as const,
    uri: 'file:///cache/shared.opus',
    mimeType: 'audio/ogg',
    fileName: 'PTT.opus',
    sizeBytes: 1234,
  };

  async function flush() {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  async function keepSound(screen: ReturnType<typeof render>, overrides: Record<string, unknown> = {}) {
    await flush();
    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(keptClip(overrides) as never);
    });
    await flush();
  }

  /** Mocked render pipeline: render() resolves with `renderedUri`; analyze() answers per file. */
  function mockRenderPipeline(renderedUri = 'file:///documents/audio-recordings/trim-1.m4a', durationMs = 6500) {
    mockNewAudioRecordingUri.mockResolvedValue(RENDER_OUT_URI);
    mockAudioRender.mockResolvedValue({ uri: renderedUri, durationMs, sizeBytes: 90_000 });
    mockAudioAnalyze.mockImplementation(async (uri: string) =>
      uri === renderedUri ? energiesFixture(durationMs) : energiesFixture(),
    );
    return renderedUri;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function openTrimAndDone(
    screen: ReturnType<typeof render>,
    range = { startMs: 1750, endMs: 8250 },
  ) {
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    expect(mockTrimSheetProps?.visible).toBe(true);
    act(() => {
      mockTrimSheetProps?.onDone(range);
    });
    await flush();
  }

  function discardedUris() {
    return mockDiscardAudioClip.mock.calls.map((call) => call[0]);
  }

  function captureShare() {
    let onPrepared: ((result: unknown) => void) | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared as never;
      return false;
    });
    return (result: unknown) => {
      act(() => {
        onPrepared?.(result);
      });
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockLatestOnKeepSound = undefined;
    mockLatestOnResult = undefined;
    mockLatestCaptureMode = undefined;
    mockTrimSheetProps = undefined;
    mockTrimSheetMounted = false;
    mockBringInProps = undefined;
    mockPickerOnPickSound = undefined;
    mockDiscardAudioClip.mockClear();
    // clearAllMocks keeps implementations: start each test from a blank slate.
    mockImportAudioFile.mockReset();
    mockPickAudioDocument.mockReset();
    mockAudioRender.mockReset();
    mockNewAudioRecordingUri.mockReset();
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
    mockAudioIsAvailable.mockReturnValue(true);
    mockIsDocumentPickerAvailable.mockReturnValue(true);
    mockAudioAnalyze.mockImplementation(async () => energiesFixture());
    mockTranscribeClip.mockResolvedValue(
      transcription({ cleanedText: 'trimmed text', description: 'Trimmed description' }),
    );

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false });
    mockedUseFamily.mockReturnValue({
      role: 'manager',
      familyId: 'family-1',
      family: { id: 'family-1', name: 'Test family' },
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyMembers.mockReturnValue({ members: [] });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
    mockedUseLocalSearchParams.mockReturnValue({});
  });

  afterEach(() => {
    mockAudioIsAvailable.mockReturnValue(false);
    mockIsDocumentPickerAvailable.mockReturnValue(false);
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  // ── Waveform + trim ────────────────────────────────────────────────

  it('analysis fills the clip waveform and offers the trim button; save sends the 64-bucket waveform', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    expect(screen.getByTestId('new-memory-audio-clip-trim')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    const input = enqueue.mock.calls[0][0] as { clip: { waveform: number[] | null } };
    expect(input.clip.waveform).toHaveLength(64);
    // The modal's analysis was reused: the composer never decoded it again.
    expect(mockAudioAnalyze).not.toHaveBeenCalled();
  });

  it('starts its own analysis when the modal handed none over (re-record / keepOnly)', async () => {
    const screen = renderScreen();
    await keepSound(screen, { pendingAnalysis: undefined });

    expect(mockAudioAnalyze).toHaveBeenCalledWith(CLIP_URI, { maxBuckets: 4000, minBucketMs: 20 });
    expect(screen.getByTestId('new-memory-audio-clip-trim')).toBeTruthy();
  });

  it('opens the sheet with the suggested range, tracks audio_trim_opened, and uses the recorded 2:00 cap', async () => {
    const screen = renderScreen();
    await keepSound(screen);
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));

    expect(mockTrimSheetProps).toEqual(
      expect.objectContaining({
        visible: true,
        sourceUri: CLIP_URI,
        durationMs: 10_000,
        suggested: true,
        maxSelectionMs: 120_000,
        mustTrim: false,
        hasUserNote: false,
        initialRange: { startMs: 1750, endMs: 8250 },
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith('audio_trim_opened', { source: 'recorded', suggested: true });
  });

  it('trim replaces the clip with the render, re-transcribes it, and replaces an untouched AI caption', async () => {
    const renderedUri = mockRenderPipeline();
    const screen = renderScreen();
    await keepSound(screen);
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    await openTrimAndDone(screen);

    expect(mockAudioRender).toHaveBeenCalledWith(CLIP_URI, {
      startMs: 1750,
      endMs: 8250,
      outputUri: RENDER_OUT_URI,
      bitrate: 96_000,
    });
    expect(mockTranscribeClip).toHaveBeenCalledWith(
      renderedUri,
      [],
      'family-1',
      expect.objectContaining({ durationMs: 6500, sizeBytes: 90_000 }),
    );
    expect(mockTranscribeClip.mock.calls[0][3]).not.toHaveProperty('speaker');
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Trimmed description');
    expect(trackEvent).toHaveBeenCalledWith('audio_trim_applied', { source: 'recorded', removed_bucket: '0_5s' });

    // The original is kept for further trims; only a superseded render would go.
    expect(discardedUris()).not.toContain(CLIP_URI);

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        audioTranscript: 'trimmed text',
        clip: expect.objectContaining({ fileUri: renderedUri, durationMs: 6500 }),
      }),
    );
    expect((enqueue.mock.calls[0][0] as { clip: { waveform: unknown[] } }).clip.waveform).toHaveLength(64);
    expect(trackEvent).toHaveBeenCalledWith('audio_memory_saved', expect.objectContaining({ trimmed: true, source: 'recorded' }));
    // Save discards the original (differs from the saved file), never the saved render.
    expect(discardedUris()).toContain(CLIP_URI);
    expect(discardedUris()).not.toContain(renderedUri);
  });

  it('a typed note survives a trim, while the invisible transcript follows the new cut', async () => {
    mockRenderPipeline();
    const screen = renderScreen();
    await flush();
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'my own words');
    await keepSound(screen);

    await openTrimAndDone(screen);

    expect(screen.getByTestId('new-memory-content').props.value).toBe('my own words');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'my own words', audioTranscript: 'trimmed text' }),
    );
  });

  it('keeps a note the user edits DURING the render', async () => {
    const renderGate = deferred<{ uri: string; durationMs: number; sizeBytes: number }>();
    mockRenderPipeline();
    mockAudioRender.mockReturnValue(renderGate.promise);
    const screen = renderScreen();
    await keepSound(screen);

    await openTrimAndDone(screen);
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'typed while trimming');

    await act(async () => {
      renderGate.resolve({ uri: 'file:///documents/audio-recordings/trim-1.m4a', durationMs: 6500, sizeBytes: 90_000 });
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('typed while trimming');
  });

  it('Save, the toolbar mic and chip removal are disabled while a render runs', async () => {
    const renderGate = deferred<{ uri: string; durationMs: number; sizeBytes: number }>();
    mockRenderPipeline();
    mockAudioRender.mockReturnValue(renderGate.promise);
    const screen = renderScreen();
    await keepSound(screen);

    await openTrimAndDone(screen);

    expect(screen.getByTestId('new-memory-audio-clip-trim-busy')).toBeTruthy();
    expect(screen.getByTestId('new-memory-save').props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId('new-memory-voice-trigger').props.accessibilityState?.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).not.toHaveBeenCalled();

    await act(async () => {
      renderGate.resolve({ uri: 'file:///documents/audio-recordings/trim-1.m4a', durationMs: 6500, sizeBytes: 90_000 });
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId('new-memory-audio-clip-trim-busy')).toBeNull();
    expect(screen.getByTestId('new-memory-save').props.accessibilityState?.disabled).toBeFalsy();
  });

  it('full-range Done restores the original file and its transcription with no new transcription call', async () => {
    const renderedUri = mockRenderPipeline();
    const screen = renderScreen();
    await keepSound(screen);
    await openTrimAndDone(screen);
    expect(mockTranscribeClip).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Trimmed description');

    // Reopen: the sheet starts where the cut was left; the user drags back out to the whole clip.
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    expect(mockTrimSheetProps?.initialRange).toEqual({ startMs: 1750, endMs: 8250 });
    act(() => {
      mockTrimSheetProps?.onDone({ startMs: 0, endMs: 10_000 });
    });
    await flush();

    expect(mockAudioRender).toHaveBeenCalledTimes(1);
    expect(mockTranscribeClip).toHaveBeenCalledTimes(1);
    expect(discardedUris()).toContain(renderedUri);
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        audioTranscript: 'hello there',
        clip: expect.objectContaining({ fileUri: CLIP_URI }),
      }),
    );
    // The uploaded file is the original: saving must never delete it.
    expect(discardedUris()).not.toContain(CLIP_URI);
    expect(trackEvent).toHaveBeenCalledWith('audio_memory_saved', expect.objectContaining({ trimmed: false }));
  });

  it('Done on an untouched full range changes nothing (no render, no transcription)', async () => {
    const screen = renderScreen();
    await keepSound(screen);
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    act(() => {
      mockTrimSheetProps?.onDone({ startMs: 0, endMs: 10_000 });
    });
    await flush();

    expect(mockAudioRender).not.toHaveBeenCalled();
    expect(mockTranscribeClip).not.toHaveBeenCalled();
    expect(discardedUris()).not.toContain(CLIP_URI);
  });

  it('a failed re-transcription saves audioTranscript: null rather than the full clip\'s words', async () => {
    mockRenderPipeline();
    mockTranscribeClip.mockResolvedValue(null);
    const screen = renderScreen();
    await keepSound(screen);

    await openTrimAndDone(screen);
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ audioTranscript: null }));
  });

  it('Cancel during a render discards the render output and the original only once it completes', async () => {
    const renderGate = deferred<{ uri: string; durationMs: number; sizeBytes: number }>();
    mockRenderPipeline();
    mockAudioRender.mockReturnValue(renderGate.promise);
    const screen = renderScreen();
    await keepSound(screen);
    await openTrimAndDone(screen);

    fireEvent.press(screen.getByTestId('new-memory-cancel'));
    expect(navigateBack).toHaveBeenCalled();
    // The render is still reading the original: not deleted yet.
    expect(discardedUris()).not.toContain(CLIP_URI);

    await act(async () => {
      renderGate.resolve({ uri: 'file:///documents/audio-recordings/trim-1.m4a', durationMs: 6500, sizeBytes: 90_000 });
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(discardedUris()).toEqual(
      expect.arrayContaining(['file:///documents/audio-recordings/trim-1.m4a', CLIP_URI]),
    );
    expect(mockTranscribeClip).not.toHaveBeenCalled();
  });

  it('Cancel discards the current render and the original, deduped', async () => {
    const renderedUri = mockRenderPipeline();
    const screen = renderScreen();
    await keepSound(screen);
    await openTrimAndDone(screen);
    mockDiscardAudioClip.mockClear();

    fireEvent.press(screen.getByTestId('new-memory-cancel'));

    expect(discardedUris().sort()).toEqual([CLIP_URI, renderedUri].sort());
  });

  it('saving an untrimmed recording never deletes the uploaded file', async () => {
    const screen = renderScreen();
    await keepSound(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ clip: expect.objectContaining({ fileUri: CLIP_URI }) }),
    );
    expect(discardedUris()).not.toContain(CLIP_URI);
  });

  it('re-recording after a trim discards the old render and the old original', async () => {
    const renderedUri = mockRenderPipeline();
    const screen = renderScreen();
    await keepSound(screen);
    await openTrimAndDone(screen);
    mockDiscardAudioClip.mockClear();

    fireEvent.press(screen.getByTestId('new-memory-voice-trigger'));
    act(() => {
      mockLatestOnKeepSound?.(keptClip({ localUri: 'file:///documents/audio-recordings/second.m4a' }) as never);
    });
    await flush();

    expect(discardedUris().sort()).toEqual([CLIP_URI, renderedUri].sort());
  });

  // ── Fast save vs. analysis ─────────────────────────────────────────

  it('save during a pending analysis waits up to 1.5 s, then saves with waveform: null', async () => {
    const never = new Promise<Energies | null>(() => undefined);
    const screen = renderScreen();
    await keepSound(screen, { pendingAnalysis: never });

    // No energies yet: no trim button.
    expect(screen.queryByTestId('new-memory-audio-clip-trim')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1499);
    });
    expect(enqueue).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][0] as { clip: { waveform: unknown } }).clip.waveform).toBeNull();
  });

  it('save during a pending analysis that finishes inside the wait includes the waveform', async () => {
    const gate = deferred<Energies | null>();
    const screen = renderScreen();
    await keepSound(screen, { pendingAnalysis: gate.promise });

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(400);
      gate.resolve(energiesFixture());
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][0] as { clip: { waveform: unknown[] } }).clip.waveform).toHaveLength(64);
  });

  it('a failed analysis saves with waveform: null and offers no trim button', async () => {
    const screen = renderScreen();
    await keepSound(screen, { pendingAnalysis: Promise.resolve(null) });

    expect(screen.queryByTestId('new-memory-audio-clip-trim')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect((enqueue.mock.calls[0][0] as { clip: { waveform: unknown } }).clip.waveform).toBeNull();
  });

  // ── Import ─────────────────────────────────────────────────────────

  it('share: a voice note imports as an imported clip with an unknown-speaker transcription, dated by the file', async () => {
    mockImportAudioFile.mockResolvedValue(importedClipResult({ suggestedDateIso: '2024-05-06' }));
    const prepared = captureShare();
    const screen = renderScreen();

    prepared(sharedAudio);
    await flush();

    expect(trackEvent).toHaveBeenCalledWith('audio_import_started', { entry: 'share' });
    expect(mockImportAudioFile).toHaveBeenCalledWith({
      uri: sharedAudio.uri,
      fileName: sharedAudio.fileName,
      mimeType: sharedAudio.mimeType,
      sizeBytes: 1234,
      entry: 'share',
    });
    expect(mockTranscribeClip).toHaveBeenCalledWith(
      IMPORT_URI,
      [],
      'family-1',
      { speaker: 'unknown', durationMs: 20_000, sizeBytes: 200_000 },
    );
    expect(screen.getByText('· Sound')).toBeTruthy();
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Trimmed description');

    const dateField = screen.getByTestId('new-memory-date');
    expect(dateField.props.accessibilityLabel).toContain('2024');
    expect(dateField.props.accessibilityHint).toBe("Suggested from the voice note's date");
    expect(screen.getByText('From the voice note', { includeHiddenElements: true })).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryDate: '2024-05-06',
        clip: expect.objectContaining({ fileUri: IMPORT_URI, durationMs: 20_000 }),
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith('memory_saved', expect.objectContaining({ memory_type: 'audio', used_voice: false }));
    expect(trackEvent).toHaveBeenCalledWith('audio_memory_saved', {
      duration_bucket: '15_30s',
      has_description: true,
      source: 'imported',
      trimmed: false,
    });
    // Passthrough import: the uploaded file is also the original -- never deleted.
    expect(discardedUris()).not.toContain(IMPORT_URI);
  });

  it('shows the imported-clip generating copy while the note is being written', async () => {
    const pending = deferred<Transcription | null>();
    mockTranscribeClip.mockReturnValue(pending.promise);
    mockImportAudioFile.mockResolvedValue(importedClipResult());
    const prepared = captureShare();
    const screen = renderScreen();

    prepared(sharedAudio);
    await flush();

    expect(screen.getByText('Writing a note about this sound…')).toBeTruthy();
    await act(async () => {
      pending.resolve(transcription());
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId('new-memory-audio-note-generating')).toBeNull();
  });

  it('keeps text the user types while a share import is in flight', async () => {
    const importGate = deferred<ReturnType<typeof importedClipResult>>();
    mockImportAudioFile.mockReturnValue(importGate.promise);
    const prepared = captureShare();
    const screen = renderScreen();
    await flush();

    prepared(sharedAudio);
    expect(screen.getByTestId('new-memory-audio-import-loading')).toBeTruthy();
    // Save is held while the sound is coming in.
    expect(screen.getByTestId('new-memory-save').props.accessibilityState?.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'grandma says hi');

    await act(async () => {
      importGate.resolve(importedClipResult());
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('grandma says hi');
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
  });

  it('a stored draft never wins over a voice note that is still being imported', async () => {
    await saveNewMemoryDraft('user-1', 'family-1', {
      content: 'draft text',
      taggedMemberIds: [],
      memoryDate: '2024-01-01',
      illustrationEnabled: true,
    });
    const importGate = deferred<ReturnType<typeof importedClipResult>>();
    mockImportAudioFile.mockReturnValue(importGate.promise);
    const prepared = captureShare();
    const screen = renderScreen();
    // Share hook says "preparing" until the callback fires.
    prepared(sharedAudio);
    await flush();

    await act(async () => {
      importGate.resolve(importedClipResult());
      await jest.advanceTimersByTimeAsync(0);
    });
    await flush();

    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
    expect(screen.getByTestId('new-memory-content').props.value).not.toBe('draft text');
  });

  it('import error: shows the friendly copy and tracks audio_import_failed', async () => {
    mockImportAudioFile.mockResolvedValue({
      kind: 'error',
      code: 'unsupported_format',
      message: "Momora can't open this kind of sound file yet.",
    });
    const prepared = captureShare();
    const screen = renderScreen();

    prepared(sharedAudio);
    await flush();

    expect(screen.getByText("Momora can't open this kind of sound file yet.")).toBeTruthy();
    expect(trackEvent).toHaveBeenCalledWith('audio_import_failed', { entry: 'share', code: 'unsupported_format' });
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();
  });

  it('needsTrim: opens the sheet in must-trim mode, Done renders and applies it as an imported clip', async () => {
    const long = energiesFixture(400_000);
    const original = {
      localUri: IMPORT_URI,
      durationMs: 400_000,
      sizeBytes: 4_000_000,
      energies: long,
      uploadable: false,
      transcription: null,
    };
    mockImportAudioFile.mockResolvedValue({
      kind: 'needsTrim',
      original,
      suggested: null,
      suggestedDateIso: '2024-05-06',
    });
    const renderedUri = mockRenderPipeline('file:///documents/audio-recordings/trim-2.m4a', 290_000);
    const prepared = captureShare();
    const screen = renderScreen();

    prepared(sharedAudio);
    await flush();

    expect(mockTrimSheetProps).toEqual(
      expect.objectContaining({
        visible: true,
        mustTrim: true,
        maxSelectionMs: 300_000,
        sourceUri: IMPORT_URI,
        initialRange: { startMs: 0, endMs: 300_000 },
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith('audio_trim_opened', { source: 'imported', suggested: false });
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();

    act(() => {
      mockTrimSheetProps?.onDone({ startMs: 10_000, endMs: 300_000 });
    });
    await flush();

    expect(mockAudioRender).toHaveBeenCalledWith(IMPORT_URI, expect.objectContaining({ startMs: 10_000, endMs: 300_000 }));
    expect(mockTranscribeClip).toHaveBeenCalledWith(
      renderedUri,
      [],
      'family-1',
      expect.objectContaining({ speaker: 'unknown' }),
    );
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
    expect(discardedUris()).not.toContain(IMPORT_URI);

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryDate: '2024-05-06',
        clip: expect.objectContaining({ fileUri: renderedUri }),
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith('audio_memory_saved', {
      duration_bucket: '120_300s',
      has_description: true,
      source: 'imported',
      trimmed: true,
    });
    // The (non-uploadable) long source goes at save; the render is what's kept.
    expect(discardedUris()).toContain(IMPORT_URI);
    expect(discardedUris()).not.toContain(renderedUri);
  });

  it('needsTrim: Cancel discards the claimed source and leaves the composer empty', async () => {
    mockImportAudioFile.mockResolvedValue({
      kind: 'needsTrim',
      original: {
        localUri: IMPORT_URI,
        durationMs: 400_000,
        sizeBytes: 4_000_000,
        energies: energiesFixture(400_000),
        uploadable: false,
        transcription: null,
      },
      suggested: { startMs: 5000, endMs: 395_000 },
      suggestedDateIso: '2024-05-06',
    });
    const prepared = captureShare();
    const screen = renderScreen();

    prepared(sharedAudio);
    await flush();
    expect(mockTrimSheetProps?.suggested).toBe(true);
    expect(mockTrimSheetProps?.initialRange).toEqual({ startMs: 5000, endMs: 300_000 + 5000 });

    act(() => {
      mockTrimSheetProps?.onCancel();
    });
    await flush();

    expect(discardedUris()).toContain(IMPORT_URI);
    expect(mockAudioRender).not.toHaveBeenCalled();
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();
    // No date was suggested from an aborted import.
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();
  });

  it('a second voice note replaces the first and discards its files (typed note kept)', async () => {
    mockImportAudioFile.mockResolvedValueOnce(importedClipResult());
    const prepared = captureShare();
    const screen = renderScreen();
    prepared(sharedAudio);
    await flush();
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'my note');

    const second = 'file:///documents/audio-recordings/imp-2.m4a';
    mockImportAudioFile.mockResolvedValueOnce(
      importedClipResult({
        clip: { ...importedClipResult().clip, localUri: second },
        original: { ...importedClipResult().original, localUri: second },
      }),
    );
    prepared(sharedAudio);
    await flush();

    expect(discardedUris()).toContain(IMPORT_URI);
    expect(discardedUris()).not.toContain(second);
    expect(screen.getByTestId('new-memory-content').props.value).toBe('my note');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ clip: expect.objectContaining({ fileUri: second }) }),
    );
  });

  it('drops the late result of a superseded import and discards its files', async () => {
    const firstGate = deferred<ReturnType<typeof importedClipResult>>();
    const lateUri = 'file:///documents/audio-recordings/late.m4a';
    mockImportAudioFile.mockReturnValueOnce(firstGate.promise);
    const prepared = captureShare();
    const screen = renderScreen();
    prepared(sharedAudio);
    await flush();

    mockImportAudioFile.mockResolvedValueOnce(importedClipResult());
    prepared(sharedAudio);
    await flush();
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();

    await act(async () => {
      firstGate.resolve(
        importedClipResult({
          clip: { ...importedClipResult().clip, localUri: lateUri },
          original: { ...importedClipResult().original, localUri: lateUri },
        }),
      );
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(discardedUris()).toContain(lateUri);
    expect(mockTranscribeClip).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ clip: expect.objectContaining({ fileUri: IMPORT_URI }) }),
    );
  });

  it('Cancel while an import is in flight discards the import\'s output when it lands', async () => {
    const gate = deferred<ReturnType<typeof importedClipResult>>();
    mockImportAudioFile.mockReturnValue(gate.promise);
    const prepared = captureShare();
    const screen = renderScreen();
    prepared(sharedAudio);
    await flush();

    fireEvent.press(screen.getByTestId('new-memory-cancel'));
    await act(async () => {
      gate.resolve(importedClipResult());
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(discardedUris()).toContain(IMPORT_URI);
    expect(mockTranscribeClip).not.toHaveBeenCalled();
  });

  // ── Mutual exclusion ───────────────────────────────────────────────

  it('refuses a shared voice note while photos are attached, leaving the photos alone', async () => {
    const prepared = captureShare();
    const screen = renderScreen();
    await attachPhoto(screen, buildImageAsset());
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();

    prepared(sharedAudio);
    await flush();

    expect(screen.getByText(PHOTO_ERROR)).toBeTruthy();
    expect(mockImportAudioFile).not.toHaveBeenCalled();
    expect(screen.getByText('· Photo')).toBeTruthy();
    expect(discardedUris()).toContain(sharedAudio.uri);
  });

  it('refuses a voice note whose import finishes after photos were attached, and discards its files', async () => {
    const gate = deferred<ReturnType<typeof importedClipResult>>();
    mockImportAudioFile.mockReturnValue(gate.promise);
    const prepared = captureShare();
    const screen = renderScreen();
    await flush();
    prepared(sharedAudio);
    await flush();

    // Photos shared in while the sound is still being read.
    prepared({
      kind: 'media',
      attachments: [{ id: 'p1', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 }],
      errorMessage: null,
    });
    await act(async () => {
      gate.resolve(importedClipResult());
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(PHOTO_ERROR)).toBeTruthy();
    expect(discardedUris()).toContain(IMPORT_URI);
    expect(screen.queryByTestId('new-memory-audio-clip')).toBeNull();
    expect(mockTranscribeClip).not.toHaveBeenCalled();
  });

  it('refuses shared photos while the composer holds a sound', async () => {
    const prepared = captureShare();
    const screen = renderScreen();
    await keepSound(screen);

    prepared({
      kind: 'media',
      attachments: [{ id: 'p1', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 }],
      errorMessage: null,
    });

    expect(screen.getByText(SOUND_ERROR)).toBeTruthy();
    expect(screen.getByText('· Sound')).toBeTruthy();
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
  });

  // ── In-app picker ─────────────────────────────────────────────────

  it('offers the sound option only with the native modules present and nothing attached', async () => {
    const screen = renderScreen();
    await flush();
    expect(mockPickerOnPickSound).toBeDefined();

    await attachPhoto(screen, buildImageAsset());
    expect(mockPickerOnPickSound).toBeUndefined();
  });

  it('Choose from Files: closes the sheet, waits for it to dismiss, then picks and imports (entry picker)', async () => {
    mockPickAudioDocument.mockResolvedValue({
      uri: 'file:///cache/picked.m4a',
      name: 'note.m4a',
      mimeType: 'audio/mp4',
      size: 5000,
    });
    mockImportAudioFile.mockResolvedValue(importedClipResult());
    const screen = renderScreen();
    await flush();

    act(() => {
      mockPickerOnPickSound?.();
    });
    expect(mockBringInProps?.visible).toBe(true);

    act(() => {
      mockBringInProps?.onChooseFile();
    });
    expect(mockBringInProps?.visible).toBe(false);
    // Not yet: iOS can't present the picker while the sheet is dismissing.
    expect(mockPickAudioDocument).not.toHaveBeenCalled();

    act(() => {
      mockBringInProps?.onDismissed?.();
    });
    await flush();

    expect(mockPickAudioDocument).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('audio_import_started', { entry: 'picker' });
    expect(mockImportAudioFile).toHaveBeenCalledWith({
      uri: 'file:///cache/picked.m4a',
      fileName: 'note.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 5000,
      entry: 'picker',
    });
    expect(screen.getByTestId('new-memory-audio-clip')).toBeTruthy();
  });

  it('closing the sheet without choosing never opens the picker', async () => {
    renderScreen();
    await flush();

    act(() => {
      mockPickerOnPickSound?.();
    });
    act(() => {
      mockBringInProps?.onClose();
    });
    act(() => {
      mockBringInProps?.onDismissed?.();
    });
    await flush();

    expect(mockPickAudioDocument).not.toHaveBeenCalled();
  });

  it('a cancelled picker imports nothing', async () => {
    mockPickAudioDocument.mockResolvedValue(null);
    renderScreen();
    await flush();
    act(() => {
      mockPickerOnPickSound?.();
    });
    act(() => {
      mockBringInProps?.onChooseFile();
    });
    act(() => {
      mockBringInProps?.onDismissed?.();
    });
    await flush();

    expect(mockImportAudioFile).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith('audio_import_started', expect.anything());
  });

  it('a must-trim sheet from the picker waits for the bring-in sheet to dismiss', async () => {
    mockPickAudioDocument.mockResolvedValue({ uri: 'file:///cache/long.m4a', name: 'long.m4a', mimeType: 'audio/mp4', size: 9000 });
    mockImportAudioFile.mockResolvedValue({
      kind: 'needsTrim',
      original: {
        localUri: IMPORT_URI,
        durationMs: 400_000,
        sizeBytes: 4_000_000,
        energies: energiesFixture(400_000),
        uploadable: false,
        transcription: null,
      },
      suggested: null,
      suggestedDateIso: null,
    });
    renderScreen();
    await flush();
    act(() => {
      mockPickerOnPickSound?.();
    });
    act(() => {
      mockBringInProps?.onChooseFile();
    });
    act(() => {
      mockBringInProps?.onDismissed?.();
    });
    await flush();

    expect(mockTrimSheetProps?.visible).toBe(true);
    expect(mockTrimSheetProps?.mustTrim).toBe(true);
  });

  // ── Trim sheet lifecycle ───────────────────────────────────────────

  it('mounts the trim sheet only for a session and unmounts it once it has dismissed', async () => {
    const screen = renderScreen();
    await keepSound(screen);
    expect(mockTrimSheetMounted).toBe(false);

    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    expect(mockTrimSheetMounted).toBe(true);
    expect(mockTrimSheetProps?.visible).toBe(true);

    act(() => {
      mockTrimSheetProps?.onCancel();
    });
    // Closing animates out: still mounted until the Modal reports dismissed.
    expect(mockTrimSheetProps?.visible).toBe(false);
    expect(mockTrimSheetMounted).toBe(true);

    act(() => {
      mockTrimSheetProps?.onDismissed?.();
    });
    expect(mockTrimSheetMounted).toBe(false);
  });

  it('hasUserNote is true when the user wrote a note, false for an untouched AI caption', async () => {
    const screen = renderScreen();
    await keepSound(screen);
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    expect(mockTrimSheetProps?.hasUserNote).toBe(false);
    act(() => {
      mockTrimSheetProps?.onCancel();
    });

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'mine');
    fireEvent.press(screen.getByTestId('new-memory-audio-clip-trim'));
    expect(mockTrimSheetProps?.hasUserNote).toBe(true);
  });

  // ── Module unavailable (older binary receiving this JS by OTA) ─────

  describe('native audio module unavailable', () => {
    beforeEach(() => {
      mockAudioIsAvailable.mockReturnValue(false);
    });

    it('offers no sound option and no trim button; recordings save with waveform: null', async () => {
      const screen = renderScreen();
      await keepSound(screen, { pendingAnalysis: undefined });

      expect(mockPickerOnPickSound).toBeUndefined();
      expect(mockAudioAnalyze).not.toHaveBeenCalled();
      expect(screen.queryByTestId('new-memory-audio-clip-trim')).toBeNull();

      await act(async () => {
        fireEvent.press(screen.getByTestId('new-memory-save'));
      });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          clip: { fileUri: CLIP_URI, durationMs: 10_000, contentType: 'audio/mp4', waveform: null },
        }),
      );
    });

    it('refuses a shared voice note with the update copy', async () => {
      const prepared = captureShare();
      const screen = renderScreen();

      prepared(sharedAudio);
      await flush();

      expect(screen.getByText('Update Momora to bring in voice notes.')).toBeTruthy();
      expect(mockImportAudioFile).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith('audio_import_failed', { entry: 'share', code: 'unavailable' });
    });
  });
});
