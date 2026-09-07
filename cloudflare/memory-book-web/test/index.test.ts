import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

function makeEnv(fetchImpl: (request: Request) => Response | Promise<Response>): Env {
  return { ASSETS: { fetch: vi.fn(fetchImpl) } } as unknown as Env;
}

describe('memory-book-web static-assets Worker', () => {
  it('returns the asset store response as-is on a hit', async () => {
    const env = makeEnv(() => new Response('css body', { status: 200, headers: { 'content-type': 'text/css' } }));
    const response = await worker.fetch(new Request('https://shop.usemomora.com/assets/web-abc123.css'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('css body');
  });

  it('falls back to /web.html on a 404 for a client-side route (e.g. /b/<id>)', async () => {
    const fetchImpl = vi.fn((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/web.html') {
        return new Response('<html>app shell</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('not found', { status: 404 });
    });
    const env = makeEnv(fetchImpl);
    const response = await worker.fetch(new Request('https://shop.usemomora.com/b/687bb3d1-0000-0000-0000-000000000000'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>app shell</html>');
    // Two ASSETS.fetch calls: the original miss, then the /web.html fallback.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to /web.html for the root path too', async () => {
    const fetchImpl = vi.fn((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/web.html') {
        return new Response('<html>app shell</html>', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const env = makeEnv(fetchImpl);
    const response = await worker.fetch(new Request('https://shop.usemomora.com/'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>app shell</html>');
  });

  it('preserves the original request method/headers on the fallback fetch', async () => {
    const seenRequests: Request[] = [];
    const fetchImpl = vi.fn((request: Request) => {
      seenRequests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/web.html') return new Response('shell', { status: 200 });
      return new Response('miss', { status: 404 });
    });
    const env = makeEnv(fetchImpl);
    await worker.fetch(new Request('https://shop.usemomora.com/b/xyz', { headers: { 'x-test': '1' } }), env);
    expect(seenRequests[1].url).toBe('https://shop.usemomora.com/web.html');
    expect(seenRequests[1].headers.get('x-test')).toBe('1');
  });

  it('does not fall back on a non-404 error response (e.g. a 500 from the asset store)', async () => {
    const fetchImpl = vi.fn(() => new Response('server error', { status: 500 }));
    const env = makeEnv(fetchImpl);
    const response = await worker.fetch(new Request('https://shop.usemomora.com/assets/broken.js'), env);
    expect(response.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
