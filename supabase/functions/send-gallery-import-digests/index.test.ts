import { assertEquals } from 'jsr:@std/assert@1';

import { handleSendGalleryImportDigests, type SendGalleryImportDigestsDependencies } from './index.ts';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_A = '33333333-3333-4333-8333-333333333333';
const RECIPIENT_B = '44444444-4444-4444-8444-444444444444';
const RECIPIENT_C = '55555555-5555-4555-8555-555555555555';

interface DigestState {
  memberships?: Array<{ user_id: string }>;
  profiles?: Array<{ id: string; expo_push_token: string | null; notify_new_memories: boolean }>;
  blocks?: Array<{ blocker_user_id: string }>;
  membershipsError?: boolean;
}

function dependencies(state: DigestState = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pushes: Array<{ to: string; title: string; body: string; data: unknown }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'claim_gallery_import_digests') return { data: [{ family_id: FAMILY, actor_id: ACTOR, claim_token: 'digest-claim' }], error: null };
      if (name === 'finish_gallery_import_digest') return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: (table: string) => {
      if (table === 'family_memberships') return { select: () => ({ eq: () => ({ neq: async () => ({
        data: state.memberships ?? [], error: state.membershipsError ? { code: 'XX000' } : null,
      }) }) }) };
      if (table === 'families') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Our family' }, error: null }) }) }) };
      if (table === 'user_profiles') return { select: () => ({ in: async () => ({ data: state.profiles ?? [], error: null }) }) };
      if (table === 'blocked_family_accounts') return { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: state.blocks ?? [], error: null }) }) }) }) };
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const overrides: Partial<SendGalleryImportDigestsDependencies> = {
    createServiceClient: () => client as never,
    validateCronSecret: () => true,
    sendExpoPushNotification: async (to, title, body, data) => {
      pushes.push({ to, title, body, data });
      return true;
    },
  };
  return { rpcCalls, pushes, overrides };
}

Deno.test('gallery digest rejects non-cron requests', async () => {
  const { overrides } = dependencies();
  assertEquals((await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'GET' }), overrides)).status, 405);
  assertEquals((await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'POST' }), {
    ...overrides, validateCronSecret: () => false,
  })).status, 401);
});

Deno.test('gallery digest delegates the 30-minute/family aggregation claim to SQL and sends only eligible generic notifications', async () => {
  const { rpcCalls, pushes, overrides } = dependencies({
    memberships: [{ user_id: RECIPIENT_A }, { user_id: RECIPIENT_B }, { user_id: RECIPIENT_C }],
    profiles: [
      { id: RECIPIENT_A, expo_push_token: 'ExponentPushToken[a]', notify_new_memories: true },
      { id: RECIPIENT_B, expo_push_token: 'ExponentPushToken[b]', notify_new_memories: false },
      { id: RECIPIENT_C, expo_push_token: 'ExponentPushToken[c]', notify_new_memories: true },
    ],
    blocks: [{ blocker_user_id: RECIPIENT_C }],
  });
  const response = await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'POST' }), overrides);

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, sent: 1 });
  assertEquals(rpcCalls, [
    { name: 'claim_gallery_import_digests', args: { p_limit: 50 } },
    { name: 'finish_gallery_import_digest', args: { p_family_id: FAMILY, p_actor_id: ACTOR, p_claim_token: 'digest-claim', p_sent: true } },
  ]);
  assertEquals(pushes, [{
    to: 'ExponentPushToken[a]', title: 'Our family', body: 'New family memories are ready to revisit.',
    data: { route: 'timeline', familyId: FAMILY },
  }]);
  assertEquals(pushes[0].body.includes('1'), false);
});

Deno.test('gallery digest finalizes a no-recipient batch without sending a push', async () => {
  const { rpcCalls, pushes, overrides } = dependencies();
  const response = await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'POST' }), overrides);
  assertEquals(response.status, 200);
  assertEquals(pushes, []);
  assertEquals(rpcCalls.at(-1), {
    name: 'finish_gallery_import_digest', args: { p_family_id: FAMILY, p_actor_id: ACTOR, p_claim_token: 'digest-claim', p_sent: true },
  });
});

Deno.test('gallery digest finalizes after every attempted delivery to avoid duplicate recipients, but retries pre-delivery lookup failures', async () => {
  const { rpcCalls, overrides } = dependencies({
    memberships: [{ user_id: RECIPIENT_A }, { user_id: RECIPIENT_B }],
    profiles: [
      { id: RECIPIENT_A, expo_push_token: 'ExponentPushToken[a]', notify_new_memories: true },
      { id: RECIPIENT_B, expo_push_token: 'ExponentPushToken[b]', notify_new_memories: true },
    ],
  });
  let call = 0;
  const response = await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'POST' }), {
    ...overrides,
    sendExpoPushNotification: async () => {
      call += 1;
      if (call === 1) return false;
      throw new Error('provider unavailable');
    },
  });
  assertEquals(response.status, 200);
  assertEquals(rpcCalls.filter((entry) => entry.name === 'finish_gallery_import_digest').length, 1);

  const lookup = dependencies({ membershipsError: true });
  await handleSendGalleryImportDigests(new Request('http://localhost', { method: 'POST' }), lookup.overrides);
  assertEquals(lookup.rpcCalls.filter((entry) => entry.name === 'finish_gallery_import_digest').length, 0);
});
