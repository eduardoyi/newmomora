import { act, renderHook } from '@testing-library/react-native';

import { beginAudioPlayback, pauseAllAudioPlayback, resetAudioPlaybackCoordinatorForTests } from '@/hooks/audio-playback-coordinator';
import { useBedPreview } from '@/hooks/useBedPreview';

type Listener = (status: Record<string, unknown>) => void;

function mockCreatePlayer() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    replace: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(() => Promise.resolve()),
    remove: jest.fn(),
    addListener: jest.fn((_event: string, listener: Listener) => {
      listeners.add(listener);
      return { remove: jest.fn(() => listeners.delete(listener)) };
    }),
  };
}

let mockPlayers: ReturnType<typeof mockCreatePlayer>[] = [];
const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    const player = mockCreatePlayer();
    mockPlayers.push(player);
    return player;
  },
  setAudioModeAsync: (...args: unknown[]) => mockSetAudioModeAsync(...args),
}));

const bedA = { id: 'bright-pop', preview: 101 };
const bedB = { id: 'sparkle-pop', preview: 102 };

describe('useBedPreview', () => {
  beforeEach(() => {
    mockPlayers = [];
    mockSetAudioModeAsync.mockClear();
    resetAudioPlaybackCoordinatorForTests();
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  it('creates one player, sets the playback audio mode and plays the bed preview', async () => {
    const { result } = renderHook(() => useBedPreview());

    await act(async () => {
      await result.current.toggle(bedA);
    });

    expect(mockPlayers).toHaveLength(1);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: false, playsInSilentMode: true });
    expect(mockPlayers[0].replace).toHaveBeenCalledWith(101);
    expect(mockPlayers[0].play).toHaveBeenCalledTimes(1);
    expect(result.current.playingBedId).toBe('bright-pop');
  });

  it('stops when the playing bed is toggled again', async () => {
    const { result } = renderHook(() => useBedPreview());
    await act(async () => {
      await result.current.toggle(bedA);
    });

    await act(async () => {
      await result.current.toggle(bedA);
    });

    expect(mockPlayers[0].pause).toHaveBeenCalled();
    expect(result.current.playingBedId).toBeNull();
  });

  it('switches beds on the same player with replace()', async () => {
    const { result } = renderHook(() => useBedPreview());
    await act(async () => {
      await result.current.toggle(bedA);
    });

    await act(async () => {
      await result.current.toggle(bedB);
    });

    expect(mockPlayers).toHaveLength(1);
    expect(mockPlayers[0].replace).toHaveBeenLastCalledWith(102);
    expect(mockPlayers[0].play).toHaveBeenCalledTimes(2);
    expect(result.current.playingBedId).toBe('sparkle-pop');
  });

  it('restarts a bed that already finished from the start without reloading it', async () => {
    const { result } = renderHook(() => useBedPreview());
    await act(async () => {
      await result.current.toggle(bedA);
    });
    act(() => {
      mockPlayers[0].listeners.forEach((listener) => listener({ didJustFinish: true }));
    });
    expect(result.current.playingBedId).toBeNull();

    await act(async () => {
      await result.current.toggle(bedA);
    });

    expect(mockPlayers[0].replace).toHaveBeenCalledTimes(1);
    expect(mockPlayers[0].seekTo).toHaveBeenCalledWith(0);
    expect(mockPlayers[0].play).toHaveBeenCalledTimes(2);
    expect(result.current.playingBedId).toBe('bright-pop');
  });

  it('pauses when other audio takes the playback slot, and when everything is paused', async () => {
    const { result } = renderHook(() => useBedPreview());
    await act(async () => {
      await result.current.toggle(bedA);
    });

    act(() => {
      beginAudioPlayback('some-clip', jest.fn());
    });
    expect(mockPlayers[0].pause).toHaveBeenCalledTimes(1);
    expect(result.current.playingBedId).toBeNull();

    await act(async () => {
      await result.current.toggle(bedA);
    });
    expect(result.current.playingBedId).toBe('bright-pop');
    act(() => {
      pauseAllAudioPlayback();
    });
    expect(result.current.playingBedId).toBeNull();
  });

  it('pauses and releases the player on unmount', async () => {
    const { result, unmount } = renderHook(() => useBedPreview());
    await act(async () => {
      await result.current.toggle(bedA);
    });

    unmount();

    expect(mockPlayers[0].pause).toHaveBeenCalled();
    expect(mockPlayers[0].remove).toHaveBeenCalledTimes(1);
  });
});
