import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { createVideoPlayer } from 'expo-video';
import { AccessibilityInfo, Alert, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import YearFilmScreen from '../../app/(app)/year-film/[id]';
import { pauseAllAudioPlayback, prepareAudioPlaybackMode } from '@/hooks/audio-playback-coordinator';
import { invalidateYearFilms } from '@/hooks/useYearFilms';
import { trackEvent } from '@/services/analytics';
import { getYearFilmPlayback } from '@/services/year-films';

// The route is mounted for real; its collaborators (data hooks, the native
// expo-video player, the file system, the OS share sheet) are the boundaries.

let mockParams: { id: string; source?: string } = { id: 'film-1' };
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    router: { back: jest.fn(), canGoBack: jest.fn(() => true), push: jest.fn(), replace: jest.fn() },
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
    useLocalSearchParams: () => mockParams,
  };
});

type Handler = (payload?: unknown) => void;
interface MockPlayer {
  handlers: Map<string, Set<Handler>>;
  addListener: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  release: jest.Mock;
  replaceAsync: jest.Mock;
  currentTime: number;
  muted: boolean;
  loop: boolean;
  timeUpdateEventInterval: number;
}
let mockPlayer: MockPlayer;

function newMockPlayer(): MockPlayer {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    addListener: jest.fn((name: string, handler: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return { remove: jest.fn(() => handlers.get(name)?.delete(handler)) };
    }),
    play: jest.fn(),
    pause: jest.fn(),
    release: jest.fn(),
    replaceAsync: jest.fn(() => Promise.resolve()),
    currentTime: 0,
    muted: false,
    loop: false,
    timeUpdateEventInterval: 0,
  };
}

function emit(name: string, payload?: unknown) {
  act(() => {
    mockPlayer.handlers.get(name)?.forEach((handler) => handler(payload));
  });
}

jest.mock('expo-video', () => ({
  createVideoPlayer: jest.fn(() => mockPlayer),
  VideoView: 'VideoView',
}));
jest.mock('lucide-react-native', () => ({
  ChevronLeft: () => null, ChevronRight: () => null, Pause: () => null, Play: () => null,
  Pencil: () => null, RotateCcw: () => null, Share2: () => null, Volume2: () => null, VolumeX: () => null, X: () => null,
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
  createDownloadResumable: jest.fn(),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/services/year-films', () => ({ getYearFilmPlayback: jest.fn() }));
let mockMemberships: { familyId: string; role: string }[] = [];
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ memberships: mockMemberships }) }));
// The edit sheet has its own suite (film-edit-sheet.integration.test.tsx): here
// it is a stand-in that shows whether it is open and can report a save.
jest.mock('@/components/year-films/edit/film-edit-sheet', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text, View } = require('react-native');
  return {
    FILM_EDIT_SAVED_MESSAGE: 'Remaking your film… this takes a few minutes',
    FilmEditSheet: ({ visible, filmId, familyId, onClose, onSaved }: {
      visible: boolean; filmId: string; familyId: string; onClose: () => void; onSaved: () => void;
    }) =>
      visible ? (
        <View testID="film-edit-sheet-stub">
          <Text testID="film-edit-sheet-stub-ids">{`${filmId}|${familyId}`}</Text>
          <Pressable onPress={onClose} testID="film-edit-stub-close" />
          <Pressable onPress={onSaved} testID="film-edit-stub-save" />
        </View>
      ) : null,
  };
});
jest.mock('@/hooks/audio-playback-coordinator', () => ({
  pauseAllAudioPlayback: jest.fn(),
  prepareAudioPlaybackMode: jest.fn(() => Promise.resolve()),
}));

const mockFilm = {
  id: 'film-1',
  family_id: 'family-9',
  kind: 'family_month' as 'birthday' | 'family_month' | 'family_year',
  family_member_id: null,
  age_year: null,
  scope_start_date: '2026-09-01',
  duration_ms: 60_000,
  ready_at: '2026-10-01T00:00:00Z',
};
let mockFilmResult: { film: (typeof mockFilm & { blocked?: boolean }) | null; title: string | null };
const mockRefetchFilm = jest.fn();
jest.mock('@/hooks/useYearFilm', () => ({ useYearFilm: () => ({ ...mockFilmResult, refetch: mockRefetchFilm }) }));

const mockMarkViewed = jest.fn();
const mockMarkCompleted = jest.fn();
jest.mock('@/hooks/useYearFilms', () => ({
  useMarkYearFilmViewed: () => ({ mutate: mockMarkViewed }),
  useMarkYearFilmCompleted: () => ({ mutate: mockMarkCompleted }),
  invalidateYearFilms: jest.fn(),
}));

const mockedGetPlayback = getYearFilmPlayback as jest.MockedFunction<typeof getYearFilmPlayback>;
const mockedTrack = trackEvent as jest.MockedFunction<typeof trackEvent>;
const mockedCreatePlayer = createVideoPlayer as jest.MockedFunction<typeof createVideoPlayer>;
const mockedFs = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedSharing = Sharing as jest.Mocked<typeof Sharing>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require('expo-router') as { router: { back: jest.Mock; canGoBack: jest.Mock; replace: jest.Mock } };

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

const playback = {
  videoUrl: 'https://r2.example/video.mp4?sig=1',
  posterUrl: 'https://r2.example/poster.jpg?sig=1',
  scenesUrl: 'https://r2.example/scenes.json?sig=1',
  durationMs: 12_000,
  expiresIn: 900,
};
const scenesJson = {
  version: 1,
  durationMs: 12_000,
  scenes: [
    { id: 's0', type: 'title', role: 'open', startMs: 0, durationMs: 3000 },
    { id: 's1', type: 'montage', role: 'body', startMs: 3000, durationMs: 4000 },
    { id: 's2', type: 'montage', role: 'body', startMs: 7000, durationMs: 3000 },
    { id: 's3', type: 'close', role: 'close', startMs: 10_000, durationMs: 2000 },
  ],
};

async function renderPlayer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await renderAsync(
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <YearFilmScreen />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
  // Let playback -> scenes -> replaceAsync settle.
  await waitFor(() => expect(mockPlayer.replaceAsync).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

async function renderWithoutSettling() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderAsync(
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <YearFilmScreen />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
}

async function reachCompletion() {
  // Real playback: time progressed to the end, then the player reports it.
  emit('timeUpdate', { currentTime: 11 });
  emit('playToEnd');
  await screen.findByTestId('year-film-complete');
}

describe('Year Film player screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { id: 'film-1' };
    mockPlayer = newMockPlayer();
    mockFilmResult = { film: { ...mockFilm }, title: 'September recap' };
    mockMemberships = [{ familyId: 'family-9', role: 'owner' }];
    mockedGetPlayback.mockResolvedValue({ data: playback, error: null, unavailable: false });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(scenesJson) }),
    ) as unknown as typeof fetch;
    // The deferred player release runs a frame after unmount; run it inline so no
    // timer outlives the test environment.
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    jest.spyOn(AppState, 'addEventListener');
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
    (Sharing.shareAsync as jest.Mock).mockResolvedValue(undefined);
    mockedFs.getInfoAsync.mockResolvedValue({ exists: true } as never);
    mockedFs.deleteAsync.mockResolvedValue(undefined);
    mockedFs.makeDirectoryAsync.mockResolvedValue(undefined);
  });

  it('shows the poster while buffering, then plays and hides it on the first frame', async () => {
    await renderPlayer();

    // Audio: other playback stops and the session plays with the silent switch on.
    expect(pauseAllAudioPlayback).toHaveBeenCalled();
    expect(prepareAudioPlaybackMode).toHaveBeenCalled();
    // The player is created once and the source arrives through replaceAsync.
    expect(mockedCreatePlayer).toHaveBeenCalledTimes(1);
    expect(mockedCreatePlayer).toHaveBeenCalledWith(null);
    expect(mockPlayer.replaceAsync).toHaveBeenCalledWith({ uri: playback.videoUrl });
    expect(mockPlayer.muted).toBe(false);
    expect(mockPlayer.play).toHaveBeenCalled();

    expect(screen.getByTestId('year-film-poster')).toBeTruthy();
    expect(screen.getByTestId('year-film-loading')).toBeTruthy();

    fireEvent(screen.getByTestId('year-film-video'), 'firstFrameRender');

    expect(screen.queryByTestId('year-film-poster')).toBeNull();
    expect(screen.queryByTestId('year-film-loading')).toBeNull();
    expect(screen.getByTestId('year-film-title').props.children).toBe('September recap');
    expect(screen.getByLabelText('September recap, film')).toBeTruthy();
  });

  it('draws one progress segment per scene and advances the active one', async () => {
    await renderPlayer();

    expect(screen.getAllByTestId(/^year-film-progress-segment-/)).toHaveLength(4);
    expect(screen.getByLabelText('Scene 1 of 4')).toBeTruthy();

    emit('timeUpdate', { currentTime: 3.5 });

    expect(screen.getByLabelText('Scene 2 of 4')).toBeTruthy();
  });

  it('falls back to a single segment when scenes.json is missing', async () => {
    mockedGetPlayback.mockResolvedValue({ data: { ...playback, scenesUrl: null }, error: null, unavailable: false });

    await renderPlayer();

    expect(screen.getAllByTestId(/^year-film-progress-segment-/)).toHaveLength(1);
    expect(screen.getByLabelText('Film progress')).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to a single segment when scenes.json fails to load', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));

    await renderPlayer();

    expect(screen.getAllByTestId(/^year-film-progress-segment-/)).toHaveLength(1);
  });

  it('seeks to the next and previous scene on tap', async () => {
    await renderPlayer();
    emit('timeUpdate', { currentTime: 1 });

    fireEvent.press(screen.getByTestId('year-film-tap-next'));
    expect(mockPlayer.currentTime).toBe(3);
    expect(screen.getByLabelText('Scene 2 of 4')).toBeTruthy();

    // Just after the scene start: previous goes to the scene before.
    emit('timeUpdate', { currentTime: 3.4 });
    fireEvent.press(screen.getByTestId('year-film-tap-previous'));
    expect(mockPlayer.currentTime).toBe(0);
    expect(screen.getByLabelText('Scene 1 of 4')).toBeTruthy();

    // Deep into a scene: previous restarts it.
    emit('timeUpdate', { currentTime: 8.5 });
    fireEvent.press(screen.getByTestId('year-film-tap-previous'));
    expect(mockPlayer.currentTime).toBe(7);
  });

  it('pauses while held and resumes on release, without counting the hold as a tap', async () => {
    await renderPlayer();
    emit('timeUpdate', { currentTime: 1 });
    mockPlayer.play.mockClear();
    mockPlayer.pause.mockClear();

    const zone = screen.getByTestId('year-film-tap-next');
    fireEvent(zone, 'pressIn');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(mockPlayer.pause).toHaveBeenCalled();
    expect(screen.getByTestId('year-film-pause-veil')).toBeTruthy();

    fireEvent(zone, 'pressOut');
    fireEvent.press(zone);

    expect(mockPlayer.play).toHaveBeenCalled();
    expect(screen.queryByTestId('year-film-pause-veil')).toBeNull();
    // The recognised hold was swallowed: still in scene 1.
    expect(mockPlayer.currentTime).toBe(0);
  });

  it('completes when tapping past the last scene', async () => {
    await renderPlayer();
    emit('timeUpdate', { currentTime: 11 });

    fireEvent.press(screen.getByTestId('year-film-tap-next'));

    expect(await screen.findByTestId('year-film-complete')).toBeTruthy();
    expect(mockMarkCompleted).toHaveBeenCalledWith('film-1');
  });

  it('toggles mute on the player', async () => {
    await renderPlayer();

    fireEvent.press(screen.getByTestId('year-film-mute'));
    expect(mockPlayer.muted).toBe(true);
    expect(screen.getByLabelText('Unmute film')).toBeTruthy();

    fireEvent.press(screen.getByTestId('year-film-mute'));
    expect(mockPlayer.muted).toBe(false);
  });

  it('shows the unavailable state for a 404/409 and refreshes the film lists', async () => {
    mockedGetPlayback.mockResolvedValue({
      data: null,
      error: { message: 'gone', code: 'film_unavailable' },
      unavailable: true,
    });

    await renderPlayer_unavailable();

    expect(await screen.findByText("This film isn't available right now.")).toBeTruthy();
    expect(mockPlayer.replaceAsync).not.toHaveBeenCalled();
    expect(invalidateYearFilms).toHaveBeenCalledWith(expect.anything(), 'family-9');

    fireEvent.press(screen.getByTestId('year-film-unavailable-close'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('says the film is being remade when the unavailable film is blocked', async () => {
    mockFilmResult = { film: { ...mockFilm, blocked: true }, title: 'September recap' };
    mockedGetPlayback.mockResolvedValue({
      data: null,
      error: { message: 'blocked', code: 'film_unavailable' },
      unavailable: true,
    });

    await renderPlayer_unavailable();

    expect(await screen.findByText('This film is being remade. Check back in a few minutes.')).toBeTruthy();
    expect(screen.queryByText("This film isn't available right now.")).toBeNull();
    // The by-id row is re-read so the copy follows the server's current state.
    expect(mockRefetchFilm).toHaveBeenCalled();
  });

  it('closes to the Timeline when there is no history (cold-start push)', async () => {
    router.canGoBack.mockReturnValueOnce(false);
    await renderPlayer();

    fireEvent.press(screen.getByTestId('year-film-close'));

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalled();
  });

  it('records the view on first play only', async () => {
    await renderPlayer();

    emit('playingChange', { isPlaying: true });
    emit('playingChange', { isPlaying: false });
    emit('playingChange', { isPlaying: true });

    expect(mockMarkViewed).toHaveBeenCalledTimes(1);
    expect(mockMarkViewed).toHaveBeenCalledWith('film-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('reports opened once with the route source (default timeline), and completed with a duration', async () => {
    mockParams = { id: 'film-1', source: 'push' };
    const { unmountAsync } = await renderPlayer();

    expect(mockedTrack.mock.calls.filter(([event]) => event === 'year_film_opened')).toEqual([
      ['year_film_opened', { kind: 'family_month', source: 'push' }],
    ]);

    emit('sourceLoad', { duration: 12 });
    await reachCompletion();

    expect(mockedTrack).toHaveBeenCalledWith('year_film_completed', { kind: 'family_month', duration_s: 12 });
    expect(mockMarkCompleted).toHaveBeenCalledWith('film-1');
    await unmountAsync();

    jest.clearAllMocks();
    mockPlayer = newMockPlayer();
    mockedGetPlayback.mockResolvedValue({ data: playback, error: null, unavailable: false });
    mockParams = { id: 'film-1', source: 'bogus' };
    await renderPlayer();
    expect(mockedTrack).toHaveBeenCalledWith('year_film_opened', { kind: 'family_month', source: 'timeline' });
  });

  describe('completion is only believed after real playback', () => {
    it('ignores a spurious playToEnd before any time has progressed (empty item / source swap)', async () => {
      await renderPlayer();

      emit('playToEnd');
      emit('playToEnd');

      expect(screen.queryByTestId('year-film-complete')).toBeNull();
      expect(mockMarkCompleted).not.toHaveBeenCalled();
      expect(mockedTrack).not.toHaveBeenCalledWith('year_film_completed', expect.anything());
    });

    it('ignores a playToEnd after playback that stopped far from the end', async () => {
      await renderPlayer();
      emit('timeUpdate', { currentTime: 2 });

      emit('playToEnd');

      expect(screen.queryByTestId('year-film-complete')).toBeNull();
    });

    it('ignores a playToEnd that arrives while the source is being replaced', async () => {
      await renderPlayer();
      (mockPlayer as MockPlayer & { playing: boolean }).playing = true;
      emit('timeUpdate', { currentTime: 11.9 });
      // A recovery reload resets what counts as played for the new source.
      emit('statusChange', { status: 'error' });
      await act(async () => {});
      expect(mockPlayer.replaceAsync).toHaveBeenCalledTimes(2);

      emit('playToEnd');

      expect(screen.queryByTestId('year-film-complete')).toBeNull();
    });

    it('finishes on playToEnd once time progressed to the end', async () => {
      await renderPlayer();
      emit('timeUpdate', { currentTime: 11.2 });
      mockPlayer.currentTime = 12;

      emit('playToEnd');

      expect(await screen.findByTestId('year-film-complete')).toBeTruthy();
      expect(mockMarkCompleted).toHaveBeenCalledWith('film-1');
    });

    it('finishes when timeUpdate reaches the end and the player is no longer playing', async () => {
      await renderPlayer();
      emit('timeUpdate', { currentTime: 6 });
      expect(screen.queryByTestId('year-film-complete')).toBeNull();

      (mockPlayer as MockPlayer & { playing: boolean }).playing = false;
      emit('timeUpdate', { currentTime: 11.8 });

      expect(await screen.findByTestId('year-film-complete')).toBeTruthy();
    });

    it('does not finish from timeUpdate near the end while the player is still playing', async () => {
      await renderPlayer();
      (mockPlayer as MockPlayer & { playing: boolean }).playing = true;

      emit('timeUpdate', { currentTime: 11.8 });

      expect(screen.queryByTestId('year-film-complete')).toBeNull();
    });

    it('never finishes from timeUpdate before any real playback', async () => {
      await renderPlayer();
      (mockPlayer as MockPlayer & { playing: boolean }).playing = false;

      emit('timeUpdate', { currentTime: 0 });

      expect(screen.queryByTestId('year-film-complete')).toBeNull();
    });

    it('sets the timeUpdate interval so progress events fire', async () => {
      await renderPlayer();

      expect(mockPlayer.timeUpdateEventInterval).toBeGreaterThan(0);
    });

    it('starts playback again when the item reports readyToPlay while play is wanted', async () => {
      await renderPlayer();
      mockPlayer.play.mockClear();

      emit('statusChange', { status: 'readyToPlay' });

      expect(mockPlayer.play).toHaveBeenCalled();
    });

    it('Replay clears completion, and a spurious playToEnd afterwards does not re-complete', async () => {
      await renderPlayer();
      await reachCompletion();
      mockPlayer.play.mockClear();

      fireEvent.press(screen.getByTestId('year-film-replay'));
      expect(screen.queryByTestId('year-film-complete')).toBeNull();
      expect(mockPlayer.currentTime).toBe(0);
      expect(mockPlayer.play).toHaveBeenCalled();

      emit('playToEnd');
      expect(screen.queryByTestId('year-film-complete')).toBeNull();

      // Playing through again completes normally.
      emit('timeUpdate', { currentTime: 11.5 });
      emit('playToEnd');
      expect(await screen.findByTestId('year-film-complete')).toBeTruthy();
    });
  });

  describe('resumes after an unexpected pause (Android audio focus)', () => {
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

    it('re-asserts play when the player stops although the user wants the film playing', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 2 });
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });

      await waitFor(() => expect(mockPlayer.play).toHaveBeenCalledTimes(1));
    });

    it('does not resume if playback came back by itself first', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 2 });
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      emit('playingChange', { isPlaying: true });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });

    it('gives up after a few resumes without progress, and earns them back with progress', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 2 });
      mockPlayer.play.mockClear();

      for (let i = 0; i < 5; i += 1) {
        emit('playingChange', { isPlaying: false });
        await settle();
      }
      expect(mockPlayer.play).toHaveBeenCalledTimes(3);

      emit('timeUpdate', { currentTime: 4 });
      mockPlayer.play.mockClear();
      emit('playingChange', { isPlaying: false });
      await waitFor(() => expect(mockPlayer.play).toHaveBeenCalledTimes(1));
    });

    it('does not resume a deliberate hold', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 1 });
      const zone = screen.getByTestId('year-film-tap-next');
      fireEvent(zone, 'pressIn');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(mockPlayer.pause).toHaveBeenCalled();
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });

    it('does not resume while the share flow has the film paused', async () => {
      mockedFs.createDownloadResumable.mockImplementation((() => ({
        downloadAsync: () => new Promise(() => undefined),
        cancelAsync: jest.fn(() => Promise.resolve()),
      })) as never);
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 1 });
      fireEvent.press(screen.getByTestId('year-film-share-top'));
      await waitFor(() => expect(mockPlayer.pause).toHaveBeenCalled());
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });

    it('does not resume after completion', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      await reachCompletion();
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });

    it('does not resume when the player stopped at the very end (finishing, not interrupted)', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 11.8 });
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });

    it('does not resume while the app is backgrounded', async () => {
      await renderPlayer();
      emit('playingChange', { isPlaying: true });
      emit('timeUpdate', { currentTime: 1 });
      const listener = (AppState.addEventListener as jest.Mock | undefined);
      expect(listener).toBeDefined();
      const handler = (listener as jest.Mock).mock.calls.at(-1)?.[1] as (state: string) => void;
      act(() => handler('background'));
      mockPlayer.play.mockClear();

      emit('playingChange', { isPlaying: false });
      await settle();

      expect(mockPlayer.play).not.toHaveBeenCalled();
    });
  });

  it('replays from the completion overlay', async () => {
    await renderPlayer();
    await reachCompletion();
    mockPlayer.play.mockClear();

    fireEvent.press(screen.getByTestId('year-film-replay'));

    expect(screen.queryByTestId('year-film-complete')).toBeNull();
    expect(mockPlayer.currentTime).toBe(0);
    expect(mockPlayer.play).toHaveBeenCalled();
  });

  describe('share', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    function mockDownload(result: () => Promise<unknown>) {
      const cancelAsync = jest.fn(() => Promise.resolve());
      let onProgress: ((data: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) | undefined;
      mockedFs.createDownloadResumable.mockImplementation(((_url: string, _uri: string, _opts: unknown, cb: typeof onProgress) => {
        onProgress = cb;
        return { downloadAsync: result, cancelAsync };
      }) as never);
      return { cancelAsync, progress: (written: number, total: number) => act(() => onProgress?.({ totalBytesWritten: written, totalBytesExpectedToWrite: total })) };
    }

    it('downloads with a progress label, shares the mp4, and deletes the file', async () => {
      const download = deferred<{ uri: string; status: number }>();
      const handle = mockDownload(() => download.promise);
      await renderPlayer();
      await reachCompletion();

      fireEvent.press(screen.getByTestId('year-film-share'));
      await waitFor(() => expect(mockedFs.createDownloadResumable).toHaveBeenCalled());
      expect(mockedFs.createDownloadResumable.mock.calls[0]?.[0]).toBe(playback.videoUrl);
      expect(mockedFs.createDownloadResumable.mock.calls[0]?.[1]).toBe('file:///cache/film-share/film-1.mp4');
      handle.progress(42, 100);

      expect(screen.getByTestId('year-film-share-progress').props.children).toBe('Preparing video… 42%');
      expect(mockedTrack).toHaveBeenCalledWith('year_film_share_tapped', { kind: 'family_month', source: 'completion' });

      await act(async () => {
        download.resolve({ uri: 'file:///cache/film-share/film-1.mp4', status: 200 });
      });

      await waitFor(() =>
        expect(mockedSharing.shareAsync).toHaveBeenCalledWith('file:///cache/film-share/film-1.mp4', {
          mimeType: 'video/mp4',
          UTI: 'public.mpeg-4',
          dialogTitle: 'September recap',
        }),
      );
      await waitFor(() => expect(mockedTrack).toHaveBeenCalledWith('year_film_shared', { kind: 'family_month', source: 'completion' }));
      await waitFor(() =>
        expect(mockedFs.deleteAsync).toHaveBeenLastCalledWith('file:///cache/film-share/film-1.mp4', { idempotent: true }),
      );
      // Back to the Replay / Share buttons.
      expect(await screen.findByTestId('year-film-share')).toBeTruthy();
    });

    it('cancel stops the download, never opens the share sheet, and deletes the file', async () => {
      const download = deferred<undefined>();
      const handle = mockDownload(() => download.promise);
      await renderPlayer();
      await reachCompletion();

      fireEvent.press(screen.getByTestId('year-film-share'));
      await screen.findByTestId('year-film-share-cancel');
      handle.progress(10, 100);

      fireEvent.press(screen.getByTestId('year-film-share-cancel'));
      expect(handle.cancelAsync).toHaveBeenCalled();
      await act(async () => {
        download.resolve(undefined);
      });

      await waitFor(() => expect(screen.getByTestId('year-film-share')).toBeTruthy());
      expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
      expect(mockedTrack).not.toHaveBeenCalledWith('year_film_shared', expect.anything());
      expect(mockedFs.deleteAsync).toHaveBeenLastCalledWith('file:///cache/film-share/film-1.mp4', { idempotent: true });
    });

    describe('from the top bar during playback', () => {
      it('shows the button in the top row beside mute and close', async () => {
        await renderPlayer();
        const button = screen.getByTestId('year-film-share-top');
        expect(button.props.accessibilityLabel).toBe('Share film');
        expect(screen.getByTestId('year-film-mute')).toBeTruthy();
        expect(screen.getByTestId('year-film-close')).toBeTruthy();
      });

      it('is hidden when the film is unavailable', async () => {
        mockedGetPlayback.mockResolvedValue({
          data: null,
          error: { message: 'gone', code: 'film_unavailable' },
          unavailable: true,
        });
        await renderWithoutSettling();
        await screen.findByTestId('year-film-unavailable');
        expect(screen.queryByTestId('year-film-share-top')).toBeNull();
      });

      it('is hidden when the film could not be played', async () => {
        mockPlayer.replaceAsync.mockRejectedValue(new Error('bad source'));
        await renderWithoutSettling();
        await screen.findByTestId('year-film-error');
        expect(screen.queryByTestId('year-film-share-top')).toBeNull();
      });

      it('is hidden while the film is still loading', async () => {
        mockedGetPlayback.mockReturnValue(new Promise(() => undefined));
        await renderWithoutSettling();
        expect(screen.queryByTestId('year-film-share-top')).toBeNull();
      });

      it('pauses, shows progress during playback, shares with source "player" and stays paused', async () => {
        const download = deferred<{ uri: string; status: number }>();
        const handle = mockDownload(() => download.promise);
        await renderPlayer();
        emit('timeUpdate', { currentTime: 1 });
        mockPlayer.pause.mockClear();
        mockPlayer.play.mockClear();

        fireEvent.press(screen.getByTestId('year-film-share-top'));

        expect(mockPlayer.pause).toHaveBeenCalled();
        expect(mockedTrack).toHaveBeenCalledWith('year_film_share_tapped', { kind: 'family_month', source: 'player' });
        await waitFor(() => expect(mockedFs.createDownloadResumable).toHaveBeenCalled());
        handle.progress(30, 100);
        expect(screen.queryByTestId('year-film-complete')).toBeNull();
        expect(screen.getByTestId('year-film-share-progress').props.children).toBe('Preparing video… 30%');
        expect(screen.getByTestId('year-film-share-cancel')).toBeTruthy();
        expect(screen.getByTestId('year-film-share-top').props.accessibilityState?.disabled).toBe(true);

        await act(async () => {
          download.resolve({ uri: 'file:///cache/film-share/film-1.mp4', status: 200 });
        });
        await waitFor(() => expect(mockedSharing.shareAsync).toHaveBeenCalled());
        await waitFor(() =>
          expect(mockedTrack).toHaveBeenCalledWith('year_film_shared', { kind: 'family_month', source: 'player' }),
        );
        await waitFor(() => expect(screen.queryByTestId('year-film-share-progress')).toBeNull());
        await waitFor(() =>
          expect(mockedFs.deleteAsync).toHaveBeenLastCalledWith('file:///cache/film-share/film-1.mp4', { idempotent: true }),
        );

        // Still paused (never resumed by the share flow), with the Paused veil up.
        expect(mockPlayer.play).not.toHaveBeenCalled();
        expect(screen.getByTestId('year-film-pause-veil')).toBeTruthy();

        // A tap resumes without also skipping a scene.
        const zone = screen.getByTestId('year-film-tap-next');
        fireEvent(zone, 'pressIn');
        fireEvent(zone, 'pressOut');
        fireEvent.press(zone);
        expect(mockPlayer.play).toHaveBeenCalled();
        expect(mockPlayer.currentTime).toBe(0);
        expect(screen.queryByTestId('year-film-pause-veil')).toBeNull();
      });

      it('cancel leaves the film paused and never opens the share sheet', async () => {
        const download = deferred<undefined>();
        const handle = mockDownload(() => download.promise);
        await renderPlayer();
        mockPlayer.play.mockClear();

        fireEvent.press(screen.getByTestId('year-film-share-top'));
        await screen.findByTestId('year-film-share-cancel');
        fireEvent.press(screen.getByTestId('year-film-share-cancel'));
        expect(handle.cancelAsync).toHaveBeenCalled();
        await act(async () => {
          download.resolve(undefined);
        });

        await waitFor(() => expect(screen.queryByTestId('year-film-share-progress')).toBeNull());
        expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
        expect(mockedTrack).not.toHaveBeenCalledWith('year_film_shared', expect.anything());
        expect(mockPlayer.play).not.toHaveBeenCalled();
        expect(screen.getByTestId('year-film-pause-veil')).toBeTruthy();
        expect(screen.getByTestId('year-film-share-top').props.accessibilityState?.disabled).toBe(false);
      });

      it('is replaced by the completion overlay at the end', async () => {
        await renderPlayer();
        await reachCompletion();
        expect(screen.queryByTestId('year-film-share-top')).toBeNull();
        expect(screen.getByTestId('year-film-share')).toBeTruthy();
      });
    });

    it('deletes the file when the download fails', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
      mockDownload(() => Promise.reject(new Error('network')));
      await renderPlayer();
      await reachCompletion();

      fireEvent.press(screen.getByTestId('year-film-share'));

      await waitFor(() => expect(alertSpy).toHaveBeenCalled());
      expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
      expect(mockedFs.deleteAsync).toHaveBeenLastCalledWith('file:///cache/film-share/film-1.mp4', { idempotent: true });
      alertSpy.mockRestore();
    });
  });

  it('refetches the playback URLs once on a player error and resumes at the last position', async () => {
    await renderPlayer();
    emit('timeUpdate', { currentTime: 4.2 });
    mockedGetPlayback.mockResolvedValue({
      data: { ...playback, videoUrl: 'https://r2.example/video.mp4?sig=2' },
      error: null,
      unavailable: false,
    });
    mockPlayer.replaceAsync.mockClear();

    emit('statusChange', { status: 'error' });

    await waitFor(() =>
      expect(mockPlayer.replaceAsync).toHaveBeenCalledWith({ uri: 'https://r2.example/video.mp4?sig=2' }),
    );
    await waitFor(() => expect(mockPlayer.currentTime).toBeCloseTo(4.2, 3));
    expect(mockedGetPlayback).toHaveBeenCalledTimes(2);
    expect(mockedCreatePlayer).toHaveBeenCalledTimes(1);
    expect(mockPlayer.release).not.toHaveBeenCalled();

    // The refreshed URL also fails before ever becoming ready: no endless loop.
    emit('statusChange', { status: 'error' });
    expect(await screen.findByTestId('year-film-error')).toBeTruthy();
    expect(mockedGetPlayback).toHaveBeenCalledTimes(2);

    // A healthy player earns the retry back.
    fireEvent.press(screen.getByTestId('year-film-retry'));
    await waitFor(() => expect(mockedGetPlayback).toHaveBeenCalledTimes(3));
  });

  it('shows the unavailable state if the refetch after a player error says the film is gone', async () => {
    await renderPlayer();
    mockedGetPlayback.mockResolvedValue({
      data: null,
      error: { message: 'gone', code: 'film_unavailable' },
      unavailable: true,
    });

    emit('statusChange', { status: 'error' });

    expect(await screen.findByTestId('year-film-unavailable')).toBeTruthy();
  });

  it('releases the player once, only after unmount, never on re-renders', async () => {
    const { rerenderAsync, unmountAsync } = await renderPlayer();
    emit('timeUpdate', { currentTime: 2 });
    emit('playingChange', { isPlaying: true });
    expect(mockPlayer.release).not.toHaveBeenCalled();

    await rerenderAsync(
      <QueryClientProvider client={new QueryClient()}>
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <YearFilmScreen />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
    expect(mockPlayer.release).not.toHaveBeenCalled();

    await unmountAsync();
    await waitFor(() => expect(mockPlayer.release).toHaveBeenCalledTimes(1));
    expect(mockedCreatePlayer).toHaveBeenCalledTimes(1);
  });

  it('waits behind a one-line motion warning when Reduce Motion is on', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);

    await renderPlayer();

    expect(screen.getByText('This film has a lot of motion.')).toBeTruthy();
    expect(screen.getByTestId('year-film-poster')).toBeTruthy();
    expect(mockPlayer.play).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('year-film-motion-play'));

    expect(screen.queryByTestId('year-film-motion-warning')).toBeNull();
    expect(mockPlayer.play).toHaveBeenCalled();
  });

  describe('edit', () => {
    it.each(['owner', 'manager'])('offers Edit to a %s of the film\'s family and opens the sheet for that film', async (role) => {
      mockMemberships = [
        { familyId: 'family-1', role: 'viewer' },
        { familyId: 'family-9', role: role },
      ];
      await renderPlayer();
      expect(screen.queryByTestId('year-film-edit')).toBeNull();

      await reachCompletion();
      expect(screen.queryByTestId('film-edit-sheet-stub')).toBeNull();
      fireEvent.press(screen.getByTestId('year-film-edit'));

      expect(screen.getByTestId('film-edit-sheet-stub-ids').props.children).toBe('film-1|family-9');
      fireEvent.press(screen.getByTestId('film-edit-stub-close'));
      expect(screen.queryByTestId('film-edit-sheet-stub')).toBeNull();
    });

    it('hides Edit from a viewer', async () => {
      mockMemberships = [{ familyId: 'family-9', role: 'viewer' }];
      await renderPlayer();

      await reachCompletion();

      expect(screen.queryByTestId('year-film-edit')).toBeNull();
      expect(screen.getByTestId('year-film-replay')).toBeTruthy();
      expect(screen.getByTestId('year-film-share')).toBeTruthy();
    });

    it("judges the role by the film's family, not another family the user manages", async () => {
      mockMemberships = [
        { familyId: 'family-1', role: 'owner' },
        { familyId: 'family-9', role: 'viewer' },
      ];
      await renderPlayer();

      await reachCompletion();

      expect(screen.queryByTestId('year-film-edit')).toBeNull();
    });

    it('hides Edit without a membership in the film\'s family', async () => {
      mockMemberships = [];
      await renderPlayer();

      await reachCompletion();

      expect(screen.queryByTestId('year-film-edit')).toBeNull();
    });

    it('after a save shows the remaking toast, then leaves the player', async () => {
      await renderPlayer();
      await reachCompletion();
      fireEvent.press(screen.getByTestId('year-film-edit'));

      const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
      try {
        fireEvent.press(screen.getByTestId('film-edit-stub-save'));

        expect(screen.queryByTestId('film-edit-sheet-stub')).toBeNull();
        expect(screen.getByText('Remaking your film… this takes a few minutes')).toBeTruthy();
        expect(router.back).not.toHaveBeenCalled();

        // The player leaves after ~2 s so the toast can be read: run that timer.
        const leave = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 2200);
        expect(leave).toBeDefined();
        act(() => {
          (leave![0] as () => void)();
        });

        expect(router.back).toHaveBeenCalledTimes(1);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  it('offers explicit previous / pause / next controls to a screen reader', async () => {
    (AccessibilityInfo.isScreenReaderEnabled as jest.Mock).mockResolvedValue(true);
    await renderPlayer();

    fireEvent.press(await screen.findByLabelText('Next scene'));
    expect(mockPlayer.currentTime).toBe(3);

    fireEvent.press(screen.getByLabelText('Pause film'));
    expect(mockPlayer.pause).toHaveBeenCalled();
    expect(screen.getByLabelText('Play film')).toBeTruthy();
  });
});

// The unavailable path never reaches replaceAsync, so it can't wait on it.
async function renderPlayer_unavailable() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderAsync(
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <YearFilmScreen />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
}
