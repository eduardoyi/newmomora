import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

// A share token shape matching generateShareToken's output (22 base62
// chars) -- the exact length isn't load-bearing for these tests (the
// worker's own SHARE_TOKEN_PATTERN is looser, see resolve.test.ts), just
// realistic. MEMORY_ID is the internal `memories.id` a token resolves to --
// never appears in a URL any of these tests construct, since Round-19
// tokens replace raw memory ids in every client-facing route.
const VALID_TOKEN = 'aB3xQ9zK1mN7pR5tW2yC4d';
const MEMORY_ID = '0fbc1354-eaf7-552c-b659-78a0f751691e';

function makeEnv(mediaGet: ReturnType<typeof vi.fn> = vi.fn()): Env {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    MEDIA: { get: mediaGet },
  } as unknown as Env;
}

function supabaseOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The `media_share_tokens` lookup response for an ACTIVE token resolving
 * to `memoryId`. Always the FIRST fetch a token-keyed request makes. */
function activeTokenRow(memoryId = MEMORY_ID): Response {
  return supabaseOk([{ memory_id: memoryId, revoked_at: null }]);
}

/** The `media_share_tokens` lookup response for a REVOKED token. */
function revokedTokenRow(memoryId = MEMORY_ID): Response {
  return supabaseOk([{ memory_id: memoryId, revoked_at: '2026-08-01T00:00:00.000Z' }]);
}

describe('memory-viewer routing', () => {
  it('responds to /health without touching Supabase or R2', async () => {
    const response = await worker.fetch(new Request('https://m.usemomora.com/health'), makeEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('404s an unrecognized path', async () => {
    const response = await worker.fetch(new Request('https://m.usemomora.com/nope'), makeEnv());
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('Momora');
  });

  it('404s a malformed share token without calling Supabase', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await worker.fetch(new Request('https://m.usemomora.com/m/short'), makeEnv());
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('404s a well-formed token that was never minted (no media_share_tokens row)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(supabaseOk([])));
    const response = await worker.fetch(new Request(`https://m.usemomora.com/m/${VALID_TOKEN}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('shows the distinct "link no longer active" page for a revoked token, as 410', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(revokedTokenRow()));
    const response = await worker.fetch(new Request(`https://m.usemomora.com/m/${VALID_TOKEN}`), makeEnv());
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(body).toContain('no longer active');
    expect(body).not.toContain("isn&rsquo;t available");
    vi.unstubAllGlobals();
  });

  it('404s a text-only memory (no media asset to show) even with an active token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(activeTokenRow())
        .mockResolvedValueOnce(
          supabaseOk([{ id: MEMORY_ID, memory_type: 'text_only', memory_date: null, content: 'hi' }]),
        )
        .mockResolvedValueOnce(supabaseOk([])),
    );
    const response = await worker.fetch(new Request(`https://m.usemomora.com/m/${VALID_TOKEN}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('renders the viewer page for a resolvable media memory, pointing /media/ at the SAME token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(activeTokenRow())
        .mockResolvedValueOnce(
          supabaseOk([{ id: MEMORY_ID, memory_type: 'media', memory_date: '2026-06-01', content: 'Pool day' }]),
        )
        .mockResolvedValueOnce(
          supabaseOk([
            {
              object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
              content_type: 'video/mp4',
              duration_ms: 9000,
              preview_object_key: null,
            },
          ]),
        ),
    );
    const response = await worker.fetch(new Request(`https://m.usemomora.com/m/${VALID_TOKEN}`), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain(`<video class="media" src="/media/${VALID_TOKEN}"`);
    expect(body).not.toContain(MEMORY_ID); // the underlying memory id never reaches the client.
    expect(body).toContain('Pool day');
    vi.unstubAllGlobals();
  });

  it('maps a Supabase failure to the friendly 404, not a 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const response = await worker.fetch(new Request(`https://m.usemomora.com/m/${VALID_TOKEN}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });
});

describe('/media/:token streaming', () => {
  function stubResolvableMemory() {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(activeTokenRow())
        .mockResolvedValueOnce(
          supabaseOk([{ id: MEMORY_ID, memory_type: 'media', memory_date: '2026-06-01', content: null }]),
        )
        .mockResolvedValueOnce(
          supabaseOk([
            {
              object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
              content_type: 'video/mp4',
              duration_ms: 9000,
              preview_object_key: null,
            },
          ]),
        ),
    );
  }

  it('streams the full object with a 200 when no Range header is sent', async () => {
    stubResolvableMemory();
    const body = new ReadableStream();
    const mediaGet = vi.fn().mockResolvedValue({
      body,
      size: 5000,
      httpEtag: '"abc"',
      writeHttpMetadata: vi.fn(),
    });
    const response = await worker.fetch(new Request(`https://m.usemomora.com/media/${VALID_TOKEN}`), makeEnv(mediaGet));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('5000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(mediaGet).toHaveBeenCalledWith('user-1/memories/mem-1/media/asset-1.mp4');
    vi.unstubAllGlobals();
  });

  it('serves a 206 with Content-Range when R2 honors a Range request', async () => {
    stubResolvableMemory();
    const body = new ReadableStream();
    const mediaGet = vi.fn().mockResolvedValue({
      body,
      size: 5000,
      httpEtag: '"abc"',
      range: { offset: 1000, length: 500 },
      writeHttpMetadata: vi.fn(),
    });
    const response = await worker.fetch(
      new Request(`https://m.usemomora.com/media/${VALID_TOKEN}`, { headers: { Range: 'bytes=1000-1499' } }),
      makeEnv(mediaGet),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1000-1499/5000');
    expect(response.headers.get('content-length')).toBe('500');
    expect(mediaGet).toHaveBeenCalledWith('user-1/memories/mem-1/media/asset-1.mp4', {
      range: { offset: 1000, length: 500 },
    });
    vi.unstubAllGlobals();
  });

  it('404s when the DB row resolves but the R2 object is missing', async () => {
    stubResolvableMemory();
    const mediaGet = vi.fn().mockResolvedValue(null);
    const response = await worker.fetch(new Request(`https://m.usemomora.com/media/${VALID_TOKEN}`), makeEnv(mediaGet));
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('never touches R2 for an unknown token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(supabaseOk([])));
    const mediaGet = vi.fn();
    const response = await worker.fetch(new Request(`https://m.usemomora.com/media/${VALID_TOKEN}`), makeEnv(mediaGet));
    expect(response.status).toBe(404);
    expect(mediaGet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('410s and never touches R2 for a revoked token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(revokedTokenRow()));
    const mediaGet = vi.fn();
    const response = await worker.fetch(new Request(`https://m.usemomora.com/media/${VALID_TOKEN}`), makeEnv(mediaGet));
    expect(response.status).toBe(410);
    expect(mediaGet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
