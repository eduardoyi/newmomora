import { composeShareCard, SHARE_CARD_RETRYABLE_STATUS } from './share-card';

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
