import { renderHook, waitFor } from '@testing-library/react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';

import {
  clearVideoThumbnailCache,
  useAttachmentPreviewUri,
  useVideoThumbnail,
  useVideoThumbnailResult,
} from '@/hooks/useVideoThumbnail';

jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: jest.fn(),
}));

const mockedGetThumbnailAsync = VideoThumbnails.getThumbnailAsync as jest.MockedFunction<
  typeof VideoThumbnails.getThumbnailAsync
>;

describe('useVideoThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearVideoThumbnailCache();
  });

  it('preserves transformed thumbnail dimensions for video aspect-ratio measurement', async () => {
    mockedGetThumbnailAsync.mockResolvedValue({
      uri: 'file:///portrait-frame.jpg',
      width: 1080,
      height: 1920,
    });

    const { result } = renderHook(() => useVideoThumbnailResult('https://example.com/video.mp4'));

    await waitFor(() => {
      expect(result.current).toEqual({
        uri: 'file:///portrait-frame.jpg',
        width: 1080,
        height: 1920,
      });
    });
    expect(mockedGetThumbnailAsync).toHaveBeenCalledWith(
      'https://example.com/video.mp4',
      { time: 0 },
    );
  });

  it('keeps the existing URI-only API for thumbnail previews', async () => {
    mockedGetThumbnailAsync.mockResolvedValue({
      uri: 'file:///frame.jpg',
      width: 1280,
      height: 720,
    });

    const { result } = renderHook(() => useVideoThumbnail('https://example.com/video.mp4'));

    await waitFor(() => expect(result.current).toBe('file:///frame.jpg'));
  });

  it('reuses a generated thumbnail after the component remounts', async () => {
    mockedGetThumbnailAsync.mockResolvedValue({
      uri: 'file:///cached-frame.jpg',
      width: 1280,
      height: 720,
    });

    const first = renderHook(() =>
      useVideoThumbnailResult('https://example.com/signed-video.mp4', 'video-object-key'),
    );
    await waitFor(() => expect(first.result.current?.uri).toBe('file:///cached-frame.jpg'));
    first.unmount();

    const second = renderHook(() =>
      useVideoThumbnailResult('https://example.com/new-signed-video.mp4', 'video-object-key'),
    );

    expect(second.result.current?.uri).toBe('file:///cached-frame.jpg');
    expect(mockedGetThumbnailAsync).toHaveBeenCalledTimes(1);
  });
});

describe('useAttachmentPreviewUri', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearVideoThumbnailCache();
  });

  it('passes a photo URI straight through without generating anything', () => {
    const { result } = renderHook(() => useAttachmentPreviewUri('file:///photo.jpg', 'image/jpeg'));

    expect(result.current).toEqual({ isVideo: false, previewUri: 'file:///photo.jpg' });
    expect(mockedGetThumbnailAsync).not.toHaveBeenCalled();
  });

  it('swaps a video URI for its generated first frame (null until it is ready)', async () => {
    mockedGetThumbnailAsync.mockResolvedValue({ uri: 'file:///frame.jpg', width: 1920, height: 1080 });

    const { result } = renderHook(() => useAttachmentPreviewUri('file:///clip.mov', 'video/quicktime'));

    expect(result.current).toEqual({ isVideo: true, previewUri: null });
    await waitFor(() => {
      expect(result.current).toEqual({ isVideo: true, previewUri: 'file:///frame.jpg' });
    });
  });

  it('returns no preview when there is no attachment', () => {
    const { result } = renderHook(() => useAttachmentPreviewUri(undefined, undefined));

    expect(result.current).toEqual({ isVideo: false, previewUri: null });
  });
});
