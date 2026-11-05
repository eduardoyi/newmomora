import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  classifyPortraitNonceInsertError,
  computeRetriggerRetryAfterMs,
  getPortraitReconcileAction,
  handleWorkflowPortraitBridge,
  isSignedPortraitWorkflowRequest,
  mapPortraitPublishOutcome,
  toPortraitProviderReservationResult,
  toPortraitWorkflowJobInput,
} from './index.ts';

const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';

async function sign(timestamp: string, nonce: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('portrait-bridge-test-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  ));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(body: Record<string, unknown>, nonce = NONCE): Promise<Request> {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify(body);
  return new Request('http://localhost/workflow-portrait-bridge', {
    method: 'POST',
    headers: {
      'x-workflow-timestamp': timestamp,
      'x-workflow-nonce': nonce,
      'x-workflow-signature': await sign(timestamp, nonce, rawBody),
    },
    body: rawBody,
  });
}

function createBridgeClient(options: { replay?: boolean } = {}) {
  const job = {
    id: JOB_ID,
    status: 'queued',
    output_key: 'portraits/new.webp',
    old_portrait_key: 'portraits/old.webp',
    provider_deadline_at: '2026-07-22T12:05:00.000Z',
    source_photo_key: 'private/source.jpg',
    style_reference_key: '_assets/styles/default.png',
    portrait_prompt: 'private prompt',
  };
  return {
    from(table: string) {
      if (table === 'portrait_generation_workflow_bridge_nonces') {
        return {
          insert: async () => ({ data: null, error: options.replay ? { code: '23505' } : null }),
          delete: () => ({ lt: async () => ({ error: null }) }),
        };
      }
      if (table === 'portrait_generation_jobs') {
        const selectBuilder = {
          eq: () => selectBuilder,
          maybeSingle: async () => ({ data: job, error: null }),
        };
        return {
          select: () => selectBuilder,
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function createHandlerClient(input: {
  status?: string;
  outputKey?: string;
  terminalStatus?: string;
  publishOutcome?: Record<string, unknown>;
  portraitMemberId?: string;
  taggedMemoryIds?: string[];
  youngMemoryCreatedAts?: string[];
  youngLookupFails?: boolean;
  neverResolvingSweep?: boolean;
  replay?: boolean;
}) {
  const calls = {
    rpc: [] as string[],
    rpcArgs: [] as Array<{ name: string; args: Record<string, unknown> }>,
    memberIds: [] as string[],
    sweeps: 0,
  };
  const job = {
    id: JOB_ID,
    status: input.status ?? 'queued',
    output_key: input.outputKey ?? 'portraits/new.webp',
    old_portrait_key: 'portraits/old.webp',
    provider_deadline_at: '2026-07-22T12:05:00.000Z',
    source_photo_key: 'private/source.jpg',
    style_reference_key: '_assets/styles/default.png',
    portrait_prompt: 'private prompt',
    family_id: '44444444-4444-4444-8444-444444444444',
    actor_user_id: '55555555-5555-4555-8555-555555555555',
    portrait_version_id: '66666666-6666-4666-8666-666666666666',
  };
  return {
    calls,
    client: {
      from(table: string) {
        if (table === 'portrait_generation_workflow_bridge_nonces') {
          return {
            insert: async () => ({ data: null, error: input.replay ? { code: '23505' } : null }),
            delete: () => ({
              lt: () => {
                calls.sweeps += 1;
                return input.neverResolvingSweep
                  ? new Promise<never>(() => {})
                  : Promise.resolve({ error: null });
              },
            }),
          };
        }
        if (table === 'portrait_generation_jobs') {
          const select = {
            eq: () => select,
            maybeSingle: async () => ({ data: job, error: null }),
          };
          return {
            select: () => select,
            update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          };
        }
        if (table === 'family_member_portrait_versions') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({
              data: { family_member_id: input.portraitMemberId ?? '77777777-7777-4777-8777-777777777777' },
              error: null,
            }) }) }),
          };
        }
        if (table === 'memory_family_members') {
          let young = false;
          const query = {
            select: () => query,
            eq: (column: string, value: string) => {
              if (column === 'family_member_id') calls.memberIds.push(value);
              return query;
            },
            lt: () => query,
            gte: () => {
              young = true;
              return query;
            },
            limit: async () => {
              if (young) {
                if (input.youngLookupFails) throw new Error('young lookup failed');
                return {
                  data: (input.youngMemoryCreatedAts ?? []).map((created_at, index) => ({
                    memory_id: `99999999-9999-4999-8999-99999999999${index}`,
                    memories: { created_at },
                  })),
                  error: null,
                };
              }
              return {
                data: (input.taggedMemoryIds ?? []).map((memory_id) => ({ memory_id })),
                error: null,
              };
            },
          };
          return query;
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        calls.rpc.push(name);
        calls.rpcArgs.push({ name, args });
        if (name === 'reserve_portrait_generation_provider_attempt') return { data: true, error: null };
        if (name === 'fail_portrait_generation_workflow_job') {
          return { data: [{ terminal_status: input.terminalStatus ?? 'failed', output_key: job.output_key }], error: null };
        }
        if (name === 'publish_portrait_generation_workflow_job' || name === 'reconcile_portrait_generation_workflow_job') {
          return { data: [input.publishOutcome ?? { published: true, already_published: false, old_key: job.old_portrait_key }], error: null };
        }
        if (name === 'record_ai_usage_event' || name === 'record_ai_usage_event_detailed') return { data: true, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
  };
}

async function withBridgeEnv(run: () => Promise<void>): Promise<void> {
  const entries = [
    ['CLOUDFLARE_PORTRAIT_BRIDGE_SECRET', 'portrait-bridge-test-secret'],
    ['SUPABASE_URL', 'https://supabase.test'],
    ['SUPABASE_ANON_KEY', 'test-anon-key'],
    ['PORTRAIT_MEMORY_RETRIGGER_SECRET', 'portrait-retrigger-test-secret'],
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

Deno.test('portrait bridge HMAC binds raw body and nonce', async () => {
  const previous = Deno.env.get('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET', 'portrait-bridge-test-secret');
  try {
    const timestamp = String(Date.now());
    const body = JSON.stringify({ operation: 'get_input', jobId: JOB_ID });
    const signature = await sign(timestamp, NONCE, body);
    const request = new Request('http://localhost', {
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': NONCE,
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedPortraitWorkflowRequest(request, body), true);
    const alteredNonce = new Request('http://localhost', {
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': '33333333-3333-4333-8333-333333333334',
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedPortraitWorkflowRequest(alteredNonce, body), false);
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET', previous);
  }
});

Deno.test('portrait bridge persists nonce replay protection before reading job input', async () => {
  const previous = Deno.env.get('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET', 'portrait-bridge-test-secret');
  try {
    const request = await signedRequest({ operation: 'get_input', jobId: JOB_ID });
    const response = await handleWorkflowPortraitBridge(request, {
      createServiceClient: () => createBridgeClient({ replay: true }) as never,
    });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'replayed_request');
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET', previous);
  }
});

Deno.test('portrait bridge handler validates narrow get, reserve, publish, fail, and reconcile operations', async () => {
  await withBridgeEnv(async () => {
    const getInput = createHandlerClient({});
    const getResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'get_input', jobId: JOB_ID }, '33333333-3333-4333-8333-333333333334'),
      { createServiceClient: () => getInput.client as never },
    );
    assertEquals(getResponse.status, 200);
    assertEquals((await getResponse.json()).job.sourcePhotoKey, 'private/source.jpg');

    const reserve = createHandlerClient({});
    const reserveResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'reserve_attempt', jobId: JOB_ID, provider: 'primary', model: 'gpt-image-2.6-flare', attemptNumber: 1 }, '33333333-3333-4333-8333-333333333335'),
      { createServiceClient: () => reserve.client as never },
    );
    assertEquals(await reserveResponse.json(), { reserved: true });
    assertEquals(reserve.calls.rpc, ['reserve_portrait_generation_provider_attempt']);

    const alreadyPublished = createHandlerClient({ publishOutcome: { published: false, already_published: true, old_key: 'portraits/old.webp' } });
    const publishResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'publish', jobId: JOB_ID, outputKey: 'portraits/new.webp', model: 'gpt-image-2.6-flare' }, '33333333-3333-4333-8333-333333333336'),
      { createServiceClient: () => alreadyPublished.client as never },
    );
    assertEquals(await publishResponse.json(), { published: true, oldPortraitKey: 'portraits/old.webp', deleteOutput: false });

    const mismatch = createHandlerClient({});
    const mismatchResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'publish', jobId: JOB_ID, outputKey: 'other.webp', model: 'gpt-image-2.6-flare' }, '33333333-3333-4333-8333-333333333337'),
      { createServiceClient: () => mismatch.client as never },
    );
    assertEquals(mismatchResponse.status, 409);
    assertEquals(mismatch.calls.rpc.length, 0);

    const failed = createHandlerClient({ terminalStatus: 'failed' });
    const failedResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'fail', jobId: JOB_ID, errorCode: 'TIMEOUT' }, '33333333-3333-4333-8333-333333333338'),
      { createServiceClient: () => failed.client as never },
    );
    assertEquals((await failedResponse.json()).deleteOutput, true);
    const succeededReplay = createHandlerClient({ terminalStatus: 'succeeded' });
    const succeededResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'fail', jobId: JOB_ID, errorCode: 'LATE_REPLAY' }, '33333333-3333-4333-8333-333333333339'),
      { createServiceClient: () => succeededReplay.client as never },
    );
    assertEquals((await succeededResponse.json()).deleteOutput, false);

    const superseded = createHandlerClient({ status: 'superseded' });
    const reconcileResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'reconcile', jobId: JOB_ID, outputKey: 'portraits/new.webp', model: 'gpt-image-2.6-flare' }, '33333333-3333-4333-8333-333333333340'),
      { createServiceClient: () => superseded.client as never },
    );
    assertEquals(await reconcileResponse.json(), { published: false, oldPortraitKey: null, deleteOutput: true });
  });
});

Deno.test('portrait bridge never lets an existing provider attempt enter OpenAI again', () => {
  assertEquals(toPortraitProviderReservationResult(true), { outcome: 'reserved_now', protocolVersion: 2 });
  assertEquals(toPortraitProviderReservationResult(false), { outcome: 'already_reserved', protocolVersion: 2 });
  assertEquals(toPortraitProviderReservationResult({ outcome: 'denied' }), { outcome: 'denied', protocolVersion: 2 });
});

Deno.test('portrait bridge records a real Worker-shaped v2 usage event with durable cost dimensions', async () => {
  await withBridgeEnv(async () => {
    const usageRequestId = '99999999-9999-4999-8999-999999999999';
    const handler = createHandlerClient({});
    const response = await handleWorkflowPortraitBridge(
      await signedRequest({
        operation: 'record_usage',
        jobId: JOB_ID,
        usageRequestId,
        protocolVersion: 2,
        provider: 'primary',
        attemptNumber: 1,
        aiCallId: `${usageRequestId}:primary:1`,
        aiOperation: 'image_generation',
        model: 'gpt-image-2.6-flare',
        success: true,
        billingStatus: 'known',
        pricingVersion: 'openai-image-2026-07-23',
        costBasis: 'provider_usage',
        costIsComplete: true,
        estimatedCostUsd: 0.0123,
        usage: {
          inputTextTokens: 10,
          inputImageTokens: 20,
          inputCachedTokens: 3,
          outputTextTokens: 4,
          outputImageTokens: 50,
          prompt: 'must not cross the bridge',
        },
      }, '33333333-3333-4333-8333-333333333343'),
      { createServiceClient: () => handler.client as never },
    );
    assertEquals(await response.json(), { recorded: true });
    const call = handler.calls.rpcArgs.find((entry) => entry.name === 'record_ai_usage_event');
    assertEquals(call?.args, {
      p_ai_call_id: `${usageRequestId}:primary:1`, p_usage_request_id: usageRequestId,
      p_job_kind: 'portrait', p_job_id: JOB_ID, p_provider: 'primary', p_attempt_number: 1,
      p_operation: 'portrait', p_model: 'gpt-image-2.6-flare',
      p_provider_usage: { inputTextTokens: 10, inputImageTokens: 20, inputCachedTokens: 3, outputTextTokens: 4, outputImageTokens: 50 },
      p_success: true, p_billing_status: 'known', p_pricing_version: 'openai-image-2026-07-23',
      p_cost_basis: 'provider_usage', p_cost_is_complete: true, p_estimated_cost_usd: 0.0123,
      p_input_text_tokens: 10, p_input_image_tokens: 20, p_cached_input_tokens: 3,
      p_output_text_tokens: 4, p_output_image_tokens: 50, p_audio_seconds: null,
    });
  });
});

Deno.test('portrait bridge records a grandfathered v1 Worker usage event with server-bound attribution only', async () => {
  await withBridgeEnv(async () => {
    const handler = createHandlerClient({});
    const response = await handleWorkflowPortraitBridge(
      await signedRequest({
        operation: 'record_usage', jobId: JOB_ID, usageRequestId: null, protocolVersion: 1,
        provider: 'primary', attemptNumber: 1, aiCallId: `${JOB_ID}:primary:1`, aiOperation: 'image_generation',
        model: 'gpt-image-2.6-flare', success: true, billingStatus: 'known', pricingVersion: 'openai-image-2026-07-23',
        costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: 0.0123,
        // These hostile fields are intentionally absent from the detailed RPC.
        familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        usage: { inputTextTokens: 10, inputImageTokens: 20, inputCachedTokens: 3, outputTextTokens: 4, outputImageTokens: 50 },
      }, '33333333-3333-4333-8333-333333333344'),
      { createServiceClient: () => handler.client as never },
    );
    assertEquals(await response.json(), { recorded: true });
    const call = handler.calls.rpcArgs.find((entry) => entry.name === 'record_ai_usage_event_detailed');
    assertEquals(call?.args, {
      p_ai_call_id: `${JOB_ID}:primary:1`, p_usage_request_id: null,
      p_family_id: '44444444-4444-4444-8444-444444444444', p_actor_user_id: '55555555-5555-4555-8555-555555555555',
      p_operation: 'portrait', p_model: 'gpt-image-2.6-flare', p_success: true,
      p_provider_usage: { provider: 'primary', input_text_tokens: 10, input_image_tokens: 20, cached_input_tokens: 3, output_text_tokens: 4, output_image_tokens: 50 },
      p_estimated_cost_usd: 0.0123, p_cost_basis: 'provider_usage', p_billing_status: 'known',
      p_cost_is_complete: true, p_pricing_version: 'openai-image-2026-07-23',
    });
  });
});

Deno.test('portrait bridge refuses a v1 usage event that tries to select a request or non-job call id', async () => {
  await withBridgeEnv(async () => {
    const handler = createHandlerClient({});
    const response = await handleWorkflowPortraitBridge(
      await signedRequest({
        operation: 'record_usage', jobId: JOB_ID, usageRequestId: '99999999-9999-4999-8999-999999999999', protocolVersion: 1,
        provider: 'primary', attemptNumber: 1, aiCallId: '99999999-9999-4999-8999-999999999999:primary:1', aiOperation: 'image_generation',
        model: 'gpt-image-2.6-flare', success: true,
      }, '33333333-3333-4333-8333-333333333345'),
      { createServiceClient: () => handler.client as never },
    );
    assertEquals(response.status, 400);
    assertEquals(handler.calls.rpc.includes('record_ai_usage_event_detailed'), false);
  });
});

Deno.test('portrait bridge retriggers only memories tagged with the resolved portrait member and propagates dispatch failures', async () => {
  await withBridgeEnv(async () => {
    const scoped = createHandlerClient({
      status: 'succeeded',
      portraitMemberId: '77777777-7777-4777-8777-777777777777',
      taggedMemoryIds: ['88888888-8888-4888-8888-888888888888'],
    });
    const recoveryBodies: string[] = [];
    const response = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'retrigger_memories', jobId: JOB_ID }, '33333333-3333-4333-8333-333333333341'),
      {
        createServiceClient: () => scoped.client as never,
        fetch: (async (_input, init) => {
          recoveryBodies.push(String(init?.body));
          return new Response(null, { status: 202 });
        }) as typeof fetch,
      },
    );
    assertEquals(await response.json(), { requested: 1, retryAfterMs: null });
    // Eligible query and young-memory lookup are both scoped to the same member.
    assertEquals(scoped.calls.memberIds, Array(2).fill('77777777-7777-4777-8777-777777777777'));
    assertEquals(JSON.parse(recoveryBodies[0]), {
      memoryId: '88888888-8888-4888-8888-888888888888',
      requestIntent: 'recovery',
      actorUserId: '55555555-5555-4555-8555-555555555555',
      familyId: '44444444-4444-4444-8444-444444444444',
    });

    const failing = createHandlerClient({ status: 'failed', taggedMemoryIds: ['88888888-8888-4888-8888-888888888888'] });
    const failingResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'retrigger_memories', jobId: JOB_ID }, '33333333-3333-4333-8333-333333333342'),
      {
        createServiceClient: () => failing.client as never,
        fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
      },
    );
    assertEquals(failingResponse.status, 500);
  });
});

Deno.test('portrait bridge exposes frozen input without legacy usage protocol fields', async () => {
  assertEquals(toPortraitWorkflowJobInput({
    id: JOB_ID,
    output_key: 'portraits/new.webp',
    old_portrait_key: 'portraits/old.webp',
    provider_deadline_at: '2026-07-22T12:05:00.000Z',
    source_photo_key: 'private/source.jpg',
    style_reference_key: '_assets/styles/default.png',
    portrait_prompt: 'private prompt',
  }), {
    job: {
      jobId: JOB_ID,
      outputKey: 'portraits/new.webp',
      oldPortraitKey: 'portraits/old.webp',
      providerDeadlineAt: '2026-07-22T12:05:00.000Z',
      sourcePhotoKey: 'private/source.jpg',
      styleReferenceKey: '_assets/styles/default.png',
      prompt: 'private prompt',
    },
  });
  assertEquals(mapPortraitPublishOutcome({ published: false, already_published: true, old_key: 'portraits/old.webp' }), {
    published: true,
    oldPortraitKey: 'portraits/old.webp',
    deleteOutput: false,
  });
  assertEquals(getPortraitReconcileAction({
    status: 'running', outputKey: 'portraits/new.webp', expectedOutputKey: 'portraits/new.webp',
  }), 'republish');
  assertEquals(getPortraitReconcileAction({
    status: 'superseded', outputKey: 'portraits/new.webp', expectedOutputKey: 'portraits/new.webp',
  }), 'delete');
  assertEquals(classifyPortraitNonceInsertError({ code: '23505' }), 'replay');
});

Deno.test('portrait bridge emits only complete v2 usage protocol fields', () => {
  const base = {
    id: JOB_ID,
    output_key: 'portraits/new.webp', old_portrait_key: null,
    provider_deadline_at: '2026-07-22T12:05:00.000Z', source_photo_key: 'private/source.jpg',
    style_reference_key: '_assets/styles/default.png', portrait_prompt: 'private prompt',
  };
  const usageRequestId = '99999999-9999-4999-8999-999999999999';
  assertEquals(toPortraitWorkflowJobInput({
    ...base, usage_request_id: usageRequestId, usage_protocol_version: 2,
  }).job, {
    jobId: JOB_ID, outputKey: 'portraits/new.webp', oldPortraitKey: null,
    providerDeadlineAt: base.provider_deadline_at, sourcePhotoKey: base.source_photo_key,
    styleReferenceKey: base.style_reference_key, prompt: base.portrait_prompt,
    usageRequestId, providerProtocolVersion: 2,
  });
  assertThrows(() => toPortraitWorkflowJobInput({
    ...base, usage_request_id: null, usage_protocol_version: 2,
  }), TypeError, 'requires a usage request id');
  assertThrows(() => toPortraitWorkflowJobInput({
    ...base, usage_request_id: null, usage_protocol_version: 3,
  }), TypeError, 'Unsupported portrait workflow usage protocol version');
});

Deno.test('portrait bridge retrigger reports when a young pending dependent memory will cross the 30s floor', async () => {
  await withBridgeEnv(async () => {
    const now = Date.now();
    const recoveryBodies: string[] = [];
    const run = async (input: Parameters<typeof createHandlerClient>[0], nonceSuffix: string) => {
      const handler = createHandlerClient({ status: 'succeeded', ...input });
      const response = await handleWorkflowPortraitBridge(
        await signedRequest({ operation: 'retrigger_memories', jobId: JOB_ID }, `33333333-3333-4333-8333-3333333333${nonceSuffix}`),
        {
          createServiceClient: () => handler.client as never,
          fetch: (async (_input, init) => {
            recoveryBodies.push(String(init?.body));
            return new Response(null, { status: 202 });
          }) as typeof fetch,
        },
      );
      assertEquals(response.status, 200);
      return await response.json() as { requested: number; retryAfterMs: number | null };
    };

    // Youngest-to-cross is the OLDEST of the young memories (created 12s and 4s ago).
    const young = await run({
      youngMemoryCreatedAts: [new Date(now - 4_000).toISOString(), new Date(now - 12_000).toISOString()],
    }, '51');
    assertEquals(young.requested, 0);
    assertEquals(young.retryAfterMs !== null, true);
    // 12s old => ~19s until 31s; allow scheduling slack.
    assertEquals(young.retryAfterMs! > 18_000 && young.retryAfterMs! <= 19_000, true);
    assertEquals(recoveryBodies.length, 0);

    // Old tagged memory still dispatches exactly as before alongside a young one.
    const mixed = await run({
      taggedMemoryIds: ['88888888-8888-4888-8888-888888888888'],
      youngMemoryCreatedAts: [new Date(now - 1_000).toISOString()],
    }, '52');
    assertEquals(mixed.requested, 1);
    assertEquals(mixed.retryAfterMs !== null && mixed.retryAfterMs > 29_000, true);
    assertEquals(recoveryBodies.length, 1);

    // No young memories => null.
    assertEquals((await run({ taggedMemoryIds: [] }, '53')).retryAfterMs, null);

    // An advisory lookup failure must not fail the operation.
    assertEquals((await run({ youngLookupFails: true }, '54')).retryAfterMs, null);
  });
});

Deno.test('computeRetriggerRetryAfterMs picks the first memory to cross the floor and clamps to [1s, 31s]', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assertEquals(computeRetriggerRetryAfterMs([], now), null);
  assertEquals(computeRetriggerRetryAfterMs([null, undefined, 'not a date'], now), null);
  assertEquals(computeRetriggerRetryAfterMs([ago(5_000), ago(20_000)], now), 11_000);
  assertEquals(computeRetriggerRetryAfterMs([ago(0)], now), 31_000);
  // Future-dated rows (clock skew) clamp to the 31s ceiling; already-crossed rows to 1s.
  assertEquals(computeRetriggerRetryAfterMs([new Date(now + 60_000).toISOString()], now), 31_000);
  assertEquals(computeRetriggerRetryAfterMs([ago(30_500)], now), 1_000);
});

Deno.test('portrait bridge keeps nonce replay rejection and does not wait for the nonce sweep', async () => {
  await withBridgeEnv(async () => {
    const replayed = createHandlerClient({ status: 'succeeded', replay: true });
    const replayResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'retrigger_memories', jobId: JOB_ID }, '33333333-3333-4333-8333-333333333361'),
      { createServiceClient: () => replayed.client as never },
    );
    assertEquals(replayResponse.status, 409);
    assertEquals(replayed.calls.sweeps, 0);

    // A sweep that never settles must not block the operation, and still ran.
    const hanging = createHandlerClient({ status: 'succeeded', neverResolvingSweep: true });
    const response = await Promise.race([
      handleWorkflowPortraitBridge(
        await signedRequest({ operation: 'retrigger_memories', jobId: JOB_ID }, '33333333-3333-4333-8333-333333333362'),
        { createServiceClient: () => hanging.client as never },
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    assertEquals(response === 'timeout', false);
    assertEquals((response as Response).status, 200);
    assertEquals(hanging.calls.sweeps, 1);
  });
});

// ---------------------------------------------------------------------------
// Living portraits: motion_* operations (docs/plans/living-portraits.md)
// ---------------------------------------------------------------------------

const MOTION_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const MOTION_MEMBER_ID = '77777777-7777-4777-8777-777777777777';
const MOTION_OWNER_ID = '55555555-5555-4555-8555-555555555555';
const MOTION_TOKEN = '88888888-8888-4888-8888-888888888888';
const MOTION_OUTPUT_KEY =
  `${MOTION_OWNER_ID}/family/${MOTION_MEMBER_ID}/portraits/${MOTION_VERSION_ID}/motion/${MOTION_TOKEN}.webp`;
const MOTION_STALE_KEY =
  `${MOTION_OWNER_ID}/family/${MOTION_MEMBER_ID}/portraits/${MOTION_VERSION_ID}/motion/99999999-9999-4999-8999-999999999999.webp`;

function createMotionClient(input: {
  claimRows?: Array<Record<string, unknown>>;
  versionOverrides?: Record<string, unknown>;
  noVersion?: boolean;
  noJob?: boolean;
  publishRows?: Array<Record<string, unknown>>;
  failResult?: boolean;
} = {}) {
  const calls = { rpc: [] as Array<{ name: string; args: Record<string, unknown> }> };
  const version = {
    id: MOTION_VERSION_ID,
    family_id: '44444444-4444-4444-8444-444444444444',
    user_id: MOTION_OWNER_ID,
    family_member_id: MOTION_MEMBER_ID,
    profile_picture_key: `${MOTION_OWNER_ID}/family/${MOTION_MEMBER_ID}/portraits/${MOTION_VERSION_ID}/photo.jpg`,
    illustrated_profile_key: 'still/current.webp',
    deletion_token: null,
    motion_status: 'pending',
    motion_token: MOTION_TOKEN,
    motion_source_key: 'still/current.webp',
    ...input.versionOverrides,
  };
  return {
    calls,
    client: {
      from(table: string) {
        if (table === 'portrait_generation_workflow_bridge_nonces') {
          return {
            insert: async () => ({ data: null, error: null }),
            delete: () => ({ lt: async () => ({ error: null }) }),
          };
        }
        const select = {
          eq: () => select,
          maybeSingle: async () => {
            if (table === 'portrait_generation_jobs') {
              return { data: input.noJob ? null : { portrait_version_id: MOTION_VERSION_ID }, error: null };
            }
            if (table === 'family_member_portrait_versions') {
              return { data: input.noVersion ? null : version, error: null };
            }
            throw new Error(`Unexpected table ${table}`);
          },
        };
        return { select: () => select };
      },
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        calls.rpc.push({ name, args });
        if (name === 'claim_portrait_motion') {
          return { data: input.claimRows ?? [{ outcome: 'claimed', motion_token: MOTION_TOKEN, stale_motion_key: null }], error: null };
        }
        if (name === 'publish_portrait_motion') {
          return { data: input.publishRows ?? [{ published: true, old_motion_key: null }], error: null };
        }
        if (name === 'fail_portrait_motion') return { data: input.failResult ?? true, error: null };
        if (name === 'record_ai_usage_event_detailed') return { data: true, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
  };
}

async function motionCall(
  body: Record<string, unknown>,
  client: ReturnType<typeof createMotionClient>,
  extra: { deleteObject?: (key: string) => Promise<void> } = {},
): Promise<Response> {
  let response: Response | undefined;
  await withBridgeEnv(async () => {
    response = await handleWorkflowPortraitBridge(
      await signedRequest(body, crypto.randomUUID()),
      {
        createServiceClient: () => client.client as never,
        deleteObject: extra.deleteObject ?? (async () => {}),
      },
    );
  });
  return response!;
}

Deno.test('motion_start claims motion for the job\'s version and returns the token', async () => {
  const client = createMotionClient();
  const response = await motionCall({ operation: 'motion_start', jobId: JOB_ID }, client);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { started: true, versionId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN });
  assertEquals(client.calls.rpc, [{ name: 'claim_portrait_motion', args: { p_version_id: MOTION_VERSION_ID, p_force: false } }]);
});

Deno.test('motion_start reports non-claimed outcomes without starting', async () => {
  for (const outcome of ['not_eligible', 'already_ready', 'in_flight', 'already_failed']) {
    const client = createMotionClient({ claimRows: [{ outcome, motion_token: null, stale_motion_key: null }] });
    const response = await motionCall({ operation: 'motion_start', jobId: JOB_ID }, client);
    assertEquals(await response.json(), { started: false, outcome });
  }
});

Deno.test('motion_start 404s for an unknown portrait job', async () => {
  const client = createMotionClient({ noJob: true });
  const response = await motionCall({ operation: 'motion_start', jobId: JOB_ID }, client);
  assertEquals(response.status, 404);
  assertEquals(client.calls.rpc.length, 0);
});

Deno.test('motion_start deletes the stale sheet best-effort and survives a delete failure', async () => {
  const deleted: string[] = [];
  const claimRows = [{ outcome: 'claimed', motion_token: MOTION_TOKEN, stale_motion_key: MOTION_STALE_KEY }];
  const ok = await motionCall(
    { operation: 'motion_start', jobId: JOB_ID },
    createMotionClient({ claimRows }),
    { deleteObject: async (key) => { deleted.push(key); } },
  );
  assertEquals((await ok.json()).started, true);
  assertEquals(deleted, [MOTION_STALE_KEY]);

  const failing = await motionCall(
    { operation: 'motion_start', jobId: JOB_ID },
    createMotionClient({ claimRows }),
    { deleteObject: async () => { throw new Error('r2 down'); } },
  );
  assertEquals(failing.status, 200);
  assertEquals((await failing.json()).started, true);
});

Deno.test('motion_start never deletes a stale key that is not a motion sheet', async () => {
  const deleted: string[] = [];
  const response = await motionCall(
    { operation: 'motion_start', jobId: JOB_ID },
    createMotionClient({ claimRows: [{ outcome: 'claimed', motion_token: MOTION_TOKEN, stale_motion_key: 'still/current.webp' }] }),
    { deleteObject: async (key) => { deleted.push(key); } },
  );
  assertEquals(response.status, 200);
  assertEquals(deleted, []);
});

Deno.test('motion_get_input returns the sheet contract for the current pending claim', async () => {
  const response = await motionCall(
    { operation: 'motion_get_input', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN },
    createMotionClient(),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.sourceKey, 'still/current.webp');
  assertEquals(body.outputKey, MOTION_OUTPUT_KEY);
  assertEquals(
    [body.columns, body.rows, body.size, body.model, body.quality, body.complexity],
    [3, 3, '1536x1536', 'gpt-image-2.6-flare', 'medium', 'medium'],
  );
  assertEquals(body.prompt.includes('Exactly 9 sequential frames arranged in a precise 3-column by 3-row grid'), true);
  assertEquals(body.prompt.includes('the ninth frame transitions smoothly'), true);
  assertEquals(body.checkPrompt.includes('same_person'), true);
});

Deno.test('motion_get_input is 409 MOTION_SUPERSEDED unless the token is the current pending claim', async () => {
  const cases: Array<Record<string, unknown>> = [
    { motion_token: '99999999-9999-4999-8999-999999999999' },
    { motion_status: 'ready' },
    { motion_status: 'failed' },
    { motion_source_key: 'still/older.webp' },
    { deletion_token: '11111111-1111-4111-8111-111111111111' },
  ];
  for (const versionOverrides of cases) {
    const response = await motionCall(
      { operation: 'motion_get_input', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN },
      createMotionClient({ versionOverrides }),
    );
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'MOTION_SUPERSEDED');
  }
  const missing = await motionCall(
    { operation: 'motion_get_input', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN },
    createMotionClient({ noVersion: true }),
  );
  assertEquals(missing.status, 409);
  const invalid = await motionCall(
    { operation: 'motion_get_input', jobId: MOTION_VERSION_ID, motionToken: 'not-a-uuid' },
    createMotionClient(),
  );
  assertEquals(invalid.status, 400);
});

Deno.test('motion_record_usage writes telemetry-only operations attributed to the version family', async () => {
  const base = {
    jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, success: true,
    billingStatus: 'known', costBasis: 'provider_usage', costIsComplete: true,
    pricingVersion: 'gpt-image-2.6-2026-11', estimatedCostUsd: 0.072,
    usage: { inputTextTokens: 300, inputImageTokens: 991, outputImageTokens: 2073, ignored: 'x' },
  };
  const image = createMotionClient();
  const imageResponse = await motionCall(
    { ...base, operation: 'motion_record_usage', aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare', aiOperation: 'image' },
    image,
  );
  assertEquals(await imageResponse.json(), { recorded: true });
  assertEquals(image.calls.rpc.length, 1);
  const imageArgs = image.calls.rpc[0].args;
  assertEquals(image.calls.rpc[0].name, 'record_ai_usage_event_detailed');
  assertEquals(imageArgs.p_operation, 'portrait_motion');
  assertEquals(imageArgs.p_family_id, '44444444-4444-4444-8444-444444444444');
  assertEquals(imageArgs.p_actor_user_id, MOTION_OWNER_ID);
  assertEquals(imageArgs.p_usage_request_id, null);
  assertEquals(imageArgs.p_provider_usage, { input_text_tokens: 300, input_image_tokens: 991, output_image_tokens: 2073 });
  assertEquals(imageArgs.p_estimated_cost_usd, 0.072);

  const check = createMotionClient();
  const checkResponse = await motionCall(
    { ...base, operation: 'motion_record_usage', aiCallId: `motion-check:${MOTION_TOKEN}:2`, model: 'gpt-4o-mini', estimatedCostUsd: 0.001, usage: { inputTextTokens: 900, outputTextTokens: 20 } },
    check,
  );
  assertEquals(await checkResponse.json(), { recorded: true });
  assertEquals(check.calls.rpc[0].args.p_operation, 'portrait_motion_check');
});

Deno.test('motion_record_usage rejects mismatched call ids, kinds and models', async () => {
  const base = { operation: 'motion_record_usage', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, success: true };
  const bad: Array<Record<string, unknown>> = [
    { aiCallId: `motion:${'99999999-9999-4999-8999-999999999999'}:1`, model: 'gpt-image-2.6-flare' },
    { aiCallId: `portrait:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare' },
    { aiCallId: `motion:${MOTION_TOKEN}:0`, model: 'gpt-image-2.6-flare' },
    { aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-4o-mini' },
    { aiCallId: `motion-check:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare' },
    { aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare', aiOperation: 'check' },
    { aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare', estimatedCostUsd: -1 },
    { aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare', success: 'yes' },
  ];
  for (const extra of bad) {
    const client = createMotionClient();
    const response = await motionCall({ ...base, ...extra }, client);
    assertEquals(response.status, 400, JSON.stringify(extra));
    assertEquals(client.calls.rpc.length, 0);
  }
});

Deno.test('motion_record_usage is a no-op for a deleted version', async () => {
  const client = createMotionClient({ noVersion: true });
  const response = await motionCall(
    { operation: 'motion_record_usage', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, success: true, aiCallId: `motion:${MOTION_TOKEN}:1`, model: 'gpt-image-2.6-flare' },
    client,
  );
  assertEquals(await response.json(), { recorded: false });
  assertEquals(client.calls.rpc.length, 0);
});

Deno.test('motion_publish passes the CAS arguments through and maps the outcome', async () => {
  const body = { operation: 'motion_publish', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, outputKey: MOTION_OUTPUT_KEY, columns: 3, rows: 3 };
  const published = createMotionClient({ publishRows: [{ published: true, old_motion_key: 'old/sheet.webp' }] });
  const response = await motionCall(body, published);
  assertEquals(await response.json(), { published: true, oldMotionKey: 'old/sheet.webp' });
  assertEquals(published.calls.rpc[0], {
    name: 'publish_portrait_motion',
    args: {
      p_version_id: MOTION_VERSION_ID, p_motion_token: MOTION_TOKEN, p_output_key: MOTION_OUTPUT_KEY,
      p_columns: 3, p_rows: 3,
    },
  });
  const superseded = createMotionClient({ publishRows: [{ published: false, old_motion_key: null }] });
  assertEquals(await (await motionCall(body, superseded)).json(), { published: false, oldMotionKey: null });
});

Deno.test('motion_publish validates the token, key and grid before touching the database', async () => {
  const base = { operation: 'motion_publish', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, outputKey: MOTION_OUTPUT_KEY, columns: 3, rows: 3 };
  const bad: Array<Record<string, unknown>> = [
    { motionToken: 'nope' }, { outputKey: '' }, { outputKey: 7 },
    { columns: 0 }, { columns: 5 }, { rows: 2.5 }, { rows: undefined },
  ];
  for (const extra of bad) {
    const client = createMotionClient();
    const response = await motionCall({ ...base, ...extra }, client);
    assertEquals(response.status, 400, JSON.stringify(extra));
    assertEquals(client.calls.rpc.length, 0);
  }
});

Deno.test('motion_fail maps the RPC result and validates the error code', async () => {
  const body = { operation: 'motion_fail', jobId: MOTION_VERSION_ID, motionToken: MOTION_TOKEN, errorCode: 'QA_FAILED' };
  const failed = createMotionClient();
  assertEquals(await (await motionCall(body, failed)).json(), { failed: true });
  assertEquals(failed.calls.rpc[0], {
    name: 'fail_portrait_motion',
    args: { p_version_id: MOTION_VERSION_ID, p_motion_token: MOTION_TOKEN, p_error_code: 'QA_FAILED' },
  });
  assertEquals(await (await motionCall(body, createMotionClient({ failResult: false }))).json(), { failed: false });
  const defaulted = createMotionClient();
  await motionCall({ ...body, errorCode: undefined }, defaulted);
  assertEquals(defaulted.calls.rpc[0].args.p_error_code, 'MOTION_FAILED');
  const tooLong = createMotionClient();
  assertEquals((await motionCall({ ...body, errorCode: 'x'.repeat(101) }, tooLong)).status, 400);
  assertEquals((await motionCall({ ...body, motionToken: 'nope' }, createMotionClient())).status, 400);
});

Deno.test('portrait bridge keeps rejecting unknown operations after adding motion operations', async () => {
  const response = await motionCall({ operation: 'motion_destroy', jobId: MOTION_VERSION_ID }, createMotionClient());
  assertEquals(response.status, 400);
});
