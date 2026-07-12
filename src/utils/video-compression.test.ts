import { Video } from 'react-native-compressor';

import {
  compressVideoForUpload,
  VIDEO_UPLOAD_MAX_DIMENSION,
} from '@/utils/video-compression';

const mockedCompress = Video.compress as jest.MockedFunction<typeof Video.compress>;

describe('compressVideoForUpload', () => {
  beforeEach(() => {
    mockedCompress.mockReset();
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
  });

  it('falls back to the original file when compression fails', async () => {
    mockedCompress.mockRejectedValue(new Error('codec unavailable'));

    const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };
    const result = await compressVideoForUpload(media);

    expect(result).toEqual(media);
  });

  it('falls back to the original file when compression returns nothing', async () => {
    mockedCompress.mockResolvedValue('');

    const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };
    const result = await compressVideoForUpload(media);

    expect(result).toEqual(media);
  });
});
