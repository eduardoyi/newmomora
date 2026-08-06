import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';
import { getMediaUrls, resetMediaUrlBatcherForTests, uploadMediaObject, uploadToPresignedUrl } from '@/services/media';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
    functions: {
      invoke: jest.fn(),
    },
  },
}));

const mockedInvoke = supabase.functions.invoke as jest.MockedFunction<typeof supabase.functions.invoke>;

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: {
    BINARY_CONTENT: 0,
  },
}));

const mockedUploadAsync = FileSystem.uploadAsync as jest.MockedFunction<
  typeof FileSystem.uploadAsync
>;
const mockedGetSession = supabase.auth.getSession as jest.MockedFunction<
  typeof supabase.auth.getSession
>;

describe('uploadToPresignedUrl', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('uploads via FileSystem on native and returns null on success', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 200,
      body: '',
      headers: {},
    });

    const result = await uploadToPresignedUrl(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      'image/jpeg',
    );

    expect(result.error).toBeNull();
    expect(mockedUploadAsync).toHaveBeenCalledWith(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      expect.objectContaining({
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
  });

  it('returns an error when native upload fails', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 403,
      body: 'Forbidden',
      headers: {},
    });

    const result = await uploadToPresignedUrl(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      'image/jpeg',
    );

    expect(result.error).toEqual({
      message: 'Photo upload failed',
      code: '403',
    });
  });
});

describe('uploadMediaObject', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    mockedGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'session-token',
        },
      },
      error: null,
    } as never);
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('uploads native files through the Supabase upload-media function', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ objectKey: 'user-1/memories/memory-1/media/asset.jpg', success: true }),
      headers: {},
    });

    const result = await uploadMediaObject(
      'user-1/memories/memory-1/media/asset.jpg',
      'file:///tmp/photo.jpg',
      'image/jpeg',
      'family-1',
    );

    expect(result.error).toBeNull();
    expect(mockedUploadAsync).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/upload-media',
      'file:///tmp/photo.jpg',
      expect.objectContaining({
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
          'Content-Type': 'image/jpeg',
          'x-object-key': 'user-1/memories/memory-1/media/asset.jpg',
          'x-family-id': 'family-1',
        }),
      }),
    );
  });

  it('returns the upload-media error response for native failures', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: 'Invalid object key', code: 'validation_error' }),
      headers: {},
    });

    const result = await uploadMediaObject(
      'bad-key',
      'file:///tmp/photo.jpg',
      'image/jpeg',
      'family-1',
    );

    expect(result.error).toEqual({
      message: 'Invalid object key',
      code: 'validation_error',
    });
  });
});

describe('getMediaUrls batching', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetMediaUrlBatcherForTests();
    jest.clearAllMocks();
  });

  it('coalesces concurrent calls made within the batch window into one invocation', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockResolvedValue({
      data: {
        urls: { 'key-a': 'https://example.com/a', 'key-b': 'https://example.com/b' },
        expiresIn: 300,
      },
      error: null,
    } as never);

    const callA = getMediaUrls(['key-a']);
    const callB = getMediaUrls(['key-b', 'key-a']);

    await jest.advanceTimersByTimeAsync(25);
    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    const requestedKeys = mockedInvoke.mock.calls[0][1]?.body.keys as string[];
    expect(new Set(requestedKeys)).toEqual(new Set(['key-a', 'key-b']));
    expect(requestedKeys).toHaveLength(2);

    expect(resultA.error).toBeNull();
    expect(resultA.data?.urls['key-a']).toBe('https://example.com/a');
    expect(resultB.error).toBeNull();
    expect(resultB.data?.urls['key-b']).toBe('https://example.com/b');
    expect(resultB.data?.urls['key-a']).toBe('https://example.com/a');
  });

  it('splits more than 50 merged keys across multiple invocations and combines results for a spanning caller', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockImplementation(async (_name, options) => {
      const requestedKeys = (options as { body: { keys: string[] } }).body.keys;
      const urls: Record<string, string> = {};
      for (const key of requestedKeys) {
        urls[key] = `https://example.com/${key}`;
      }
      return { data: { urls, expiresIn: 300 }, error: null } as never;
    });

    const keysA = Array.from({ length: 30 }, (_, i) => `a-${i}`);
    const keysB = Array.from({ length: 30 }, (_, i) => `b-${i}`);

    const callA = getMediaUrls(keysA);
    const callB = getMediaUrls(keysB);

    await jest.advanceTimersByTimeAsync(25);
    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(mockedInvoke.mock.calls[0][1]?.body.keys).toHaveLength(50);
    expect(mockedInvoke.mock.calls[1][1]?.body.keys).toHaveLength(10);

    expect(resultA.error).toBeNull();
    expect(resultA.data?.urls['a-0']).toBe('https://example.com/a-0');
    expect(resultA.data?.urls['a-29']).toBe('https://example.com/a-29');

    // caller B's 30 keys straddle both chunks -- its result must combine them.
    expect(resultB.error).toBeNull();
    expect(resultB.data?.urls['b-0']).toBe('https://example.com/b-0');
    expect(resultB.data?.urls['b-29']).toBe('https://example.com/b-29');
  });

  it('propagates a failed invoke as { data: null, error } to the callers whose keys were in that batch', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'boom', context: { status: 500 } },
    } as never);

    const call = getMediaUrls(['key-a']);

    await jest.advanceTimersByTimeAsync(25);
    const result = await call;

    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'boom', code: '500' });
  });

  it('settles every pending caller with an error when the invoke itself throws unexpectedly', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockRejectedValue(new Error('boom'));

    const callA = getMediaUrls(['key-a']);
    const callB = getMediaUrls(['key-b']);

    await jest.advanceTimersByTimeAsync(25);
    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual({ data: null, error: { message: 'boom' } });
    expect(resultB).toEqual({ data: null, error: { message: 'boom' } });
  });

  it('does not merge sequential calls made outside the batch window', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockResolvedValueOnce({
      data: { urls: { 'key-a': 'https://example.com/a' }, expiresIn: 300 },
      error: null,
    } as never);

    const call1 = getMediaUrls(['key-a']);
    await jest.advanceTimersByTimeAsync(25);
    await call1;

    mockedInvoke.mockResolvedValueOnce({
      data: { urls: { 'key-b': 'https://example.com/b' }, expiresIn: 300 },
      error: null,
    } as never);

    const call2 = getMediaUrls(['key-b']);
    await jest.advanceTimersByTimeAsync(25);
    await call2;

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(mockedInvoke.mock.calls[0][1]?.body.keys).toEqual(['key-a']);
    expect(mockedInvoke.mock.calls[1][1]?.body.keys).toEqual(['key-b']);
  });

  // Bug A mechanism #1 (production gray-box incident, docs/plans/...):
  // get-media-url (supabase/functions/get-media-url/index.ts) OMITS -- not
  // errors -- a key it can't yet resolve/authorize/see-as-referenced,
  // returning 200 success with that key simply missing from `urls`. A key
  // requested the instant after its owning row commits (a fresh
  // memory_media row, or a memory's illustration_key just having been set)
  // can lose that visibility race and come back omitted even though the
  // row/key is genuinely fine a moment later. Before this fix, that omitted
  // result was cached as an unqualified SUCCESS by useMediaUrls' 50-minute
  // staleTime with no retry -- a real gray box until app restart cleared
  // the react-query cache. The fix retries the OMITTED SUBSET a bounded
  // number of times with a short backoff before resolving the caller, so a
  // key that only lost a brief visibility race is very likely present by
  // the time getMediaUrls actually resolves.
  it('retries an omitted key and resolves once a later attempt returns it (visibility race self-heals)', async () => {
    jest.useFakeTimers();
    mockedInvoke
      .mockResolvedValueOnce({
        data: { urls: { 'key-a': 'https://example.com/a' }, expiresIn: 300 },
        error: null,
      } as never)
      .mockResolvedValueOnce({
        data: { urls: { 'key-b': 'https://example.com/b' }, expiresIn: 300 },
        error: null,
      } as never);

    const call = getMediaUrls(['key-a', 'key-b']);
    await jest.advanceTimersByTimeAsync(25); // batch window flush -- initial invoke
    await jest.advanceTimersByTimeAsync(300); // first retry backoff
    const result = await call;

    expect(result.error).toBeNull();
    expect(result.data?.urls['key-a']).toBe('https://example.com/a');
    expect(result.data?.urls['key-b']).toBe('https://example.com/b');
    // First call requested both; the retry only re-requested the omitted one.
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(mockedInvoke.mock.calls[1][1]?.body.keys).toEqual(['key-b']);
  });

  it('stops retrying after a bounded number of attempts and resolves with the key still omitted (genuinely gone)', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockResolvedValue({
      data: { urls: {}, expiresIn: 300 },
      error: null,
    } as never);

    const call = getMediaUrls(['key-gone']);
    await jest.advanceTimersByTimeAsync(25); // batch window flush -- initial invoke
    await jest.advanceTimersByTimeAsync(300); // first retry backoff
    await jest.advanceTimersByTimeAsync(600); // second retry backoff
    const result = await call;

    expect(result.error).toBeNull();
    expect(result.data?.urls['key-gone']).toBeUndefined();
    // Bounded: the initial request plus a small, fixed number of retries --
    // not unbounded polling for a key that's genuinely never coming back.
    expect(mockedInvoke).toHaveBeenCalledTimes(3);
  });

  it('does not retry keys that were already present in the first response', async () => {
    jest.useFakeTimers();
    mockedInvoke.mockResolvedValue({
      data: { urls: { 'key-a': 'https://example.com/a' }, expiresIn: 300 },
      error: null,
    } as never);

    const call = getMediaUrls(['key-a']);
    await jest.advanceTimersByTimeAsync(25);
    await call;

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the empty-keys request un-batched', async () => {
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'keys must be a non-empty array', context: { status: 400 } },
    } as never);

    const result = await getMediaUrls([]);

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('get-media-url', { body: { keys: [] } });
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'keys must be a non-empty array', code: '400' });
  });
});
