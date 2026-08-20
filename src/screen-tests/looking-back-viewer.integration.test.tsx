import { act, fireEvent, renderAsync } from '@testing-library/react-native';
import { AccessibilityInfo, AppState, View } from 'react-native';
import { withTiming } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// This suite mounts the route itself.  The chapter/reducer has its own unit
// coverage; these tests deliberately keep the route's collaborators as
// controllable boundaries so navigation, safety reconciliation and lifecycle
// effects cannot be accidentally covered only by a reducer test.
const mockNavigation = { addListener: jest.fn(() => jest.fn()) };
let mockBeforeRemove: ((event: { preventDefault: () => void }) => void) | undefined;
let mockAppStateListener: ((nextState: string) => void) | undefined;
let mockLastStageSize: { width: number; height: number } | undefined;
let mockIsTargetReported: jest.Mock;
let mockIsUserBlocked: jest.Mock;

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    router: {
      back: jest.fn(), canGoBack: jest.fn(() => true), push: jest.fn(), replace: jest.fn(),
    },
    // Match Expo Router's focus lifecycle closely enough for changes in the
    // route callback (for example a deep-link query resolving) to run its
    // cleanup/re-entry. The production selectors are stable, so this is not
    // permitted to mask a render loop with an empty dependency array.
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
    useLocalSearchParams: () => ({ id: 'package-1' }),
    useNavigation: () => mockNavigation,
  };
});
jest.mock('expo-haptics', () => ({ selectionAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null, ArrowRight: () => null, ChevronLeft: () => null,
  ChevronRight: () => null, Layers3: () => null, Volume2: () => null,
  VolumeX: () => null, X: () => null,
}));
const mockUseFamily = jest.fn();
const mockUseContentSafety = jest.fn();
const mockUseLookingBackPackages = jest.fn();
const mockUseLookingBackSession = jest.fn();
const mockUseLookingBackPlayback = jest.fn();
const mockUseLookingBackMediaWarmup = jest.fn();
const mockUseLookingBackVideoPreload = jest.fn();
jest.mock('@/hooks/use-family', () => ({ useFamily: () => mockUseFamily() }));
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: () => mockUseContentSafety() }));
jest.mock('@/hooks/useLookingBackPackages', () => ({ useLookingBackPackages: () => mockUseLookingBackPackages() }));
jest.mock('@/hooks/useLookingBackSession', () => ({ useLookingBackSession: () => mockUseLookingBackSession() }));
jest.mock('@/hooks/useLookingBackPlayback', () => ({ useLookingBackPlayback: (options: unknown) => mockUseLookingBackPlayback(options) }));
jest.mock('@/hooks/useLookingBackMediaWarmup', () => ({ useLookingBackMediaWarmup: (...args: unknown[]) => mockUseLookingBackMediaWarmup(...args) }));
jest.mock('@/hooks/useLookingBackVideoPreload', () => ({ useLookingBackVideoPreload: (...args: unknown[]) => mockUseLookingBackVideoPreload(...args) }));
jest.mock('@/components/offline-banner', () => ({ OFFLINE_BANNER_CONTENT_CLEARANCE: 54, useOfflineBannerVisible: () => false }));
jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));
jest.mock('@/components/looking-back/story-progress', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View: NativeView } = require('react-native');
  return { StoryProgress: () => React.createElement(NativeView, { testID: 'looking-back-progress' }) };
});
jest.mock('@/components/looking-back/story-frame', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable: NativePressable, Text: NativeText, View: NativeView } = require('react-native');
  return {
    StoryFrame: ({ onBuffering, onDuration, onReady, onUnavailable, muted, stageSize }: {
      onBuffering: (value: boolean) => void; onDuration: (value: number) => void;
      onReady: () => void; onUnavailable: () => void; muted: boolean; stageSize?: { width: number; height: number };
      onVideoAttach?: unknown; onVideoDetach?: unknown; videoPlayer?: unknown;
    }) => {
      mockLastStageSize = stageSize;
      return React.createElement(NativeView, { testID: 'looking-back-story-frame' },
      React.createElement(NativeText, { testID: 'looking-back-muted' }, String(muted)),
      React.createElement(NativePressable, { testID: 'looking-back-frame-ready', onPress: onReady }),
      React.createElement(NativePressable, { testID: 'looking-back-frame-unavailable', onPress: onUnavailable }),
      React.createElement(NativePressable, { testID: 'looking-back-frame-buffer', onPress: () => onBuffering(true) }),
      React.createElement(NativePressable, { testID: 'looking-back-frame-duration', onPress: () => onDuration(11_000) }),
      );
    },
    StoryUnavailable: () => React.createElement(NativeView, { testID: 'looking-back-media-unavailable' }),
  };
});
jest.mock('@/components/looking-back/cover-artwork', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View: NativeView } = require('react-native');
  return { LookingBackCoverArtwork: ({ testID }: { testID?: string }) => React.createElement(NativeView, testID ? { testID } : undefined) };
});
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

// Import after the route's boundaries are mocked.
// eslint-disable-next-line import/first
import LookingBackViewerScreen from '../../app/(app)/looking-back/[id]';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockRouter = require('expo-router').router as {
  back: jest.Mock; canGoBack: jest.Mock; push: jest.Mock; replace: jest.Mock;
};

const frame = {
  id: 'memory-1:text', index: 0, chapterIndex: 0, assetIndex: 0, assetCount: 1,
  kind: 'text-short', durationMs: 5600,
  memory: {
    id: 'memory-1', family_id: 'family-1', memory_type: 'text_only', memory_date: '2024-08-08',
    content: 'A caption that can expand while paused.', emotion: 'joy', taggedMembers: [],
  },
};
const videoFrame = { ...frame, id: 'memory-1:video', kind: 'video', durationMs: 6000 };
const item = {
  id: 'package-1', familyId: 'family-1', dailySetId: 'daily-1', packageType: 'archive_mix',
  displayKind: 'From your archive', title: 'A little look back', era: '2024', tint: 'joy',
  memories: [
    { ...frame.memory, id: 'memory-1' }, { ...frame.memory, id: 'memory-2' },
    { ...frame.memory, id: 'memory-3' }, { ...frame.memory, id: 'memory-4' },
  ],
  view: { firstViewedAt: null },
};

interface PlaybackState {
  phase: 'intro' | 'playing' | 'complete';
  frameIndex: number;
  frameFraction: number;
  pauseReasons: string[];
  isMuted: boolean;
}

let playbackState: PlaybackState;
let playbackFrame = frame;
let latestPlaybackOptions: any;
let latestWarmupOptions: any;
let latestVideoPreloadOptions: any;
let dispatch: jest.Mock;
let pause: jest.Mock;
let resume: jest.Mock;
let next: jest.Mock;
let previous: jest.Mock;
let replay: jest.Mock;
let toggleMuted: jest.Mock;
let checkpointFor: jest.Mock;
let packagesValue: any;
let sessionValue: any;

function configurePlayback(overrides: Partial<PlaybackState> = {}) {
  playbackState = { phase: 'intro', frameIndex: 0, frameFraction: 0, pauseReasons: [], isMuted: true, ...overrides };
  playbackFrame = frame;
  dispatch = jest.fn(); pause = jest.fn(); resume = jest.fn(); next = jest.fn(); previous = jest.fn();
  replay = jest.fn(); toggleMuted = jest.fn();
  checkpointFor = jest.fn(() => ({ familyId: 'family-1', dailySetId: 'daily-1', packageId: 'package-1', frameIndex: 0, frameFraction: 0.4, phase: 'playing', isMuted: true, pauseReasons: [] }));
  mockUseLookingBackPlayback.mockImplementation((options: unknown) => {
    latestPlaybackOptions = options;
    return { state: playbackState, currentFrame: playbackFrame, dispatch, pause, resume, next, previous, replay, toggleMuted, checkpointFor, progress: { value: 0 } };
  });
}

function viewerTree() {
  return <SafeAreaProvider initialMetrics={{
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  }}><LookingBackViewerScreen /></SafeAreaProvider>;
}

async function renderViewer() {
  // Route lifecycle assertions are synchronous and timer-controlled. A
  // concurrent test root leaves React Native Scheduler's Immediate pending
  // after mocked navigation; the device still uses the normal concurrent
  // runtime, while this harness deliberately uses a deterministic root.
  return renderAsync(viewerTree(), { concurrentRoot: false });
}

describe('LookingBackViewerScreen route integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBeforeRemove = undefined;
    mockAppStateListener = undefined;
    mockLastStageSize = undefined;
    latestWarmupOptions = undefined;
    latestVideoPreloadOptions = undefined;
    mockUseLookingBackMediaWarmup.mockImplementation((options: unknown) => { latestWarmupOptions = options; });
    mockUseLookingBackVideoPreload.mockImplementation((options: unknown) => {
      latestVideoPreloadOptions = options;
      return { currentPlayer: null, attachVideoPlayer: jest.fn(), detachVideoPlayer: jest.fn() };
    });
    mockNavigation.addListener.mockImplementation((event: string, listener: typeof mockBeforeRemove) => {
      if (event === 'beforeRemove') mockBeforeRemove = listener;
      return jest.fn();
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event: never, listener: never) => {
      mockAppStateListener = listener;
      return { remove: jest.fn() } as never;
    });
    (withTiming as jest.Mock).mockImplementation((value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(true);
      return value;
    });
    // Leave the native accessibility lookup pending by default so initial
    // render has no out-of-act state update. The dedicated screen-reader case
    // overrides this with a resolved value and explicitly awaits it in act().
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );
    mockUseFamily.mockReturnValue({ familyId: 'family-1' });
    mockIsTargetReported = jest.fn(() => false);
    // Deliberately return a new wrapper on every render. The route must key
    // memoized frames to the stable selector, not the hook's object identity.
    mockIsUserBlocked = jest.fn(() => false);
    mockUseContentSafety.mockImplementation(() => ({
      isTargetReported: mockIsTargetReported, isUserBlocked: mockIsUserBlocked, isLoading: false, isError: false,
    }));
    packagesValue = {
      viewerPackages: [item], packages: [item], dailySetId: 'daily-1', isSuccess: true,
      portraitVersions: [], isPortraitDataUnavailable: false,
      markPackageViewed: jest.fn(), markPackageCompleted: jest.fn(),
    };
    mockUseLookingBackPackages.mockImplementation(() => packagesValue);
    sessionValue = {
      checkpoint: null,
      packageSnapshot: { packageId: 'package-1', familyId: 'family-1', dailySetId: 'daily-1', sourceGeometry: null, value: item },
      saveCheckpoint: jest.fn(), savePackageSnapshot: jest.fn(), reconcilePackageMemories: jest.fn(), clearCheckpoint: jest.fn(),
    };
    mockUseLookingBackSession.mockImplementation(() => sessionValue);
    configurePlayback();
  });
  afterEach(() => jest.useRealTimers());
  it('opens the intro, then marks viewed only after a real frame is visible', async () => {
    const screen = await renderViewer();
    expect(screen.getByTestId('looking-back-intro')).toBeTruthy();
    expect(screen.getByTestId('looking-back-intro-print-0')).toBeTruthy();
    expect(screen.getByTestId('looking-back-intro-print-1')).toBeTruthy();
    expect(screen.getByTestId('looking-back-intro-print-2')).toBeTruthy();
    expect(screen.getByTestId('looking-back-intro-cover')).toBeTruthy();
    expect(packagesValue.markPackageViewed).not.toHaveBeenCalled();

    playbackState = { ...playbackState, phase: 'playing' };
    await screen.rerenderAsync(viewerTree());
    expect(packagesValue.markPackageViewed).toHaveBeenCalledWith('package-1');
  });

  it('hides a subject title while portrait versions are unavailable', async () => {
    const taggedMember = {
      id: 'member-1', name: 'Nora', family_id: 'family-1', user_id: 'user-1', date_of_birth: null,
      illustrated_profile_key: 'nora.webp', illustrated_profile_status: 'ready', profile_picture_key: null,
      updated_at: '2026-01-01', created_at: '2020-01-01', gender: null,
    };
    const birthdayPackage = {
      ...item,
      packageType: 'member_birthday',
      subjectFamilyMemberId: 'member-1',
      title: 'Nora’s birthday, through the years',
      memories: item.memories.map((memory) => ({ ...memory, taggedMembers: [taggedMember] })),
    };
    packagesValue = {
      ...packagesValue,
      viewerPackages: [birthdayPackage], packages: [birthdayPackage],
      portraitVersions: [], isPortraitDataUnavailable: true,
    };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: birthdayPackage },
    };
    const screen = await renderViewer();
    expect(screen.getAllByText('A birthday memory').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nora’s birthday, through the years')).toBeNull();
  });

  it('waits on the intro until the explicit Start button begins unpaused playback', async () => {
    const screen = await renderViewer();
    expect(screen.queryByText('Tap to move · hold to pause')).toBeNull();
    fireEvent.press(screen.getByTestId('looking-back-start'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'INTRO_COMPLETE' });
    expect(pause).not.toHaveBeenCalledWith('manual');
    expect(next).not.toHaveBeenCalled();
  });

  it('waits for image/video readiness before marking a non-text first frame viewed', async () => {
    configurePlayback({ phase: 'playing' });
    playbackFrame = { ...videoFrame };
    const screen = await renderViewer();
    expect(pause).toHaveBeenCalledWith('buffering');
    expect(packagesValue.markPackageViewed).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('looking-back-frame-ready'));
    expect(resume).toHaveBeenCalledWith('buffering');
    expect(packagesValue.markPackageViewed).toHaveBeenCalledWith('package-1');
  });

  it('wires the complete package, playback phase, and current frame to the viewer-scoped warm-up', async () => {
    const screen = await renderViewer();

    expect(latestWarmupOptions).toEqual({
      frames: latestPlaybackOptions.frames,
      phase: 'intro',
      frameIndex: 0,
      foregroundGeneration: 0,
    });

    playbackState = { ...playbackState, phase: 'playing', frameIndex: 1 };
    await screen.rerenderAsync(viewerTree());

    expect(latestWarmupOptions).toEqual({
      frames: latestPlaybackOptions.frames,
      phase: 'playing',
      frameIndex: 1,
      foregroundGeneration: 0,
    });
    expect(latestVideoPreloadOptions).toEqual({
      frames: latestPlaybackOptions.frames,
      phase: 'playing',
      frameIndex: 1,
      foregroundGeneration: 0,
    });
  });

  it('re-sanitizes a frozen snapshot after an illustration report, falling back to written memory', async () => {
    jest.useRealTimers();
    const illustrated = {
      ...frame.memory, id: 'memory-illustration', memory_type: 'text_illustration',
      illustration_key: 'private-illustration-key', illustration_status: 'ready',
      illustration_generation_id: 'illustration-generation-1', isIllustrationHidden: false,
    };
    const packageWithIllustration = { ...item, memories: [illustrated, ...item.memories.slice(1)] };
    sessionValue.packageSnapshot = { ...sessionValue.packageSnapshot, value: packageWithIllustration };
    packagesValue = { ...packagesValue, viewerPackages: [packageWithIllustration] };
    mockIsTargetReported.mockImplementation((target: string, memoryId: string) => target === 'memory_illustration' && memoryId === 'memory-illustration');

    await renderViewer();
    expect(latestPlaybackOptions.frames[0]).toEqual(expect.objectContaining({
      kind: 'text-short', memory: expect.objectContaining({ id: 'memory-illustration', content: frame.memory.content }),
    }));
  });

  it('removes newly reported memories from a frozen snapshot before they reach playback', async () => {
    jest.useRealTimers();
    mockIsTargetReported.mockImplementation((target: string, memoryId: string) => target === 'memory' && memoryId === 'memory-1');
    await renderViewer();

    expect(latestPlaybackOptions.frames).toHaveLength(3);
    expect(latestPlaybackOptions.frames).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ memory: expect.objectContaining({ id: 'memory-1' }) }),
    ]));
  });

  it('removes all frozen chapters and closes once when their author is blocked', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    mockIsUserBlocked.mockReturnValue(true);
    const screen = await renderViewer();
    act(() => { jest.runOnlyPendingTimers(); });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    act(() => { jest.clearAllTimers(); });
    await screen.unmountAsync();
    jest.useRealTimers();
  });

  it('holds a frozen package behind a fail-closed safety loading state', async () => {
    jest.useRealTimers();
    mockUseContentSafety.mockImplementation(() => ({
      isTargetReported: mockIsTargetReported, isUserBlocked: mockIsUserBlocked, isLoading: true, isError: false,
    }));
    const screen = await renderViewer();
    expect(screen.getByTestId('looking-back-safety-pending')).toBeTruthy();
    expect(screen.queryByText('A caption that can expand while paused.')).toBeNull();
    expect(screen.getByLabelText('Close looking back').props.style).toEqual(expect.objectContaining({ height: 44, width: 44 }));
    fireEvent.press(screen.getByTestId('looking-back-fallback-close'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockBeforeRemove?.({ preventDefault: jest.fn() });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    await screen.unmountAsync();
  });

  it('closes a safety-error fallback directly for its button and native Back', async () => {
    jest.useRealTimers();
    mockUseContentSafety.mockImplementation(() => ({
      isTargetReported: mockIsTargetReported, isUserBlocked: mockIsUserBlocked, isLoading: false, isError: true,
    }));
    const screen = await renderViewer();
    fireEvent.press(screen.getByText('Back to your timeline'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockBeforeRemove?.({ preventDefault: jest.fn() });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('keeps an accessible close available while a direct-link package is loading', async () => {
    jest.useRealTimers();
    sessionValue.packageSnapshot = null;
    packagesValue = { ...packagesValue, viewerPackages: [], packages: [], isSuccess: false };
    const screen = await renderViewer();
    const closeButton = screen.getByTestId('looking-back-fallback-close');
    expect(closeButton.props.style).toEqual(expect.objectContaining({ height: 44, width: 44 }));
    fireEvent.press(closeButton);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockBeforeRemove?.({ preventDefault: jest.fn() });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('waits for a direct-link package query, opens a resolved package, then redirects only after a successful miss', async () => {
    jest.useRealTimers();
    sessionValue.packageSnapshot = null;
    packagesValue = { ...packagesValue, viewerPackages: [], packages: [], isSuccess: false };
    const screen = await renderViewer();
    expect(screen.getByTestId('looking-back-loading')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    packagesValue = { ...packagesValue, viewerPackages: [item], packages: [item], isSuccess: true };
    await screen.rerenderAsync(viewerTree());
    expect(screen.getByTestId('looking-back-intro')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    packagesValue = { ...packagesValue, viewerPackages: [], packages: [], isSuccess: true };
    await screen.rerenderAsync(viewerTree());
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  it('does not reject a deep link while safety is still filtering a successful raw package result', async () => {
    jest.useRealTimers();
    sessionValue.packageSnapshot = null;
    packagesValue = { ...packagesValue, viewerPackages: [], packages: [], isSuccess: true };
    mockUseContentSafety.mockImplementation(() => ({
      isTargetReported: mockIsTargetReported, isUserBlocked: mockIsUserBlocked, isLoading: true, isError: false,
    }));
    const pending = await renderViewer();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await pending.unmountAsync();

    packagesValue = { ...packagesValue, viewerPackages: [item], packages: [item] };
    mockUseContentSafety.mockImplementation(() => ({
      isTargetReported: mockIsTargetReported, isUserBlocked: mockIsUserBlocked, isLoading: false, isError: false,
    }));
    const resolved = await renderViewer();
    expect(resolved.getByTestId('looking-back-intro')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('recognizes a hold as a manual pause', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    configurePlayback({ phase: 'playing' });
    playbackFrame = { ...videoFrame, memory: { ...frame.memory, memory_type: 'media' } };
    const screen = await renderViewer();
    const stage = screen.getByTestId('looking-back-stage');
    fireEvent(stage, 'layout', { nativeEvent: { layout: { width: 300, height: 400 } } });
    expect(mockLastStageSize).toEqual({ width: 264, height: 392 });
    fireEvent(stage, 'pressIn');
    act(() => { jest.advanceTimersByTime(220); });
    expect(pause).toHaveBeenCalledWith('manual');
    fireEvent(stage, 'pressOut');
    act(() => { jest.clearAllTimers(); });
    await screen.unmountAsync();
    // RNTL's automatic unmount waits for asynchronous React work with real
    // timers. Restore them before its global afterEach runs.
    jest.useRealTimers();
  });

  it('renders the full-screen pause veil, resumes manual hold, and handles tap plus accessibility navigation', async () => {
    configurePlayback({ phase: 'playing', pauseReasons: ['manual'] });
    playbackFrame = { ...videoFrame, memory: { ...frame.memory, memory_type: 'media' } };
    const screen = await renderViewer();
    const stage = screen.getByTestId('looking-back-stage');
    fireEvent(stage, 'layout', { nativeEvent: { layout: { width: 300, height: 400 } } });
    expect(mockLastStageSize).toEqual({ width: 264, height: 392 });
    expect(screen.getByTestId('looking-back-pause-veil').props.style).toEqual(expect.objectContaining({ position: 'absolute', top: 0, bottom: 0 }));
    fireEvent(stage, 'pressOut');
    expect(resume).toHaveBeenCalledWith('manual');

    fireEvent(stage, 'pressIn');
    fireEvent(stage, 'pressOut');
    fireEvent(stage, 'press', { nativeEvent: { locationX: 20 } });
    fireEvent(stage, 'pressIn');
    fireEvent(stage, 'pressOut');
    fireEvent(stage, 'press', { nativeEvent: { locationX: 280 } });
    expect(previous).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    fireEvent(screen.getByLabelText('Story navigation'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('pauses and then checkpoints before opening memory detail, and resumes detail ownership on focus', async () => {
    configurePlayback({ phase: 'playing' });
    const screen = await renderViewer();
    expect(resume).toHaveBeenCalledWith('detail');
    pause.mockClear();
    sessionValue.saveCheckpoint.mockClear();

    fireEvent.press(screen.getByTestId('looking-back-open-memory'));

    expect(pause).toHaveBeenCalledWith('detail');
    expect(sessionValue.saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(sessionValue.saveCheckpoint.mock.invocationCallOrder[0]);
    expect(mockRouter.push).toHaveBeenCalledWith(expect.stringContaining('memory-1'));
  });

  it('expands a media caption only while manually paused', async () => {
    configurePlayback({ phase: 'playing', pauseReasons: ['manual'] });
    playbackFrame = { ...videoFrame, memory: { ...frame.memory, memory_type: 'media' } };
    const screen = await renderViewer();
    expect(screen.getByText('A caption that can expand while paused.').props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('looking-back-open-memory').props.style).toEqual(expect.objectContaining({ minHeight: 44 }));
  });

  it('checkpoints when backgrounded and pauses automatic playback for a screen-reader session', async () => {
    configurePlayback({ phase: 'playing' });
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    const screen = await renderViewer();
    await act(async () => { await Promise.resolve(); });
    expect(latestPlaybackOptions.isScreenReaderEnabled).toBe(true);
    expect(screen.getByLabelText('Next memory')).toBeTruthy();
    act(() => mockAppStateListener?.('background'));
    expect(pause).toHaveBeenCalledWith('background');
    expect(sessionValue.saveCheckpoint).toHaveBeenCalled();
    expect(pause.mock.invocationCallOrder.at(-1)).toBeLessThan(sessionValue.saveCheckpoint.mock.invocationCallOrder.at(-1)!);
  });

  it('bumps the media warm-up generation when returning to the foreground', async () => {
    await renderViewer();
    act(() => mockAppStateListener?.('active'));

    expect(latestWarmupOptions.foregroundGeneration).toBe(1);
    expect(latestVideoPreloadOptions.foregroundGeneration).toBe(1);
  });

  it('uses the one reverse-close path exactly once, even during intro or native Back', async () => {
    jest.useRealTimers();
    const screen = await renderViewer();
    fireEvent.press(screen.getByTestId('looking-back-close'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(sessionValue.clearCheckpoint).toHaveBeenCalledWith('package-1');

    mockBeforeRemove?.({ preventDefault: jest.fn() });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    // Navigation is mocked, so replace the route explicitly; otherwise the
    // already-closed viewer remains mounted and its native beforeRemove
    // lifecycle cannot settle during asynchronous test cleanup.
    await screen.rerenderAsync(<View />);
  });

  it('closes after a same-daily-set package reconciliation loses access, but not from a midnight set change', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const screen = await renderViewer();
    packagesValue = { ...packagesValue, viewerPackages: [], packages: [] };
    await screen.rerenderAsync(viewerTree());
    act(() => { jest.runOnlyPendingTimers(); });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    await screen.rerenderAsync(<View />);

    jest.clearAllMocks();
    packagesValue = { ...packagesValue, viewerPackages: [], packages: [], dailySetId: 'tomorrow' };
    const midnight = await renderViewer();
    expect(mockRouter.back).not.toHaveBeenCalled();
    await midnight.rerenderAsync(<View />);
  });

  it('closes a zero-frame frozen package and returns to Timeline on family access loss', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    sessionValue.packageSnapshot = { ...sessionValue.packageSnapshot, value: { ...item, memories: [] } };
    const zero = await renderViewer();
    act(() => { jest.runOnlyPendingTimers(); });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    await zero.rerenderAsync(<View />);

    jest.clearAllMocks();
    mockUseFamily.mockReturnValue({ familyId: 'family-2' });
    const accessLost = await renderViewer();
    expect(sessionValue.clearCheckpoint).toHaveBeenCalledWith('package-1');
    expect(mockRouter.replace).toHaveBeenCalled();
    await accessLost.rerenderAsync(<View />);
  });

  it('shows video mute in the metadata chrome and applies authoritative duration corrections', async () => {
    configurePlayback({ phase: 'playing' });
    playbackFrame = { ...videoFrame };
    const screen = await renderViewer();
    expect(screen.getByTestId('looking-back-video-mute')).toBeTruthy();
    fireEvent.press(screen.getByTestId('looking-back-frame-duration'));
    expect(screen.getByText('From your archive')).toBeTruthy();
    expect(screen.getByTestId('looking-back-top-chrome')).toContainElement(screen.getByTestId('looking-back-progress'));
    expect(screen.getByTestId('looking-back-video-mute')).toBeTruthy();
  });

  it('keeps the completion screen concise', async () => {
    configurePlayback({ phase: 'complete' });
    const screen = await renderViewer();
    expect(screen.getByTestId('looking-back-complete')).toBeTruthy();
    expect(screen.queryByText('Every one of them is still in your timeline.')).toBeNull();
    expect(screen.getByText('That was 4 memories from a little look back.')).toBeTruthy();
    expect(screen.getByText('Back to your timeline')).toBeTruthy();
    expect(screen.getByText('Play it again')).toBeTruthy();
  });

  it('preserves a member name in the package-name completion copy', async () => {
    configurePlayback({ phase: 'complete' });
    const memberPackage = { ...item, packageType: 'member_at_age', title: 'Enzo at 1' };
    packagesValue = { ...packagesValue, viewerPackages: [memberPackage], packages: [memberPackage] };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: memberPackage },
    };
    const screen = await renderViewer();
    expect(screen.getByText('That was 4 memories from Enzo at 1.')).toBeTruthy();
  });

  it('preserves a birthday member name in the package-name completion copy', async () => {
    configurePlayback({ phase: 'complete' });
    const birthdayPackage = {
      ...item,
      packageType: 'member_birthday',
      title: 'Nora’s birthday, through the years',
    };
    packagesValue = { ...packagesValue, viewerPackages: [birthdayPackage], packages: [birthdayPackage] };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: birthdayPackage },
    };
    const screen = await renderViewer();
    expect(screen.getByText('That was 4 memories from Nora’s birthday, through the years.')).toBeTruthy();
  });

  it('lowercases a generic reported-subject title in completion copy', async () => {
    configurePlayback({ phase: 'complete' });
    const genericBirthdayPackage = { ...item, packageType: 'member_birthday', title: 'A birthday memory' };
    packagesValue = { ...packagesValue, viewerPackages: [genericBirthdayPackage], packages: [genericBirthdayPackage] };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: genericBirthdayPackage },
    };
    const screen = await renderViewer();
    expect(screen.getByText('That was 4 memories from a birthday memory.')).toBeTruthy();
  });

  it('keeps leading From titles grammatical in completion copy', async () => {
    configurePlayback({ phase: 'complete' });
    const firstYearPackage = { ...item, packageType: 'member_at_age', title: "From Mara's first year" };
    packagesValue = { ...packagesValue, viewerPackages: [firstYearPackage], packages: [firstYearPackage] };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: firstYearPackage },
    };
    const screen = await renderViewer();
    expect(screen.getByText("That was 4 memories from Mara's first year.")).toBeTruthy();
  });

  it('keeps month titles capitalized in completion copy', async () => {
    configurePlayback({ phase: 'complete' });
    const monthPackage = { ...item, packageType: 'month_archive', title: 'From April 2025' };
    packagesValue = { ...packagesValue, viewerPackages: [monthPackage], packages: [monthPackage] };
    sessionValue = {
      ...sessionValue,
      packageSnapshot: { ...sessionValue.packageSnapshot, value: monthPackage },
    };
    const screen = await renderViewer();
    expect(screen.getByText('That was 4 memories from April 2025.')).toBeTruthy();
  });
});
