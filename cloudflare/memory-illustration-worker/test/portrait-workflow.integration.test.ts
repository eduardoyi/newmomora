import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import worker from '../src/index';
import { hmacSha256Hex } from '../src/crypto';
import { PortraitGenerationWorkflow } from '../src/portrait-workflow';
import type { PortraitWorkflowJobInput } from '../src/types';

const JOB_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661222';
const UPLOAD_TOKEN = '50abcc52-5c0d-4b7b-86d4-1b3a0a661199';

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

function job(overrides: Partial<PortraitWorkflowJobInput> = {}): PortraitWorkflowJobInput {
  return {
    jobId: JOB_ID,
    outputKey: 'owner/family/member/portraits/version/portrait/attempt.webp',
    oldPortraitKey: 'owner/family/member/portraits/version/portrait/old.webp',
    providerDeadlineAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    prompt: 'Create the canonical illustrated portrait using the two supplied references.',
    sourcePhotoKey: 'owner/family/member/portraits/version/photo.jpg',
    styleReferenceKey: '_assets/styles/default.png',
    ...overrides,
  };
}

function createEnvironment(workflowJob = job(), outputInitial: Record<string, StoredObject> = {}) {
  const portraits = createBucket(outputInitial);
  const profiles = createBucket({ [workflowJob.sourcePhotoKey]: { bytes: new Uint8Array([9, 8, 7]).buffer } });
  const styles = createBucket({ [workflowJob.styleReferenceKey]: { bytes: new Uint8Array([6, 5, 4]).buffer } });
  let transformNumber = 0;
  const images = {
    input: () => {
      transformNumber += 1;
      const bytes = transformNumber === 1 ? [4, 5, 6] : [7, 8, 9];
      const transform = {
        transform: () => transform,
        output: async () => ({ image: () => stream(bytes) }),
      };
      return transform;
    },
  };
  const env = {
    CHARACTER_PORTRAITS: portraits,
    PROFILE_PICTURES: profiles,
    STYLE_REFERENCES: styles,
    IMAGES: images,
    OPENAI_API_KEY: 'test-openai-key',
    PORTRAIT_SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-portrait-bridge',
    PORTRAIT_SUPABASE_BRIDGE_HMAC_SECRET: 'portrait-bridge-secret',
    PORTRAIT_DISPATCH_SIGNING_SECRET: 'portrait-dispatch-secret',
    DISPATCH_SIGNING_SECRET: 'memory-dispatch-secret',
    SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-illustration-bridge',
    SUPABASE_BRIDGE_HMAC_SECRET: 'memory-bridge-secret',
  } as unknown as Env;
  return { env, portraits, profiles, styles, workflowJob };
}

function fakeStep(): WorkflowStep {
  return {
    do: async (_name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      return await (callback as () => Promise<unknown>)();
    },
  } as unknown as WorkflowStep;
}

function workflowWithEnv(env: Env): PortraitGenerationWorkflow {
  const workflow = Object.create(PortraitGenerationWorkflow.prototype) as PortraitGenerationWorkflow;
  (workflow as unknown as { env: Env }).env = env;
  return workflow;
}

function bridgeAndOpenAiFetch(
  input: PortraitWorkflowJobInput,
  options: {
    openAiResponses?: Response[];
    publish?: Response;
    reconcile?: Response;
    bridgeResponses?: Partial<Record<string, Response[]>>;
  } = {},
) {
  const operations: Array<Record<string, unknown>> = [];
  const imageForms: FormData[] = [];
  const openAiResponses = options.openAiResponses ?? [Response.json({ data: [{ b64_json: 'AQI=' }] })];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('api.openai.com')) {
      imageForms.push(init?.body as FormData);
      return openAiResponses.shift() ?? Response.json({ data: [{ b64_json: 'AQI=' }] });
    }
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    operations.push(request);
    const queuedResponse = options.bridgeResponses?.[String(request.operation)]?.shift();
    if (queuedResponse) return queuedResponse;
    switch (request.operation) {
      case 'get_input': return Response.json({ job: input });
      case 'reserve_attempt': return Response.json({ reserved: true });
      case 'authorize_upload': return Response.json({
        authorized: true,
        uploadToken: UPLOAD_TOKEN,
        existingLease: false,
      });
      case 'record_upload_complete': return Response.json({ completed: true });
      case 'publish': return options.publish ?? Response.json({
        published: true,
        oldPortraitKey: input.oldPortraitKey,
        deleteOutput: false,
      });
      case 'reconcile': return options.reconcile ?? Response.json({
        published: true,
        oldPortraitKey: input.oldPortraitKey,
        deleteOutput: false,
      });
      case 'fail': return Response.json({ failed: true, outputKey: null, deleteOutput: false });
      case 'retrigger_memories': return Response.json({ requested: true });
      default: throw new Error('unexpected bridge operation');
    }
  });
  return { fetchMock, imageForms, operations };
}

afterEach(() => vi.unstubAllGlobals());

describe('portrait dispatch authentication', () => {
  it('uses its own HMAC secret and treats an existing instance as a successful 202', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: JOB_ID })
      .mockRejectedValueOnce(new Error('Workflow instance already exists'));
    const env = {
      PORTRAIT_DISPATCH_SIGNING_SECRET: 'portrait-dispatch-secret',
      PORTRAIT_GENERATION_WORKFLOW: { create },
    } as unknown as Env;
    const body = JSON.stringify({ jobId: JOB_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661223';
    const signature = await hmacSha256Hex('portrait-dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const request = () => new Request('https://worker.test/dispatch/portrait', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature,
      },
      body,
    });

    expect((await worker.fetch(request(), env)).status).toBe(202);
    expect((await worker.fetch(request(), env)).status).toBe(202);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a valid memory-dispatch signature before portrait Workflow creation', async () => {
    const create = vi.fn();
    const env = {
      PORTRAIT_DISPATCH_SIGNING_SECRET: 'portrait-dispatch-secret',
      PORTRAIT_GENERATION_WORKFLOW: { create },
    } as unknown as Env;
    const body = JSON.stringify({ jobId: JOB_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661224';
    const wrongSignature = await hmacSha256Hex('memory-dispatch-secret', `${timestamp}.${nonce}.${body}`);

    const response = await worker.fetch(new Request('https://worker.test/dispatch/portrait', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': wrongSignature,
      },
      body,
    }), env);

    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('portrait Workflow', () => {
  it('uses style then source references, sends canonical WebP options, publishes, then deletes the previous portrait', async () => {
    const setup = createEnvironment();
    const { fetchMock, imageForms, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'ready', model: 'gpt-image-2' });
    expect(setup.styles.get).toHaveBeenCalledWith(setup.workflowJob.styleReferenceKey);
    expect(setup.profiles.get).toHaveBeenCalledWith(setup.workflowJob.sourcePhotoKey);
    expect(setup.styles.get.mock.invocationCallOrder[0]).toBeLessThan(setup.profiles.get.mock.invocationCallOrder[0]);
    expect(imageForms).toHaveLength(1);
    const form = imageForms[0];
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('size')).toBe('1024x1024');
    expect(form.get('output_format')).toBe('webp');
    expect(form.get('output_compression')).toBe('85');
    expect(form.get('quality')).toBeNull();
    expect(form.get('input_fidelity')).toBeNull();
    const files = form.getAll('image[]') as File[];
    expect(files).toHaveLength(2);
    expect(Array.from(new Uint8Array(await files[0].arrayBuffer()))).toEqual([4, 5, 6]);
    expect(Array.from(new Uint8Array(await files[1].arrayBuffer()))).toEqual([7, 8, 9]);
    expect(setup.portraits.put).toHaveBeenCalledWith(
      setup.workflowJob.outputKey,
      expect.any(ArrayBuffer),
      expect.objectContaining({ httpMetadata: { contentType: 'image/webp' }, customMetadata: { model: 'gpt-image-2' } }),
    );
    expect(setup.portraits.delete).toHaveBeenCalledWith(setup.workflowJob.oldPortraitKey);
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'reserve_attempt', 'authorize_upload', 'record_upload_complete', 'publish', 'retrigger_memories',
    ]);
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'record_upload_complete',
      jobId: JOB_ID,
      outputKey: setup.workflowJob.outputKey,
      uploadToken: UPLOAD_TOKEN,
    }));
  });

  it('allows exactly one retryable primary and one high-fidelity fallback, never a text-only call', async () => {
    const setup = createEnvironment();
    const { fetchMock, imageForms, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      openAiResponses: [
        Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }),
        Response.json({ data: [{ b64_json: 'AQI=' }] }),
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'ready', model: 'gpt-image-1.5' });
    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toEqual([
      expect.objectContaining({ provider: 'primary', model: 'gpt-image-2', attemptNumber: 1 }),
      expect.objectContaining({ provider: 'fallback', model: 'gpt-image-1.5', attemptNumber: 1 }),
    ]);
    expect(imageForms).toHaveLength(2);
    expect(imageForms[1].get('input_fidelity')).toBe('high');
    expect(imageForms[1].get('quality')).toBeNull();
    expect(imageForms[1].getAll('image[]')).toHaveLength(2);
  });

  it('does not fall back after moderation and records a terminal failure before retriggering waiting memories', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      openAiResponses: [Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 })],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'failed', code: 'MODERATION_BLOCKED' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'fail', errorCode: 'MODERATION_BLOCKED' }));
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'retrigger_memories' }));
  });

  it('deletes only the exact portrait output authorized by terminal failure state', async () => {
    const moderation = () => Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 });
    const failed = createEnvironment();
    const failedFetch = bridgeAndOpenAiFetch(failed.workflowJob, {
      openAiResponses: [moderation()],
      bridgeResponses: {
        fail: [Response.json({
          failed: true,
          outputKey: failed.workflowJob.outputKey,
          deleteOutput: true,
        })],
      },
    });
    vi.stubGlobal('fetch', failedFetch.fetchMock);
    await workflowWithEnv(failed.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());
    expect(failed.portraits.delete).toHaveBeenCalledWith(failed.workflowJob.outputKey);
    expect(failed.portraits.delete).not.toHaveBeenCalledWith(failed.workflowJob.oldPortraitKey);

    const succeededReplay = createEnvironment();
    const replayFetch = bridgeAndOpenAiFetch(succeededReplay.workflowJob, {
      openAiResponses: [moderation()],
      bridgeResponses: {
        fail: [Response.json({
          failed: false,
          outputKey: succeededReplay.workflowJob.outputKey,
          deleteOutput: false,
        })],
      },
    });
    vi.stubGlobal('fetch', replayFetch.fetchMock);
    await workflowWithEnv(succeededReplay.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());
    expect(succeededReplay.portraits.delete).not.toHaveBeenCalled();
  });

  it('fails with an explicit reference error before reserving or calling OpenAI', async () => {
    const setup = createEnvironment();
    setup.styles.get.mockResolvedValueOnce(null);
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'failed', code: 'STYLE_REFERENCE_UNAVAILABLE' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations.map((operation) => operation.operation)).toEqual(['get_input', 'fail', 'retrigger_memories']);
  });

  it('replays from a deterministic R2 object only after confirming its no-op upload lease', async () => {
    const input = job();
    const setup = createEnvironment(input, {
      [input.outputKey]: { bytes: new Uint8Array([1]).buffer, customMetadata: { model: 'gpt-image-1.5' } },
    });
    const { fetchMock, operations } = bridgeAndOpenAiFetch(input);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'ready', model: 'gpt-image-1.5' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'authorize_upload', 'record_upload_complete', 'publish', 'retrigger_memories',
    ]);
  });

  it('clears an active portrait upload lease on HEAD recovery before publish', async () => {
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
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).toEqual([
      'get_input', 'authorize_upload', 'record_upload_complete', 'publish', 'retrigger_memories',
    ]);
  });

  it('does not publish an existing portrait when its upload lease cannot be authorized', async () => {
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
    expect(setup.portraits.delete).not.toHaveBeenCalled();
  });

  it('treats an already-published CAS replay as success and never deletes the ready portrait', async () => {
    const setup = createEnvironment();
    const { fetchMock } = bridgeAndOpenAiFetch(setup.workflowJob, {
      publish: Response.json({
        published: false,
        alreadyPublished: true,
        oldPortraitKey: setup.workflowJob.oldPortraitKey,
        deleteOutput: true,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.portraits.delete).toHaveBeenCalledWith(setup.workflowJob.oldPortraitKey);
    expect(setup.portraits.delete).not.toHaveBeenCalledWith(setup.workflowJob.outputKey);
  });

  it('does not call OpenAI again when a repeated one-shot reservation rejects a replay', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: { reserve_attempt: [Response.json({ reserved: false })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'failed', code: 'ATTEMPT_CAP_EXHAUSTED' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'reserve_attempt' }));
  });

  it('fails closed when the portrait reservation committed but its response was lost', async () => {
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

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep());

    expect(result).toMatchObject({ status: 'failed', code: 'ATTEMPT_CAP_EXHAUSTED' });
    expect(operations.filter((operation) => operation.operation === 'reserve_attempt')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
  });

  it('does not use the fallback when the primary cannot fit before the publication reserve', async () => {
    const input = job({ providerDeadlineAt: new Date(Date.now() + 140_000).toISOString() });
    const setup = createEnvironment(input);
    const { fetchMock, operations } = bridgeAndOpenAiFetch(input);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'failed', code: 'GENERATION_TIMEOUT' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(0);
    expect(operations.map((operation) => operation.operation)).toEqual(['get_input', 'fail', 'retrigger_memories']);
  });

  it('retries the same portrait bytes under one upload lease without another provider call', async () => {
    const setup = createEnvironment();
    setup.portraits.put.mockRejectedValueOnce(new Error('temporary R2 failure'));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.portraits.put).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'authorize_upload')).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'record_upload_complete')).toEqual([
      expect.objectContaining({ uploadToken: UPLOAD_TOKEN, outputKey: setup.workflowJob.outputKey }),
    ]);
  });

  it('leaves the lease and deterministic key for recovery when all same-byte portrait PUTs are ambiguous', async () => {
    const setup = createEnvironment();
    setup.portraits.put.mockRejectedValue(new Error('ambiguous R2 failure'));
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    )).rejects.toThrow('UPLOAD_OUTCOME_AMBIGUOUS');

    expect(setup.portraits.put).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'authorize_upload')).toHaveLength(1);
    expect(operations.filter((operation) => operation.operation === 'record_upload_complete')).toHaveLength(0);
    expect(operations.filter((operation) => operation.operation === 'fail')).toHaveLength(0);
    expect(setup.portraits.delete).not.toHaveBeenCalled();
  });

  it('treats a null portrait R2 PUT result as ambiguous and never clears its lease', async () => {
    const setup = createEnvironment();
    setup.portraits.put.mockResolvedValue(null);
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob);
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>, fakeStep(),
    )).rejects.toThrow('UPLOAD_OUTCOME_AMBIGUOUS');

    expect(setup.portraits.put).toHaveBeenCalledTimes(3);
    expect(operations.map((operation) => operation.operation)).not.toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).not.toContain('fail');
  });

  it('does not overwrite a portrait that appears under an existing lease after the initial HEAD miss', async () => {
    const setup = createEnvironment();
    setup.portraits.head
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
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(operations.map((operation) => operation.operation)).toContain('record_upload_complete');
    expect(operations.map((operation) => operation.operation)).toContain('publish');
  });

  it('does not PUT when the bridge refuses portrait upload authorization', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        authorize_upload: [Response.json({ authorized: false, uploadToken: null, existingLease: false })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'failed', code: 'UPLOAD_NOT_AUTHORIZED' });
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(operations.filter((operation) => operation.operation === 'record_upload_complete')).toHaveLength(0);
  });

  it('keeps a successfully PUT portrait when upload completion remains ambiguous', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      bridgeResponses: {
        record_upload_complete: [
          new Response('unavailable', { status: 503 }),
          new Response('unavailable', { status: 503 }),
          new Response('unavailable', { status: 503 }),
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    )).rejects.toThrow('UPLOAD_OUTCOME_AMBIGUOUS');

    expect(setup.portraits.objects.has(setup.workflowJob.outputKey)).toBe(true);
    expect(operations.filter((operation) => operation.operation === 'record_upload_complete')).toHaveLength(3);
    expect(operations.filter((operation) => operation.operation === 'fail')).toHaveLength(0);
    expect(setup.portraits.delete).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous publish and removes only the superseded generated object during a deletion race', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      publish: new Response('unavailable', { status: 503 }),
      reconcile: Response.json({ published: false, oldPortraitKey: null, deleteOutput: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'superseded' });
    expect(operations.map((operation) => operation.operation)).toContain('reconcile');
    expect(setup.portraits.delete).toHaveBeenCalledWith(setup.workflowJob.outputKey);
    expect(setup.portraits.delete).not.toHaveBeenCalledWith(setup.workflowJob.oldPortraitKey);
  });

  it('cleans up a generated object when publish and reconcile reject because the version was deleted', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = bridgeAndOpenAiFetch(setup.workflowJob, {
      publish: new Response('version deleted', { status: 404 }),
      reconcile: new Response('version deleted', { status: 404 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(setup.env).run(
      { payload: { jobId: JOB_ID } } as WorkflowEvent<{ jobId: string }>,
      fakeStep(),
    );

    expect(result).toMatchObject({ status: 'superseded' });
    expect(setup.portraits.delete).toHaveBeenCalledWith(setup.workflowJob.outputKey);
    expect(setup.portraits.delete).not.toHaveBeenCalledWith(setup.workflowJob.oldPortraitKey);
    expect(operations.map((operation) => operation.operation)).toContain('retrigger_memories');
  });
});
