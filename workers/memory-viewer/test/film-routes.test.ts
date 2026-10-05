import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

// Fictional fixtures only: this repo is public. The "secret" strings stand in
// for memory text that lives in a film's script and must never reach a page.
const TOKEN = 'fT3xQ9zK1mN7pR5tW2yC4d';
const FILM_ID = '0fbc1354-eaf7-552c-b659-78a0f751691e';
const VIDEO_KEY = 'owner-1/year-films/film-1/attempt-1/film.mp4';
const POSTER_KEY = 'owner-1/year-films/film-1/attempt-1/poster.jpg';
const SECRET_CAPTION = 'SECRET-CAPTION-first-steps-at-the-park';
const SECRET_NAME = 'SECRET-CHILD-NAME';

function makeEnv(mediaGet: ReturnType<typeof vi.fn> = vi.fn()): Env {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    MEDIA: { get: mediaGet },
  } as unknown as Env;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function filmRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FILM_ID,
    family_id: 'family-1',
    kind: 'family_holiday',
    status: 'ready',
    blocked: false,
    video_key: VIDEO_KEY,
    poster_key: POSTER_KEY,
    language: 'es',
    film_script: {
      title: `Nuestro 2026 ${SECRET_NAME}`,
      scenes: [
        { type: 'chapter', name: SECRET_NAME, line: { quote: SECRET_CAPTION } },
        { type: 'sound', caption: SECRET_CAPTION },
        { type: 'end_card', greeting: 'Feliz Navidad', from: 'de parte de la familia Pruebas' },
      ],
    },
    families: { deleted_at: null },
    ...overrides,
  };
}

/** Stubs the two Supabase reads a film request makes, in order. */
function stubFilm(row: Record<string, unknown> | null, token: { revoked_at: string | null } | null = { revoked_at: null }) {
  const fetchSpy = vi.fn();
  fetchSpy.mockResolvedValueOnce(ok(token ? [{ film_id: FILM_ID, revoked_at: token.revoked_at }] : []));
  if (token && !token.revoked_at) fetchSpy.mockResolvedValueOnce(ok(row ? [row] : []));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`https://m.usemomora.com${path}`, init);
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /f/:token (page)', () => {
  it('resolves the token, then the film, and never touches memory tables', async () => {
    const fetchSpy = stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    expect(response.status).toBe(200);

    const urls = fetchSpy.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls).toHaveLength(2);
    expect(urls[0].pathname).toBe('/rest/v1/film_share_tokens');
    expect(urls[0].searchParams.get('token')).toBe(`eq.${TOKEN}`);
    expect(urls[1].pathname).toBe('/rest/v1/year_films');
    expect(urls[1].searchParams.get('id')).toBe(`eq.${FILM_ID}`);
    expect(urls.some((url) => /memories|memory_media/.test(url.pathname))).toBe(false);
  });

  it('renders a full-height 9:16 player with sound-on tap-to-play, poster and wordmark', async () => {
    stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    const html = await response.text();

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain(`src="/f/${TOKEN}/video"`);
    expect(html).toContain(`poster="/f/${TOKEN}/poster"`);
    expect(html).toContain('playsinline');
    expect(html).toContain('controls');
    expect(html).toContain('aspect-ratio: 9 / 16');
    expect(html).toContain('id="play"');
    expect(html).toContain('Toca para ver con sonido');
    expect(html).not.toMatch(/\bautoplay\b/);
    expect(html).not.toMatch(/\bmuted\b="?/);
    expect(html).toContain('aria-label="Momora"');
  });

  it('titles the share preview from the end card and points og:image at the poster route', async () => {
    stubFilm(filmRow());
    const html = await (await worker.fetch(get(`/f/${TOKEN}`), makeEnv())).text();
    expect(html).toContain('<meta property="og:title" content="Feliz Navidad · de la familia Pruebas" />');
    expect(html).toContain(`<meta property="og:image" content="https://m.usemomora.com/f/${TOKEN}/poster" />`);
    expect(html).toContain(`<link rel="canonical" href="https://m.usemomora.com/f/${TOKEN}" />`);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow" />');
  });

  it('uses English copy for an English film and a neutral title without an end card', async () => {
    stubFilm(filmRow({ language: 'en', film_script: { scenes: [{ type: 'title' }] } }));
    const html = await (await worker.fetch(get(`/f/${TOKEN}`), makeEnv())).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Tap to play with sound');
    expect(html).toContain('<meta property="og:title" content="A year as a family" />');
  });

  it('never puts memory text from the script into the page', async () => {
    stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    const html = await response.text();
    const headerLines: string[] = [];
    response.headers.forEach((value, name) => headerLines.push(`${name}: ${value}`));
    const everything = html + headerLines.join('\n');
    expect(everything).not.toContain(SECRET_CAPTION);
    expect(everything).not.toContain(SECRET_NAME);
    // The R2 key of the film is internal too.
    expect(everything).not.toContain(VIDEO_KEY);
    expect(everything).not.toContain('owner-1');
  });

  it('escapes the end card strings', async () => {
    stubFilm(filmRow({ film_script: { scenes: [{ type: 'end_card', greeting: '<script>alert(1)</script>', from: '"><img src=x>' }] } }));
    const html = await (await worker.fetch(get(`/f/${TOKEN}`), makeEnv())).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('"><img src=x>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('sends noindex, no-store and privacy headers', async () => {
    stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('film error states', () => {
  it('404s an unknown token (no row), without reading R2', async () => {
    stubFilm(null, null);
    const mediaGet = vi.fn();
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv(mediaGet));
    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(mediaGet).not.toHaveBeenCalled();
  });

  it('404s a malformed token or sub-route without calling Supabase', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const path of ['/f/short', `/f/${TOKEN}/`, `/f/${TOKEN}/scenes`, `/f/${TOKEN}x`, '/f/']) {
      const response = await worker.fetch(get(path), makeEnv());
      expect(response.status, path).toBe(404);
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404s when the film row is missing or its family is pending deletion', async () => {
    stubFilm(null);
    expect((await worker.fetch(get(`/f/${TOKEN}`), makeEnv())).status).toBe(404);
    stubFilm(filmRow({ families: { deleted_at: '2026-10-01T00:00:00Z' } }));
    expect((await worker.fetch(get(`/f/${TOKEN}`), makeEnv())).status).toBe(404);
  });

  it('fails closed to the 404 page when Supabase errors, and logs without the token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    expect(response.status).toBe(404);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
    errorSpy.mockRestore();
  });

  it('410s a revoked token on the page, the video and the poster, before any film or R2 read', async () => {
    for (const path of [`/f/${TOKEN}`, `/f/${TOKEN}/video`, `/f/${TOKEN}/poster`]) {
      const fetchSpy = stubFilm(null, { revoked_at: '2026-10-01T00:00:00Z' });
      const mediaGet = vi.fn();
      const response = await worker.fetch(get(path), makeEnv(mediaGet));
      expect(response.status, path).toBe(410);
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mediaGet).not.toHaveBeenCalled();
    }
  });

  it('shows a calm "being updated" page (503) for a blocked film, on every route, never the video', async () => {
    const copy: Record<string, string> = { es: 'Estamos actualizando esta película', en: 'This film is being updated' };
    for (const [language, text] of Object.entries(copy)) {
      for (const path of [`/f/${TOKEN}`, `/f/${TOKEN}/video`, `/f/${TOKEN}/poster`]) {
        stubFilm(filmRow({ blocked: true, language }));
        const mediaGet = vi.fn();
        const response = await worker.fetch(get(path), makeEnv(mediaGet));
        expect(response.status, path).toBe(503);
        expect(response.headers.get('retry-after')).toBe('3600');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toContain(text);
        expect(mediaGet).not.toHaveBeenCalled();
      }
    }
  });

  it('shows the same page when the film has no video yet', async () => {
    stubFilm(filmRow({ video_key: null, poster_key: null, status: 'queued' }));
    const response = await worker.fetch(get(`/f/${TOKEN}`), makeEnv());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('actualizando');
  });
});

describe('GET /f/:token/video', () => {
  function r2Object(extra: Record<string, unknown> = {}) {
    return { body: new ReadableStream(), size: 5000, httpEtag: '"abc"', writeHttpMetadata: vi.fn(), ...extra };
  }

  it('streams the full film as video/mp4 with a 200', async () => {
    stubFilm(filmRow());
    const mediaGet = vi.fn().mockResolvedValue(r2Object());
    const response = await worker.fetch(get(`/f/${TOKEN}/video`), makeEnv(mediaGet));
    expect(response.status).toBe(200);
    expect(mediaGet).toHaveBeenCalledWith(VIDEO_KEY);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('5000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('serves a 206 with Content-Range for a Range request', async () => {
    stubFilm(filmRow());
    const mediaGet = vi.fn().mockResolvedValue(r2Object({ range: { offset: 1000, length: 500 } }));
    const response = await worker.fetch(get(`/f/${TOKEN}/video`, { headers: { Range: 'bytes=1000-1499' } }), makeEnv(mediaGet));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1000-1499/5000');
    expect(response.headers.get('content-length')).toBe('500');
    expect(mediaGet).toHaveBeenCalledWith(VIDEO_KEY, { range: { offset: 1000, length: 500 } });
  });

  it('supports an open-ended and a suffix range (iOS Safari probes with bytes=0-1)', async () => {
    stubFilm(filmRow());
    const mediaGet = vi.fn().mockResolvedValue(r2Object({ range: { offset: 0, length: 2 } }));
    const probe = await worker.fetch(get(`/f/${TOKEN}/video`, { headers: { Range: 'bytes=0-1' } }), makeEnv(mediaGet));
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe('bytes 0-1/5000');

    stubFilm(filmRow());
    const tail = vi.fn().mockResolvedValue(r2Object({ range: { offset: 4500, length: 500 } }));
    await worker.fetch(get(`/f/${TOKEN}/video`, { headers: { Range: 'bytes=-500' } }), makeEnv(tail));
    expect(tail).toHaveBeenCalledWith(VIDEO_KEY, { range: { suffix: 500 } });
  });

  it('re-resolves the token on every request', async () => {
    const fetchSpy = stubFilm(filmRow());
    const mediaGet = vi.fn().mockResolvedValue(r2Object());
    await worker.fetch(get(`/f/${TOKEN}/video`), makeEnv(mediaGet));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('404s when the film row points at an object missing from R2', async () => {
    stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}/video`), makeEnv(vi.fn().mockResolvedValue(null)));
    expect(response.status).toBe(404);
  });
});

describe('GET /f/:token/poster', () => {
  it('serves the film poster as a private, no-store JPEG', async () => {
    stubFilm(filmRow());
    const mediaGet = vi.fn().mockResolvedValue({ body: new ReadableStream(), size: 321 });
    const response = await worker.fetch(get(`/f/${TOKEN}/poster`), makeEnv(mediaGet));
    expect(response.status).toBe(200);
    expect(mediaGet).toHaveBeenCalledWith(POSTER_KEY);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('321');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('falls back to the neutral Momora JPEG when the poster object is missing', async () => {
    stubFilm(filmRow());
    const response = await worker.fetch(get(`/f/${TOKEN}/poster`), makeEnv(vi.fn().mockResolvedValue(null)));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });
});

describe('/m routes are unchanged', () => {
  it('still resolves /m/:token through media_share_tokens, not the film tables', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok([]));
    vi.stubGlobal('fetch', fetchSpy);
    const response = await worker.fetch(get(`/m/${TOKEN}`), makeEnv());
    expect(response.status).toBe(404);
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe('/rest/v1/media_share_tokens');
    expect(await response.text()).toContain('Memory not found');
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('does not serve a film token on /media or /poster', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok([]));
    vi.stubGlobal('fetch', fetchSpy);
    for (const path of [`/media/${TOKEN}`, `/poster/${TOKEN}`]) {
      const response = await worker.fetch(get(path), makeEnv());
      expect(response.status).toBe(404);
    }
    expect(fetchSpy.mock.calls.every((call) => new URL(String(call[0])).pathname === '/rest/v1/media_share_tokens')).toBe(true);
  });
});
