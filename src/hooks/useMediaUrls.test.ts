jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn((options: { queryKey: unknown[] }) => ({
    data: undefined,
    isLoading: false,
    isError: false,
    queryKey: options.queryKey,
  })),
}));

import { useMediaUrl } from '@/hooks/useMediaUrls';

const { useQuery } = jest.requireMock('@tanstack/react-query') as {
  useQuery: jest.Mock;
};

describe('useMediaUrl', () => {
  beforeEach(() => {
    useQuery.mockClear();
  });

  it('includes cacheVersion in the media-url query key', () => {
    useMediaUrl('user-1/memories/memory-1/illustration.webp', '2026-05-28T12:00:00Z');
    useMediaUrl('user-1/memories/memory-1/illustration.webp', '2026-05-28T12:05:00Z');

    expect(useQuery.mock.calls[0][0].queryKey).toEqual([
      'media-urls',
      'user-1/memories/memory-1/illustration.webp',
      '2026-05-28T12:00:00Z',
    ]);
    expect(useQuery.mock.calls[1][0].queryKey).toEqual([
      'media-urls',
      'user-1/memories/memory-1/illustration.webp',
      '2026-05-28T12:05:00Z',
    ]);
  });
});
