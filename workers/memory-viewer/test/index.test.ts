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
          supabaseOk([
            { id: MEMORY_ID, memory_type: 'media', memory_date: '2026-06-01', content: 'Pool day', emotion: 'joy' },
          ]),
        )
        .mockResolvedValueOnce(
          supabaseOk([
            {
              object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
              content_type: 'video/mp4',
              duration_ms: 9000,
              preview_object_key: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
            },
          ]),
        ),
    );
    const mediaGet = vi.fn();
    const response = await worker.fetch(
      new Request(`https://hostile.example.invalid/m/${VALID_TOKEN}`),
      makeEnv(mediaGet),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain(`<video class="media" src="/media/${VALID_TOKEN}"`);
    expect(body).toContain(`https://m.usemomora.com/m/${VALID_TOKEN}`);
    expect(body).toContain(`https://m.usemomora.com/poster/${VALID_TOKEN}`);
    expect(body).not.toContain('hostile.example.invalid');
    expect(body).toContain('og:image:type" content="image/jpeg"');
    expect(body).not.toContain(MEMORY_ID); // the underlying memory id never reaches the client.
    expect(body).toContain('Pool day');
    // Rendering metadata must not HEAD/GET R2 just to decide if a preview
    // object is present; /poster resolves and reads it only when crawled.
    expect(mediaGet).not.toHaveBeenCalled();
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
    expect(response.headers.get('cache-control')).toBe('private, no-store');
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

describe('/poster/:token Open Graph images', () => {
  const VIDEO_KEY = 'user-1/memories/mem-1/media/video-1.mp4';
  const VIDEO_POSTER_KEY = 'user-1/memories/mem-1/media/video-1-preview.jpg';

  function readableBody(bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function stubResolvablePoster(assetRows: unknown[], memory: Record<string, unknown> = {}) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(activeTokenRow())
        .mockResolvedValueOnce(
          supabaseOk([
            {
              id: MEMORY_ID,
              memory_type: 'media',
              memory_date: '2026-06-01',
              content: 'A private pool day',
              emotion: 'joy',
              ...memory,
            },
          ]),
        )
        .mockResolvedValueOnce(supabaseOk(assetRows)),
    );
  }

  it('re-resolves the active token and streams the selected video’s JPEG preview with private no-store headers', async () => {
    // A carousel’s first asset can be a photo, but both `/m` and `/poster`
    // must choose its first VIDEO as the actual viewer asset.
    stubResolvablePoster([
      {
        object_key: 'user-1/memories/mem-1/media/photo-0.jpg',
        content_type: 'image/jpeg',
        duration_ms: null,
        preview_object_key: null,
      },
      {
        object_key: VIDEO_KEY,
        content_type: 'video/mp4',
        duration_ms: 9_000,
        preview_object_key: VIDEO_POSTER_KEY,
      },
    ]);
    const writeHttpMetadata = vi.fn();
    const mediaGet = vi.fn().mockResolvedValue({
      body: readableBody(),
      size: 4,
      httpEtag: '"poster"',
      writeHttpMetadata,
    });

    const response = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(mediaGet));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(mediaGet).toHaveBeenCalledWith(VIDEO_POSTER_KEY);
    // R2 metadata can include original filenames or cache directives. A
    // public poster response intentionally emits only its minimal headers.
    expect(writeHttpMetadata).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('streams a browser-compatible image original when it has no generated preview', async () => {
    const imageKey = 'user-1/memories/mem-1/media/photo-1.png';
    stubResolvablePoster([
      {
        object_key: imageKey,
        content_type: 'image/png',
        duration_ms: null,
        preview_object_key: null,
      },
    ]);
    const mediaGet = vi.fn().mockResolvedValue({
      body: readableBody(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      size: 4,
      httpEtag: '"photo"',
      writeHttpMetadata: vi.fn(),
    });

    const response = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(mediaGet));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(mediaGet).toHaveBeenCalledWith(imageKey);
    vi.unstubAllGlobals();
  });

  it('returns the bundled neutral JPEG for audio without reading R2', async () => {
    stubResolvablePoster(
      [
        {
          object_key: 'user-1/memories/mem-1/media/audio-1.m4a',
          content_type: 'audio/mp4',
          duration_ms: 4_200,
          preview_object_key: null,
        },
      ],
      { memory_type: 'audio' },
    );
    const mediaGet = vi.fn();

    const response = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(mediaGet));
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(mediaGet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls back to the bundled neutral JPEG when a selected real poster key is stale in R2', async () => {
    stubResolvablePoster([
      {
        object_key: VIDEO_KEY,
        content_type: 'video/mp4',
        duration_ms: 9_000,
        preview_object_key: VIDEO_POSTER_KEY,
      },
    ]);
    const mediaGet = vi.fn().mockResolvedValue(null);

    const response = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(mediaGet));
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = new TextDecoder().decode(bytes);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mediaGet).toHaveBeenCalledWith(VIDEO_POSTER_KEY);
    expect(decoded).not.toContain(MEMORY_ID);
    expect(decoded).not.toContain(VIDEO_POSTER_KEY);
    expect(bytes.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    vi.unstubAllGlobals();
  });

  it('does not access R2 for an unknown or revoked poster token', async () => {
    const unknownGet = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(supabaseOk([])));
    const unknown = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(unknownGet));
    expect(unknown.status).toBe(404);
    expect(unknownGet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const revokedGet = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(revokedTokenRow()));
    const revoked = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(revokedGet));
    expect(revoked.status).toBe(410);
    expect(revokedGet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maps an R2 poster read failure to the generic 404 without exposing the private key or memory id', async () => {
    stubResolvablePoster([
      {
        object_key: VIDEO_KEY,
        content_type: 'video/mp4',
        duration_ms: 9_000,
        preview_object_key: VIDEO_POSTER_KEY,
      },
    ]);
    const mediaGet = vi.fn().mockRejectedValue(new Error('R2 unavailable'));

    const response = await worker.fetch(new Request(`https://m.usemomora.com/poster/${VALID_TOKEN}`), makeEnv(mediaGet));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(MEMORY_ID);
    expect(body).not.toContain(VIDEO_POSTER_KEY);
    vi.unstubAllGlobals();
  });
});
