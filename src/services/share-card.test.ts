import {
  composeShareCard,
  SHARE_CARD_RETRYABLE_STATUS,
  warmShareCardFireAndForget,
  warmShareCardForMemoryFireAndForget,
} from './share-card';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
  },
}));

const mockedSupabase = jest.requireMock('@/lib/supabase').supabase as {
  auth: { getSession: jest.Mock };
};

function response(
  body: unknown,
  { ok = true, status = ok ? 200 : 500, arrayBuffer }: { ok?: boolean; status?: number; arrayBuffer?: ArrayBuffer } = {},
): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    arrayBuffer: jest.fn().mockResolvedValue(arrayBuffer ?? new ArrayBuffer(0)),
  } as unknown as Response;
}

describe('composeShareCard', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-1' } },
      error: null,
    });
  });

  it('requires an authenticated session and never calls fetch without one', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(result).toEqual({
      ok: false,
      error: { message: 'You must be signed in to share memories', code: 'unauthorized' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs with the bearer token and apikey headers, returning the raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    fetchMock.mockResolvedValueOnce(response({}, { arrayBuffer: bytes }));

    const result = await composeShareCard({ memoryId: 'memory-1', mediaAssetId: 'asset-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/compose-share-card',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          apikey: 'test-anon-key',
        }),
        body: JSON.stringify({ memoryId: 'memory-1', mediaAssetId: 'asset-1' }),
      }),
    );
    expect(result).toEqual({ ok: true, bytes });
  });

  it('maps a non-retryable failure without a second attempt', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ error: 'Sharing is currently off for this family', code: 'sharing_disabled' }, { ok: false, status: 403 }),
    );

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: { message: 'Sharing is currently off for this family', code: 'sharing_disabled', status: 403 },
    });
  });

  // Production probe (docs/plans/share-card-store-through.md's four-part
  // fix): the user's "retry never works" report traced to cold rate-bucket
  // exhaustion, not a real failure -- a 429 retry would just burn the
  // bucket further. This is the single-attempt guarantee the auto-retry
  // must never violate: ONLY 546 (SHARE_CARD_RETRYABLE_STATUS) retries.
  it('does not retry on 429 (rate limited) -- a retry would only burn the bucket further', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        { error: 'Too many share requests -- try again in a moment', code: 'rate_limited' },
        { ok: false, status: 429 },
      ),
    );

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: { message: 'Too many share requests -- try again in a moment', code: 'rate_limited', status: 429 },
    });
  });

  it('retries exactly once on HTTP 546 and returns the retry success', async () => {
    const bytes = new Uint8Array([9, 9]).buffer;
    fetchMock
      .mockResolvedValueOnce(response({ error: 'resource exhausted' }, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
      .mockResolvedValueOnce(response({}, { arrayBuffer: bytes }));

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, bytes });
  });

  it('does not retry a third time when 546 repeats on the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
      .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }));

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(SHARE_CARD_RETRYABLE_STATUS);
    }
  });

  it('maps a thrown fetch failure to a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(result).toEqual({ ok: false, error: { message: 'Network request failed', code: 'network_error' } });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jest.fn().mockRejectedValue(new Error('not json')),
    } as unknown as Response);

    const result = await composeShareCard({ memoryId: 'memory-1' });

    expect(result).toEqual({
      ok: false,
      error: { message: 'Could not compose the share card', status: 500 },
    });
  });
});

// Flushes pending microtask queues so a fire-and-forget call's internal
// promise chain (never returned to the caller) has a chance to settle
// before assertions run.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('warmShareCardFireAndForget', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-1' } },
      error: null,
    });
  });

  it('never returns a promise -- callers can never await it', () => {
    fetchMock.mockResolvedValueOnce(response(null, { status: 204, ok: true }));

    const result = warmShareCardFireAndForget('memory-1');

    expect(result).toBeUndefined();
  });

  it('POSTs warm:true with the bearer token and apikey headers, and no mediaAssetId when omitted', async () => {
    fetchMock.mockResolvedValueOnce(response(null, { status: 204, ok: true }));

    warmShareCardFireAndForget('memory-1');
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/compose-share-card',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          apikey: 'test-anon-key',
        }),
        body: JSON.stringify({ memoryId: 'memory-1', mediaAssetId: undefined, warm: true }),
      }),
    );
  });

  it('includes mediaAssetId in the payload when provided', async () => {
    fetchMock.mockResolvedValueOnce(response(null, { status: 204, ok: true }));

    warmShareCardFireAndForget('memory-1', 'asset-1');
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ memoryId: 'memory-1', mediaAssetId: 'asset-1', warm: true }),
      }),
    );
  });

  // ── Self-healing retry (docs/plans/share-card-store-through.md's
  // four-part production fix, Part 3): warm now retries internally on 546
  // up to SHARE_CARD_WARM_MAX_ATTEMPTS total attempts with 4s/8s backoff,
  // but stops immediately on 429 (or any other non-546 outcome) -- a 429
  // retry would just burn the warm bucket further, the exact failure mode
  // this fix targets on the cold path too. Fake timers advance past the
  // real setTimeout backoff without the test actually waiting.
  describe('self-healing retry on 546', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retries up to 3 total attempts on repeated 546, backing off 4s then 8s, and succeeds on the 3rd', async () => {
      fetchMock
        .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
        .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
        .mockResolvedValueOnce(response(null, { status: 204, ok: true }));

      warmShareCardFireAndForget('memory-1');
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(4000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(8000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up silently (no throw escapes, one console.warn) after 3 total attempts all 546', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      fetchMock
        .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
        .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }))
        .mockResolvedValueOnce(response({}, { ok: false, status: SHARE_CARD_RETRYABLE_STATUS }));

      expect(() => warmShareCardFireAndForget('memory-1')).not.toThrow();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(4000);
      await jest.advanceTimersByTimeAsync(8000);
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      // No further backoff/attempt after the 3rd -- advancing well past the
      // next would-be backoff window must not fire a 4th request.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to warm share card cache',
        'memory-1',
        expect.stringContaining(String(SHARE_CARD_RETRYABLE_STATUS)),
      );
      warnSpy.mockRestore();
    });

    it('stops immediately on 429 -- never retries a rate-limited warm (retrying would burn the bucket further)', async () => {
      fetchMock.mockResolvedValueOnce(response({}, { ok: false, status: 429 }));

      warmShareCardFireAndForget('memory-1');
      await flushMicrotasks();
      // No pending timer should even exist -- advancing time must not
      // produce a second request.
      await jest.advanceTimersByTimeAsync(60_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('stops immediately (single request) on a non-retryable non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(response({}, { ok: false, status: 500 }));

    warmShareCardFireAndForget('memory-1');
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a non-2xx response to a console.warn, without throwing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(response({}, { ok: false, status: 500 }));

    expect(() => warmShareCardFireAndForget('memory-1')).not.toThrow();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to warm share card cache',
      'memory-1',
      expect.stringContaining('500'),
    );
    warnSpy.mockRestore();
  });

  it('swallows a thrown network error to a console.warn, without throwing or rejecting', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    expect(() => warmShareCardFireAndForget('memory-1')).not.toThrow();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith('Failed to warm share card cache', 'memory-1', 'offline');
    warnSpy.mockRestore();
  });

  it('silently skips the request (no fetch, no throw) when there is no session', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    expect(() => warmShareCardFireAndForget('memory-1')).not.toThrow();
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('warmShareCardForMemoryFireAndForget', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue(response(null, { status: 204, ok: true }));
    mockedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-1' } },
      error: null,
    });
  });

  it('warms the per-MEMORY card (no mediaAssetId) for a text_only memory', async () => {
    warmShareCardForMemoryFireAndForget({ id: 'memory-1', memory_type: 'text_only', mediaAssets: [] });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ memoryId: 'memory-1', mediaAssetId: undefined, warm: true }),
      }),
    );
  });

  it('warms the per-MEMORY card (no mediaAssetId) for a text_illustration memory', async () => {
    warmShareCardForMemoryFireAndForget({
      id: 'memory-2',
      memory_type: 'text_illustration',
      mediaAssets: [],
    });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ memoryId: 'memory-2', mediaAssetId: undefined, warm: true }),
      }),
    );
  });

  it('warms the position-0 cover asset (not the memory id alone) for a media memory', async () => {
    warmShareCardForMemoryFireAndForget({
      id: 'memory-3',
      memory_type: 'media',
      mediaAssets: [{ id: 'media-cover' }, { id: 'media-page-2' }],
    });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ memoryId: 'memory-3', mediaAssetId: 'media-cover', warm: true }),
      }),
    );
  });

  it('skips warming entirely for a media memory with no media assets', async () => {
    warmShareCardForMemoryFireAndForget({ id: 'memory-4', memory_type: 'media', mediaAssets: [] });
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
