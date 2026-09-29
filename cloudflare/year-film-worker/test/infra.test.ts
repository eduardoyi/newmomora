import { describe, expect, it } from 'vitest';
import { createFly, FlyCapacityError } from '../src/fly';
import { credentialEnv, mintMachineCredentials } from '../src/r2creds';
import type { Env } from '../src/types';
import { uuidV5 } from '../src/uuid';

describe('uuidV5', () => {
  it('is deterministic and well-formed', async () => {
    const a = await uuidV5('attempt:check');
    expect(a).toBe(await uuidV5('attempt:check'));
    expect(a).not.toBe(await uuidV5('attempt:other'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('fly', () => {
  function fakeFetch(responses: ((url: string, init?: RequestInit) => Response)[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    let i = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responses[Math.min(i++, responses.length - 1)](url, init);
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

  it('reuses a machine a replayed step already created (deterministic name)', async () => {
    const { fetchFn, calls } = fakeFetch([json([{ id: 'abc123', name: 'yf-x-render', state: 'started' }])]);
    const fly = createFly({ token: 't', app: 'app', image: 'img', regions: ['iad'], fetchFn });
    expect(await fly.create({ name: 'yf-x-render', mode: 'render', env: {} })).toEqual({ id: 'abc123', state: 'started' });
    expect(calls.length).toBe(1);
  });

  it('falls back across regions and sizes on capacity errors, then gives up', async () => {
    const { fetchFn, calls } = fakeFetch([json([]), json({}, 412), json({}, 412), json({ id: 'm2', state: 'created' })]);
    const fly = createFly({ token: 't', app: 'app', image: 'img', regions: ['iad', 'ord'], fetchFn });
    expect((await fly.create({ name: 'n', mode: 'render', env: { A: '1' } })).id).toBe('m2');
    const body = JSON.parse(String(calls[3].init?.body));
    expect(body.config.guest.cpus).toBe(4); // 8x failed in both regions → 4x
    expect(body.config.auto_destroy).toBe(true);
    expect(body.config.init.cmd).toEqual(['render']);

    const full = fakeFetch([json([]), json({}, 412)]);
    const fly2 = createFly({ token: 't', app: 'app', image: 'img', regions: ['iad'], fetchFn: full.fetchFn });
    await expect(fly2.create({ name: 'n', mode: 'thumbs', env: {} })).rejects.toBeInstanceOf(FlyCapacityError);
  });
});

describe('r2 credentials', () => {
  it('falls back to the machine app secrets when the account is not configured', async () => {
    expect(await mintMachineCredentials({ R2_BUCKET_NAME: 'b' } as Env, { attemptPrefix: 'p/', sourceKeys: ['k'], ttlSeconds: 60 })).toBeNull();
    expect(credentialEnv(null)).toEqual({});
  });

  it('mints a prefix-scoped write credential and an object-scoped read credential', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: { accessKeyId: `k${bodies.length}`, secretAccessKey: 's', sessionToken: 't' } }));
    }) as unknown as typeof fetch;
    const env = { CF_API_TOKEN: 'x', CF_ACCOUNT_ID: 'acc', R2_PARENT_ACCESS_KEY_ID: 'parent', R2_BUCKET_NAME: 'b' } as Env;
    const creds = await mintMachineCredentials(env, { attemptPrefix: 'o/year-films/f/a/', sourceKeys: ['u1/m.jpg', 'u2/v.mp4'], ttlSeconds: 900 }, fetchFn);
    expect(bodies[0]).toMatchObject({ permission: 'object-read-write', prefixes: ['o/year-films/f/a/'], ttlSeconds: 900 });
    expect(bodies[1]).toMatchObject({ permission: 'object-read-only', objects: ['u1/m.jpg', 'u2/v.mp4'] });
    expect(Object.keys(credentialEnv(creds))).toContain('R2_READ_SESSION_TOKEN');
  });
});
