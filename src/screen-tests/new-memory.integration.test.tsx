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
jest.mock('@/utils/audio-clip-custody', () => ({
  discardAudioClip: (...args: unknown[]) => mockDiscardAudioClip(...args),
}));

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
      | ((attachments: { id: string; capturedAtIso?: string }[], message: string | null) => void)
      | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared;
      return false;
    });

    const screen = renderScreen();

    // Shared media uses the same presentation-only scalar as a library pick.
    act(() => {
      onPrepared?.(
        [{
          id: 'shared-1',
          uri: 'file:///shared.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
          capturedAtIso: '2024-03-05',
        } as never],
        null,
      );
    });

    expect(screen.getByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toContain('2024');

    // Once the user has overridden the date, a later incoming-share
    // replacement must not touch it, even when it has a different date.
    changeDateThroughPicker(screen, new Date(2022, 5, 15));
    const userChosenLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;

    act(() => {
      onPrepared?.(
        [{
          id: 'shared-2',
          uri: 'file:///shared2.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
          capturedAtIso: '2021-01-01',
        } as never],
        null,
      );
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
      | ((attachments: { id: string; capturedAtIso?: string }[], message: string | null) => void)
      | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared;
      return false;
    });

    const screen = renderScreen();
    const baselineLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;

    act(() => {
      onPrepared?.(
        [{ id: 'shared-undated', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 } as never],
        null,
      );
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
      | ((attachments: { id: string; uri: string; contentType: string; sizeBytes: number }[], message: string | null) => void)
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
      capturedOnPrepared?.(
        [{ id: 'shared-1', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 }],
        null,
      );
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
      | ((attachments: never[], message: string | null) => void)
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
      capturedOnPrepared?.([], 'Could not open the shared photos or videos. Try sharing them again.');
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
    // The first clip's description is preserved (non-empty field never gets
    // silently swapped out from under the user by a replace).
    expect(screen.getByTestId('new-memory-content').props.value).toBe('A quick hello');
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
