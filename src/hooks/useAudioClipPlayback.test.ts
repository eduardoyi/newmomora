import { act, renderHook } from '@testing-library/react-native';

import { useAudioClipPlayback } from './useAudioClipPlayback';

type Listener = (status: Record<string, unknown>) => void;

function createMockPlayer() {
  const listeners = new Map<string, Set<Listener>>();
  const player = {
    playing: false,
    currentTime: 0,
    duration: 0,
    replace: jest.fn((source: unknown) => {
      // Simulate the native side reporting an updated status shortly after
      // a source swap -- not required by every test, callers can also drive
      // this manually via emit().
      void source;
    }),
    play: jest.fn(() => {
      player.playing = true;
    }),
    pause: jest.fn(() => {
      player.playing = false;
    }),
    seekTo: jest.fn((seconds: number) => {
      player.currentTime = seconds;
      return Promise.resolve();
    }),
    remove: jest.fn(),
    addListener: jest.fn((event: string, listener: Listener) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
      return { remove: jest.fn(() => listeners.get(event)?.delete(listener)) };
    }),
    emit(event: string, status: Record<string, unknown>) {
      for (const listener of listeners.get(event) ?? []) {
        listener(status);
      }
    },
  };
  return player;
}

let createdPlayers: ReturnType<typeof createMockPlayer>[] = [];
const mockCreateAudioPlayer = jest.fn((source: unknown) => {
  const player = createMockPlayer();
  (player as any).__initialSource = source;
  createdPlayers.push(player);
  return player;
});
const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-audio', () => ({
  createAudioPlayer: (...args: unknown[]) => mockCreateAudioPlayer(...args),
}));

jest.mock('./audio-playback-coordinator', () => ({
  beginAudioPlayback: jest.fn(),
  endAudioPlayback: jest.fn(),
  prepareAudioPlaybackMode: () => mockSetAudioModeAsync(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const coordinator = require('./audio-playback-coordinator');

let originalRAF: typeof requestAnimationFrame;

beforeAll(() => {
  originalRAF = global.requestAnimationFrame;
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
});

afterAll(() => {
  global.requestAnimationFrame = originalRAF;
});

beforeEach(() => {
  createdPlayers = [];
  mockCreateAudioPlayer.mockClear();
  mockSetAudioModeAsync.mockClear();
  coordinator.beginAudioPlayback.mockClear();
  coordinator.endAudioPlayback.mockClear();
});

describe('useAudioClipPlayback -- player lifecycle', () => {
  it('creates exactly one player on mount', () => {
    renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
  });

  it('creates the player with the initial source directly, and never redundantly replaces it on mount', () => {
    renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));

    expect(mockCreateAudioPlayer).toHaveBeenCalledWith(
      { uri: 'https://example.test/clip-1.m4a' },
      // Frequent enough for the time label; the trace glides in between.
      { updateInterval: 250 },
    );
    expect(createdPlayers[0].replace).not.toHaveBeenCalled();
  });

  it('swaps the source with replace() instead of recreating the player when the source URL changes', () => {
    const { rerender } = renderHook(
      ({ source }) => useAudioClipPlayback(source),
      { initialProps: { source: 'https://example.test/clip-1.m4a' } },
    );

    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
    const player = createdPlayers[0];

    rerender({ source: 'https://example.test/clip-1-refreshed-signature.m4a' });

    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
    expect(player.replace).toHaveBeenCalledWith({ uri: 'https://example.test/clip-1-refreshed-signature.m4a' });
  });

  it('does not call replace again when the source string is unchanged across re-renders', () => {
    const { rerender } = renderHook(
      ({ source }) => useAudioClipPlayback(source),
      { initialProps: { source: 'https://example.test/clip-1.m4a' } },
    );
    const player = createdPlayers[0];
    player.replace.mockClear();

    rerender({ source: 'https://example.test/clip-1.m4a' });

    expect(player.replace).not.toHaveBeenCalled();
  });

  it('never removes the player while the component stays mounted', () => {
    const { rerender } = renderHook(
      ({ source }) => useAudioClipPlayback(source),
      { initialProps: { source: 'https://example.test/clip-1.m4a' } },
    );
    const player = createdPlayers[0];

    rerender({ source: 'https://example.test/clip-2.m4a' });
    rerender({ source: 'https://example.test/clip-3.m4a' });

    expect(player.remove).not.toHaveBeenCalled();
  });

  it('pauses and removes the player on unmount, without recreating it first', () => {
    const { unmount } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];

    unmount();

    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
  });
});

describe('useAudioClipPlayback -- status, toggle, seek', () => {
  it('reflects playbackStatusUpdate events into position/duration/progress/playing', () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];

    act(() => {
      player.emit('playbackStatusUpdate', {
        currentTime: 5,
        duration: 20,
        playing: true,
        isLoaded: true,
        error: null,
      });
    });

    expect(result.current.position).toBe(5);
    expect(result.current.duration).toBe(20);
    expect(result.current.progress).toBe(0.25);
    expect(result.current.playing).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('toggle() prepares the playback audio mode, claims the coordinator slot, and plays when paused', async () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];

    await act(async () => {
      await result.current.toggle();
    });

    expect(mockSetAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(coordinator.beginAudioPlayback).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('toggle() pauses (and releases the coordinator slot) when already playing', async () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];
    player.playing = true;

    await act(async () => {
      await result.current.toggle();
    });

    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(coordinator.endAudioPlayback).toHaveBeenCalledTimes(1);
    expect(mockSetAudioModeAsync).not.toHaveBeenCalled();
  });

  it('toggle() restarts from 0 when the clip already finished', async () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];
    player.duration = 10;
    player.currentTime = 10;

    await act(async () => {
      await result.current.toggle();
    });

    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('seekTo(fraction) seeks proportionally into the clip duration', async () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];
    player.duration = 40;

    await act(async () => {
      await result.current.seekTo(0.25);
    });

    expect(player.seekTo).toHaveBeenCalledWith(10);
  });

  it('seekTo() is a no-op while duration is unknown', async () => {
    const { result } = renderHook(() => useAudioClipPlayback('https://example.test/clip-1.m4a'));
    const player = createdPlayers[0];

    await act(async () => {
      await result.current.seekTo(0.5);
    });

    expect(player.seekTo).not.toHaveBeenCalled();
  });
});

describe('useAudioClipPlayback -- playRange / pause', () => {
  const SOURCE = 'https://example.test/clip-1.m4a';
  const playingStatus = (currentTime: number) => ({
    currentTime,
    duration: 30,
    playing: true,
    isLoaded: true,
    error: null,
  });

  it('playRange() prepares audio mode, claims the coordinator slot, seeks to the start, then plays', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];

    await act(async () => {
      await result.current.playRange(4, 9);
    });

    expect(mockSetAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(coordinator.beginAudioPlayback).toHaveBeenCalledTimes(1);
    expect(player.seekTo).toHaveBeenCalledWith(4);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekTo.mock.invocationCallOrder[0]).toBeLessThan(player.play.mock.invocationCallOrder[0]);
  });

  it('pauses and releases the coordinator slot once a status update reaches the end point', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];
    await act(async () => {
      await result.current.playRange(4, 9);
    });
    coordinator.endAudioPlayback.mockClear();

    act(() => player.emit('playbackStatusUpdate', playingStatus(8.75)));
    expect(player.pause).not.toHaveBeenCalled();

    // Up to one 250 ms update past the end is accepted.
    act(() => player.emit('playbackStatusUpdate', playingStatus(9.1)));
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(coordinator.endAudioPlayback).toHaveBeenCalledTimes(1);

    // The stop point is spent: a later update must not pause again.
    act(() => player.emit('playbackStatusUpdate', playingStatus(9.4)));
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('does not stop on a paused status that lands between the seek and play', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];
    await act(async () => {
      await result.current.playRange(4, 9);
    });

    act(() => player.emit('playbackStatusUpdate', { ...playingStatus(4), playing: false }));
    act(() => player.emit('playbackStatusUpdate', playingStatus(8.9)));
    expect(player.pause).not.toHaveBeenCalled();
    act(() => player.emit('playbackStatusUpdate', playingStatus(9.2)));
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty or inverted range', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];

    await act(async () => {
      await result.current.playRange(5, 5);
      await result.current.playRange(8, 2);
    });

    expect(player.play).not.toHaveBeenCalled();
    expect(coordinator.beginAudioPlayback).not.toHaveBeenCalled();
  });

  it('toggle() after a range preview plays through the end point (stop point cleared)', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];
    await act(async () => {
      await result.current.playRange(4, 9);
    });
    player.playing = false;

    await act(async () => {
      await result.current.toggle();
    });
    act(() => player.emit('playbackStatusUpdate', playingStatus(12)));

    expect(player.pause).not.toHaveBeenCalled();
  });

  it('pause() pauses a playing clip, releases the slot and clears the stop point', async () => {
    const { result } = renderHook(() => useAudioClipPlayback(SOURCE));
    const player = createdPlayers[0];
    await act(async () => {
      await result.current.playRange(4, 9);
    });
    coordinator.endAudioPlayback.mockClear();
    player.pause.mockClear();

    act(() => result.current.pause());
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(coordinator.endAudioPlayback).toHaveBeenCalledTimes(1);

    act(() => player.emit('playbackStatusUpdate', playingStatus(9.5)));
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('swapping the source clears a pending stop point', async () => {
    const { result, rerender } = renderHook(({ source }) => useAudioClipPlayback(source), {
      initialProps: { source: SOURCE },
    });
    const player = createdPlayers[0];
    await act(async () => {
      await result.current.playRange(4, 9);
    });

    rerender({ source: 'https://example.test/clip-2.m4a' });
    act(() => player.emit('playbackStatusUpdate', playingStatus(10)));

    expect(player.pause).not.toHaveBeenCalled();
  });
});
