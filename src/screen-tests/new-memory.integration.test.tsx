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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { JOURNALING_PROMPTS } from '@/constants/journaling-prompts';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useIncomingMemoryShare } from '@/hooks/use-incoming-memory-share';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useUserProfile } from '@/hooks/useUserProfile';
import { navigateBack } from '@/lib/navigation';
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
// stubbed out here. Voice input has its own test coverage elsewhere.
jest.mock('@/components/voice-speak-it-modal', () => ({
  VoiceSpeakItModal: () => null,
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

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
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

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedDateTimePickerAndroid = DateTimePickerAndroid as jest.Mocked<
  typeof DateTimePickerAndroid
>;
const mockedUseAuth = useAuth as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseUserProfile = useUserProfile as jest.Mock;
const mockedUsePendingMemoryUploads = usePendingMemoryUploads as jest.Mock;
const mockedUseIncomingMemoryShare = useIncomingMemoryShare as jest.Mock;

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
    expect(dateField.props.accessibilityHint).toBe('Suggested from photo date');
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

  it('an incoming-share replacement without metadata follows the documented default/override behavior', async () => {
    let onPrepared:
      | ((attachments: { id: string; capturedAtIso?: string }[], message: string | null) => void)
      | undefined;
    mockedUseIncomingMemoryShare.mockImplementation((options) => {
      onPrepared = options.onPrepared;
      return false;
    });

    const screen = renderScreen();

    // Before any override, a dated photo suggests its date.
    await attachPhoto(
      screen,
      buildImageAsset({ exif: { DateTimeOriginal: '2024:03:05 10:00:00' } }),
    );
    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeTruthy();

    // An incoming share wholesale-replaces attachedMedia with an asset that
    // lacks capturedAtIso (incoming-share extraction is out of scope) --
    // the suggestion is gone, so the date restores to the session default.
    act(() => {
      onPrepared?.(
        [{ id: 'shared-1', uri: 'file:///shared.jpg', contentType: 'image/jpeg', sizeBytes: 10 } as never],
        null,
      );
    });

    expect(screen.queryByTestId('new-memory-date-source', { includeHiddenElements: true })).toBeNull();

    // Once the user has overridden the date, an incoming-share replacement
    // must not touch it.
    changeDateThroughPicker(screen, new Date(2022, 5, 15));
    const userChosenLabel = screen.getByTestId('new-memory-date').props.accessibilityLabel;

    act(() => {
      onPrepared?.(
        [{ id: 'shared-2', uri: 'file:///shared2.jpg', contentType: 'image/jpeg', sizeBytes: 10 } as never],
        null,
      );
    });

    expect(screen.getByTestId('new-memory-date').props.accessibilityLabel).toBe(userChosenLabel);
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
