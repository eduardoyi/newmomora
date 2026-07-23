import { assertEquals } from 'jsr:@std/assert@1';
import {
  classifyPortraitNonceInsertError,
  getPortraitReconcileAction,
  handleWorkflowPortraitBridge,
  isSignedPortraitWorkflowRequest,
  mapPortraitPublishOutcome,
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
}) {
  const calls = { rpc: [] as string[], memberIds: [] as string[] };
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
            insert: async () => ({ data: null, error: null }),
            delete: () => ({ lt: async () => ({ error: null }) }),
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
          const query = {
            select: () => query,
            eq: (column: string, value: string) => {
              if (column === 'family_member_id') calls.memberIds.push(value);
              return query;
            },
            lt: () => query,
            limit: async () => ({
              data: (input.taggedMemoryIds ?? []).map((memory_id) => ({ memory_id })),
              error: null,
            }),
          };
          return query;
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (name: string) => {
        calls.rpc.push(name);
        if (name === 'reserve_portrait_generation_provider_attempt') return { data: true, error: null };
        if (name === 'fail_portrait_generation_workflow_job') {
          return { data: [{ terminal_status: input.terminalStatus ?? 'failed', output_key: job.output_key }], error: null };
        }
        if (name === 'publish_portrait_generation_workflow_job' || name === 'reconcile_portrait_generation_workflow_job') {
          return { data: [input.publishOutcome ?? { published: true, already_published: false, old_key: job.old_portrait_key }], error: null };
        }
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
      await signedRequest({ operation: 'reserve_attempt', jobId: JOB_ID, provider: 'primary', model: 'gpt-image-2', attemptNumber: 1 }, '33333333-3333-4333-8333-333333333335'),
      { createServiceClient: () => reserve.client as never },
    );
    assertEquals(await reserveResponse.json(), { reserved: true });
    assertEquals(reserve.calls.rpc, ['reserve_portrait_generation_provider_attempt']);

    const alreadyPublished = createHandlerClient({ publishOutcome: { published: false, already_published: true, old_key: 'portraits/old.webp' } });
    const publishResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'publish', jobId: JOB_ID, outputKey: 'portraits/new.webp', model: 'gpt-image-2' }, '33333333-3333-4333-8333-333333333336'),
      { createServiceClient: () => alreadyPublished.client as never },
    );
    assertEquals(await publishResponse.json(), { published: true, oldPortraitKey: 'portraits/old.webp', deleteOutput: false });

    const mismatch = createHandlerClient({});
    const mismatchResponse = await handleWorkflowPortraitBridge(
      await signedRequest({ operation: 'publish', jobId: JOB_ID, outputKey: 'other.webp', model: 'gpt-image-2' }, '33333333-3333-4333-8333-333333333337'),
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
      await signedRequest({ operation: 'reconcile', jobId: JOB_ID, outputKey: 'portraits/new.webp', model: 'gpt-image-2' }, '33333333-3333-4333-8333-333333333340'),
      { createServiceClient: () => superseded.client as never },
    );
    assertEquals(await reconcileResponse.json(), { published: false, oldPortraitKey: null, deleteOutput: true });
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
    assertEquals(await response.json(), { requested: 1 });
    assertEquals(scoped.calls.memberIds, ['77777777-7777-4777-8777-777777777777']);
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

Deno.test('portrait bridge exposes only frozen input and normalizes already-published cleanup', async () => {
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
