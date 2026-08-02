import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  MEDIA: {
    head: vi.fn(),
    get: vi.fn(),
  },
} as unknown as Env;

describe('export worker routes', () => {
  it('rejects export creation without a Supabase bearer token', async () => {
    const response = await worker.fetch(
      new Request('https://exports.example/exports', { method: 'POST' }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'unauthorized' });
  });

  it('rejects authenticated users who do not own a family', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'user-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 })));

    const response = await worker.fetch(
      new Request('https://exports.example/exports', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-1' },
      }),
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Only family owners can export an archive',
      code: 'not_owner',
    });
  });
});
