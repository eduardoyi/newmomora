import { fireEvent, render } from '@testing-library/react-native';

import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { useVideoThumbnailResult } from '@/hooks/useVideoThumbnail';

const mockVideoPlayer = {
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  removeListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  playing: true,
};

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnailResult: jest.fn(() => null),
}));

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn((_source, setup) => {
    setup?.(mockVideoPlayer);
    return mockVideoPlayer;
  }),
  VideoView: 'VideoView',
}));

const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;
const mockedUseVideoThumbnailResult = useVideoThumbnailResult as jest.MockedFunction<
  typeof useVideoThumbnailResult
>;
const mockRefetchMediaUrls = jest.fn();

const assets = [
  {
    id: 'asset-1',
    memory_id: 'memory-1',
    object_key: 'user/memory/media/photo-1.jpg',
    content_type: 'image/jpeg',
    position: 0,
    created_at: '2026-06-05T00:00:00.000Z',
  },
  {
    id: 'asset-2',
    memory_id: 'memory-1',
    object_key: 'user/memory/media/photo-2.jpg',
    content_type: 'image/jpeg',
    position: 1,
    created_at: '2026-06-05T00:00:00.000Z',
  },
];

describe('MemoryMediaCarousel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVideoPlayer.playing = true;
    mockedUseVideoThumbnailResult.mockReturnValue(null);
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/media/photo-1.jpg': 'https://example.com/photo-1.jpg',
        'user/memory/media/photo-2.jpg': 'https://example.com/photo-2.jpg',
      },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
  });

  it('calls onPress for a stationary tap', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={assets} onPress={onPress} />,
    );

    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 22, pageY: 31 } });

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress for a horizontal drag', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={assets} onPress={onPress} />,
    );

    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchMove', { nativeEvent: { pageX: 70, pageY: 32 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 110, pageY: 32 } });

    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens the currently visible carousel item', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={assets} onPress={onPress} />,
    );

    const carousel = getByTestId('memory-media-carousel');
    fireEvent(carousel, 'layout', { nativeEvent: { layout: { width: 320 } } });
    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 320, y: 0 } },
    });
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 20, pageY: 30 } });

    expect(onPress).toHaveBeenCalledWith(1);
  });

  it('adopts a single asset exact natural aspect ratio once it loads', () => {
    const { getByTestId } = render(<MemoryMediaCarousel assets={[assets[0]]} />);

    fireEvent(getByTestId('memory-media-image-asset-1'), 'load', {
      nativeEvent: { source: { width: 1080, height: 1920 } },
    });

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('uses the displayed thumbnail ratio for a rotated portrait video', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
    mockedUseVideoThumbnailResult.mockReturnValue({
      uri: 'file:///portrait-frame.jpg',
      width: 1080,
      height: 1920,
    });

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };
    const { getByTestId } = render(<MemoryMediaCarousel assets={[videoAsset]} />);

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('adopts the first asset natural aspect ratio, clamped for a carousel', () => {
    const { getByTestId } = render(<MemoryMediaCarousel assets={assets} />);

    // Defaults to 4:3 until dimensions are known.
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 4 / 3 });

    // A portrait 3:4 photo resizes the container to match (no crop).
    fireEvent(getByTestId('memory-media-image-asset-1'), 'load', {
      nativeEvent: { source: { width: 1200, height: 1600 } },
    });
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 3 / 4 });

    // An extreme 9:16 first asset is clamped to the 3:4 minimum when other
    // assets share the same carousel frame.
    fireEvent(getByTestId('memory-media-image-asset-1'), 'load', {
      nativeEvent: { source: { width: 1080, height: 1920 } },
    });
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 3 / 4 });

    // The second asset's dimensions do not drive the container.
    fireEvent(getByTestId('memory-media-image-asset-2'), 'load', {
      nativeEvent: { source: { width: 1600, height: 900 } },
    });
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 3 / 4 });
  });

  it('does not mount a video player on the page adjacent to the active one', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/media/photo-1.jpg': 'https://example.com/photo-1.jpg',
        'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4',
      },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const { queryByTestId } = render(
      <MemoryMediaCarousel
        assets={[
          assets[0],
          {
            ...assets[1],
            id: 'asset-video',
            object_key: 'user/memory/media/video-1.mp4',
            content_type: 'video/mp4',
          },
        ]}
      />,
    );

    expect(queryByTestId('memory-media-video')).toBeNull();
  });

  it('does not mount video players when the carousel is inactive', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/media/photo-1.jpg': 'https://example.com/photo-1.jpg',
        'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4',
      },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const { queryByTestId } = render(
      <MemoryMediaCarousel
        assets={[
          assets[0],
          {
            ...assets[1],
            id: 'asset-video',
            object_key: 'user/memory/media/video-1.mp4',
            content_type: 'video/mp4',
          },
        ]}
        isActive={false}
      />,
    );

    expect(queryByTestId('memory-media-video')).toBeNull();
  });

  it('loops an unmuted detail video and toggles playback when tapped', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} mutedVideos={false} videoTapToToggle />,
    );

    expect(mockVideoPlayer.loop).toBe(true);
    expect(mockVideoPlayer.muted).toBe(false);
    expect(mockVideoPlayer.bufferOptions).toEqual({
      preferredForwardBufferDuration: 8,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    expect(getByTestId('memory-media-video').props.nativeControls).toBe(false);

    fireEvent.press(getByTestId('memory-media-video-toggle'));
    expect(mockVideoPlayer.pause).toHaveBeenCalled();

    mockVideoPlayer.playing = false;
    fireEvent.press(getByTestId('memory-media-video-toggle'));
    expect(mockVideoPlayer.play).toHaveBeenCalled();
  });

  it('uses a stable image cache key and refreshes an expired signed URL', () => {
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[assets[0]]} cacheVersion="version-1" />,
    );

    const image = getByTestId('memory-media-image-asset-1');
    expect(image.props.source).toEqual([{
      uri: 'https://example.com/photo-1.jpg',
      cacheKey: 'user/memory/media/photo-1.jpg:version-1',
    }]);

    fireEvent(image, 'error', { nativeEvent: { error: 'expired' } });
    expect(mockRefetchMediaUrls).toHaveBeenCalledTimes(1);
  });
});
