// Deliberately lives under src/screen-tests/ (the repo's home for
// screen-level tests), not app/ -- see the header comment in
// new-memory.integration.test.tsx for why a route-shadowing test file under
// app/(app)/ would crash release bundles.
//
// Covers Workstream 1 of
// docs/plans/onboarding-illustration-reliability.md: auto-tagging the sole
// family member on the new-memory composer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useIncomingMemoryShare } from '@/hooks/use-incoming-memory-share';
import { useMemoryMutations } from '@/hooks/useMemories';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { useUserProfile } from '@/hooks/useUserProfile';
import { getNewMemoryDraftStorageKey, saveNewMemoryDraft } from '@/utils/new-memory-draft';
import type { FamilyMember } from '@/services/family-members';

// Imported with a relative path -- jest's moduleNameMapper only maps `@/` to
// `src/`, it does not resolve the Expo Router `app/` tree.
import NewMemoryScreen from '../../app/(app)/new-memory';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// MemoryTagPicker (rendered for real) transitively imports @/lib/supabase ->
// @react-native-async-storage/async-storage via FamilyMemberAvatar/useMediaUrls
// even with an empty member list -- mocked here like the sibling integration
// suite to keep that native module out of this suite.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

// VoiceSpeakItModal transitively imports expo-audio at module scope via
// useVoiceInput, unrelated to auto-tagging. This mock renders nothing but
// hands the latest `onResult` callback out via a module-scope variable so
// tests can drive it directly, the same way the sibling integration suite
// captures `onPrepared` from the mocked incoming-share hook.
let mockLatestVoiceOnResult:
  | ((result: { cleanedText: string; mentionedMemberIds: string[] }) => void)
  | undefined;
jest.mock('@/components/voice-speak-it-modal', () => ({
  VoiceSpeakItModal: (props: {
    onResult: (result: { cleanedText: string; mentionedMemberIds: string[] }) => void;
  }) => {
    mockLatestVoiceOnResult = props.onResult;
    return null;
  },
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
// Android via an imperative `.open({ onChange })` call -- not exercised by
// these tests, but it must still resolve to something render-safe.
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

jest.mock('@/hooks/use-incoming-memory-share', () => ({
  useIncomingMemoryShare: jest.fn(() => false),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedUseAuth = useAuth as jest.Mock;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseMemoryMutations = useMemoryMutations as jest.Mock;
const mockedUseUserProfile = useUserProfile as jest.Mock;
const mockedUsePendingMemoryUploads = usePendingMemoryUploads as jest.Mock;
const mockedUseIncomingMemoryShare = useIncomingMemoryShare as jest.Mock;

function buildMember(overrides: Partial<FamilyMember> & { id: string; name: string }): FamilyMember {
  return {
    additional_info: null,
    created_at: '2026-07-14T00:00:00.000Z',
    date_of_birth: null,
    family_id: 'family-1',
    gender: null,
    illustrated_profile_key: null,
    illustrated_profile_status: 'ready',
    is_user_profile: false,
    nicknames: [],
    profile_picture_key: null,
    updated_at: '2026-07-14T00:00:00.000Z',
    user_id: 'user-1',
    ...overrides,
  } as FamilyMember;
}

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

/** Lets the mount-time draft-restore effect (and anything chained off it,
 * like the auto-tag seed) settle before assertions run. */
async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('NewMemoryScreen -- auto-tag the sole family member (WS1)', () => {
  const enqueue = jest.fn();
  const createMemory = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLatestVoiceOnResult = undefined;
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
    mockedUseFamilyMembers.mockReturnValue({ members: [], isLoading: false });
    mockedUseMemoryMutations.mockReturnValue({ createMemory, isCreating: false });
    mockedUseUserProfile.mockReturnValue({ updateProfile });
    mockedUsePendingMemoryUploads.mockReturnValue({ enqueue, retry: jest.fn(), discard: jest.fn(), uploads: [] });
    mockedUseIncomingMemoryShare.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  });

  it('auto-selects the sole family member on mount', async () => {
    const sole = buildMember({ id: 'member-1', name: 'Sole' });
    mockedUseFamilyMembers.mockReturnValue({ members: [sole], isLoading: false });

    const screen = renderScreen();
    await settle();

    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('memory-tag-count').props.children).toEqual([' ', '· ', 1, '']);
  });

  it('does not auto-select when two members exist', async () => {
    const memberA = buildMember({ id: 'member-1', name: 'Alice' });
    const memberB = buildMember({ id: 'member-2', name: 'Bruno' });
    mockedUseFamilyMembers.mockReturnValue({ members: [memberA, memberB], isLoading: false });

    const screen = renderScreen();
    await settle();

    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.selected).toBe(false);
    expect(screen.queryByTestId('memory-tag-count')).toBeNull();
  });

  it('a saved draft with different tags wins over the seed, with no double-tag', async () => {
    const sole = buildMember({ id: 'member-1', name: 'Sole' });
    mockedUseFamilyMembers.mockReturnValue({ members: [sole], isLoading: false });

    // Simulates a draft saved while the family still had a now-removed
    // member -- the restored tag is unrelated to the current sole member.
    await saveNewMemoryDraft('user-1', 'family-1', {
      content: 'stroller walk',
      taggedMemberIds: ['member-legacy'],
      memoryDate: '2026-07-01',
      illustrationEnabled: true,
    });

    const screen = renderScreen();
    await settle();

    // Exactly one tag survives -- the restored one, not a doubled-up seed.
    expect(screen.getByTestId('memory-tag-count').props.children).toEqual([' ', '· ', 1, '']);
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-memory-save'));
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ taggedMemberIds: ['member-legacy'] }),
    );
  });

  it('untagging the seeded member does not re-seed it', async () => {
    const sole = buildMember({ id: 'member-1', name: 'Sole' });
    mockedUseFamilyMembers.mockReturnValue({ members: [sole], isLoading: false });

    const screen = renderScreen();
    await settle();
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);

    fireEvent.press(screen.getByTestId('memory-tag-member-1'));
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(false);

    // Trigger further re-renders (as typing would) -- the seed effect must
    // stay a no-op (hasSeededRef), not reassert the tag it lost.
    fireEvent.changeText(screen.getByTestId('new-memory-content'), 'a');
    fireEvent.changeText(screen.getByTestId('new-memory-content'), '');
    await settle();

    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(false);
  });

  it('a voice result with no mentioned members keeps the sole member tagged', async () => {
    const sole = buildMember({ id: 'member-1', name: 'Sole' });
    mockedUseFamilyMembers.mockReturnValue({ members: [sole], isLoading: false });

    const screen = renderScreen();
    await settle();
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);

    act(() => {
      mockLatestVoiceOnResult?.({
        cleanedText: 'she took her first steps today',
        mentionedMemberIds: [],
      });
    });

    expect(screen.getByTestId('new-memory-content').props.value).toBe('she took her first steps today');
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('memory-tag-count').props.children).toEqual([' ', '· ', 1, '']);
  });

  it('a voice result with no mentioned members still clears tags when there are two members (overwrite semantics)', async () => {
    const memberA = buildMember({ id: 'member-1', name: 'Alice' });
    const memberB = buildMember({ id: 'member-2', name: 'Bruno' });
    mockedUseFamilyMembers.mockReturnValue({ members: [memberA, memberB], isLoading: false });

    const screen = renderScreen();
    await settle();

    fireEvent.press(screen.getByTestId('memory-tag-member-1'));
    fireEvent.press(screen.getByTestId('memory-tag-member-2'));
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.selected).toBe(true);

    act(() => {
      mockLatestVoiceOnResult?.({
        cleanedText: 'someone said hi',
        mentionedMemberIds: [],
      });
    });

    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.selected).toBe(false);
    expect(screen.queryByTestId('memory-tag-count')).toBeNull();
  });

  it('seeding alone writes no draft', async () => {
    const sole = buildMember({ id: 'member-1', name: 'Sole' });
    mockedUseFamilyMembers.mockReturnValue({ members: [sole], isLoading: false });

    const screen = renderScreen();
    await settle();
    expect(screen.getByTestId('memory-tag-member-1').props.accessibilityState.selected).toBe(true);

    // Let the debounced draft-save effect actually fire (its dependency
    // array includes selectedMemberIds, so the seed alone schedules a
    // write) -- the untouched-seed check must still suppress it.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    expect(await AsyncStorage.getItem(getNewMemoryDraftStorageKey('user-1', 'family-1'))).toBeNull();

    screen.unmount();
  });
});
