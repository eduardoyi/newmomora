import { fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';
import { createVideoPlayer } from 'expo-video';

import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { useVideoThumbnailResult } from '@/hooks/useVideoThumbnail';

const mockVideoPlayer = {
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  removeListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  playing: true,
  release: jest.fn(),
  replaceAsync: jest.fn(() => Promise.resolve()),
  muted: true,
};

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('@/hooks/useVideoThumbnail', () => ({
  useVideoThumbnailResult: jest.fn(() => null),
}));

jest.mock('expo-video', () => ({
  createVideoPlayer: jest.fn(() => {
    return mockVideoPlayer;
  }),
  VideoView: 'VideoView',
}));

const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;
const mockedUseVideoThumbnailResult = useVideoThumbnailResult as jest.MockedFunction<
  typeof useVideoThumbnailResult
>;
const mockRefetchMediaUrls = jest.fn();

function measureCarousel(getByTestId: RenderResult['getByTestId']) {
  fireEvent(getByTestId('memory-media-carousel'), 'layout', {
    nativeEvent: { layout: { width: 320 } },
  });
}

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
    mockVideoPlayer.muted = false;
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

    measureCarousel(getByTestId);
    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 320, y: 0 } },
    });
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 20, pageY: 30 } });

    expect(onPress).toHaveBeenCalledWith(1);
  });

  it('opens on the requested initial page', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(
      <MemoryMediaCarousel assets={assets} initialIndex={1} onPress={onPress} />,
    );

    measureCarousel(getByTestId);
    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'contentSizeChange', 640, 480);

    expect(getByText('2 / 2')).toBeTruthy();

    // Tapping without swiping reopens the same page, not the first one.
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 20, pageY: 30 } });
    expect(onPress).toHaveBeenCalledWith(1);
  });

  it('clamps an initial page past the end of the asset list', () => {
    const { getByTestId, getByText } = render(
      <MemoryMediaCarousel assets={assets} initialIndex={7} />,
    );

    measureCarousel(getByTestId);

    expect(getByText('2 / 2')).toBeTruthy();
  });

  describe('onActiveIndexChange (Workstream S4)', () => {
    it('reports the default initial index once on mount', () => {
      const onActiveIndexChange = jest.fn();
      render(<MemoryMediaCarousel assets={assets} onActiveIndexChange={onActiveIndexChange} />);

      expect(onActiveIndexChange).toHaveBeenCalledTimes(1);
      expect(onActiveIndexChange).toHaveBeenCalledWith(0);
    });

    it('reports a requested (clamped) initial index once on mount', () => {
      const onActiveIndexChange = jest.fn();
      render(
        <MemoryMediaCarousel assets={assets} initialIndex={1} onActiveIndexChange={onActiveIndexChange} />,
      );

      expect(onActiveIndexChange).toHaveBeenCalledTimes(1);
      expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    });

    it('reports the new page after a swipe settles (handleScrollEnd), not per-frame', () => {
      const onActiveIndexChange = jest.fn();
      const { getByTestId } = render(
        <MemoryMediaCarousel assets={assets} onActiveIndexChange={onActiveIndexChange} />,
      );
      onActiveIndexChange.mockClear(); // Drop the mount call.
      measureCarousel(getByTestId);

      const scrollView = getByTestId('memory-media-carousel-scroll');
      // A per-frame scroll event must NOT report a page change.
      fireEvent(scrollView, 'scroll', { nativeEvent: { contentOffset: { x: 160, y: 0 } } });
      expect(onActiveIndexChange).not.toHaveBeenCalled();

      // A drag that ends without momentum (onScrollEndDrag) must still report.
      fireEvent(scrollView, 'scrollEndDrag', { nativeEvent: { contentOffset: { x: 320, y: 0 } } });
      expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    });
  });

  it('waits for a measured width before mounting media', () => {
    const { getByTestId, queryByTestId } = render(
      <MemoryMediaCarousel assets={[assets[0]]} stableLayout />,
    );

    expect(queryByTestId('memory-media-image-asset-1')).toBeNull();

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-image-asset-1')).toBeTruthy();
  });

  it('adopts a single asset exact natural aspect ratio once it loads', () => {
    const { getByTestId } = render(<MemoryMediaCarousel assets={[assets[0]]} />);

    measureCarousel(getByTestId);

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

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('keeps timeline video height stable when its thumbnail dimensions arrive', () => {
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
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} stableLayout />,
    );

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 4 / 3 });
  });

  it('uses a persisted video ratio immediately in a stable timeline row', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
      aspect_ratio: 9 / 16,
    };
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} stableLayout />,
    );

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('keeps a persisted first-image ratio stable when timeline images load', () => {
    const firstAsset = { ...assets[0], aspect_ratio: 9 / 16 };
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[firstAsset, assets[1]]} stableLayout />,
    );

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });

    fireEvent(getByTestId('memory-media-image-asset-1'), 'load', {
      nativeEvent: { source: { width: 1600, height: 900 } },
    });
    fireEvent(getByTestId('memory-media-image-asset-2'), 'load', {
      nativeEvent: { source: { width: 1200, height: 1200 } },
    });

    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('shows a first-frame thumbnail while a timeline video is inactive', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
    mockedUseVideoThumbnailResult.mockReturnValue({
      uri: 'file:///video-frame.jpg',
      width: 1280,
      height: 720,
    });

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };
    const { getByTestId, queryByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} isActive={false} stableLayout />,
    );

    measureCarousel(getByTestId);

    expect(queryByTestId('memory-media-video')).toBeNull();
    expect(getByTestId('memory-media-video-thumbnail-asset-video').props.source).toEqual([{
      uri: 'file:///video-frame.jpg',
      cacheKey: 'user/memory/media/video-1.mp4::thumbnail',
    }]);
  });

  it('autoplays the active video in a timeline card', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
    mockedUseVideoThumbnailResult.mockReturnValue({
      uri: 'file:///video-frame.jpg',
      width: 1280,
      height: 720,
    });

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} stableLayout />,
    );

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-video')).toBeTruthy();
    expect(mockVideoPlayer.play).toHaveBeenCalled();
  });

  it('releases a timeline player after its native view unmounts', () => {
    let releaseFrame: FrameRequestCallback | undefined;
    const requestAnimationFrameSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        releaseFrame = callback;
        return 1;
      });
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

    try {
      const { getByTestId, unmount } = render(<MemoryMediaCarousel assets={[videoAsset]} />);
      measureCarousel(getByTestId);
      unmount();

      expect(mockVideoPlayer.release).not.toHaveBeenCalled();
      expect(releaseFrame).toBeDefined();

      releaseFrame?.(0);

      expect(mockVideoPlayer.release).toHaveBeenCalledTimes(1);
    } finally {
      requestAnimationFrameSpy.mockRestore();
    }
  });

  it('swaps the source in place (no recreate) when a caption edit refreshes the signed URL for an active video', () => {
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
    const { getByTestId, rerender } = render(
      <MemoryMediaCarousel assets={[videoAsset]} cacheVersion="version-1" />,
    );

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-video')).toBeTruthy();
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);

    // Editing the memory's caption bumps cacheVersion, which produces a
    // fresh signed URL for the same object_key while this video stays
    // mounted -- the regression this hook exists to guard against.
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4?refreshed=1' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    rerender(<MemoryMediaCarousel assets={[videoAsset]} cacheVersion="version-2" />);

    expect(createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(mockVideoPlayer.release).not.toHaveBeenCalled();
    expect(mockVideoPlayer.replaceAsync).toHaveBeenCalledWith({
      uri: 'https://example.com/video-1.mp4?refreshed=1',
      useCaching: true,
    });
  });

  it('keeps the thumbnail over an active player until its first frame renders', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
    mockedUseVideoThumbnailResult.mockReturnValue({
      uri: 'file:///video-frame.jpg',
      width: 1280,
      height: 720,
    });

    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };
    const { getByTestId, queryByTestId } = render(
      <MemoryMediaCarousel assets={[videoAsset]} stableLayout />,
    );

    measureCarousel(getByTestId);

    expect(getByTestId('memory-media-video-thumbnail-asset-video')).toBeTruthy();
    fireEvent(getByTestId('memory-media-video'), 'firstFrameRender');
    expect(queryByTestId('memory-media-video-thumbnail-asset-video')).toBeNull();
  });

  it('uses the first asset exact ratio for every carousel page', () => {
    const { getByTestId } = render(<MemoryMediaCarousel assets={assets} />);

    measureCarousel(getByTestId);

    // Defaults to 4:3 until dimensions are known.
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 4 / 3 });

    // Even an extreme first asset remains authoritative for the shared frame.
    fireEvent(getByTestId('memory-media-image-asset-1'), 'load', {
      nativeEvent: { source: { width: 1080, height: 1920 } },
    });
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });

    // The second asset fits inside the first asset's frame and cannot resize it.
    expect(getByTestId('memory-media-image-asset-2').props.contentFit).toBe('contain');
    fireEvent(getByTestId('memory-media-image-asset-2'), 'load', {
      nativeEvent: { source: { width: 1600, height: 900 } },
    });
    expect(getByTestId('memory-media-carousel')).toHaveStyle({ aspectRatio: 9 / 16 });
  });

  it('does not mount a video player on the page adjacent to the active one', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/media/photo-1.jpg': 'https://example.com/photo-1.jpg',
        'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4',
      },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const { getByTestId, queryByTestId } = render(
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

    measureCarousel(getByTestId);

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

    const { getByTestId, queryByTestId } = render(
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

    measureCarousel(getByTestId);

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

    measureCarousel(getByTestId);

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

  it('updates mute state without recreating the native player', () => {
    mockVideoPlayer.play.mockImplementationOnce(() => {
      expect(mockVideoPlayer.muted).toBe(true);
    });
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
    const { getByTestId, rerender } = render(
      <MemoryMediaCarousel assets={[videoAsset]} mutedVideos />,
    );

    measureCarousel(getByTestId);
    expect(mockVideoPlayer.muted).toBe(true);
    expect(mockVideoPlayer.play).toHaveBeenCalledTimes(1);
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);

    rerender(<MemoryMediaCarousel assets={[videoAsset]} mutedVideos={false} />);

    expect(mockVideoPlayer.muted).toBe(false);
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);
  });

  describe('preferPreview (Workstream C6)', () => {
    const assetWithPreview = {
      ...assets[0],
      preview_object_key: 'user/memory/media/photo-1-preview.jpg',
    };

    it('requests the preview key and renders the preview URL when preferPreview is true', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: { 'user/memory/media/photo-1-preview.jpg': 'https://example.com/photo-1-preview.jpg' },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);

      const { getByTestId } = render(
        <MemoryMediaCarousel assets={[assetWithPreview]} preferPreview />,
      );

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(
        ['user/memory/media/photo-1-preview.jpg'],
        undefined,
        { seedFromCache: true },
      );
      expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([{
        uri: 'https://example.com/photo-1-preview.jpg',
        cacheKey: 'user/memory/media/photo-1-preview.jpg:',
      }]);
    });

    it('falls back to the original when preferPreview is true but the asset has no preview', () => {
      const { getByTestId } = render(<MemoryMediaCarousel assets={[assets[0]]} preferPreview />);

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(['user/memory/media/photo-1.jpg'], undefined, {
        seedFromCache: true,
      });
      expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([{
        uri: 'https://example.com/photo-1.jpg',
        cacheKey: 'user/memory/media/photo-1.jpg:',
      }]);
    });

    it('displays the original (preview only as a placeholder) when preferPreview is false (default -- detail/full-screen)', () => {
      const { getByTestId } = render(<MemoryMediaCarousel assets={[assetWithPreview]} />);

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(
        ['user/memory/media/photo-1.jpg', 'user/memory/media/photo-1-preview.jpg'],
        undefined,
        { seedFromCache: true },
      );
    });
  });

  describe('stored video posters (upload-time first-frame poster)', () => {
    const posterVideoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
      aspect_ratio: 9 / 16,
      preview_object_key: 'user/memory/media/video-1-preview.jpg',
    };

    it('requests both the video and poster keys, and renders the poster while inactive without a runtime extraction', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: {
          'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4',
          'user/memory/media/video-1-preview.jpg': 'https://example.com/video-1-preview.jpg',
        },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);

      const { getByTestId } = render(
        <MemoryMediaCarousel assets={[posterVideoAsset]} isActive={false} stableLayout />,
      );

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(
        ['user/memory/media/video-1.mp4', 'user/memory/media/video-1-preview.jpg'],
        undefined,
        { seedFromCache: true },
      );
      // aspect_ratio is already persisted, so no legacy ratio measurement is
      // needed -- the runtime extractor must not be asked to fetch/decode
      // the actual video just to render a paused-state thumbnail.
      expect(mockedUseVideoThumbnailResult).toHaveBeenCalledWith(null, expect.any(String));
      expect(getByTestId('memory-media-video-thumbnail-asset-video').props.source).toEqual([{
        uri: 'https://example.com/video-1-preview.jpg',
        cacheKey: 'user/memory/media/video-1.mp4::thumbnail',
      }]);
    });

    it('still runs the runtime extractor when a legacy row has both a poster and no persisted aspect ratio', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: {
          'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4',
          'user/memory/media/video-1-preview.jpg': 'https://example.com/video-1-preview.jpg',
        },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);

      const legacyPosterAsset = { ...posterVideoAsset, aspect_ratio: null };
      const { getByTestId } = render(
        <MemoryMediaCarousel assets={[legacyPosterAsset]} stableLayout />,
      );

      measureCarousel(getByTestId);

      expect(mockedUseVideoThumbnailResult).toHaveBeenCalledWith(
        'https://example.com/video-1.mp4',
        expect.any(String),
      );
    });

    it('falls back to runtime extraction when a video asset has no stored poster', () => {
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
        <MemoryMediaCarousel assets={[videoAsset]} isActive={false} stableLayout />,
      );
      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(['user/memory/media/video-1.mp4'], undefined, {
        seedFromCache: true,
      });
      expect(mockedUseVideoThumbnailResult).toHaveBeenCalledWith(
        'https://example.com/video-1.mp4',
        expect.any(String),
      );
    });
  });

  it('uses a stable image cache key and refreshes an expired signed URL', () => {
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={[assets[0]]} cacheVersion="version-1" />,
    );

    measureCarousel(getByTestId);

    const image = getByTestId('memory-media-image-asset-1');
    expect(image.props.source).toEqual([{
      uri: 'https://example.com/photo-1.jpg',
      cacheKey: 'user/memory/media/photo-1.jpg:version-1',
    }]);

    fireEvent(image, 'error', { nativeEvent: { error: 'expired' } });
    expect(mockRefetchMediaUrls).toHaveBeenCalledTimes(1);
  });
  describe('page window (performance plan Workstream C)', () => {
    const manyAssets = Array.from({ length: 6 }, (_, i) => ({
      ...assets[0],
      id: `asset-${i + 1}`,
      object_key: `user/memory/media/photo-${i + 1}.jpg`,
    }));
    const manyUrls = Object.fromEntries(
      manyAssets.map((a) => [a.object_key, `https://example.com/${a.id}.jpg`]),
    );

    beforeEach(() => {
      mockedUseMediaUrls.mockReturnValue({
        data: manyUrls,
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
    });

    function mountedPages(queryByTestId: RenderResult['queryByTestId']) {
      return manyAssets
        .map((a) => a.id)
        .filter((id) => queryByTestId(`memory-media-image-${id}`) !== null);
    }

    function swipeTo(getByTestId: RenderResult['getByTestId'], page: number) {
      fireEvent(getByTestId('memory-media-carousel-scroll'), 'momentumScrollEnd', {
        nativeEvent: { contentOffset: { x: page * 320, y: 0 } },
      });
    }

    it('only mounts the first, active and neighbouring pages', () => {
      const { getByTestId, queryByTestId } = render(<MemoryMediaCarousel assets={manyAssets} />);
      measureCarousel(getByTestId);

      expect(mountedPages(queryByTestId)).toEqual(['asset-1', 'asset-2']);

      swipeTo(getByTestId, 3);

      // 0 (always), 2-4 (window around page 3); 1 was never visited.
      expect(mountedPages(queryByTestId)).toEqual(['asset-1', 'asset-3', 'asset-4', 'asset-5']);
    });

    it('keeps pages the user has been on mounted so swiping back does not flicker', () => {
      const { getByTestId, queryByTestId } = render(<MemoryMediaCarousel assets={manyAssets} />);
      measureCarousel(getByTestId);

      swipeTo(getByTestId, 3);
      swipeTo(getByTestId, 5);

      // Visited: 0, 3, 5. Window around 5: 4, 5. Page 2 (index 1) never visited.
      expect(mountedPages(queryByTestId)).toEqual(['asset-1', 'asset-4', 'asset-5', 'asset-6']);
    });

    it('opens an initial page with its neighbours (and the first page) mounted', () => {
      const { getByTestId, queryByTestId } = render(
        <MemoryMediaCarousel assets={manyAssets} initialIndex={4} />,
      );
      measureCarousel(getByTestId);

      expect(mountedPages(queryByTestId)).toEqual(['asset-1', 'asset-4', 'asset-5', 'asset-6']);
    });

    it('prioritises the page on screen over its neighbours', () => {
      const { getByTestId } = render(<MemoryMediaCarousel assets={manyAssets} />);
      measureCarousel(getByTestId);

      expect(getByTestId('memory-media-image-asset-1').props.priority).toBe('high');
      expect(getByTestId('memory-media-image-asset-2').props.priority).toBe('low');
    });

    it('keeps one batched media-urls request for every page, mounted or not', () => {
      render(<MemoryMediaCarousel assets={manyAssets} cacheVersion="v1" />);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(
        expect.arrayContaining(manyAssets.map((a) => a.object_key)),
        'v1',
        expect.anything(),
      );
    });
  });

  describe('preview placeholder on the detail screen (performance plan C6)', () => {
    const photo = {
      ...assets[0],
      preview_object_key: 'user/memory/media/photo-1-preview.jpg',
    };
    const PREVIEW_URL = 'https://example.com/photo-1-preview.jpg';
    const ORIGINAL_URL = 'https://example.com/photo-1.jpg';

    it('paints the cached preview instead of a spinner while the original URL is unsigned', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: { 'user/memory/media/photo-1-preview.jpg': PREVIEW_URL },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
      const { getByTestId, UNSAFE_queryByType } = render(
        <MemoryMediaCarousel assets={[photo]} cacheVersion="2026-07-01T00:00:00Z" />,
      );
      measureCarousel(getByTestId);

      expect(UNSAFE_queryByType(ActivityIndicator)).toBeNull();
      // Same cacheKey the timeline card pins this preview under:
      // `${previewKey}:${memory.updated_at}` -- an expo-image disk-cache hit.
      expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([{
        uri: PREVIEW_URL,
        cacheKey: 'user/memory/media/photo-1-preview.jpg:2026-07-01T00:00:00Z',
      }]);
    });

    it('upgrades to the original with the preview as placeholder, still cached on the original key', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: {
          'user/memory/media/photo-1.jpg': ORIGINAL_URL,
          'user/memory/media/photo-1-preview.jpg': PREVIEW_URL,
        },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
      const { getByTestId } = render(
        <MemoryMediaCarousel assets={[photo]} cacheVersion="v1" />,
      );
      measureCarousel(getByTestId);

      const image = getByTestId('memory-media-image-asset-1');
      expect(image.props.source).toEqual([
        { uri: ORIGINAL_URL, cacheKey: 'user/memory/media/photo-1.jpg:v1' },
      ]);
      expect(image.props.placeholder).toEqual([
        { uri: PREVIEW_URL, cacheKey: 'user/memory/media/photo-1-preview.jpg:v1' },
      ]);
      expect(image.props.transition).toEqual({ duration: 150 });
    });

    it('still shows the spinner when there is neither an original nor a preview URL yet', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: {},
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
      const { getByTestId, UNSAFE_queryByType } = render(<MemoryMediaCarousel assets={[photo]} />);
      measureCarousel(getByTestId);

      expect(UNSAFE_queryByType(ActivityIndicator)).not.toBeNull();
    });

    it('requests the preview alongside the original and seeds from the cache', () => {
      render(<MemoryMediaCarousel assets={[photo]} cacheVersion="v1" />);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(
        [photo.object_key, 'user/memory/media/photo-1-preview.jpg'],
        'v1',
        { seedFromCache: true },
      );
    });

    it('list surfaces (preferPreview) display the preview directly, with no placeholder', () => {
      mockedUseMediaUrls.mockReturnValue({
        data: { 'user/memory/media/photo-1-preview.jpg': PREVIEW_URL },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
      const { getByTestId } = render(
        <MemoryMediaCarousel assets={[photo]} cacheVersion="v1" preferPreview />,
      );
      measureCarousel(getByTestId);

      const image = getByTestId('memory-media-image-asset-1');
      expect(image.props.source).toEqual([
        { uri: PREVIEW_URL, cacheKey: 'user/memory/media/photo-1-preview.jpg:v1' },
      ]);
      expect(image.props.placeholder).toEqual([]);
      expect(mockedUseMediaUrls.mock.calls[0][0]).toEqual(['user/memory/media/photo-1-preview.jpg']);
    });

    it('never treats a video poster as a placeholder source', () => {
      const video = {
        ...assets[0],
        id: 'asset-video',
        object_key: 'user/memory/media/video-1.mp4',
        content_type: 'video/mp4',
        preview_object_key: 'user/memory/media/video-1-poster.jpg',
      };
      render(<MemoryMediaCarousel assets={[video]} />);

      // The poster is requested once (as the poster), not twice.
      expect(mockedUseMediaUrls.mock.calls[0][0]).toEqual([
        'user/memory/media/video-1.mp4',
        'user/memory/media/video-1-poster.jpg',
      ]);
    });
  });

  describe('isPlaybackDeferred (push-transition gating)', () => {
    const videoAsset = {
      ...assets[0],
      id: 'asset-video',
      object_key: 'user/memory/media/video-1.mp4',
      content_type: 'video/mp4',
    };

    beforeEach(() => {
      mockedUseMediaUrls.mockReturnValue({
        data: { 'user/memory/media/video-1.mp4': 'https://example.com/video-1.mp4' },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
      mockedUseVideoThumbnailResult.mockReturnValue({
        uri: 'file:///video-frame.jpg',
        width: 1280,
        height: 720,
      });
    });

    it('holds the player and play() back, keeping the poster (no play overlay), until released', () => {
      const { getByTestId, queryByTestId, rerender } = render(
        <MemoryMediaCarousel assets={[videoAsset]} isPlaybackDeferred />,
      );
      measureCarousel(getByTestId);

      expect(queryByTestId('memory-media-video')).toBeNull();
      expect(createVideoPlayer).not.toHaveBeenCalled();
      expect(mockVideoPlayer.play).not.toHaveBeenCalled();
      expect(getByTestId('memory-media-video-thumbnail-asset-video')).toBeTruthy();

      rerender(<MemoryMediaCarousel assets={[videoAsset]} isPlaybackDeferred={false} />);

      expect(getByTestId('memory-media-video')).toBeTruthy();
      expect(mockVideoPlayer.play).toHaveBeenCalled();
    });
  });
});
