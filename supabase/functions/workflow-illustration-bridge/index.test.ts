import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  classifyNonceInsertError,
  getReconcileAction,
  handleWorkflowIllustrationBridge,
  isSignedWorkflowRequest,
  mapPublishOutcome,
  toProviderReservationResult,
  toWorkflowJobInput,
} from './index.ts';

async function sign(timestamp: string, nonce: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('bridge-test-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  ));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(body: Record<string, unknown>): Promise<Request> {
  const timestamp = String(Date.now());
  const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
  const rawBody = JSON.stringify(body);
  return new Request('http://localhost/workflow-illustration-bridge', {
    method: 'POST',
    headers: {
      'x-workflow-timestamp': timestamp,
      'x-workflow-nonce': nonce,
      'x-workflow-signature': await sign(timestamp, nonce, rawBody),
    },
    body: rawBody,
  });
}

Deno.test('workflow bridge HMAC binds the nonce as well as timestamp and body', async () => {
  const previous = Deno.env.get('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', 'bridge-test-secret');
  try {
    const timestamp = String(Date.now());
    const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
    const body = JSON.stringify({ operation: 'get_input', jobId: '22222222-2222-4222-8222-222222222222' });
    const signature = await sign(timestamp, nonce, body);
    const valid = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': nonce,
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedWorkflowRequest(valid, body), true);
    const replayWithFreshNonce = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': '4e5c933a-3a75-4a23-9adc-82227afc10ea',
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedWorkflowRequest(replayWithFreshNonce, body), false);
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', previous);
  }
});

Deno.test('workflow bridge maps publication and reconciliation outcomes to the Worker contract', () => {
  assertEquals(mapPublishOutcome({ published: true, old_key: 'old.webp' }), {
    published: true, oldIllustrationKey: 'old.webp', deleteOutput: false,
  });
  assertEquals(mapPublishOutcome({ already_published: true, old_key: 'old.webp' }), {
    published: true, oldIllustrationKey: 'old.webp', deleteOutput: false,
  });
  assertEquals(mapPublishOutcome({ published: false }), {
    published: false, oldIllustrationKey: null, deleteOutput: true,
  });
  assertEquals(getReconcileAction({ status: 'running', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'republish');
  assertEquals(getReconcileAction({ status: 'succeeded', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'succeeded');
  assertEquals(getReconcileAction({ status: 'superseded', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'delete');
});

Deno.test('workflow bridge classifies nonce failures and omits legacy usage protocol fields', () => {
  assertEquals(classifyNonceInsertError(null), 'ok');
  assertEquals(classifyNonceInsertError({ code: '23505' }), 'replay');
  assertEquals(classifyNonceInsertError({ code: '08006' }), 'error');
  assertEquals(toWorkflowJobInput({
    id: '22222222-2222-4222-8222-222222222222',
    output_key: 'new.webp', old_illustration_key: 'old.webp', provider_deadline_at: '2026-07-21T12:05:00Z',
    style_description: 'storybook', safe_scene_description: 'safe scene', expression_style: 'tender',
    color_palette: 'rose', emotion: 'tender', memory_date: '2026-07-21', reference_candidates: [],
  }), {
    job: {
      jobId: '22222222-2222-4222-8222-222222222222', outputKey: 'new.webp', oldIllustrationKey: 'old.webp',
      providerDeadlineAt: '2026-07-21T12:05:00Z', styleDescription: 'storybook', safeSceneDescription: 'safe scene',
      expressionStyle: 'tender', colorPalette: 'rose', emotion: 'tender', memoryDate: '2026-07-21', referenceCandidates: [],
    },
  });
});

Deno.test('workflow bridge emits only complete v2 usage protocol fields', () => {
  const base = {
    id: '22222222-2222-4222-8222-222222222222',
    output_key: 'new.webp', old_illustration_key: null, provider_deadline_at: '2026-07-21T12:05:00Z',
    style_description: 'storybook', safe_scene_description: 'safe scene', expression_style: null,
    color_palette: 'rose', emotion: null, memory_date: '2026-07-21', reference_candidates: [],
  };
  const usageRequestId = '99999999-9999-4999-8999-999999999999';
  assertEquals(toWorkflowJobInput({
    ...base, usage_request_id: usageRequestId, usage_protocol_version: 2,
  }).job, {
    jobId: base.id, outputKey: 'new.webp', oldIllustrationKey: null,
    providerDeadlineAt: base.provider_deadline_at, styleDescription: 'storybook', safeSceneDescription: 'safe scene',
    expressionStyle: null, colorPalette: 'rose', emotion: null, memoryDate: '2026-07-21', referenceCandidates: [],
    usageRequestId, providerProtocolVersion: 2,
  });
  assertThrows(() => toWorkflowJobInput({
    ...base, usage_request_id: null, usage_protocol_version: 2,
  }), TypeError, 'requires a usage request id');
  assertThrows(() => toWorkflowJobInput({
    ...base, usage_request_id: null, usage_protocol_version: 3,
  }), TypeError, 'Unsupported workflow usage protocol version');
});

Deno.test('workflow bridge reserves only a new provider slot and fails replays closed', () => {
  assertEquals(toProviderReservationResult(true), { outcome: 'reserved_now', protocolVersion: 2 });
  assertEquals(toProviderReservationResult(false), { outcome: 'already_reserved', protocolVersion: 2 });
  assertEquals(toProviderReservationResult({ outcome: 'denied' }), { outcome: 'denied', protocolVersion: 2 });
});

Deno.test('illustration bridge preserves the v1 reservation response contract', async () => {
  const previous = Deno.env.get('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', 'bridge-test-secret');
  try {
    const response = await handleWorkflowIllustrationBridge(await signedRequest({
      operation: 'reserve_attempt', jobId: '22222222-2222-4222-8222-222222222222',
      provider: 'primary', model: 'gpt-image-2', attemptNumber: 1,
    }), {
      createServiceClient: () => ({
        from(table: string) {
          if (table === 'memory_illustration_workflow_bridge_nonces') return {
            insert: async () => ({ error: null }), delete: () => ({ lt: async () => ({ error: null }) }),
          };
          const query = {
            select: () => query, eq: () => query,
            maybeSingle: async () => ({
              data: { usage_request_id: null, usage_protocol_version: 1 }, error: null,
            }),
          };
          return query;
        },
        rpc: async () => ({ data: true, error: null }),
      }) as never,
    });
    assertEquals(await response.json(), { reserved: true });
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', previous);
  }
});

Deno.test('illustration bridge records grandfathered v1 Worker usage with server-bound family and creator metadata', async () => {
  const previous = Deno.env.get('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', 'bridge-test-secret');
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const jobId = '22222222-2222-4222-8222-222222222222';
  try {
    const response = await handleWorkflowIllustrationBridge(await signedRequest({
      operation: 'record_usage', jobId, usageRequestId: null, protocolVersion: 1,
      provider: 'primary', attemptNumber: 1, aiCallId: `${jobId}:primary:1`, aiOperation: 'image_generation',
      model: 'gpt-image-2', success: true, familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      usage: { inputTextTokens: 10, inputImageTokens: 20, inputCachedTokens: 3, outputTextTokens: 4, outputImageTokens: 50 },
    }), {
      createServiceClient: () => ({
        from(table: string) {
          if (table === 'memory_illustration_workflow_bridge_nonces') return {
            insert: async () => ({ error: null }), delete: () => ({ lt: async () => ({ error: null }) }),
          };
          const row = table === 'memory_illustration_jobs'
            ? { family_id: '44444444-4444-4444-8444-444444444444', memory_id: '55555555-5555-4555-8555-555555555555', usage_request_id: null, usage_protocol_version: 1 }
            : { family_id: '44444444-4444-4444-8444-444444444444', user_id: '66666666-6666-4666-8666-666666666666' };
          const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
          return query;
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
          rpcCalls.push({ name, args });
          return { data: true, error: null };
        },
      }) as never,
    });
    assertEquals(await response.json(), { recorded: true });
    assertEquals(rpcCalls, [{
      name: 'record_ai_usage_event_detailed',
      args: {
        p_ai_call_id: `${jobId}:primary:1`, p_usage_request_id: null,
        p_family_id: '44444444-4444-4444-8444-444444444444', p_actor_user_id: '66666666-6666-4666-8666-666666666666',
        p_operation: 'illustration', p_model: 'gpt-image-2', p_success: true,
        p_provider_usage: { provider: 'primary', input_text_tokens: 10, input_image_tokens: 20, cached_input_tokens: 3, output_text_tokens: 4, output_image_tokens: 50 },
        p_estimated_cost_usd: null, p_cost_basis: 'unpriced', p_billing_status: 'unknown', p_cost_is_complete: false, p_pricing_version: null,
      },
    }]);
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', previous);
  }
});
