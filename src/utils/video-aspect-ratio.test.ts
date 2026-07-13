import * as VideoThumbnails from 'expo-video-thumbnails';

import { getVideoAspectRatio } from '@/utils/video-aspect-ratio';

jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: jest.fn(),
}));

const mockedGetThumbnailAsync = VideoThumbnails.getThumbnailAsync as jest.MockedFunction<
  typeof VideoThumbnails.getThumbnailAsync
>;

describe('getVideoAspectRatio', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses transformed thumbnail dimensions for rotated portrait video', async () => {
    mockedGetThumbnailAsync.mockResolvedValue({
      uri: 'file:///frame.jpg',
      width: 1080,
      height: 1920,
    });

    await expect(getVideoAspectRatio('file:///clip.mp4')).resolves.toBe(9 / 16);
  });

  it('returns null when a frame cannot be extracted', async () => {
    mockedGetThumbnailAsync.mockRejectedValue(new Error('unsupported'));

    await expect(getVideoAspectRatio('file:///clip.mov')).resolves.toBeNull();
  });
});
