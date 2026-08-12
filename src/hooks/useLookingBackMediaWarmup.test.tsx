import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanupAsync, renderHook, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';

import { useLookingBackMediaWarmup } from './useLookingBackMediaWarmup';

import { getMediaUrls } from '@/services/media';
import type { LookingBackFrame } from '@/utils/looking-back-frames';
import { frameMediaKeys } from '@/utils/looking-back-frames';
import { mediaUrlsQueryOptions } from '@/hooks/useMediaUrls';
import { resetLookingBackImagePreloadForTests } from '@/utils/looking-back-image-preload';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));
jest.mock('expo-image', () => ({
  Image: { loadAsync: jest.fn() },
}));

const mockedGetMediaUrls = getMediaUrls as jest.MockedFunction<typeof getMediaUrls>;
const mockedLoadAsync = Image.loadAsync as jest.MockedFunction<typeof Image.loadAsync>;

function buildFrame(
  id: string,
  kind: LookingBackFrame['kind'],
  overrides: { objectKey?: string; previewKey?: string | null; illustrationKey?: string | null } = {},
): LookingBackFrame {
  const {
    objectKey = `${id}-original`,
    previewKey = null,
    illustrationKey = `${id}-illustration`,
  } = overrides;

  return {
    id,
    index: Number(id.replace(/\D/g, '')) || 0,
    chapterIndex: 0,
    assetIndex: 0,
    assetCount: 1,
    kind,
    durationMs: 5000,
    memory: {
      id: `${id}-memory`,
      updated_at: `${id}-version`,
      illustration_key: kind === 'illustration' ? illustrationKey : null,
    },
    asset: kind === 'photo' || kind === 'video'
      ? { object_key: objectKey, preview_object_key: previewKey }
      : undefined,
  } as LookingBackFrame;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function resolveMediaUrls(keys: string[]) {
  return {
    data: {
      urls: Object.fromEntries(keys.map((key) => [key, `https://signed.example/${key}`])),
      expiresIn: 3600,
    },
    error: null,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useLookingBackMediaWarmup', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    resetLookingBackImagePreloadForTests();
    jest.clearAllMocks();
    queryClient = createQueryClient();
    mockedGetMediaUrls.mockImplementation(async (keys) => resolveMediaUrls(keys));
    mockedLoadAsync.mockResolvedValue({ release: jest.fn() } as never);
  });

  afterEach(async () => {
    resetLookingBackImagePreloadForTests();
    await cleanupAsync();
    queryClient.clear();
  });

  it('signs every non-empty frame with its own cache version and never byte-warms raw video', async () => {
    const frames = [
      buildFrame('frame-1', 'photo', { previewKey: 'frame-1-preview' }),
      buildFrame('frame-2', 'illustration'),
      buildFrame('frame-3', 'video', { previewKey: 'frame-3-poster' }),
      buildFrame('frame-4', 'text-short'),
    ];

    renderHook(() => useLookingBackMediaWarmup({ frames, phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(3));

    for (const frame of frames) {
      const keys = frameMediaKeys(frame);
      if (keys.queryKeys.length === 0) continue;
      expect(queryClient.getQueryData(
        mediaUrlsQueryOptions(keys.queryKeys, frame.memory.updated_at).queryKey,
      )).toEqual(expect.objectContaining(Object.fromEntries(
        keys.queryKeys.map((key) => [key, `https://signed.example/${key}`]),
      )));
    }

    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(3));
    const warmedKeys = mockedLoadAsync.mock.calls.map(([source]) => source.cacheKey);
    expect(warmedKeys).toEqual(['frame-1-preview', 'frame-2-illustration', 'frame-3-poster']);
    expect(warmedKeys).not.toContain('frame-3-original');
  });

  it('reuses fresh signed data and fetches stale signed data', async () => {
    const frame = buildFrame('frame-1', 'photo', { previewKey: 'frame-1-preview' });
    const options = mediaUrlsQueryOptions(frameMediaKeys(frame).queryKeys, frame.memory.updated_at);
    const urls = { 'frame-1-original': 'https://cached/original', 'frame-1-preview': 'https://cached/preview' };

    queryClient.setQueryData(options.queryKey, urls, { updatedAt: Date.now() });
    const fresh = renderHook(() => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    expect(mockedGetMediaUrls).not.toHaveBeenCalled();
    fresh.unmount();

    queryClient.setQueryData(options.queryKey, urls, {
      updatedAt: Date.now() - (50 * 60 * 1000) - 1,
    });
    renderHook(() => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(1));
  });

  it('warms the intro/current lookahead in frame order with no more than two image loads in flight', async () => {
    const frames = [
      buildFrame('frame-1', 'photo'),
      buildFrame('frame-2', 'photo'),
      buildFrame('frame-3', 'photo'),
      buildFrame('frame-4', 'photo'),
    ];
    const pending: { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }[] = [];
    mockedLoadAsync.mockImplementation(() => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    }) as never);

    const hook = renderHook(
      ({ phase, frameIndex }: { phase: 'intro' | 'playing' | 'complete' | 'closed'; frameIndex: number }) =>
        useLookingBackMediaWarmup({ frames, phase, frameIndex }),
      { initialProps: { phase: 'intro', frameIndex: 0 }, wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(2));
    expect(mockedLoadAsync.mock.calls.map(([source]) => source.cacheKey)).toEqual([
      'frame-1-original',
      'frame-2-original',
    ]);
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0]?.resolve({ release: jest.fn() });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(3));
    expect(mockedLoadAsync.mock.calls[2][0].cacheKey).toBe('frame-3-original');

    await act(async () => {
      pending[1]?.resolve({ release: jest.fn() });
      pending[2]?.resolve({ release: jest.fn() });
      await Promise.resolve();
    });
    await hook.rerender({ phase: 'playing', frameIndex: 1 });
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(4));
    expect(mockedLoadAsync.mock.calls[3][0].cacheKey).toBe('frame-4-original');
    hook.unmount();
  });

  it('keeps the two-load limit when a package generation changes during active image loads', async () => {
    const firstFrames = [buildFrame('frame-1', 'photo'), buildFrame('frame-2', 'photo')];
    const secondFrames = [buildFrame('frame-3', 'photo'), buildFrame('frame-4', 'photo')];
    const pending: (() => void)[] = [];
    mockedLoadAsync.mockImplementation(() => new Promise((resolve) => {
      pending.push(() => resolve({ release: jest.fn() }));
    }) as never);

    const hook = renderHook(
      ({ frames }: { frames: LookingBackFrame[] }) =>
        useLookingBackMediaWarmup({ frames, phase: 'intro', frameIndex: 0 }),
      { initialProps: { frames: firstFrames }, wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(2));
    await hook.rerender({ frames: secondFrames });
    await flushPromises();
    expect(mockedLoadAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[0]?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(3));
    expect(mockedLoadAsync.mock.calls[2][0].cacheKey).toBe('frame-3-original');

    pending.slice(1).forEach((resolve) => resolve());
    hook.unmount();
  });

  it('releases every successful image reference immediately', async () => {
    const release = jest.fn();
    mockedLoadAsync.mockResolvedValue({ release } as never);
    const frame = buildFrame('frame-1', 'photo');

    renderHook(() => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it('leaves failed keys retryable for a later lookahead pass', async () => {
    const frames = [buildFrame('frame-1', 'photo'), buildFrame('frame-2', 'photo')];
    mockedLoadAsync
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ release: jest.fn() } as never);
    const hook = renderHook(
      ({ frameIndex }: { frameIndex: number }) => useLookingBackMediaWarmup({ frames, phase: 'playing', frameIndex }),
      { initialProps: { frameIndex: 0 }, wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(2));
    await hook.rerender({ frameIndex: 1 });
    await hook.rerender({ frameIndex: 0 });
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(3));
    expect(mockedLoadAsync.mock.calls[2][0].cacheKey).toBe('frame-1-original');
  });

  it('handles signing and image-load rejections without starting unhandled work', async () => {
    const frame = buildFrame('frame-1', 'photo');
    mockedGetMediaUrls.mockRejectedValue(new Error('offline'));

    renderHook(() => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(mockedLoadAsync).not.toHaveBeenCalled();

    mockedGetMediaUrls.mockImplementation(async (keys) => resolveMediaUrls(keys));
    mockedLoadAsync.mockRejectedValue(new Error('offline image'));
    const imageFailureFrame = buildFrame('frame-2', 'photo');
    renderHook(() => useLookingBackMediaWarmup({ frames: [imageFailureFrame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(mockedLoadAsync).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'frame-2-original' }));
  });

  it('does not start byte work after the package run is superseded or unmounted', async () => {
    const frame = buildFrame('frame-1', 'photo');
    let resolveUrls: ((value: { data: { urls: Record<string, string>; expiresIn: number }; error: null }) => void) | undefined;
    mockedGetMediaUrls.mockImplementation(() => new Promise((resolve) => { resolveUrls = resolve; }));

    const hook = renderHook(() => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(1));
    hook.unmount();

    await act(async () => {
      resolveUrls?.(resolveMediaUrls(['frame-1-original']));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedLoadAsync).not.toHaveBeenCalled();
  });

});
