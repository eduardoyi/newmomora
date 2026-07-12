import { renderHook, waitFor } from '@testing-library/react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { useVideoThumbnail, useVideoThumbnailResult } from '@/hooks/useVideoThumbnail';

jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: jest.fn(),
}));

const mockedGetThumbnailAsync = VideoThumbnails.getThumbnailAsync as jest.MockedFunction<
  typeof VideoThumbnails.getThumbnailAsync
>;

describe('useVideoThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
