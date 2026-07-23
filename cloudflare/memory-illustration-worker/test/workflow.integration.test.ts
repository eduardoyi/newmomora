import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import worker from '../src/index';
import { hmacSha256Hex } from '../src/crypto';
import { MemoryIllustrationWorkflow } from '../src/workflow';
import type { WorkflowJobInput } from '../src/types';

const JOB_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661112';
const UPLOAD_TOKEN = '50abcc52-5c0d-4b7b-86d4-1b3a0a661199';
const NOW_DEADLINE = new Date(Date.now() + 5 * 60 * 1000).toISOString();

interface StoredObject {
  bytes: ArrayBuffer;
  customMetadata?: Record<string, string>;
}

function stream(bytes: number[] = [1, 2, 3]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function createBucket(initial: Record<string, StoredObject> = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    objects,
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { body: stream(Array.from(new Uint8Array(object.bytes))) } : null;
    }),
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { customMetadata: object.customMetadata } : null;
    }),
    put: vi.fn(async (
      key: string,
      bytes: ArrayBuffer,
      options?: { customMetadata?: Record<string, string> },
    ): Promise<{ key: string } | null> => {
      objects.set(key, { bytes, customMetadata: options?.customMetadata });
      return { key };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
}

function job(overrides: Partial<WorkflowJobInput> = {}): WorkflowJobInput {
  return {
    jobId: JOB_ID,
    outputKey: 'owner/memories/memory/generation.webp',
    oldIllustrationKey: 'owner/memories/memory/old.webp',
    providerDeadlineAt: NOW_DEADLINE,
    safeSceneDescription: 'A child builds a tower.',
    expressionStyle: 'neutral',
    styleDescription: 'storybook',
    colorPalette: 'warm yellow',
    emotion: 'pride',
    memoryDate: '2026-07-21',
    referenceCandidates: [{
      memberId: 'member-id',
      description: 'A child with dark hair.',
      portraitKey: 'portrait.webp',
      portraitContentType: 'image/webp',
      profileKey: 'profile.jpg',
      profileContentType: 'image/jpeg',
    }],
    ...overrides,
  };
}

function createEnvironment(workflowJob = job(), outputInitial: Record<string, StoredObject> = {}) {
  const output = createBucket(outputInitial);
  const portraits = createBucket({ 'portrait.webp': { bytes: new Uint8Array([9, 8, 7]).buffer } });
  const profiles = createBucket({ 'profile.jpg': { bytes: new Uint8Array([6, 5, 4]).buffer } });
  const transform = {
    transform: () => transform,
    output: async () => ({ image: () => stream([4, 5, 6]) }),
  };
  const env = {
    MEMORY_ILLUSTRATIONS: output,
    CHARACTER_PORTRAITS: portraits,
    PROFILE_PICTURES: profiles,
    IMAGES: { input: () => transform },
    OPENAI_API_KEY: 'test-openai-key',
    SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-illustration-bridge',
    SUPABASE_BRIDGE_HMAC_SECRET: 'bridge-secret',
    DISPATCH_SIGNING_SECRET: 'dispatch-secret',
  } as unknown as Env;
  return { env, output, portraits, profiles, workflowJob };
}

function fakeStep(): WorkflowStep {
  return {
    do: async (_name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      return await (callback as (context: unknown) => Promise<unknown>)({});
    },
  } as unknown as WorkflowStep;
}

function serializingFakeStep(): WorkflowStep {
  return {
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      try {
        return await (callback as () => Promise<unknown>)();
      } catch (error) {
        if (name === 'generate and upload illustration' &&
          error instanceof Error && error.message === 'UPLOAD_OUTCOME_AMBIGUOUS') {
          throw { message: 'UPLOAD_OUTCOME_AMBIGUOUS', code: 1234 };
        }
        throw error;
      }
    },
  } as unknown as WorkflowStep;
}

function workflowWithEnv(env: Env): MemoryIllustrationWorkflow {
  const workflow = Object.create(MemoryIllustrationWorkflow.prototype) as MemoryIllustrationWorkflow;
  (workflow as unknown as { env: Env }).env = env;
  return workflow;
}

function bridgeAndOpenAiFetch(
  input: WorkflowJobInput,
  options: {
    primaryResponses?: Array<Response>;
    publish?: Response;
    reconcile?: Response;
    bridgeResponses?: Partial<Record<string, Response[]>>;
  } = {},
) {
  const operations: Array<Record<string, unknown>> = [];
  const primaryResponses = options.primaryResponses ?? [Response.json({ data: [{ b64_json: 'AQI=' }] })];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url);
    if (urlString.includes('api.openai.com')) {
      return primaryResponses.shift() ?? Response.json({ data: [{ b64_json: 'AQI=' }] });
    }
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    operations.push(request);
    const queuedResponse = options.bridgeResponses?.[String(request.operation)]?.shift();
    if (queuedResponse) return queuedResponse;
    switch (request.operation) {
      case 'get_input': return Response.json({ job: input });
      case 'reserve_attempt': return Response.json({ reserved: true });
      case 'record_prompt': return Response.json({ recorded: true });
      case 'authorize_upload': return Response.json({
        authorized: true,
        uploadToken: UPLOAD_TOKEN,
        existingLease: false,
      });
      case 'record_upload_complete': return Response.json({ completed: true });
      case 'publish': return options.publish ?? Response.json({
        published: true,
        oldIllustrationKey: input.oldIllustrationKey,
        deleteOutput: false,
      });
      case 'reconcile': return options.reconcile ?? Response.json({
        published: true,
        oldIllustrationKey: input.oldIllustrationKey,
        deleteOutput: false,
      });
      case 'fail': return Response.json({ failed: true, outputKey: null, deleteOutput: false });
      default: throw new Error('unexpected bridge operation');
    }
  });
  return { fetchMock, operations };
}

describe('dispatch endpoint authentication', () => {
  it('accepts valid signed dispatch and treats duplicate Workflow IDs as 202', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: JOB_ID })
      .mockRejectedValueOnce(new Error('Workflow instance already exists'));
    const env = { DISPATCH_SIGNING_SECRET: 'dispatch-secret', MEMORY_ILLUSTRATION_WORKFLOW: { create } } as unknown as Env;
    const body = JSON.stringify({ jobId: JOB_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661114';
    const signature = await hmacSha256Hex('dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const signedRequest = () => new Request('https://worker.test/dispatch', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature,
      },
      body,
    });

    expect((await worker.fetch(signedRequest(), env)).status).toBe(202);
    expect((await worker.fetch(signedRequest(), env)).status).toBe(202);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects tampered and stale dispatch signatures before Workflow creation', async () => {
    const create = vi.fn();
    const env = { DISPATCH_SIGNING_SECRET: 'dispatch-secret', MEMORY_ILLUSTRATION_WORKFLOW: { create } } as unknown as Env;
    const body = JSON.stringify({ jobId: JOB_ID });
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661115';
    const signature = await hmacSha256Hex('dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const response = await worker.fetch(new Request('https://worker.test/dispatch', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature.slice(0, -1) + '0',
      },
      body,
    }), env);
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Workflow integration', () => {
  it('publishes an image, stores canonical metadata, and deletes the previous object', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready', model: 'gpt-image-2' });
    expect(setup.output.put).toHaveBeenCalledWith(
      setup.workflowJob.outputKey,
      expect.any(ArrayBuffer),
      expect.objectContaining({ customMetadata: { model: 'gpt-image-2' } }),
    );
    expect(setup.output.delete).toHaveBeenCalledWith(setup.workflowJob.oldIllustrationKey);
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'record_prompt', 'reserve_attempt', 'authorize_upload', 'record_upload_complete', 'publish',
    ]);
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'record_upload_complete',
      outputKey: setup.workflowJob.outputKey,
      uploadToken: UPLOAD_TOKEN,
    }));
  });

  it('makes at most two primary reservations before a successful fallback', async () => {
    const setup = createEnvironment();
    const retryable = () => Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      primaryResponses: [retryable(), retryable(), Response.json({ data: [{ b64_json: 'AQI=' }] })],
    });
    vi.stubGlobal('fetch', fetchMock);

    await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toEqual([
      expect.objectContaining({ provider: 'primary', model: 'gpt-image-2', attemptNumber: 1 }),
      expect.objectContaining({ provider: 'primary', model: 'gpt-image-2', attemptNumber: 2 }),
      expect.objectContaining({ provider: 'fallback', model: 'gpt-image-1.5', attemptNumber: 1 }),
    ]);
  });

  it('records moderation as terminal and does not call the fallback', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      primaryResponses: [Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 })],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'MODERATION_BLOCKED' });
    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toHaveLength(1);
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'fail', errorCode: 'MODERATION_BLOCKED' }));
  });

  it('fails before OpenAI when no reference can be loaded', async () => {
    const setup = createEnvironment(job({ referenceCandidates: [{
      memberId: 'member-id', description: 'A child', portraitKey: null, portraitContentType: null, profileKey: null, profileContentType: null,
    }] }));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'NO_USABLE_REFERENCES' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'fail', errorCode: 'NO_USABLE_REFERENCES' }));
  });

  it('reconciles a lost publish response and deletes a superseded output', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      publish: new Response('unavailable', { status: 503 }),
      reconcile: Response.json({ published: false, oldIllustrationKey: null, deleteOutput: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'superseded' });
    expect(operations.map((operation) => operation.operation)).toContain('reconcile');
    expect(setup.output.delete).toHaveBeenCalledWith(setup.workflowJob.outputKey);
  });

  it('replays a deterministic object with a new no-op upload lease before publish', async () => {
    const input = job();
    const setup = createEnvironment(input, {
      [input.outputKey]: { bytes: new Uint8Array([1]).buffer, customMetadata: { model: 'gpt-image-1.5' } },
    });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(input);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready', model: 'gpt-image-1.5' });
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'authorize_upload', 'record_upload_complete', 'publish',
    ]);
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'record_upload_complete',
      uploadToken: UPLOAD_TOKEN,
    }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
  });

  it('clears the exact active upload lease on deterministic HEAD recovery before publish', async () => {
    const input = job();
    const setup = createEnvironment(input, {
      [input.outputKey]: { bytes: new Uint8Array([1]).buffer, customMetadata: { model: 'gpt-image-2' } },
    });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(input, {
      bridgeResponses: {
        authorize_upload: [Response.json({
          authorized: true,
          uploadToken: UPLOAD_TOKEN,
          existingLease: true,
        })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.output.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'authorize_upload', 'record_upload_complete', 'publish',
    ]);
  });

  it('does not publish an existing object when its upload lease cannot be authorized', async () => {
    const input = job();
    const setup = createEnvironment(input, {
      [input.outputKey]: { bytes: new Uint8Array([1]).buffer, customMetadata: { model: 'gpt-image-2' } },
    });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(input, {
      bridgeResponses: {
        authorize_upload: [Response.json({ authorized: false, uploadToken: null, existingLease: false })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'UPLOAD_NOT_AUTHORIZED' });
    expect(operations.map((operation) => operation.operation)).not.toContain('publish');
    expect(setup.output.delete).not.toHaveBeenCalled();
  });

  it('recovers a transient get_input bridge failure before any provider call', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: { get_input: [new Response('unavailable', { status: 503 })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready' });
    expect(operations.filter((operation) => operation.operation === 'get_input')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
  });

  it('retries an idempotent R2 PUT under one lease, then clears that exact token after success', async () => {
    const setup = createEnvironment();
    setup.output.put.mockRejectedValueOnce(new Error('temporary R2 failure'));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.output.put).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'authorize_upload')).toHaveLength(1);
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'record_upload_complete',
      uploadToken: UPLOAD_TOKEN,
    }));
  });

  it('leaves exhausted R2 PUTs leased for recovery without clearing or terminal cleanup', async () => {
    const setup = createEnvironment();
    setup.output.put.mockRejectedValue(new Error('ambiguous R2 failure'));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    )).rejects.toMatchObject({ code: 'UPLOAD_OUTCOME_AMBIGUOUS' });

    expect(setup.output.put).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'authorize_upload')).toHaveLength(1);
    expect(operations.map((operation) => operation.operation)).not.toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
    expect(setup.output.delete).not.toHaveBeenCalled();
  });

  it('treats a null R2 PUT result as ambiguous and never clears its lease', async () => {
    const setup = createEnvironment();
    setup.output.put.mockResolvedValue(null);
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep(),
    )).rejects.toMatchObject({ code: 'UPLOAD_OUTCOME_AMBIGUOUS' });

    expect(setup.output.put).toHaveBeenCalledTimes(3);
    expect(operations.map((operation) => operation.operation)).not.toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
  });

  it('never overwrites an object that appears under an existing lease after the initial HEAD miss', async () => {
    const setup = createEnvironment();
    setup.output.head
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ customMetadata: { model: 'gpt-image-2' } });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        authorize_upload: [Response.json({
          authorized: true,
          uploadToken: UPLOAD_TOKEN,
          existingLease: true,
        })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.output.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).toContain('publish');
  });

  it('keeps an existing lease ambiguous when its object is still not visible after the provider call', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        authorize_upload: [Response.json({
          authorized: true,
          uploadToken: UPLOAD_TOKEN,
          existingLease: true,
        })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep(),
    )).rejects.toMatchObject({ code: 'UPLOAD_OUTCOME_AMBIGUOUS' });

    expect(setup.output.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).not.toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
  });

  it('never PUTs when the upload lease is rejected', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        authorize_upload: [Response.json({ authorized: false, uploadToken: null, existingLease: false })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'UPLOAD_NOT_AUTHORIZED' });
    expect(setup.output.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).not.toContain('record_upload_complete');
  });

  it('keeps a successful PUT when upload completion remains ambiguous', async () => {
    const setup = createEnvironment();
    const unavailable = () => new Response('response lost', { status: 503 });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        record_upload_complete: [unavailable(), unavailable(), unavailable()],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep(),
    )).rejects.toMatchObject({ code: 'UPLOAD_OUTCOME_AMBIGUOUS' });

    expect(setup.output.put).toHaveBeenCalledTimes(1);
    expect(setup.output.objects.has(setup.workflowJob.outputKey)).toBe(true);
    expect(operations.filter((operation) => operation.operation === 'record_upload_complete')).toHaveLength(3);
    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
    expect(setup.output.delete).not.toHaveBeenCalled();
  });

  it('recognizes a serialized ambiguous upload error and still skips terminal cleanup', async () => {
    const setup = createEnvironment();
    setup.output.put.mockRejectedValue(new Error('ambiguous R2 failure'));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, serializingFakeStep(),
    )).rejects.toMatchObject({ message: 'UPLOAD_OUTCOME_AMBIGUOUS' });

    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
    expect(setup.output.delete).not.toHaveBeenCalled();
  });

  it('deletes the exact memory output returned by a terminal failure, but not a succeeded replay', async () => {
    const retryableFailure = () => Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 });
    const failed = createEnvironment();
    const failedFetch = bridgeAndOpenAiFetch(failed.workflowJob, {
      primaryResponses: [retryableFailure()],
      bridgeResponses: {
        fail: [Response.json({ failed: true, outputKey: failed.workflowJob.outputKey, deleteOutput: true })],
      },
    });
    vi.stubGlobal('fetch', failedFetch.fetchMock);
    await workflowWithEnv(failed.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());
    expect(failed.output.delete).toHaveBeenCalledWith(failed.workflowJob.outputKey);

    const succeeded = createEnvironment();
    const succeededFetch = bridgeAndOpenAiFetch(succeeded.workflowJob, {
      primaryResponses: [retryableFailure()],
      bridgeResponses: {
        fail: [Response.json({ failed: false, outputKey: succeeded.workflowJob.outputKey, deleteOutput: false })],
      },
    });
    vi.stubGlobal('fetch', succeededFetch.fetchMock);
    await workflowWithEnv(succeeded.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());
    expect(succeeded.output.delete).not.toHaveBeenCalledWith(succeeded.workflowJob.outputKey);
  });

  it('fails closed when a reservation response is lost and its exact slot is already consumed', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        reserve_attempt: [
          new Response('committed but response lost', { status: 503 }),
          Response.json({ reserved: false }),
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run({ payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'ATTEMPT_CAP_EXHAUSTED' });
    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toEqual([
      expect.objectContaining({ provider: 'primary', attemptNumber: 1 }),
      expect.objectContaining({ provider: 'primary', attemptNumber: 1 }),
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
  });

  it('does not repeat a paid call when a consumed memory reservation is replayed', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: { reserve_attempt: [Response.json({ reserved: false })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'ATTEMPT_CAP_EXHAUSTED' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toHaveLength(1);
  });
});
