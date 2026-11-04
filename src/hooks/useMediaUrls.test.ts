import { renderHook } from '@testing-library/react-native';

import { mediaUrlsQueryOptions, useMediaUrl, useMediaUrls } from '@/hooks/useMediaUrls';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));

const mockQueryClient = { getQueryCache: () => ({ findAll: jest.fn(() => mockCachedQueries) }) };
let mockCachedQueries: unknown[] = [];

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
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
    renderHook(() => useMediaUrl('user-1/memories/memory-1/illustration.webp', '2026-05-28T12:00:00Z'));
    renderHook(() => useMediaUrl('user-1/memories/memory-1/illustration.webp', '2026-05-28T12:05:00Z'));

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
    renderHook(() => useMediaUrl('user-1/portrait.webp', 'version-1'));

    const placeholderData = useQuery.mock.calls[0][0].placeholderData;
    const previousData = { 'user-1/portrait.webp': 'https://signed.example/old' };
    expect(placeholderData(previousData)).toBe(previousData);
  });

  it('sets gcTime above staleTime and below the R2 signed-URL 60min expiry (Workstream C7)', () => {
    renderHook(() => useMediaUrl('user-1/portrait.webp', 'version-1'));

    const { staleTime, gcTime } = useQuery.mock.calls[0][0];
    expect(staleTime).toBe(50 * 60 * 1000);
    expect(gcTime).toBe(55 * 60 * 1000);
    expect(gcTime).toBeGreaterThan(staleTime);
    expect(gcTime).toBeLessThan(60 * 60 * 1000);
  });

  it('shares the hook query key and freshness options with imperative callers', () => {
    const options = mediaUrlsQueryOptions(
      ['user-1/photo-preview.jpg', 'user-1/photo.jpg'],
      'memory-version-1',
    );

    renderHook(() => useMediaUrls(['user-1/photo.jpg', 'user-1/photo-preview.jpg'], 'memory-version-1'));
    const hookOptions = useQuery.mock.calls[0][0];

    expect(options.queryKey).toEqual([
      'media-urls',
      'user-1/photo-preview.jpg|user-1/photo.jpg',
      'memory-version-1',
    ]);
    expect(hookOptions.queryKey).toEqual(options.queryKey);
    expect(hookOptions.staleTime).toBe(options.staleTime);
    expect(hookOptions.gcTime).toBe(options.gcTime);
  });
});

describe('useMediaUrls seedFromCache', () => {
  beforeEach(() => {
    useQuery.mockClear();
    mockCachedQueries = [
      {
        state: {
          data: { 'user-1/photo-preview.jpg': 'https://signed.example/preview' },
          dataUpdatedAt: Date.now(),
        },
      },
    ];
  });

  afterEach(() => {
    mockCachedQueries = [];
  });

  it('seeds placeholder data with fresh URLs another query already signed', () => {
    renderHook(() => useMediaUrls(['user-1/photo.jpg', 'user-1/photo-preview.jpg'], 'v1', { seedFromCache: true }));

    const placeholderData = useQuery.mock.calls[0][0].placeholderData;
    expect(placeholderData(undefined)).toEqual({
      'user-1/photo-preview.jpg': 'https://signed.example/preview',
    });
  });

  it('prefers the previous data over the seed', () => {
    renderHook(() => useMediaUrls(['user-1/photo-preview.jpg'], 'v1', { seedFromCache: true }));

    const previous = { 'user-1/photo-preview.jpg': 'https://signed.example/previous' };
    expect(useQuery.mock.calls[0][0].placeholderData(previous)).toBe(previous);
  });

  it('seeds nothing when no key is cached', () => {
    renderHook(() => useMediaUrls(['user-1/other.jpg'], 'v1', { seedFromCache: true }));

    expect(useQuery.mock.calls[0][0].placeholderData(undefined)).toBeUndefined();
  });

  it('is opt-in: other callers never see partial placeholder data', () => {
    renderHook(() => useMediaUrls(['user-1/photo-preview.jpg'], 'v1'));

    expect(useQuery.mock.calls[0][0].placeholderData(undefined)).toBeUndefined();
  });
});
