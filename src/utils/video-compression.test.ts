import { Video } from 'react-native-compressor';

import { getLocalFileSizeBytes } from '@/utils/local-files';
import { MAX_VIDEO_BYTES } from '@/utils/media-validation';
import {
  compressVideoForUpload,
  VIDEO_COMPRESSION_TOO_LARGE_ERROR,
  VIDEO_UPLOAD_MAX_DIMENSION,
} from '@/utils/video-compression';

jest.mock('@/utils/local-files', () => ({
  getLocalFileSizeBytes: jest.fn(),
}));

const mockedCompress = Video.compress as jest.MockedFunction<typeof Video.compress>;
const mockedGetLocalFileSizeBytes = getLocalFileSizeBytes as jest.MockedFunction<
  typeof getLocalFileSizeBytes
>;

describe('compressVideoForUpload', () => {
  beforeEach(() => {
    mockedCompress.mockReset();
    mockedGetLocalFileSizeBytes.mockReset();
  });

  it('passes images through without compressing', async () => {
    const media = { fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' };

    const result = await compressVideoForUpload(media);

    expect(result).toEqual(media);
    expect(mockedCompress).not.toHaveBeenCalled();
  });

  it('transcodes videos to MP4 and returns the compressed file', async () => {
    mockedCompress.mockResolvedValue('file:///compressed.mp4');

    const result = await compressVideoForUpload({
      fileUri: 'file:///clip.mov',
      contentType: 'video/quicktime',
    });

    expect(mockedCompress).toHaveBeenCalledWith('file:///clip.mov', {
      compressionMethod: 'auto',
      maxSize: VIDEO_UPLOAD_MAX_DIMENSION,
    });
    expect(result).toEqual({
      fileUri: 'file:///compressed.mp4',
      contentType: 'video/mp4',
    });
    // Successful compression never needs to check the original's size.
    expect(mockedGetLocalFileSizeBytes).not.toHaveBeenCalled();
  });

  describe('fallback when compression fails or returns nothing', () => {
    it('falls back to the original file when it is within MAX_VIDEO_BYTES', async () => {
      mockedCompress.mockRejectedValue(new Error('codec unavailable'));
      mockedGetLocalFileSizeBytes.mockResolvedValue(MAX_VIDEO_BYTES);

      const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };
      const result = await compressVideoForUpload(media);

      expect(result).toEqual(media);
    });

    it('falls back to the original file when compression returns nothing and the original fits', async () => {
      mockedCompress.mockResolvedValue('');
      mockedGetLocalFileSizeBytes.mockResolvedValue(10 * 1024 * 1024);

      const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };
      const result = await compressVideoForUpload(media);

      expect(result).toEqual(media);
    });

    it('fails the asset when the original exceeds MAX_VIDEO_BYTES', async () => {
      mockedCompress.mockRejectedValue(new Error('codec unavailable'));
      mockedGetLocalFileSizeBytes.mockResolvedValue(MAX_VIDEO_BYTES + 1);

      const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };

      await expect(compressVideoForUpload(media)).rejects.toThrow(
        VIDEO_COMPRESSION_TOO_LARGE_ERROR,
      );
    });

    it('fails the asset when the original size cannot be determined', async () => {
      mockedCompress.mockResolvedValue('');
      mockedGetLocalFileSizeBytes.mockResolvedValue(null);

      const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };

      await expect(compressVideoForUpload(media)).rejects.toThrow(
        VIDEO_COMPRESSION_TOO_LARGE_ERROR,
      );
    });
  });
});
