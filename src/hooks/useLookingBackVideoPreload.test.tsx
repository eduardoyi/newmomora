import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanupAsync, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import { createVideoPlayer, type VideoPlayer } from 'expo-video';

import {
  LookingBackVideoPreloadController,
  useLookingBackVideoPreload,
} from './useLookingBackVideoPreload';

import { mediaUrlsQueryOptions } from '@/hooks/useMediaUrls';
import type { LookingBackFrame } from '@/utils/looking-back-frames';
import { frameMediaKeys } from '@/utils/looking-back-frames';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));
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
    duration: 0,
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
    emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((callback) => callback(payload)),
  } as unknown as FakePlayer;
  players.push(player);
  return player;
}

function buildVideoFrame(id: string, version = `${id}-version`): LookingBackFrame {
  return {
    id,
    index: Number(id.replace(/\D/g, '')) || 0,
    chapterIndex: 0,
    assetIndex: 0,
    assetCount: 1,
    kind: 'video',
    durationMs: 6000,
    memory: { id: `${id}-memory`, updated_at: version },
    asset: { object_key: `${id}-object`, preview_object_key: `${id}-poster` },
  } as LookingBackFrame;
}

function buildTextFrame(id: string): LookingBackFrame {
  return {
    id,
    index: Number(id.replace(/\D/g, '')) || 0,
    chapterIndex: 0,
    assetIndex: 0,
    assetCount: 1,
    kind: 'text-short',
    durationMs: 5600,
    memory: { id: `${id}-memory`, updated_at: `${id}-version` },
  } as LookingBackFrame;
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function seedVideoUrl(queryClient: QueryClient, frame: LookingBackFrame, url: string): void {
  const keys = frameMediaKeys(frame).queryKeys;
  const options = mediaUrlsQueryOptions(keys, frame.memory.updated_at);
  queryClient.setQueryData(
    options.queryKey,
    Object.fromEntries(keys.map((key) => [key, key === frame.asset?.object_key ? url : `https://signed.example/${key}`])),
    { updatedAt: Date.now() },
  );
}

function controllerOptions(frames: LookingBackFrame[], phase: 'intro' | 'playing', frameIndex: number) {
  return { frames, phase, frameIndex, foregroundGeneration: 0 } as const;
}

describe('useLookingBackVideoPreload', () => {
  let queryClient: QueryClient;
  const originalPlatformOs = Platform.OS;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    jest.clearAllMocks();
    players.length = 0;
    mockedCreateVideoPlayer.mockImplementation(() => createFakePlayer());
    queryClient = createQueryClient();
  });

  afterEach(async () => {
    await cleanupAsync();
    queryClient.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('preloads the nearest intro video, keeps it muted/paused, and hands that same player to the current frame', async () => {
    const firstVideo = buildVideoFrame('frame-0');
    const secondVideo = buildVideoFrame('frame-2');
    const frames = [firstVideo, buildTextFrame('frame-1'), secondVideo];
    seedVideoUrl(queryClient, firstVideo, 'https://signed.example/frame-0');
    seedVideoUrl(queryClient, secondVideo, 'https://signed.example/frame-2');

    const hook = renderHook(
      ({ phase, frameIndex }: { phase: 'intro' | 'playing'; frameIndex: number }) =>
        useLookingBackVideoPreload({ frames, phase, frameIndex }),
      { initialProps: { phase: 'intro', frameIndex: 0 }, wrapper: wrapperFor(queryClient) },
    );

    await waitFor(() => expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(1));
    const preloadedPlayer = players[0];
    expect(hook.result.current.currentPlayer).toBeNull();
    expect(preloadedPlayer.muted).toBe(true);
    expect(preloadedPlayer.pause).toHaveBeenCalled();
    expect(preloadedPlayer.bufferOptions.preferredForwardBufferDuration).toBe(8);

    // `replaceAsync` accepting a URL is not proof that native has applied it.
    // The manager admits the player only after the matching native event.
    act(() => {
      preloadedPlayer.emit('sourceChange', { source: { uri: 'https://signed.example/frame-0' } });
    });
    expect(hook.result.current.currentPlayer).toBeNull();
    await hook.rerender({ phase: 'playing', frameIndex: 0 });
    await waitFor(() => expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(2));
    expect(hook.result.current.currentPlayer).toBe(preloadedPlayer);
    expect(players[1]).not.toBe(preloadedPlayer);
  });

  it('reacts to asynchronous exact-query signing instead of relying on a one-time cache read', async () => {
    const frame = buildVideoFrame('frame-1');
    const frames = [buildTextFrame('frame-0'), frame];
    const hook = renderHook(
      () => useLookingBackVideoPreload({ frames, phase: 'playing', frameIndex: 0 }),
      { wrapper: wrapperFor(queryClient) },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedCreateVideoPlayer).not.toHaveBeenCalled();
    await act(async () => {
      seedVideoUrl(queryClient, frame, 'https://signed.example/frame-1');
    });
    await waitFor(() => expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(1));
    expect(hook.result.current.currentPlayer).toBeNull();
  });

  it('does not warm a missing, stale, or invalidated exact URL cache entry', () => {
    const staleFrame = buildVideoFrame('frame-1');
    const invalidatedFrame = buildVideoFrame('frame-2');
    const staleOptions = mediaUrlsQueryOptions(frameMediaKeys(staleFrame).queryKeys, staleFrame.memory.updated_at);
    const invalidatedOptions = mediaUrlsQueryOptions(frameMediaKeys(invalidatedFrame).queryKeys, invalidatedFrame.memory.updated_at);
    queryClient.setQueryData(staleOptions.queryKey, { [staleFrame.asset?.object_key ?? '']: 'https://signed.example/stale' }, { updatedAt: Date.now() - staleOptions.staleTime - 1 });
    seedVideoUrl(queryClient, invalidatedFrame, 'https://signed.example/invalidated');
    void queryClient.invalidateQueries({ queryKey: invalidatedOptions.queryKey, exact: true });

    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.update(controllerOptions([staleFrame], 'playing', 0));
    controller.update(controllerOptions([invalidatedFrame], 'playing', 0));

    expect(mockedCreateVideoPlayer).not.toHaveBeenCalled();
  });

  it('waits for foreground before recreating video work whose cache completes in the background', () => {
    const frame = buildVideoFrame('frame-0');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.handleBackground();
    seedVideoUrl(queryClient, frame, 'https://signed.example/frame-0');
    controller.update(controllerOptions([frame], 'playing', 0));

    expect(mockedCreateVideoPlayer).not.toHaveBeenCalled();
    controller.handleForeground();
    expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(1);
  });

  it('does not create a third player when current playback must wait for retiring surfaces', () => {
    const first = buildVideoFrame('frame-0');
    const second = buildVideoFrame('frame-1');
    const frames = [first, second];
    seedVideoUrl(queryClient, first, 'https://signed.example/frame-0');
    seedVideoUrl(queryClient, second, 'https://signed.example/frame-1');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());

    controller.update(controllerOptions(frames, 'playing', 0));
    (players[0] as FakePlayer).emit('sourceChange', { source: { uri: 'https://signed.example/frame-0' } });
    const firstPlayer = controller.getCurrentPlayer();
    expect(firstPlayer).toBe(players[0]);
    const firstToken = controller.attach(first.id, firstPlayer!);
    expect(firstToken).not.toBeNull();

    controller.update(controllerOptions(frames, 'playing', 1));
    const secondPlayer = players[1];
    secondPlayer.emit('sourceChange', { source: { uri: 'https://signed.example/frame-1' } });
    const secondToken = controller.attach(second.id, secondPlayer);
    expect(secondToken).not.toBeNull();

    // A→B→A arrives before the old native surfaces detach. The old A cannot
    // be reused and the manager must wait instead of creating a third player.
    controller.update(controllerOptions(frames, 'playing', 0));
    expect(players).toHaveLength(2);
    expect(controller.getCurrentPlayer()).toBeNull();

    controller.detach(first.id, firstPlayer!, firstToken!);
    expect(players).toHaveLength(3);
    expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(3);
    players[2].emit('sourceChange', { source: { uri: 'https://signed.example/frame-0' } });
    expect(controller.getCurrentPlayer()).toBe(players[2]);

    controller.detach(first.id, firstPlayer!, firstToken!);
    expect(players[2].release).not.toHaveBeenCalled();
    controller.detach(second.id, secondPlayer, secondToken!);
    const currentToken = controller.attach(first.id, players[2]);
    controller.dispose();
    controller.detach(first.id, players[2], currentToken!);
    expect(players[2].release).toHaveBeenCalledTimes(1);
  });

  it('releases only the detached upcoming player on background and waits for attachment detachment on unmount', () => {
    const current = buildVideoFrame('frame-0');
    const upcoming = buildVideoFrame('frame-1');
    seedVideoUrl(queryClient, current, 'https://signed.example/frame-0');
    seedVideoUrl(queryClient, upcoming, 'https://signed.example/frame-1');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.update(controllerOptions([current, upcoming], 'playing', 0));
    players[0].emit('sourceChange', { source: { uri: 'https://signed.example/frame-0' } });
    const currentPlayer = controller.getCurrentPlayer()!;
    const currentToken = controller.attach(current.id, currentPlayer);
    const upcomingPlayer = players[1];

    controller.handleBackground();
    expect(upcomingPlayer.release).toHaveBeenCalledTimes(1);
    expect(currentPlayer.release).not.toHaveBeenCalled();

    controller.update({ ...controllerOptions([current, upcoming], 'playing', 0), foregroundGeneration: 1 });
    controller.handleForeground();
    expect(players).toHaveLength(3);
    expect(players[2]).not.toBe(upcomingPlayer);

    controller.dispose();
    expect(currentPlayer.release).not.toHaveBeenCalled();
    controller.detach(current.id, currentPlayer, currentToken!);
    expect(currentPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('requires a matching source event after replaceAsync and serializes out-of-order replacements', () => {
    const frame = buildVideoFrame('frame-0', 'version-1');
    seedVideoUrl(queryClient, frame, 'https://signed.example/one');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.update(controllerOptions([frame], 'playing', 0));
    const player = players[0];
    expect(controller.getCurrentPlayer()).toBeNull();
    player.emit('sourceChange', { source: { uri: 'https://signed.example/one' } });
    expect(controller.getCurrentPlayer()).toBe(player);

    seedVideoUrl(queryClient, frame, 'https://signed.example/two');
    controller.update(controllerOptions([frame], 'playing', 0));
    seedVideoUrl(queryClient, frame, 'https://signed.example/three');
    controller.update(controllerOptions([frame], 'playing', 0));
    expect(player.replaceAsync).toHaveBeenNthCalledWith(1, { uri: 'https://signed.example/one', useCaching: true });
    expect(player.replaceAsync).toHaveBeenNthCalledWith(2, { uri: 'https://signed.example/two', useCaching: true });
    expect(player.replaceAsync).toHaveBeenCalledTimes(2);
    expect(controller.getCurrentPlayer()).toBeNull();

    player.emit('sourceChange', { source: { uri: 'https://signed.example/two', useCaching: true } });
    expect(player.replaceAsync).toHaveBeenNthCalledWith(3, { uri: 'https://signed.example/three', useCaching: true });
    expect(controller.getCurrentPlayer()).toBeNull();
    // A duplicate late event for the old URL is ignored once the latest
    // replacement is the active native request.
    player.emit('sourceChange', { source: { uri: 'https://signed.example/two', useCaching: true } });
    expect(controller.getCurrentPlayer()).toBeNull();
    player.emit('sourceLoad', { videoSource: { uri: 'https://signed.example/three', useCaching: true }, duration: 2 });
    expect(controller.getCurrentPlayer()).toBe(player);
  });

  it('admits an initial iOS-style ready player when the detached source event is not delivered', () => {
    const frame = buildVideoFrame('frame-0');
    seedVideoUrl(queryClient, frame, 'https://signed.example/frame-0');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());

    controller.update(controllerOptions([frame], 'playing', 0));
    const player = players[0];
    expect(controller.getCurrentPlayer()).toBeNull();

    player.emit('statusChange', { status: 'readyToPlay' });

    expect(controller.getCurrentPlayer()).toBe(player);
  });

  it('does not let a late initial ready event confirm a newer signed URL', async () => {
    const frame = buildVideoFrame('frame-0', 'version-1');
    seedVideoUrl(queryClient, frame, 'https://signed.example/one');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());

    controller.update(controllerOptions([frame], 'playing', 0));
    const player = players[0];

    seedVideoUrl(queryClient, frame, 'https://signed.example/two');
    controller.update(controllerOptions([frame], 'playing', 0));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(player.replaceAsync).toHaveBeenLastCalledWith({ uri: 'https://signed.example/two', useCaching: true });
    player.emit('statusChange', { status: 'readyToPlay' });
    expect(controller.getCurrentPlayer()).toBeNull();

    player.emit('sourceLoad', { videoSource: { uri: 'https://signed.example/two', useCaching: true }, duration: 2 });
    expect(controller.getCurrentPlayer()).toBe(player);
  });

  it('does not use the ready-state source fallback on Android', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const frame = buildVideoFrame('frame-0');
    seedVideoUrl(queryClient, frame, 'https://signed.example/frame-0');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());

    controller.update(controllerOptions([frame], 'playing', 0));
    const player = players[0];
    player.emit('statusChange', { status: 'readyToPlay' });

    expect(controller.getCurrentPlayer()).toBeNull();
  });

  it('keeps an attached player mounted while replacing its signed URL', () => {
    const frame = buildVideoFrame('frame-0', 'version-1');
    seedVideoUrl(queryClient, frame, 'https://signed.example/one');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.update(controllerOptions([frame], 'playing', 0));
    const player = players[0];
    player.emit('sourceChange', { source: { uri: 'https://signed.example/one' } });
    const token = controller.attach(frame.id, player);
    expect(token).not.toBeNull();

    seedVideoUrl(queryClient, frame, 'https://signed.example/two');
    controller.update(controllerOptions([frame], 'playing', 0));
    expect(controller.getCurrentPlayer()).toBe(player);
    expect(player.replaceAsync).toHaveBeenLastCalledWith({ uri: 'https://signed.example/two', useCaching: true });
    expect(player.release).not.toHaveBeenCalled();

    player.emit('sourceChange', { source: { uri: 'https://signed.example/two' } });
    expect(controller.getCurrentPlayer()).toBe(player);
    expect(player.release).not.toHaveBeenCalled();

    controller.dispose();
    controller.detach(frame.id, player, token!);
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('retries a transient native source replacement before admitting the player', async () => {
    const frame = buildVideoFrame('frame-0');
    seedVideoUrl(queryClient, frame, 'https://signed.example/frame-0');
    const player = createFakePlayer();
    player.replaceAsync.mockRejectedValueOnce(new Error('temporary native failure')).mockResolvedValue(undefined);
    mockedCreateVideoPlayer.mockReturnValueOnce(player);
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());

    controller.update(controllerOptions([frame], 'playing', 0));
    await waitFor(() => expect(player.replaceAsync).toHaveBeenCalledTimes(2));
    expect(controller.getCurrentPlayer()).toBeNull();

    player.emit('sourceLoad', { videoSource: { uri: 'https://signed.example/frame-0' }, duration: 2 });
    expect(controller.getCurrentPlayer()).toBe(player);
  });

  it('does not recreate a player when only the measured video duration changes', () => {
    const frame = buildVideoFrame('frame-0');
    seedVideoUrl(queryClient, frame, 'https://signed.example/frame-0');
    const controller = new LookingBackVideoPreloadController(queryClient, jest.fn());
    controller.update(controllerOptions([frame], 'playing', 0));
    const changedDuration = { ...frame, durationMs: 9000 };
    controller.update(controllerOptions([changedDuration], 'playing', 0));
    expect(mockedCreateVideoPlayer).toHaveBeenCalledTimes(1);
  });
});
