import { useMediaUrl } from '@/hooks/useMediaUrls';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn((options: { queryKey: unknown[]; placeholderData?: (previousData: unknown) => unknown }) => ({
    data: undefined,
    isLoading: false,
    isError: false,
    queryKey: options.queryKey,
  })),
}));

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

  it('keeps the previous signed URL visible while a refreshed one loads', () => {
    useMediaUrl('user-1/portrait.webp', 'version-1');

    const placeholderData = useQuery.mock.calls[0][0].placeholderData;
    const previousData = { 'user-1/portrait.webp': 'https://signed.example/old' };
    expect(placeholderData(previousData)).toBe(previousData);
  });
});
