import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanupAsync, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import { StoryFrame } from './story-frame';

import { useLookingBackMediaWarmup } from '@/hooks/useLookingBackMediaWarmup';
import { getMediaUrls } from '@/services/media';
import type { LookingBackFrame } from '@/utils/looking-back-frames';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const loadAsync = jest.fn(async () => ({ release: jest.fn() }));
  const ImageComponent = (props: Record<string, unknown>) => React.createElement(View, props);
  return { Image: Object.assign(ImageComponent, { loadAsync }) };
});
jest.mock('expo-video', () => ({
  createVideoPlayer: jest.fn(),
  VideoView: 'VideoView',
}));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnailResult: jest.fn(() => null) }));

const mockedGetMediaUrls = getMediaUrls as jest.MockedFunction<typeof getMediaUrls>;
const mockedLoadAsync = Image.loadAsync as jest.MockedFunction<typeof Image.loadAsync>;

function buildPhotoFrame(
  id: string,
  version: string,
  objectKey: string,
  previewKey: string | null,
): LookingBackFrame {
  return {
    id,
    index: Number(id.replace(/\D/g, '')) || 0,
    chapterIndex: 0,
    assetIndex: 0,
    assetCount: 1,
    kind: 'photo',
    durationMs: 4600,
    memory: { id: `${id}-memory`, updated_at: version },
    asset: { object_key: objectKey, preview_object_key: previewKey, aspect_ratio: 4 / 3 },
  } as LookingBackFrame;
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('StoryFrame media warm-up cache regression', () => {
  const originalPlatformOs = Platform.OS;
  let queryClient: QueryClient;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    jest.clearAllMocks();
    mockedLoadAsync.mockImplementation(async () => ({ release: jest.fn() }));
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mockedGetMediaUrls.mockImplementation(async (keys) => ({
      data: {
        urls: Object.fromEntries(keys.map((key) => [key, `https://signed.example/${key}`])),
        expiresIn: 3600,
      },
      error: null,
    }));
  });

  afterEach(async () => {
    await cleanupAsync();
    queryClient.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('mounts a later media frame from the warmed exact query without a new signing call or LoadingPlate', async () => {
    const frames = [
      buildPhotoFrame('frame-1', 'memory-1-version', 'photo-1-original', 'photo-1-preview'),
      buildPhotoFrame('frame-2', 'memory-2-version', 'photo-2-original', 'photo-2-preview'),
    ];
    const warmup = renderHook(
      () => useLookingBackMediaWarmup({ frames, phase: 'intro', frameIndex: 0 }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedLoadAsync).toHaveBeenCalledTimes(2));
    warmup.unmount();

    const serviceCallCountBeforeMount = mockedGetMediaUrls.mock.calls.length;
    const screen = render(
      <QueryClientProvider client={queryClient}>
        <StoryFrame
          frame={frames[1]}
          isPaused={false}
          muted
          onBuffering={() => {}}
          onReady={() => {}}
          onUnavailable={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(mockedGetMediaUrls).toHaveBeenCalledTimes(serviceCallCountBeforeMount);
    expect(screen.queryByTestId('looking-back-media-loading')).toBeNull();
    expect(screen.getByTestId('looking-back-image')).toBeTruthy();
  });

  it('does not leave the first visible photo on LoadingPlate while the package warm-up query is in flight', async () => {
    const frame = buildPhotoFrame('frame-0', 'memory-0-version', 'photo-0-original', 'photo-0-preview');
    let resolveMediaUrls: ((result: Awaited<ReturnType<typeof getMediaUrls>>) => void) | undefined;
    mockedGetMediaUrls.mockImplementation(() => new Promise((resolve) => {
      resolveMediaUrls = resolve;
    }));

    const warmup = renderHook(
      () => useLookingBackMediaWarmup({ frames: [frame], phase: 'intro', frameIndex: 0 }),
      { wrapper: wrapperFor(queryClient) },
    );
    const onBuffering = jest.fn();
    const onReady = jest.fn();
    const screen = render(
      <QueryClientProvider client={queryClient}>
        <StoryFrame
          frame={frame}
          isPaused={false}
          muted
          onBuffering={onBuffering}
          onReady={onReady}
          onUnavailable={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('looking-back-media-loading')).toBeTruthy();
    await waitFor(() => expect(mockedGetMediaUrls).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveMediaUrls?.({
        data: {
          urls: {
            'photo-0-original': 'https://signed.example/photo-0-original',
            'photo-0-preview': 'https://signed.example/photo-0-preview',
          },
          expiresIn: 3600,
        },
        error: null,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('looking-back-media-loading')).toBeNull();
      expect(screen.getByTestId('looking-back-image')).toBeTruthy();
    });
    fireEvent(screen.getByTestId('looking-back-image'), 'display');
    expect(onReady).toHaveBeenCalledTimes(1);
    warmup.unmount();
  });

  it('uses imperative image-load readiness when iOS omits native image callbacks', async () => {
    const frame = buildPhotoFrame('frame-0', 'memory-0-version', 'photo-0-original', 'photo-0-preview');
    const onReady = jest.fn();
    let resolveLoad: ((imageRef: Awaited<ReturnType<typeof Image.loadAsync>>) => void) | undefined;
    mockedLoadAsync.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }) as Promise<Awaited<ReturnType<typeof Image.loadAsync>>>);
    const screen = render(
      <QueryClientProvider client={queryClient}>
        <StoryFrame
          frame={frame}
          isPaused={false}
          muted
          onBuffering={() => {}}
          onReady={onReady}
          onUnavailable={() => {}}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('looking-back-image')).toBeTruthy());
    expect(onReady).not.toHaveBeenCalled();
    await act(async () => {
      resolveLoad?.({ release: jest.fn() } as Awaited<ReturnType<typeof Image.loadAsync>>);
      await Promise.resolve();
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('looking-back-image')).toBeTruthy();
  });
});
