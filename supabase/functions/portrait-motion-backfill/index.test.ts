import { assertEquals } from 'jsr:@std/assert@1';
import {
  type BackfillVersionRow,
  handlePortraitMotionBackfill,
  needsPortraitMotion,
  resolveCurrentPortraitVersion,
  selectBackfillCandidates,
  toPortraitMotionDispatchUrl,
} from './index.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TODAY = '2026-11-05';
const SERVICE_KEY = 'service-role-test-key';
const FAMILY = 'f0000000-0000-4000-8000-000000000001';
const MEMBER_A = 'a0000000-0000-4000-8000-00000000000a';
const MEMBER_B = 'a0000000-0000-4000-8000-00000000000b';

function version(overrides: Partial<BackfillVersionRow> & { id: string }): BackfillVersionRow {
  return {
    family_id: FAMILY,
    family_member_id: MEMBER_A,
    reference_date: '2026-01-01',
    created_at: '2026-01-01T00:00:00+00:00',
    illustrated_profile_key: `still/${overrides.id}.webp`,
    motion_status: null,
    motion_source_key: null,
    motion_started_at: null,
    ...overrides,
  };
}

Deno.test('resolveCurrentPortraitVersion mirrors the app resolver: latest dated <= today, newest on ties', () => {
  const old = version({ id: 'v1', reference_date: '2025-01-01' });
  const latest = version({ id: 'v2', reference_date: '2026-06-01', created_at: '2026-06-01T00:00:00+00:00' });
  const tieNewer = version({ id: 'v3', reference_date: '2026-06-01', created_at: '2026-07-01T00:00:00+00:00' });
  const future = version({ id: 'v4', reference_date: '2027-01-01' });
  assertEquals(resolveCurrentPortraitVersion([old, latest, tieNewer, future], TODAY)?.id, 'v3');
  assertEquals(resolveCurrentPortraitVersion([old, future], TODAY)?.id, 'v1');
});

Deno.test('resolveCurrentPortraitVersion falls back to the earliest future date, then undated legacy', () => {
  const futureLate = version({ id: 'f2', reference_date: '2028-01-01' });
  const futureEarly = version({ id: 'f1', reference_date: '2027-01-01' });
  assertEquals(resolveCurrentPortraitVersion([futureLate, futureEarly], TODAY)?.id, 'f1');
  const legacyOld = version({ id: 'l1', reference_date: null, created_at: '2025-01-01T00:00:00+00:00' });
  const legacyNew = version({ id: 'l2', reference_date: null, created_at: '2025-02-01T00:00:00+00:00' });
  assertEquals(resolveCurrentPortraitVersion([legacyOld, legacyNew], TODAY)?.id, 'l2');
  assertEquals(resolveCurrentPortraitVersion([], TODAY), null);
});

Deno.test('needsPortraitMotion skips ready, failed and fresh in-flight work for the current still only', () => {
  const nowMs = NOW.getTime();
  const base = version({ id: 'v1' });
  const source = base.illustrated_profile_key;
  assertEquals(needsPortraitMotion(base, nowMs), true);
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'ready', motion_source_key: source }, nowMs), false);
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'failed', motion_source_key: source }, nowMs), false);
  const fresh = new Date(nowMs - 5 * 60_000).toISOString();
  const stale = new Date(nowMs - 16 * 60_000).toISOString();
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'pending', motion_source_key: source, motion_started_at: fresh }, nowMs), false);
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'pending', motion_source_key: source, motion_started_at: stale }, nowMs), true);
  // A sheet/failure made from a replaced still counts as "no motion for the current still".
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'ready', motion_source_key: 'still/older.webp' }, nowMs), true);
  assertEquals(needsPortraitMotion({ ...base, motion_status: 'failed', motion_source_key: 'still/older.webp' }, nowMs), true);
});

Deno.test('selectBackfillCandidates only considers each member\'s current version', () => {
  const memberAOld = version({ id: 'a-old', reference_date: '2025-01-01' });
  const memberACurrent = version({ id: 'a-cur', reference_date: '2026-06-01' });
  const memberBCurrent = version({
    id: 'b-cur', family_member_id: MEMBER_B,
    motion_status: 'ready', motion_source_key: 'still/b-cur.webp',
  });
  const candidates = selectBackfillCandidates([memberAOld, memberACurrent, memberBCurrent], TODAY, NOW.getTime());
  assertEquals(candidates.map((c) => c.id), ['a-cur']);
});

Deno.test('toPortraitMotionDispatchUrl swaps only the dispatch path and rejects unexpected URLs', () => {
  assertEquals(
    toPortraitMotionDispatchUrl('https://worker.example.test/dispatch/portrait'),
    'https://worker.example.test/dispatch/portrait-motion',
  );
  assertEquals(
    toPortraitMotionDispatchUrl('https://worker.example.test/prefix/dispatch/portrait'),
    'https://worker.example.test/prefix/dispatch/portrait-motion',
  );
  let threw = false;
  try {
    toPortraitMotionDispatchUrl('https://worker.example.test/other');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

interface FixtureOptions {
  versions?: BackfillVersionRow[];
  fencedFamilies?: string[];
  fencedMembers?: string[];
  claim?: (versionId: string, n: number) => Record<string, unknown> | { error: true };
}

function createFixture(options: FixtureOptions = {}) {
  const claims: string[] = [];
  const client = {
    from(table: string) {
      if (table === 'family_member_portrait_versions') {
        const query = {
          select: () => query,
          eq: () => query,
          not: () => query,
          is: () => query,
          order: () => query,
          range: async () => ({ data: options.versions ?? [], error: null }),
        };
        return query;
      }
      if (table === 'families') {
        return { select: () => ({ or: async () => ({ data: (options.fencedFamilies ?? []).map((id) => ({ id })), error: null }) }) };
      }
      if (table === 'family_members') {
        return { select: () => ({ not: async () => ({ data: (options.fencedMembers ?? []).map((id) => ({ id })), error: null }) }) };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name: string, args: { p_version_id: string; p_force: boolean }) => {
      if (name !== 'claim_portrait_motion') throw new Error(`Unexpected RPC ${name}`);
      claims.push(args.p_version_id);
      const result = options.claim?.(args.p_version_id, claims.length) ?? {
        outcome: 'claimed',
        motion_token: `00000000-0000-4000-8000-${String(claims.length).padStart(12, '0')}`,
        stale_motion_key: null,
      };
      if ('error' in result) return { data: null, error: { message: 'boom' } };
      return { data: [result], error: null };
    },
  };
  return { client, claims };
}

function request(body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SERVICE_KEY}` }, method = 'POST') {
  return new Request('http://localhost/portrait-motion-backfill', {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function withEnv(run: () => Promise<void>): Promise<void> {
  const entries = [
    ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY],
    ['CRON_SECRET', 'cron-test-secret'],
    ['CLOUDFLARE_PORTRAIT_WORKFLOW_URL', 'https://worker.example.test/dispatch/portrait'],
    ['CLOUDFLARE_PORTRAIT_DISPATCH_SECRET', 'dispatch-test-secret'],
  ] as const;
  const previous = new Map(entries.map(([key]) => [key, Deno.env.get(key)]));
  for (const [key, value] of entries) Deno.env.set(key, value);
  try {
    await run();
  } finally {
    for (const [key] of entries) {
      const value = previous.get(key);
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function deps(fixture: ReturnType<typeof createFixture>, fetchImpl: typeof fetch = async () => new Response('', { status: 202 }), extra: { deleteObject?: (key: string) => Promise<void>; verifyServiceKey?: (token: string) => Promise<boolean> } = {}) {
  return {
    createServiceClient: () => fixture.client as never,
    fetch: fetchImpl,
    deleteObject: extra.deleteObject ?? (async () => {}),
    now: () => NOW,
    verifyServiceKey: extra.verifyServiceKey ?? (async () => false),
  };
}

Deno.test('portrait-motion-backfill accepts another service-level key only when Auth verifies it', async () => {
  await withEnv(async () => {
    const seen: string[] = [];
    const verifyServiceKey = async (token: string) => {
      seen.push(token);
      return token === 'sb_secret_other_format';
    };
    const accepted = await handlePortraitMotionBackfill(
      request({ dryRun: true }, { Authorization: 'Bearer sb_secret_other_format' }),
      deps(createFixture(), undefined, { verifyServiceKey }),
    );
    assertEquals(accepted.status, 200);
    const rejected = await handlePortraitMotionBackfill(
      request({ dryRun: true }, { Authorization: 'Bearer anon-or-user-token' }),
      deps(createFixture(), undefined, { verifyServiceKey }),
    );
    assertEquals(rejected.status, 401);
    assertEquals(seen, ['sb_secret_other_format', 'anon-or-user-token']);
  });
});

Deno.test('portrait-motion-backfill rejects missing or wrong credentials and non-POST methods', async () => {
  await withEnv(async () => {
    const fixture = createFixture();
    assertEquals((await handlePortraitMotionBackfill(request({}, {}), deps(fixture))).status, 401);
    assertEquals((await handlePortraitMotionBackfill(request({}, { Authorization: 'Bearer wrong' }), deps(fixture))).status, 401);
    assertEquals((await handlePortraitMotionBackfill(request({}, { 'x-cron-secret': 'wrong' }), deps(fixture))).status, 401);
    assertEquals((await handlePortraitMotionBackfill(request({}, {}, 'GET'), deps(fixture))).status, 405);
    assertEquals(fixture.claims.length, 0);
  });
});

Deno.test('portrait-motion-backfill accepts the cron secret and the exact service-role bearer', async () => {
  await withEnv(async () => {
    const cron = await handlePortraitMotionBackfill(request({ dryRun: true }, { 'x-cron-secret': 'cron-test-secret' }), deps(createFixture()));
    assertEquals(cron.status, 200);
    const bearer = await handlePortraitMotionBackfill(request({ dryRun: true }), deps(createFixture()));
    assertEquals(bearer.status, 200);
  });
});

Deno.test('portrait-motion-backfill validates limit and dryRun', async () => {
  await withEnv(async () => {
    for (const body of [{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { limit: '5' }, { dryRun: 'yes' }]) {
      const response = await handlePortraitMotionBackfill(request(body), deps(createFixture()));
      assertEquals(response.status, 400, JSON.stringify(body));
    }
  });
});

Deno.test('portrait-motion-backfill dry run reports eligible counts without claiming or dispatching', async () => {
  await withEnv(async () => {
    const fixture = createFixture({
      versions: [version({ id: 'v1' }), version({ id: 'v2', family_member_id: MEMBER_B })],
    });
    let fetched = 0;
    const response = await handlePortraitMotionBackfill(
      request({ dryRun: true }),
      deps(fixture, async () => { fetched += 1; return new Response('', { status: 202 }); }),
    );
    assertEquals(await response.json(), { eligible: 2, claimed: 0, dispatched: 0, failed: 0 });
    assertEquals(fixture.claims.length, 0);
    assertEquals(fetched, 0);
  });
});

Deno.test('portrait-motion-backfill excludes fenced families and members from eligible', async () => {
  await withEnv(async () => {
    const fixture = createFixture({
      versions: [
        version({ id: 'v1' }),
        version({ id: 'v2', family_member_id: MEMBER_B }),
        version({ id: 'v3', family_id: 'f0000000-0000-4000-8000-000000000002', family_member_id: 'a0000000-0000-4000-8000-00000000000c' }),
      ],
      fencedMembers: [MEMBER_B],
      fencedFamilies: ['f0000000-0000-4000-8000-000000000002'],
    });
    const response = await handlePortraitMotionBackfill(request({ dryRun: true }), deps(fixture));
    assertEquals((await response.json()).eligible, 1);
  });
});

Deno.test('portrait-motion-backfill claims up to limit and dispatches a signed { versionId, motionToken } to the motion endpoint', async () => {
  await withEnv(async () => {
    const fixture = createFixture({
      versions: [
        version({ id: 'v1' }),
        version({ id: 'v2', family_member_id: MEMBER_B }),
        version({ id: 'v3', family_member_id: 'a0000000-0000-4000-8000-00000000000c' }),
      ],
    });
    const dispatched: Array<{ url: string; headers: Headers; body: string }> = [];
    const response = await handlePortraitMotionBackfill(
      request({ limit: 2 }),
      deps(fixture, async (input, init) => {
        dispatched.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response('', { status: 202 });
      }),
    );
    assertEquals(await response.json(), { eligible: 3, claimed: 2, dispatched: 2, failed: 0 });
    assertEquals(fixture.claims, ['v1', 'v2']);
    assertEquals(dispatched.length, 2);
    assertEquals(dispatched[0].url, 'https://worker.example.test/dispatch/portrait-motion');
    const payload = JSON.parse(dispatched[0].body);
    assertEquals(Object.keys(payload).sort(), ['motionToken', 'versionId']);
    assertEquals(payload.versionId, 'v1');

    // The signature binds timestamp, nonce and raw body with the dispatch secret.
    const timestamp = dispatched[0].headers.get('x-dispatch-timestamp')!;
    const nonce = dispatched[0].headers.get('x-dispatch-nonce')!;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('dispatch-test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${dispatched[0].body}`)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    assertEquals(dispatched[0].headers.get('x-dispatch-signature'), expected);
  });
});

Deno.test('portrait-motion-backfill skips non-claimed outcomes and counts dispatch and claim failures', async () => {
  await withEnv(async () => {
    const fixture = createFixture({
      versions: [
        version({ id: 'v1' }),
        version({ id: 'v2', family_member_id: MEMBER_B }),
        version({ id: 'v3', family_member_id: 'a0000000-0000-4000-8000-00000000000c' }),
        version({ id: 'v4', family_member_id: 'a0000000-0000-4000-8000-00000000000d' }),
      ],
      claim: (versionId, n) => {
        if (versionId === 'v1') return { outcome: 'in_flight', motion_token: null, stale_motion_key: null };
        if (versionId === 'v2') return { error: true };
        return { outcome: 'claimed', motion_token: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, stale_motion_key: null };
      },
    });
    let calls = 0;
    const response = await handlePortraitMotionBackfill(
      request({ limit: 10 }),
      deps(fixture, async () => {
        calls += 1;
        return new Response('', { status: calls === 1 ? 500 : 409 });
      }),
    );
    // v1 raced (skipped), v2 claim error (failed), v3 dispatch 500 (failed), v4 409 duplicate (ok).
    assertEquals(await response.json(), { eligible: 4, claimed: 2, dispatched: 1, failed: 2 });
  });
});

Deno.test('portrait-motion-backfill deletes a returned stale sheet best-effort', async () => {
  await withEnv(async () => {
    const stale = 'a0000000-0000-4000-8000-0000000000aa/family/a0000000-0000-4000-8000-00000000000a/portraits/b0000000-0000-4000-8000-0000000000bb/motion/c0000000-0000-4000-8000-0000000000cc.webp';
    const fixture = createFixture({
      versions: [version({ id: 'v1' })],
      claim: () => ({ outcome: 'claimed', motion_token: '00000000-0000-4000-8000-000000000001', stale_motion_key: stale }),
    });
    const deleted: string[] = [];
    const response = await handlePortraitMotionBackfill(
      request({}),
      deps(fixture, undefined, { deleteObject: async (key) => { deleted.push(key); throw new Error('r2 down'); } }),
    );
    assertEquals((await response.json()).dispatched, 1);
    assertEquals(deleted, [stale]);
  });
});
