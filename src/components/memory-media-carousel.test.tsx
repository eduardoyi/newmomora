import { fireEvent, render, type RenderResult } from '@testing-library/react-native';
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
      );
      expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([{
        uri: 'https://example.com/photo-1-preview.jpg',
        cacheKey: 'user/memory/media/photo-1-preview.jpg:',
      }]);
    });

    it('falls back to the original when preferPreview is true but the asset has no preview', () => {
      const { getByTestId } = render(<MemoryMediaCarousel assets={[assets[0]]} preferPreview />);

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(['user/memory/media/photo-1.jpg'], undefined);
      expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([{
        uri: 'https://example.com/photo-1.jpg',
        cacheKey: 'user/memory/media/photo-1.jpg:',
      }]);
    });

    it('ignores the preview key when preferPreview is false (default -- detail/full-screen)', () => {
      const { getByTestId } = render(<MemoryMediaCarousel assets={[assetWithPreview]} />);

      measureCarousel(getByTestId);

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(['user/memory/media/photo-1.jpg'], undefined);
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

      expect(mockedUseMediaUrls).toHaveBeenCalledWith(['user/memory/media/video-1.mp4'], undefined);
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
});
