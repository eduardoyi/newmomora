import { act, fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { StoryFrame } from './story-frame';

import { resetLookingBackImagePreloadForTests } from '@/utils/looking-back-image-preload';

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const ImageComponent = (props: Record<string, unknown>) => React.createElement(View, {
    ...props,
    source: Array.isArray(props.source) || !props.source ? props.source : [props.source],
    transition: props.transition === 0 ? { duration: 0 } : props.transition,
  });
  return { Image: Object.assign(ImageComponent, { loadAsync: jest.fn(() => new Promise(() => {})) }) };
});

const listeners = new Map<string, (event: any) => void>();
const mockPlayer = { duration: 2, status: 'idle' as const, muted: true, loop: false, bufferOptions: {}, addListener: jest.fn((name: string, callback: (event: unknown) => void) => { listeners.set(name, callback as (event: any) => void); return { remove: jest.fn() }; }), pause: jest.fn(), play: jest.fn(), replaceAsync: jest.fn(() => Promise.resolve()), release: jest.fn() };
const mockRefetch = jest.fn(() => Promise.resolve());
const mockAttach = jest.fn(() => 1);
const mockDetach = jest.fn();

let mockMediaUrlState = { data: { 'video-key': 'https://signed/video' } as Record<string, string>, isLoading: false };
const mockUseMediaUrls = jest.fn(() => ({ ...mockMediaUrlState, refetch: mockRefetch }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrls: (...args: unknown[]) => mockUseMediaUrls(...args) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnailResult: jest.fn(() => null) }));
jest.mock('expo-video', () => ({ VideoView: 'VideoView' }));

const videoFrame = {
  id: 'frame', index: 0, chapterIndex: 0, assetIndex: 0, assetCount: 1, kind: 'video', durationMs: 6000,
  memory: { id: 'memory', updated_at: '2026-01-01', emotion: null }, asset: { object_key: 'video-key' },
} as any;

describe('StoryFrame video lifecycle', () => {
  const originalPlatformOs = Platform.OS;

  beforeEach(() => {
    resetLookingBackImagePreloadForTests();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    listeners.clear();
    jest.clearAllMocks();
    mockPlayer.duration = 2;
    mockPlayer.status = 'idle';
    mockAttach.mockImplementation(() => 1);
    mockMediaUrlState = { data: { 'video-key': 'https://signed/video' }, isLoading: false };
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('marks a video ready after its first rendered frame and corrects its authoritative duration', () => {
    const onReady = jest.fn(); const onDuration = jest.fn();
    const screen = render(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={() => {}} onDuration={onDuration} onReady={onReady} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);
    act(() => listeners.get('sourceLoad')?.({}));
    expect(onDuration).toHaveBeenCalledWith(2000);
    expect(onReady).not.toHaveBeenCalled();
    act(() => listeners.get('statusChange')?.({ status: 'readyToPlay' }));
    expect(onReady).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('looking-back-video'), 'firstFrameRender');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('attaches the manager-owned player unchanged and reconciles ready-before-mount state', () => {
    mockPlayer.status = 'readyToPlay';
    const onReady = jest.fn();
    const screen = render(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={() => {}} onReady={onReady} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('looking-back-video').props.player).toBe(mockPlayer);
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
    expect(mockAttach).toHaveBeenCalledWith('frame', mockPlayer);

    act(() => listeners.get('sourceChange')?.({ source: { uri: 'https://signed/video' } }));
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
  });

  it('does not use a ready status as a visual fallback on Android', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockPlayer.status = 'readyToPlay';
    const onReady = jest.fn();
    const screen = render(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={() => {}} onReady={onReady} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);

    expect(onReady).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('looking-back-video'), 'firstFrameRender');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('keeps the loading cover during a later signed-URL refresh until the visible first frame', () => {
    mockPlayer.status = 'readyToPlay';
    const onReady = jest.fn();
    const onBuffering = jest.fn();
    const screen = render(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={onBuffering} onReady={onReady} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);

    mockMediaUrlState = { data: { 'video-key': 'https://signed/video-refreshed' }, isLoading: false };
    screen.rerender(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={onBuffering} onReady={onReady} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);
    expect(screen.getByTestId('looking-back-video-loading')).toBeTruthy();

    act(() => listeners.get('statusChange')?.({ status: 'readyToPlay' }));
    expect(screen.getByTestId('looking-back-video-loading')).toBeTruthy();
    expect(onReady).toHaveBeenCalledTimes(1);

    act(() => listeners.get('sourceChange')?.({ source: { uri: 'https://signed/video-refreshed' } }));
    fireEvent(screen.getByTestId('looking-back-video'), 'firstFrameRender');
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('covers a loading video with its stored first-frame poster and loading affordance', () => {
    mockMediaUrlState = {
      data: {
        'video-key': 'https://signed/video',
        'video-poster': 'https://signed/video-poster',
      },
      isLoading: false,
    };
    const frameWithPoster = {
      ...videoFrame,
      asset: { ...videoFrame.asset, preview_object_key: 'video-poster' },
    } as any;
    const screen = render(<StoryFrame frame={frameWithPoster} isPaused={false} muted onBuffering={() => {}} onReady={() => {}} onUnavailable={() => {}} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);

    expect(mockUseMediaUrls).toHaveBeenCalledWith(['video-key', 'video-poster'], '2026-01-01');
    expect(screen.getByTestId('looking-back-video-placeholder').props.source).toEqual([
      { uri: 'https://signed/video-poster', cacheKey: 'video-poster' },
    ]);
    expect(screen.getByTestId('looking-back-video-loading')).toBeTruthy();
    expect(screen.getByText('Video · Loading')).toBeTruthy();
    fireEvent(screen.getByTestId('looking-back-video'), 'firstFrameRender');
    expect(screen.queryByTestId('looking-back-video-placeholder')).toBeNull();
    expect(screen.queryByTestId('looking-back-video-loading')).toBeNull();
  });
  it('maps native video failure to the calm unavailable state', () => {
    const onUnavailable = jest.fn();
    render(<StoryFrame frame={videoFrame} isPaused={false} muted onBuffering={() => {}} onReady={() => {}} onUnavailable={onUnavailable} onVideoAttach={mockAttach} onVideoDetach={mockDetach} videoPlayer={mockPlayer as any} />);
    act(() => listeners.get('statusChange')?.({ status: 'error' }));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('uses the Timeline preview first and falls back to the original photo', () => {
    mockMediaUrlState = {
      data: {
        'photo-original': 'https://signed/photo-original',
        'photo-preview': 'https://signed/photo-preview',
      },
      isLoading: false,
    };
    const onReady = jest.fn();
    const onUnavailable = jest.fn();
    const photoFrame = {
      ...videoFrame,
      kind: 'photo',
      asset: {
        object_key: 'photo-original',
        preview_object_key: 'photo-preview',
        aspect_ratio: 4 / 3,
      },
    } as any;
    const screen = render(<StoryFrame frame={photoFrame} isPaused={false} muted onBuffering={() => {}} onReady={onReady} onUnavailable={onUnavailable} />);
    const image = screen.getByTestId('looking-back-image');
    expect(image.props.source).toEqual([{ uri: 'https://signed/photo-preview', cacheKey: 'photo-preview' }]);

    fireEvent(image, 'error', { nativeEvent: {} });

    expect(screen.getByTestId('looking-back-image').props.source).toEqual([{ uri: 'https://signed/photo-original', cacheKey: 'photo-original' }]);
    expect(screen.getByTestId('looking-back-image').props.transition).toEqual({ duration: 0 });
    expect(onUnavailable).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('looking-back-image'), 'display');
    fireEvent(screen.getByTestId('looking-back-image'), 'load', { nativeEvent: {} });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('re-signs and retries transient image failures before declaring the frame unavailable', async () => {
    jest.useFakeTimers();
    mockMediaUrlState = { data: { 'photo-original': 'https://signed/photo-original' }, isLoading: false };
    const onUnavailable = jest.fn();
    const photoFrame = {
      ...videoFrame,
      kind: 'photo',
      asset: { object_key: 'photo-original', preview_object_key: null, aspect_ratio: 1 },
    } as any;
    const screen = render(<StoryFrame frame={photoFrame} isPaused={false} muted onBuffering={() => {}} onReady={() => {}} onUnavailable={onUnavailable} />);

    fireEvent(screen.getByTestId('looking-back-image'), 'error', { nativeEvent: {} });
    expect(screen.getByTestId('looking-back-media-loading')).toBeTruthy();
    expect(onUnavailable).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('looking-back-image')).toBeTruthy();
    expect(onUnavailable).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('uses an available preview immediately when the original URL is omitted', () => {
    mockMediaUrlState = { data: { 'photo-preview': 'https://signed/photo-preview' }, isLoading: false };
    const onUnavailable = jest.fn();
    const photoFrame = {
      ...videoFrame,
      kind: 'photo',
      asset: { object_key: 'photo-original', preview_object_key: 'photo-preview', aspect_ratio: 1 },
    } as any;
    const screen = render(<StoryFrame frame={photoFrame} isPaused={false} muted onBuffering={() => {}} onReady={() => {}} onUnavailable={onUnavailable} />);

    expect(screen.getByTestId('looking-back-image').props.source).toEqual([{ uri: 'https://signed/photo-preview', cacheKey: 'photo-preview' }]);
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
