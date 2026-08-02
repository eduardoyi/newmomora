import { assertEquals } from 'jsr:@std/assert@1';

import { checkBillingAiGeneration, checkBillingFamilyWrite } from './billing.ts';

function fakeClient(response: { data: unknown; error: unknown }) {
  return { rpc: () => Promise.resolve(response) } as never;
}

Deno.test('allows an AI request when the billing RPC admits it', async () => {
  const result = await checkBillingAiGeneration(fakeClient({
    data: [{ allowed: true, scope: null, retry_after_iso: null, error_code: null }],
    error: null,
  }), {
    familyId: 'family-1',
    actorUserId: 'user-1',
    targetKind: 'memory',
    targetId: 'memory-1',
    requestIntent: 'initial',
  });

  assertEquals(result, null);
});

Deno.test('returns a subscription error when an AI request is gated', async () => {
  const result = await checkBillingAiGeneration(fakeClient({
    data: [{ allowed: false, scope: null, retry_after_iso: null, error_code: 'SUBSCRIPTION_REQUIRED' }],
    error: null,
  }), {
    familyId: 'family-1',
    actorUserId: 'user-1',
    targetKind: 'memory',
    targetId: 'memory-1',
    requestIntent: 'initial',
  });

  assertEquals(result?.status, 403);
  assertEquals(await result?.json(), {
    error: 'An active Momora subscription is required for AI generation',
    code: 'SUBSCRIPTION_REQUIRED',
  });
});

Deno.test('returns a retryable response for a usage cap', async () => {
  const result = await checkBillingAiGeneration(fakeClient({
    data: [{
      allowed: false,
      scope: 'daily',
      retry_after_iso: new Date(Date.now() + 60_000).toISOString(),
      error_code: 'OWNER_AI_LIMIT_REACHED',
    }],
    error: null,
  }), {
    familyId: 'family-1',
    actorUserId: 'user-1',
    targetKind: 'portrait_version',
    targetId: 'portrait-1',
    requestIntent: 'initial',
  });

  assertEquals(result?.status, 429);
  assertEquals(result?.headers.get('Retry-After') !== null, true);
});

Deno.test('maps a family write subscription error to a 403', async () => {
  const result = await checkBillingFamilyWrite(
    fakeClient({ data: null, error: { code: 'P0001' } }),
    'family-1',
    'user-1',
    'voice_memory',
  );

  assertEquals(result?.status, 403);
  assertEquals(await result?.json(), {
    error: 'An active Momora subscription is required for this action',
    code: 'SUBSCRIPTION_REQUIRED',
  });
});
