import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanupAsync, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import { createVideoPlayer, type VideoPlayer } from 'expo-video';

import { StoryFrame } from './story-frame';

import { mediaUrlsQueryOptions } from '@/hooks/useMediaUrls';
import { LookingBackVideoPreloadController } from '@/hooks/useLookingBackVideoPreload';
import type { LookingBackFrame } from '@/utils/looking-back-frames';
import { frameMediaKeys } from '@/utils/looking-back-frames';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnailResult: jest.fn(() => null) }));
jest.mock('expo-video', () => ({
  createVideoPlayer: jest.fn(),
  VideoView: 'VideoView',
}));

interface FakePlayer extends VideoPlayer {
  emit: (event: string, payload: unknown) => void;
  replaceAsync: jest.Mock;
  release: jest.Mock;
  pause: jest.Mock;
}

const mockedCreateVideoPlayer = createVideoPlayer as jest.MockedFunction<typeof createVideoPlayer>;
const players: FakePlayer[] = [];

function createFakePlayer(): FakePlayer {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const player = {
    duration: 2,
    status: 'loading' as const,
    muted: false,
    loop: false,
    bufferOptions: {},
    addListener: jest.fn((event: string, callback: (payload: unknown) => void) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return { remove: () => callbacks.delete(callback) };
    }),
    pause: jest.fn(),
    play: jest.fn(),
    replaceAsync: jest.fn(() => Promise.resolve()),
    release: jest.fn(),
    emit: (event: string, payload: unknown) => {
      if (event === 'statusChange' && payload && typeof payload === 'object' && 'status' in payload) {
        (player as unknown as { status: VideoPlayer['status'] }).status = payload.status as VideoPlayer['status'];
      }
      listeners.get(event)?.forEach((callback) => callback(payload));
    },
  } as unknown as FakePlayer;
  players.push(player);
  return player;
}

const frame = {
  id: 'frame-0',
  index: 0,
  chapterIndex: 0,
  assetIndex: 0,
  assetCount: 1,
  kind: 'video',
  durationMs: 6000,
  memory: { id: 'memory-0', updated_at: 'memory-0-version' },
  asset: { object_key: 'video-key', preview_object_key: null },
} as unknown as LookingBackFrame;

function controllerOptions() {
  return { frames: [frame], phase: 'playing' as const, frameIndex: 0, foregroundGeneration: 0 };
}

function seedVideoUrl(queryClient: QueryClient, url: string): void {
  const keys = frameMediaKeys(frame).queryKeys;
  const options = mediaUrlsQueryOptions(keys, frame.memory.updated_at);
  queryClient.setQueryData(options.queryKey, { 'video-key': url }, { updatedAt: Date.now() });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function VideoStoryHarness({ queryClient, onController, onReady }: { queryClient: QueryClient; onController: (controller: LookingBackVideoPreloadController) => void; onReady: () => void }) {
  const [, forceUpdate] = useState(0);
  const [controller] = useState(() => new LookingBackVideoPreloadController(queryClient, () => forceUpdate((value) => value + 1)));
  const player = controller.getCurrentPlayer();
  const attach = useCallback((frameId: string, attachedPlayer: VideoPlayer) => controller.attach(frameId, attachedPlayer), [controller]);
  const detach = useCallback((frameId: string, attachedPlayer: VideoPlayer, token: number) => controller.detach(frameId, attachedPlayer, token), [controller]);

  useEffect(() => {
    onController(controller);
    controller.update(controllerOptions());
    return () => controller.dispose();
  }, [controller, onController]);

  return <StoryFrame frame={frame} isPaused={false} muted onBuffering={() => {}} onReady={onReady} onUnavailable={() => {}} onVideoAttach={attach} onVideoDetach={detach} videoPlayer={player} />;
}

describe('StoryFrame and video preload handoff', () => {
  const originalPlatformOs = Platform.OS;
  let queryClient: QueryClient;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    jest.clearAllMocks();
    players.length = 0;
    mockedCreateVideoPlayer.mockImplementation(() => createFakePlayer());
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    seedVideoUrl(queryClient, 'https://signed.example/one');
  });

  afterEach(async () => {
    await cleanupAsync();
    queryClient.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('hands an iOS ready player to StoryFrame, then waits for the refreshed visible frame', async () => {
    const onReady = jest.fn();
    let controller: LookingBackVideoPreloadController | undefined;
    const screen = render(
      <VideoStoryHarness onController={(value) => { controller = value; }} onReady={onReady} queryClient={queryClient} />,
      { wrapper: wrapperFor(queryClient) },
    );

    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0];
    await act(async () => {
      player.emit('statusChange', { status: 'readyToPlay' });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('looking-back-video')).toBeTruthy());
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();

    // The initial source event can arrive after the detached ready state. It
    // must not undo the already accepted visual handoff.
    act(() => player.emit('sourceChange', { source: { uri: 'https://signed.example/one' } }));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();

    await act(async () => {
      seedVideoUrl(queryClient, 'https://signed.example/two');
      controller?.update(controllerOptions());
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('looking-back-video-loading')).toBeTruthy());

    act(() => player.emit('statusChange', { status: 'readyToPlay' }));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('looking-back-video-loading')).toBeTruthy();

    act(() => player.emit('sourceChange', { source: { uri: 'https://signed.example/two' } }));
    fireEvent(screen.getByTestId('looking-back-video'), 'firstFrameRender');
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
  });
});
