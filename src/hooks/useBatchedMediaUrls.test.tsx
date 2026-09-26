import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { readCachedMediaUrls, useBatchedMediaUrls } from '@/hooks/useMediaUrls';
import { getMediaUrls } from '@/services/media';

jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(),
}));

const mockedGetMediaUrls = getMediaUrls as jest.MockedFunction<typeof getMediaUrls>;

function signAll(keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, `https://signed.example/${key}`]));
}

// Every client a test creates, cleared afterwards so the queries' 55min
// gcTime timers don't keep the Jest worker alive.
const clients: QueryClient[] = [];
function newClient(config?: ConstructorParameters<typeof QueryClient>[0]) {
  const client = new QueryClient(config);
  clients.push(client);
  return client;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
});

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('readCachedMediaUrls', () => {
  it('finds fresh URLs across any media-urls grouping and skips stale ones', () => {
    const queryClient = newClient();
    const now = Date.now();
    queryClient.setQueryData(['media-urls', 'a', ''], { a: 'https://signed.example/a' }, { updatedAt: now });
    queryClient.setQueryData(
      ['media-urls', 'b|c', 'v1'],
      { b: 'https://signed.example/b', c: 'https://signed.example/c' },
      { updatedAt: now },
    );
    queryClient.setQueryData(
      ['media-urls', 'd', ''],
      { d: 'https://signed.example/d' },
      { updatedAt: now - 51 * 60 * 1000 },
    );

    expect(readCachedMediaUrls(queryClient, ['a', 'c', 'd', 'e'], now)).toEqual({
      a: 'https://signed.example/a',
      c: 'https://signed.example/c',
    });
  });
});

describe('useBatchedMediaUrls', () => {
  beforeEach(() => {
    mockedGetMediaUrls.mockReset();
    mockedGetMediaUrls.mockImplementation(async (keys: string[]) => ({
      data: { urls: signAll(keys), expiresIn: 3600 },
      error: null,
    }));
  });

  it('reuses cached URLs and signs only the rest in one request', async () => {
    const queryClient = newClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['media-urls', 'cached', ''], { cached: 'https://signed.example/cached' });

    const { result } = renderHook(() => useBatchedMediaUrls(['cached', 'x', 'y', 'x']), {
      wrapper: makeWrapper(queryClient),
    });

    expect(result.current.cached).toBe('https://signed.example/cached');
    await waitFor(() => expect(result.current.y).toBeDefined());
    expect(mockedGetMediaUrls).toHaveBeenCalledTimes(1);
    expect(mockedGetMediaUrls).toHaveBeenCalledWith(['x', 'y']);
    expect(result.current).toEqual(signAll(['cached', 'x', 'y']));
  });

  it('splits more than 50 uncached keys into get-media-url sized batches', async () => {
    const queryClient = newClient({ defaultOptions: { queries: { retry: false } } });
    const keys = Array.from({ length: 60 }, (_, i) => `key-${String(i).padStart(2, '0')}`);

    const { result } = renderHook(() => useBatchedMediaUrls(keys), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(60));
    expect(mockedGetMediaUrls).toHaveBeenCalledTimes(2);
    expect(mockedGetMediaUrls.mock.calls[0][0]).toHaveLength(50);
    expect(mockedGetMediaUrls.mock.calls[1][0]).toHaveLength(10);
  });

  it('makes no request when there are no keys', () => {
    const queryClient = newClient();
    const { result } = renderHook(() => useBatchedMediaUrls([]), { wrapper: makeWrapper(queryClient) });

    expect(result.current).toEqual({});
    expect(mockedGetMediaUrls).not.toHaveBeenCalled();
  });
});
