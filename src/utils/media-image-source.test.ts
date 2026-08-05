import { mediaImageSource } from '@/utils/media-image-source';

describe('mediaImageSource', () => {
  it('passes the uri through unchanged with no cacheKey when no object key is given', () => {
    expect(mediaImageSource('https://signed.example/a.jpg')).toEqual({
      uri: 'https://signed.example/a.jpg',
    });
  });

  it('sets cacheKey to the object key when one is provided', () => {
    expect(mediaImageSource('https://signed.example/a.jpg', 'user-1/family-1/a.jpg')).toEqual({
      uri: 'https://signed.example/a.jpg',
      cacheKey: 'user-1/family-1/a.jpg',
    });
  });

  it('omits cacheKey when the object key is null', () => {
    expect(mediaImageSource('https://signed.example/a.jpg', null)).toEqual({
      uri: 'https://signed.example/a.jpg',
    });
  });

  it('omits cacheKey when the object key is undefined', () => {
    expect(mediaImageSource('https://signed.example/a.jpg', undefined)).toEqual({
      uri: 'https://signed.example/a.jpg',
    });
  });

  it('omits cacheKey when the object key is an empty string', () => {
    expect(mediaImageSource('https://signed.example/a.jpg', '')).toEqual({
      uri: 'https://signed.example/a.jpg',
    });
  });
});
