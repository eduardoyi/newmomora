import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

const VALID_ID = '0fbc1354-eaf7-552c-b659-78a0f751691e';

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

describe('memory-viewer routing', () => {
  it('responds to /health without touching Supabase or R2', async () => {
    const response = await worker.fetch(new Request('https://m.momora.app/health'), makeEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('404s an unrecognized path', async () => {
    const response = await worker.fetch(new Request('https://m.momora.app/nope'), makeEnv());
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('Momora');
  });

  it('404s a malformed memory id without calling Supabase', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await worker.fetch(new Request('https://m.momora.app/m/not-a-uuid'), makeEnv());
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('404s a well-formed id with no matching memory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(supabaseOk([])).mockResolvedValueOnce(supabaseOk([])),
    );
    const response = await worker.fetch(new Request(`https://m.momora.app/m/${VALID_ID}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('404s a text-only memory (no media asset to show)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(supabaseOk([{ id: VALID_ID, memory_type: 'text_only', memory_date: null, content: 'hi' }]))
        .mockResolvedValueOnce(supabaseOk([])),
    );
    const response = await worker.fetch(new Request(`https://m.momora.app/m/${VALID_ID}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('renders the viewer page for a resolvable media memory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          supabaseOk([{ id: VALID_ID, memory_type: 'media', memory_date: '2026-06-01', content: 'Pool day' }]),
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
    const response = await worker.fetch(new Request(`https://m.momora.app/m/${VALID_ID}`), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain(`<video class="media" src="/media/${VALID_ID}"`);
    expect(body).toContain('Pool day');
    vi.unstubAllGlobals();
  });

  it('maps a Supabase failure to the friendly 404, not a 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const response = await worker.fetch(new Request(`https://m.momora.app/m/${VALID_ID}`), makeEnv());
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });
});

describe('/media/:memoryId streaming', () => {
  function stubResolvableMemory() {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          supabaseOk([{ id: VALID_ID, memory_type: 'media', memory_date: '2026-06-01', content: null }]),
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
    const response = await worker.fetch(new Request(`https://m.momora.app/media/${VALID_ID}`), makeEnv(mediaGet));
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
      new Request(`https://m.momora.app/media/${VALID_ID}`, { headers: { Range: 'bytes=1000-1499' } }),
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
    const response = await worker.fetch(new Request(`https://m.momora.app/media/${VALID_ID}`), makeEnv(mediaGet));
    expect(response.status).toBe(404);
    vi.unstubAllGlobals();
  });
});
