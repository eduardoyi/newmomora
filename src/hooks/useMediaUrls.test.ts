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

  it('sets gcTime above staleTime and below the R2 signed-URL 60min expiry (Workstream C7)', () => {
    useMediaUrl('user-1/portrait.webp', 'version-1');

    const { staleTime, gcTime } = useQuery.mock.calls[0][0];
    expect(staleTime).toBe(50 * 60 * 1000);
    expect(gcTime).toBe(55 * 60 * 1000);
    expect(gcTime).toBeGreaterThan(staleTime);
    expect(gcTime).toBeLessThan(60 * 60 * 1000);
  });
});
