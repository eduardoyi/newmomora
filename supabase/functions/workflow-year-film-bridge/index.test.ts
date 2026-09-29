import { assertEquals } from 'jsr:@std/assert@1';
import { handleWorkflowYearFilmBridge, verifySignedRequest } from './index.ts';

const SECRET = 'test-secret';
const FILM = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

async function sign(body: string, nonce = crypto.randomUUID(), timestamp = String(Date.now())) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`));
  const signature = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('http://localhost/workflow-year-film-bridge', {
    method: 'POST',
    headers: { 'x-workflow-timestamp': timestamp, 'x-workflow-nonce': nonce, 'x-workflow-signature': signature },
    body,
  });
}

interface Fake {
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  client: unknown;
}

function fake(options: { nonceFresh?: boolean; heartbeat?: string; rpc?: Record<string, unknown> } = {}): Fake {
  const f: Fake = { rpcCalls: [], client: null };
  const table = (rows: Record<string, unknown>) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: () => Promise.resolve({ data: rows, error: null }),
    };
    return chain;
  };
  f.client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      f.rpcCalls.push({ name, args });
      if (name === 'record_year_film_bridge_nonce') return Promise.resolve({ data: options.nonceFresh ?? true, error: null });
      if (name === 'year_film_heartbeat') return Promise.resolve({ data: options.heartbeat ?? 'ok', error: null });
      return Promise.resolve({ data: options.rpc?.[name] ?? 'ok', error: null });
    },
    from: (name: string) =>
      table(name === 'families' ? { owner_id: OWNER } : { family_id: 'fam', status: 'ready', attempt_id: null, video_key: `${OWNER}/year-films/${FILM}/${ATTEMPT}/film.mp4` }),
  };
  return f;
}

const call = (body: Record<string, unknown>, f: Fake, request?: Request) =>
  (request ? Promise.resolve(request) : sign(JSON.stringify(body))).then((req) =>
    handleWorkflowYearFilmBridge(req, { createServiceClient: () => f.client as never, secret: SECRET })
  );

Deno.test('signature: valid, tampered, expired, missing secret', async () => {
  const body = '{"a":1}';
  assertEquals(typeof await verifySignedRequest(await sign(body), body, SECRET), 'string');
  assertEquals(await verifySignedRequest(await sign(body), '{"a":2}', SECRET), null);
  assertEquals(await verifySignedRequest(await sign(body, crypto.randomUUID(), String(Date.now() - 10 * 60_000)), body, SECRET), null);
  assertEquals(await verifySignedRequest(await sign(body), body, undefined), null);
});

Deno.test('unsigned → 401; replayed nonce → 409; bad operation → 400', async () => {
  const f = fake();
  const unsigned = new Request('http://localhost', { method: 'POST', body: '{}' });
  assertEquals((await handleWorkflowYearFilmBridge(unsigned, { createServiceClient: () => f.client as never, secret: SECRET })).status, 401);
  assertEquals((await call({ operation: 'heartbeat', filmId: FILM, attemptId: ATTEMPT }, fake({ nonceFresh: false }))).status, 409);
  assertEquals((await call({ operation: 'drop_table', filmId: FILM, attemptId: ATTEMPT }, f)).status, 400);
  assertEquals((await call({ operation: 'heartbeat', filmId: 'nope', attemptId: ATTEMPT }, f)).status, 400);
});

Deno.test('work operations stop when the attempt is superseded, the epoch moved or mode is off', async () => {
  for (const state of ['superseded', 'epoch_changed', 'disabled']) {
    const f = fake({ heartbeat: state });
    const res = await call({ operation: 'claim_render_slot', filmId: FILM, attemptId: ATTEMPT }, f);
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { state });
    assertEquals(f.rpcCalls.some((c) => c.name === 'year_film_claim_render_slot'), false);
  }
});

Deno.test('publish only accepts keys under the attempt prefix', async () => {
  const prefix = `${OWNER}/year-films/${FILM}/${ATTEMPT}/`;
  const ok = fake({ rpc: { publish_year_film: { ok: true, delete_keys: [] } } });
  const res = await call({
    operation: 'publish', filmId: FILM, attemptId: ATTEMPT, editsVersion: 0, durationMs: 61000.4,
    videoKey: `${prefix}film.mp4`, posterKey: `${prefix}poster.jpg`, scenesKey: `${prefix}scenes.json`,
  }, ok);
  assertEquals(await res.json(), { ok: true, delete_keys: [] });
  assertEquals(ok.rpcCalls.find((c) => c.name === 'publish_year_film')?.args.p_duration_ms, 61000);

  const bad = fake();
  const rejected = await call({
    operation: 'publish', filmId: FILM, attemptId: ATTEMPT, editsVersion: 0, durationMs: 1,
    videoKey: `someone-else/year-films/${FILM}/${ATTEMPT}/film.mp4`, posterKey: `${prefix}poster.jpg`, scenesKey: `${prefix}scenes.json`,
  }, bad);
  assertEquals(rejected.status, 400);
  assertEquals(bad.rpcCalls.some((c) => c.name === 'publish_year_film'), false);
});

Deno.test('end_cycle validates the outcome and code; reconcile finds a publish that landed', async () => {
  assertEquals((await call({ operation: 'end_cycle', filmId: FILM, attemptId: ATTEMPT, outcome: 'boom', code: 'X' }, fake())).status, 400);
  assertEquals((await call({ operation: 'end_cycle', filmId: FILM, attemptId: ATTEMPT, outcome: 'failed', code: 'raw error text' }, fake())).status, 400);
  const res = await call({ operation: 'reconcile', filmId: FILM, attemptId: ATTEMPT }, fake());
  assertEquals(await res.json(), { outcome: 'succeeded' });
});
