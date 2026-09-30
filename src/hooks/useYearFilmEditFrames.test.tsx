import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useYearFilmEditFrames } from '@/hooks/useYearFilmEditFrames';
import { fetchMemoriesByIds } from '@/services/memories';

jest.mock('@/services/memories', () => ({
  LOOKING_BACK_MEMORY_FETCH_LIMIT: 40,
  fetchMemoriesByIds: jest.fn(),
}));
const mockSafety = { isLoading: false, isError: false, reported: new Set<string>() };
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: mockSafety.isLoading,
    isError: mockSafety.isError,
    isTargetReported: (type: string, id: string | null | undefined) => mockSafety.reported.has(`${type}:${id}`),
  }),
}));
jest.mock('@/hooks/useMediaUrls', () => ({
  useBatchedMediaUrls: (keys: string[]) => Object.fromEntries(keys.map((key) => [key, `https://r2/${key}`])),
}));

const mockedFetch = fetchMemoriesByIds as jest.MockedFunction<typeof fetchMemoriesByIds>;

const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(async () => {
  await Promise.all(clients.map((client) => waitFor(() => expect(client.isFetching()).toBe(0))));
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  clients.splice(0).forEach((client) => client.clear());
});

function memory(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    memory_type: 'media',
    media_content_type: 'image/jpeg',
    media_key: null,
    illustration_key: null,
    illustration_generation_id: null,
    emotion: 'joy',
    mediaAssets: [{ content_type: 'image/jpeg', object_key: `orig/${id}`, preview_object_key: `preview/${id}` }],
    ...overrides,
  } as never;
}

describe('useYearFilmEditFrames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafety.isLoading = false;
    mockSafety.isError = false;
    mockSafety.reported = new Set();
  });

  it('picks the illustration or the photo preview and signs the keys', async () => {
    mockedFetch.mockResolvedValue({
      data: [memory('a'), memory('b', { memory_type: 'text_illustration', illustration_key: 'ill/b', mediaAssets: [] })],
      error: null,
    });

    const { result } = renderHook(() => useYearFilmEditFrames('family-1', ['a', 'b']), { wrapper });

    await waitFor(() => expect(result.current.resolve('a').key).toBe('preview/a'));
    expect(result.current.resolve('a').url).toBe('https://r2/preview/a');
    expect(result.current.resolve('b')).toMatchObject({ key: 'ill/b', url: 'https://r2/ill/b' });
    expect(mockedFetch).toHaveBeenCalledWith('family-1', ['a', 'b']);
  });

  it('loads in chunks of 40 memories', async () => {
    const ids = Array.from({ length: 85 }, (_, i) => `m-${String(i).padStart(3, '0')}`);
    mockedFetch.mockImplementation(async (_family, chunk) => ({ data: chunk.map((id) => memory(id)), error: null }));

    const { result } = renderHook(() => useYearFilmEditFrames('family-1', ids), { wrapper });

    await waitFor(() => expect(result.current.resolve('m-084').key).toBe('preview/m-084'));
    expect(mockedFetch.mock.calls.map(([, chunk]) => chunk.length)).toEqual([40, 40, 5]);
  });

  it('draws nothing for a reported memory and falls back for a missing one', async () => {
    mockSafety.reported = new Set(['memory:a']);
    mockedFetch.mockResolvedValue({ data: [memory('a')], error: null });

    const { result } = renderHook(() => useYearFilmEditFrames('family-1', ['a', 'gone']), { wrapper });

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.resolve('a')).toMatchObject({ key: null, fallback: 'blank' });
    expect(result.current.resolve('gone')).toMatchObject({ key: null, fallback: 'blank' });
  });

  it('shows no image until the viewer reports have loaded', async () => {
    mockSafety.isLoading = true;
    mockedFetch.mockResolvedValue({ data: [memory('a')], error: null });

    const { result } = renderHook(() => useYearFilmEditFrames('family-1', ['a']), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.resolve('a').key).toBeNull();
  });

  it('does not fetch without a family or memories', () => {
    renderHook(() => useYearFilmEditFrames(null, ['a']), { wrapper });
    renderHook(() => useYearFilmEditFrames('family-1', []), { wrapper });

    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
