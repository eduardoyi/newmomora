// App shortcut actions in the composer (docs/features/app-shortcuts.md):
// `action` + `actionId` route params run the camera / recorder / scanner path
// exactly once per actionId, and only once the screen is ready. Lives under
// src/screen-tests/ for the reason given in new-memory.integration.test.tsx.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ARTWORK_INTRO_SEEN_STORAGE_KEY } from '@/components/artwork-scan-button';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useUserProfile } from '@/hooks/useUserProfile';
import { trackEvent } from '@/services/analytics';
import { saveNewMemoryDraft } from '@/utils/new-memory-draft';

import NewMemoryScreen from '../../app/(app)/new-memory';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn() }, functions: { invoke: jest.fn() } },
}));

jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));

let mockVoiceModalProps: { visible?: boolean; captureMode?: string } | undefined;
jest.mock('@/components/voice-speak-it-modal', () => ({
  VoiceSpeakItModal: (props: { visible?: boolean; captureMode?: string }) => {
    mockVoiceModalProps = props;
    return null;
  },
}));

jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: () => ({
    playing: false, position: 0, duration: 0, progress: 0, loading: false, error: null,
    toggle: jest.fn(), seekTo: jest.fn(),
  }),
}));

jest.mock('@/utils/audio-clip-custody', () => ({
  discardAudioClip: jest.fn().mockResolvedValue(undefined),
  newAudioRecordingUri: jest.fn(),
}));

jest.mock('../../modules/momora-audio', () => ({
  isAvailable: () => false,
  analyze: jest.fn(),
  render: jest.fn(),
  probe: jest.fn(),
}));

jest.mock('@/services/voice-transcription', () => ({ transcribeClip: jest.fn() }));
jest.mock('@/services/audio-import', () => ({ importAudioFile: jest.fn() }));
jest.mock('@/utils/document-picker', () => ({
  pickAudioDocument: jest.fn(),
  isDocumentPickerAvailable: () => false,
}));
jest.mock('@/components/audio/trim-sheet', () => ({ TrimSheet: () => null }));
jest.mock('@/components/audio/bring-in-sound-sheet', () => ({ BringInSoundSheet: () => null }));

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  getMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

jest.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
  DateTimePickerAndroid: { open: jest.fn() },
}));

jest.mock('@/lib/navigation', () => ({ navigateBack: jest.fn() }));

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), setParams: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  useNavigation: jest.fn(),
}));

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-billing', () => ({ useBilling: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemories', () => ({ useMemoryMutations: jest.fn() }));
jest.mock('@/hooks/useUserProfile', () => ({ useUserProfile: jest.fn() }));
jest.mock('@/hooks/use-pending-memory-uploads', () => ({ usePendingMemoryUploads: jest.fn() }));
jest.mock('@/hooks/use-incoming-memory-share', () => ({ useIncomingMemoryShare: jest.fn(() => false) }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

const mockScanArtwork = jest.fn();
const mockIsArtworkScannerAvailable = jest.fn(() => true);
jest.mock('@/services/artwork-scanner', () => ({
  ArtworkScanError: class ArtworkScanError extends Error {},
  isArtworkScannerAvailable: () => mockIsArtworkScannerAvailable(),
  scanArtwork: (...args: unknown[]) => mockScanArtwork(...args),
}));
jest.mock('@/utils/artwork-scan-custody', () => ({ deleteArtworkScanFile: jest.fn() }));
jest.mock('@/utils/shared-file-cleanup', () => ({ deleteShareCopies: jest.fn(async () => {}) }));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedUseAuth = useAuth as jest.Mock;
const mockedUseBilling = useBilling as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseUserProfile = useUserProfile as jest.Mock;
const mockedUsePendingMemoryUploads = usePendingMemoryUploads as jest.Mock;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockedUseNavigation = useNavigation as jest.Mock;
let mockTransitionEndListener: ((event: { data: { closing: boolean } }) => void) | undefined;
const mockNavigation = {
  addListener: jest.fn((name: string, listener: typeof mockTransitionEndListener) => {
    if (name === 'transitionEnd') mockTransitionEndListener = listener;
    return () => {
      mockTransitionEndListener = undefined;
    };
  }),
};
const mockedSetParams = router.setParams as jest.Mock;
const mockedTrackEvent = trackEvent as jest.Mock;

function Tree() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <NewMemoryScreen />
    </SafeAreaProvider>
  );
}

async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

// Most tests want a presented (settled) modal: fire the native transitionEnd.
async function renderScreen() {
  const screen = render(<Tree />);
  await settle();
  await finishPresentation();
  return screen;
}

async function finishPresentation() {
  await act(async () => {
    mockTransitionEndListener?.({ data: { closing: false } });
    await jest.advanceTimersByTimeAsync(0);
  });
}

function setParams(params: Record<string, string>) {
  mockedUseLocalSearchParams.mockReturnValue(params);
}

function setBilling(overrides: Record<string, unknown>) {
  mockedUseBilling.mockReturnValue({ status: { has_write_access: true }, isLoading: false, ...overrides });
}

describe('NewMemoryScreen -- app shortcut actions', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(ARTWORK_INTRO_SEEN_STORAGE_KEY, '1');
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockVoiceModalProps = undefined;
    mockTransitionEndListener = undefined;
    mockedUseNavigation.mockReturnValue(mockNavigation);
    mockIsArtworkScannerAvailable.mockReturnValue(true);
    mockScanArtwork.mockReset();
    mockScanArtwork.mockResolvedValue({
      status: 'cancel',
      attachments: [],
      droppedCount: 0,
      rejectedCount: 0,
      validationError: null,
    });
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.launchCameraAsync.mockResolvedValue({
      canceled: true,
      assets: null,
    } as ImagePicker.ImagePickerResult);
    mockedUseLocalSearchParams.mockReturnValue({});

    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    setBilling({});
    mockedUseFamily.mockReturnValue({ role: 'manager', familyId: 'family-1', isLoading: false });
    mockedUseFamilyMembers.mockReturnValue({ members: [], isLoading: false });
    mockedUseMemoryMutations.mockReturnValue({ createMemory: jest.fn(), isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile: jest.fn().mockResolvedValue(undefined) });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue: jest.fn(), retry: jest.fn(), discard: jest.fn(), uploads: [] });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  it('does nothing without an action, and ignores unknown actions', async () => {
    await renderScreen();
    setParams({ action: 'dance', actionId: 'a1' });
    await renderScreen();

    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(mockScanArtwork).not.toHaveBeenCalled();
    expect(mockVoiceModalProps?.visible).toBeFalsy();
  });

  it('text: opens the plain composer with nothing extra', async () => {
    setParams({ action: 'text', actionId: 'a1', source: 'shortcut_text' });
    await renderScreen();

    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(mockScanArtwork).not.toHaveBeenCalled();
    expect(mockVoiceModalProps?.visible).toBeFalsy();
  });

  it('voice: opens the recorder in fork mode', async () => {
    setParams({ action: 'voice', actionId: 'a1', source: 'shortcut_voice' });
    await renderScreen();

    expect(mockVoiceModalProps?.visible).toBe(true);
    expect(mockVoiceModalProps?.captureMode).toBe('fork');
  });

  it('photo: launches the camera once', async () => {
    setParams({ action: 'photo', actionId: 'a1', source: 'shortcut_photo' });
    await renderScreen();

    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
  });

  it('scan: starts the scanner once', async () => {
    setParams({ action: 'scan', actionId: 'a1', source: 'shortcut_scan' });
    await renderScreen();

    expect(mockScanArtwork).toHaveBeenCalledTimes(1);
  });

  it('scan: an unavailable scanner is a quiet no-op', async () => {
    mockIsArtworkScannerAvailable.mockReturnValue(false);
    setParams({ action: 'scan', actionId: 'a1' });
    await renderScreen();

    expect(mockScanArtwork).not.toHaveBeenCalled();
  });

  it('clears the action params after consuming them', async () => {
    setParams({ action: 'text', actionId: 'a1' });
    await renderScreen();

    expect(mockedSetParams).toHaveBeenCalledWith({ action: undefined, actionId: undefined });
  });

  it.each([
    ['billing still loading', () => setBilling({ isLoading: true })],
    ['billing status missing', () => setBilling({ status: null })],
    ['no write access', () => setBilling({ status: { has_write_access: false } })],
    ['members still loading', () => mockedUseFamilyMembers.mockReturnValue({ members: [], isLoading: true })],
    ['viewer role', () => mockedUseFamily.mockReturnValue({ role: 'viewer', familyId: 'family-1', isLoading: false })],
  ])('does not fire while not ready (%s)', async (_label, makeNotReady) => {
    makeNotReady();
    setParams({ action: 'photo', actionId: 'a1' });
    await renderScreen();

    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(mockedSetParams).not.toHaveBeenCalled();
  });

  it('fires once the screen becomes ready', async () => {
    setBilling({ isLoading: true });
    setParams({ action: 'photo', actionId: 'a1' });
    const screen = await renderScreen();
    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();

    setBilling({});
    screen.rerender(<Tree />);
    await settle();

    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire on rerender with the same actionId, but fires for a new one', async () => {
    setParams({ action: 'photo', actionId: 'a1' });
    const screen = await renderScreen();
    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);

    screen.rerender(<Tree />);
    await settle();
    screen.rerender(<Tree />);
    await settle();
    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);

    setParams({ action: 'photo', actionId: 'a2' });
    screen.rerender(<Tree />);
    await settle();
    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(2);
  });

  it('does not re-fire the recorder after it was closed and the screen rerenders', async () => {
    setParams({ action: 'voice', actionId: 'a1' });
    const screen = await renderScreen();
    expect(mockVoiceModalProps?.visible).toBe(true);

    await act(async () => {
      (mockVoiceModalProps as unknown as { onDismiss: () => void }).onDismiss();
    });
    expect(mockVoiceModalProps?.visible).toBe(false);

    screen.rerender(<Tree />);
    await settle();
    expect(mockVoiceModalProps?.visible).toBe(false);
  });

  it('photo: respects the picker being disabled while saving', async () => {
    mockedUseMemoryMutations.mockReturnValue({ createMemory: jest.fn(), isCreating: true });
    setParams({ action: 'photo', actionId: 'a1' });
    await renderScreen();

    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('scan: respects the scan button being disabled while saving', async () => {
    mockedUseMemoryMutations.mockReturnValue({ createMemory: jest.fn(), isCreating: true });
    setParams({ action: 'scan', actionId: 'a1' });
    await renderScreen();

    expect(mockScanArtwork).not.toHaveBeenCalled();
  });

  it('voice: does not open while saving', async () => {
    mockedUseMemoryMutations.mockReturnValue({ createMemory: jest.fn(), isCreating: true });
    setParams({ action: 'voice', actionId: 'a1' });
    await renderScreen();

    expect(mockVoiceModalProps?.visible).toBeFalsy();
  });

  describe('modal presentation gate', () => {
    it('does not fire before transitionEnd, then fires after it', async () => {
      setParams({ action: 'photo', actionId: 'a1' });
      const screen = render(<Tree />);
      await settle();
      expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();

      await finishPresentation();
      expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
      screen.unmount();
    });

    it('ignores a closing transition', async () => {
      setParams({ action: 'photo', actionId: 'a1' });
      render(<Tree />);
      await settle();
      await act(async () => {
        mockTransitionEndListener?.({ data: { closing: true } });
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    });

    it('fires after the fallback timer when no event arrives', async () => {
      setParams({ action: 'voice', actionId: 'a1' });
      render(<Tree />);
      await settle();
      expect(mockVoiceModalProps?.visible).toBeFalsy();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(700);
      });
      expect(mockVoiceModalProps?.visible).toBe(true);
    });

    it('fires immediately for params set on an already-settled composer', async () => {
      const screen = await renderScreen();
      expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();

      setParams({ action: 'photo', actionId: 'a9' });
      screen.rerender(<Tree />);
      await settle();
      expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the typed draft when params change on an open composer', async () => {
    const screen = await renderScreen();
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Her first steps');

    setParams({ action: 'photo', actionId: 'a1', source: 'shortcut_photo' });
    screen.rerender(<Tree />);
    await settle();

    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('new-memory-content').props.value).toBe('Her first steps');
  });

  it('waits for the draft restore, then restores the stored draft before acting', async () => {
    await saveNewMemoryDraft('user-1', 'family-1', {
      content: 'Saved draft',
      taggedMemberIds: [],
      memoryDate: '2026-10-01',
      illustrationEnabled: true,
    });
    setParams({ action: 'voice', actionId: 'a1' });
    const screen = await renderScreen();

    expect(screen.getByTestId('new-memory-content').props.value).toBe('Saved draft');
    expect(mockVoiceModalProps?.visible).toBe(true);
  });

  it('reports the shortcut source on memory_saved', async () => {
    const createMemory = jest.fn().mockResolvedValue({ id: 'm1' });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    setParams({ action: 'text', actionId: 'a1', source: 'shortcut_text' });
    const screen = await renderScreen();

    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'Hello');
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });
    await settle();

    expect(mockedTrackEvent).toHaveBeenCalledWith(
      'memory_saved',
      expect.objectContaining({ source: 'shortcut_text' }),
    );
  });
});
