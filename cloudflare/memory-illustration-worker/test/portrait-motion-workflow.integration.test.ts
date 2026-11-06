import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import worker from '../src/index';
import { hmacSha256Hex } from '../src/crypto';
import { PortraitMotionWorkflow } from '../src/portrait-motion-workflow';
import type { BridgeMotionInput } from '../src/types';

const VERSION_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661301';
const MOTION_TOKEN = '50abcc52-5c0d-4b7b-86d4-1b3a0a661302';
const PNG_B64 = 'iVBORw0KGgo='; // PNG magic bytes: forces the PNG -> WebP conversion path
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

const motionInput: BridgeMotionInput = {
  sourceKey: 'owner/family/member/portraits/version/portrait/still.webp',
  outputKey: `owner/family/member/portraits/${VERSION_ID}/motion/${MOTION_TOKEN}.webp`,
  prompt: 'Make a 3x3 sheet of the person breathing.',
  checkPrompt: 'Compare image 2 to image 1 and return the JSON verdict.',
  columns: 3,
  rows: 3,
  size: '1536x1536',
  model: 'gpt-image-2.6-flare',
  quality: 'medium',
  complexity: 'medium',
};
const OLD_MOTION_KEY = `owner/family/member/portraits/${VERSION_ID}/motion/old-token.webp`;

function stream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function createEnvironment(initial: Record<string, number[]> = { [motionInput.sourceKey]: [9, 8, 7] }) {
  const objects = new Map<string, ArrayBuffer>(
    Object.entries(initial).map(([key, bytes]) => [key, new Uint8Array(bytes).buffer]),
  );
  const portraits = {
    objects,
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { body: stream(Array.from(new Uint8Array(object))) } : null;
    }),
    head: vi.fn(async (key: string) => (objects.has(key) ? { key } : null)),
    put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
      objects.set(key, bytes);
      return { key };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  const transform: { transform: () => unknown; output: () => Promise<{ image: () => ReadableStream<Uint8Array> }> } = {
    transform: () => transform,
    output: async () => ({ image: () => stream(WEBP_BYTES) }),
  };
  const images = { input: vi.fn(() => transform) };
  const env = {
    CHARACTER_PORTRAITS: portraits,
    IMAGES: images,
    OPENAI_API_KEY: 'test-openai-key',
    PORTRAIT_SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-portrait-bridge',
    PORTRAIT_SUPABASE_BRIDGE_HMAC_SECRET: 'portrait-bridge-secret',
    PORTRAIT_DISPATCH_SIGNING_SECRET: 'portrait-dispatch-secret',
    DISPATCH_SIGNING_SECRET: 'memory-dispatch-secret',
  } as unknown as Env;
  return { env, portraits, images };
}

function fakeStep(): WorkflowStep {
  return {
    do: async (_name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      return await (callback as () => Promise<unknown>)();
    },
  } as unknown as WorkflowStep;
}

function recordingStep() {
  const configs: Array<{ name: string; config: unknown }> = [];
  const step = {
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      configs.push({ name, config: typeof configOrCallback === 'function' ? undefined : configOrCallback });
      const callback = typeof configOrCallback === 'function' ? configOrCallback : maybeCallback;
      return await (callback as () => Promise<unknown>)();
    },
  } as unknown as WorkflowStep;
  return { step, configs };
}

function workflowWithEnv(env: Env): PortraitMotionWorkflow {
  const workflow = Object.create(PortraitMotionWorkflow.prototype) as PortraitMotionWorkflow;
  (workflow as unknown as { env: Env }).env = env;
  return workflow;
}

const image = () => Response.json({
  data: [{ b64_json: PNG_B64 }],
  usage: { input_tokens_details: { text_tokens: 100, image_tokens: 1000, cached_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 2000 } },
});
const verdict = (overrides: Record<string, unknown> = {}) => Response.json({
  choices: [{
    message: {
      content: JSON.stringify({
        same_person: true, equal_panels: true, no_text_or_borders: true, stable_framing: true, ...overrides,
      }),
    },
  }],
  usage: { prompt_tokens: 1500, completion_tokens: 20, total_tokens: 1520 },
});
const rawContent = (content: string) => Response.json({ choices: [{ message: { content } }] });

function setupFetch(options: {
  images?: Response[];
  checks?: Response[];
  bridge?: Partial<Record<string, Response[]>>;
  input?: Partial<BridgeMotionInput>;
} = {}) {
  const operations: Array<Record<string, unknown>> = [];
  const imageForms: FormData[] = [];
  const checkBodies: Array<Record<string, unknown>> = [];
  const imageResponses = options.images ?? [image()];
  const checkResponses = options.checks ?? [verdict()];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('api.openai.com/v1/images/edits')) {
      imageForms.push(init?.body as FormData);
      return imageResponses.shift() ?? image();
    }
    if (target.includes('api.openai.com/v1/chat/completions')) {
      checkBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return checkResponses.shift() ?? verdict();
    }
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    operations.push(request);
    const queued = options.bridge?.[String(request.operation)]?.shift();
    if (queued) return queued;
    switch (request.operation) {
      case 'motion_get_input': return Response.json({ ...motionInput, ...options.input });
      case 'motion_record_usage': return Response.json({ recorded: true });
      case 'motion_publish': return Response.json({ published: true, oldMotionKey: null });
      case 'motion_fail': return Response.json({ failed: true });
      default: throw new Error('unexpected bridge operation');
    }
  });
  return { fetchMock, operations, imageForms, checkBodies };
}

async function runMotion(env: Env) {
  return await workflowWithEnv(env).run(
    { payload: { versionId: VERSION_ID, motionToken: MOTION_TOKEN } } as WorkflowEvent<{ versionId: string; motionToken: string }>,
    fakeStep(),
  );
}

const opNames = (operations: Array<Record<string, unknown>>) => operations.map((operation) => operation.operation);

afterEach(() => vi.unstubAllGlobals());

describe('portrait motion Workflow', () => {
  it('retries once after a failed QA, then converts to WebP, uploads and publishes', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations, imageForms, checkBodies } = setupFetch({
      images: [image(), image()],
      checks: [verdict({ equal_panels: false }), verdict()],
      bridge: { motion_publish: [Response.json({ published: true, oldMotionKey: OLD_MOTION_KEY })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMotion(setup.env);

    expect(result).toMatchObject({ status: 'ready' });
    expect(imageForms).toHaveLength(2);
    const form = imageForms[0];
    expect(form.get('model')).toBe('gpt-image-2.6-flare');
    expect(form.get('size')).toBe('1536x1536');
    expect(form.get('quality')).toBe('medium');
    expect(form.get('complexity')).toBe('medium');
    expect(form.get('output_format')).toBe('png');
    expect(form.get('prompt')).toBe(motionInput.prompt);
    const files = form.getAll('image[]') as File[];
    expect(files).toHaveLength(1);
    expect(Array.from(new Uint8Array(await files[0].arrayBuffer()))).toEqual([9, 8, 7]);

    expect(checkBodies).toHaveLength(2);
    expect(checkBodies[0]).toMatchObject({ model: 'gpt-6-luna' });
    const content = (checkBodies[0].messages as Array<{ content: unknown }>)[1].content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text', text: motionInput.checkPrompt });
    expect(content.filter((part) => part.type === 'image_url')).toHaveLength(2);

    expect(setup.portraits.put).toHaveBeenCalledTimes(1);
    expect(setup.portraits.put).toHaveBeenCalledWith(
      motionInput.outputKey,
      expect.any(ArrayBuffer),
      expect.objectContaining({ httpMetadata: { contentType: 'image/webp' } }),
    );
    const [, stored] = setup.portraits.put.mock.calls[0];
    expect(Array.from(new Uint8Array(stored as ArrayBuffer))).toEqual(WEBP_BYTES);

    expect(opNames(operations).filter((name) => name !== 'motion_record_usage')).toEqual([
      'motion_get_input', 'motion_publish',
    ]);
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'motion_publish', jobId: VERSION_ID, motionToken: MOTION_TOKEN,
      outputKey: motionInput.outputKey, columns: 3, rows: 3,
    }));
    expect(setup.portraits.delete).toHaveBeenCalledTimes(1);
    expect(setup.portraits.delete).toHaveBeenCalledWith(OLD_MOTION_KEY);
    expect(setup.portraits.objects.has(motionInput.outputKey)).toBe(true);

    await vi.waitFor(() => {
      expect(operations.filter((operation) => operation.operation === 'motion_record_usage')).toHaveLength(4);
    });
    const usage = operations.filter((operation) => operation.operation === 'motion_record_usage');
    expect(usage.map((operation) => operation.aiCallId).sort()).toEqual([
      `motion-check:${MOTION_TOKEN}:1`, `motion-check:${MOTION_TOKEN}:2`,
      `motion:${MOTION_TOKEN}:1`, `motion:${MOTION_TOKEN}:2`,
    ]);
    expect(usage.find((operation) => operation.aiCallId === `motion:${MOTION_TOKEN}:1`)).toMatchObject({
      jobId: VERSION_ID, motionToken: MOTION_TOKEN, aiOperation: 'image', model: 'gpt-image-2.6-flare', success: true,
      costIsComplete: true,
    });
    expect(usage.find((operation) => operation.aiCallId === `motion-check:${MOTION_TOKEN}:1`)).toMatchObject({
      aiOperation: 'check', model: 'gpt-6-luna', success: true, costIsComplete: true,
      pricingVersion: 'openai-2026-09-28',
      usage: { inputTextTokens: 1500, outputTextTokens: 20 },
    });
  });

  it('does not delete the new output when the bridge echoes it back as the old key', async () => {
    const setup = createEnvironment();
    const { fetchMock } = setupFetch({
      bridge: { motion_publish: [Response.json({ published: true, oldMotionKey: motionInput.outputKey })] },
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'ready' });
    expect(setup.portraits.delete).not.toHaveBeenCalled();
  });

  it('fails with motion_fail and never publishes when both attempts fail QA', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations, imageForms } = setupFetch({
      images: [image(), image()],
      checks: [verdict({ same_person: false }), verdict({ no_text_or_borders: false })],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMotion(setup.env);

    expect(result).toMatchObject({ status: 'failed', code: 'MOTION_QA_FAILED' });
    expect(imageForms).toHaveLength(2);
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(opNames(operations)).not.toContain('motion_publish');
    expect(operations).toContainEqual(expect.objectContaining({
      operation: 'motion_fail', jobId: VERSION_ID, motionToken: MOTION_TOKEN, errorCode: 'MOTION_QA_FAILED',
    }));
  });

  it.each([
    ['non-JSON text', rawContent('looks fine to me')],
    ['an array', rawContent('[true,true,true,true]')],
    ['a missing key', rawContent(JSON.stringify({ same_person: true, equal_panels: true, no_text_or_borders: true }))],
    ['an extra key', rawContent(JSON.stringify({
      same_person: true, equal_panels: true, no_text_or_borders: true, stable_framing: true, extra: true,
    }))],
    ['string booleans', rawContent(JSON.stringify({
      same_person: 'true', equal_panels: true, no_text_or_borders: true, stable_framing: true,
    }))],
    ['empty content', Response.json({ choices: [{ message: { content: null } }] })],
    ['a refusal', Response.json({ choices: [{ message: { content: null, refusal: 'I cannot help with that.' } }] })],
    ['a non-JSON body', new Response('not json at all')],
  ])('treats %s from the QA call as a QA failure', async (_label, checkResponse) => {
    const setup = createEnvironment();
    const { fetchMock, operations, imageForms } = setupFetch({
      images: [image(), image()],
      checks: [checkResponse, verdict()],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'ready' });
    expect(imageForms).toHaveLength(2);
    expect(opNames(operations)).toContain('motion_publish');
  });

  it('fails closed when the QA call itself keeps erroring, without publishing', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = setupFetch({
      images: [image(), image()],
      checks: [
        new Response('x', { status: 503 }), new Response('x', { status: 503 }),
        new Response('x', { status: 400 }),
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'failed', code: 'MOTION_QA_FAILED' });
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(opNames(operations)).not.toContain('motion_publish');
  });

  it('retries a retryable provider error once and publishes the second sheet', async () => {
    const setup = createEnvironment();
    const { fetchMock, imageForms, checkBodies } = setupFetch({
      images: [Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }), image()],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'ready' });
    expect(imageForms).toHaveLength(2);
    expect(checkBodies).toHaveLength(1);
  });

  it('gives up after two retryable provider errors', async () => {
    const setup = createEnvironment();
    const { fetchMock, imageForms, operations } = setupFetch({
      images: [
        Response.json({}, { status: 500 }),
        Response.json({}, { status: 500 }),
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'failed', code: 'OPENAI_RETRYABLE_ERROR' });
    expect(imageForms).toHaveLength(2);
    expect(opNames(operations)).toContain('motion_fail');
  });

  it('stops after one OpenAI call on a non-retryable provider error', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations, imageForms, checkBodies } = setupFetch({
      images: [Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 })],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMotion(setup.env);

    expect(result).toMatchObject({ status: 'failed', code: 'MODERATION_BLOCKED' });
    expect(imageForms).toHaveLength(1);
    expect(checkBodies).toHaveLength(0);
    expect(setup.portraits.put).not.toHaveBeenCalled();
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'motion_fail', errorCode: 'MODERATION_BLOCKED' }));
    await vi.waitFor(() => {
      expect(operations.find((operation) => operation.operation === 'motion_record_usage')).toMatchObject({
        aiOperation: 'image', success: false,
      });
    });
  });

  it('deletes the uploaded output when the bridge reports it was not published', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = setupFetch({
      bridge: { motion_publish: [Response.json({ published: false, oldMotionKey: OLD_MOTION_KEY })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'superseded' });
    expect(setup.portraits.delete).toHaveBeenCalledTimes(1);
    expect(setup.portraits.delete).toHaveBeenCalledWith(motionInput.outputKey);
    expect(setup.portraits.objects.has(motionInput.outputKey)).toBe(false);
    expect(opNames(operations)).not.toContain('motion_fail');
  });

  it('records a failure and removes the output when publish is rejected outright', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations } = setupFetch({
      bridge: { motion_publish: [Response.json({ error: 'bad' }, { status: 400 })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'failed', code: 'BRIDGE_REJECTED' });
    expect(operations).toContainEqual(expect.objectContaining({ operation: 'motion_fail' }));
    expect(setup.portraits.delete).toHaveBeenCalledWith(motionInput.outputKey);
  });

  it('keeps the output on an ambiguous publish outage unless motion_fail proves it did not commit', async () => {
    const outage = () => new Response('unavailable', { status: 503 });
    const committed = createEnvironment();
    const committedFetch = setupFetch({
      bridge: {
        motion_publish: [outage()],
        motion_fail: [Response.json({ failed: false })],
      },
    });
    vi.stubGlobal('fetch', committedFetch.fetchMock);
    await runMotion(committed.env);
    expect(committed.portraits.delete).not.toHaveBeenCalled();

    const uncommitted = createEnvironment();
    const uncommittedFetch = setupFetch({
      bridge: { motion_publish: [outage()], motion_fail: [Response.json({ failed: true })] },
    });
    vi.stubGlobal('fetch', uncommittedFetch.fetchMock);
    await runMotion(uncommitted.env);
    expect(uncommitted.portraits.delete).toHaveBeenCalledWith(motionInput.outputKey);
  });

  it('records a failure without calling OpenAI when the claim was superseded before input', async () => {
    const setup = createEnvironment();
    const { fetchMock, operations, imageForms } = setupFetch({
      bridge: { motion_get_input: [Response.json({ code: 'MOTION_SUPERSEDED' }, { status: 409 })] },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'failed' });
    expect(imageForms).toHaveLength(0);
    expect(opNames(operations)).toEqual(['motion_get_input', 'motion_fail']);
    expect(setup.portraits.delete).not.toHaveBeenCalled();
  });

  it('fails without calling OpenAI when the still is missing', async () => {
    const setup = createEnvironment({});
    const { fetchMock, imageForms } = setupFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'failed', code: 'SOURCE_REFERENCE_UNAVAILABLE' });
    expect(imageForms).toHaveLength(0);
  });

  it('never repeats the paid calls when this claim already uploaded its output', async () => {
    const setup = createEnvironment({ [motionInput.sourceKey]: [9, 8, 7], [motionInput.outputKey]: WEBP_BYTES });
    const { fetchMock, operations, imageForms, checkBodies } = setupFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'ready' });
    expect(imageForms).toHaveLength(0);
    expect(checkBodies).toHaveLength(0);
    expect(opNames(operations)).toEqual(['motion_get_input', 'motion_publish']);
  });

  it('publishes even when usage recording fails', async () => {
    const setup = createEnvironment();
    const { fetchMock } = setupFetch({
      bridge: { motion_record_usage: [new Response('x', { status: 503 }), new Response('x', { status: 503 })] },
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(runMotion(setup.env)).resolves.toMatchObject({ status: 'ready' });
  });

  it('disables retries on the paid generation step and marks its output sensitive', async () => {
    const setup = createEnvironment();
    const { fetchMock } = setupFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { step, configs } = recordingStep();
    await workflowWithEnv(setup.env).run(
      { payload: { versionId: VERSION_ID, motionToken: MOTION_TOKEN } } as WorkflowEvent<{ versionId: string; motionToken: string }>,
      step,
    );
    expect(configs[0]).toMatchObject({
      name: 'generate motion sheet',
      config: { retries: { limit: 0 }, timeout: '6 minutes', sensitive: 'output' },
    });
    expect(configs[1].name).toBe('publish motion');
  });
});

describe('portrait motion dispatch', () => {
  async function signed(body: string, secret = 'portrait-dispatch-secret', nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661400') {
    const timestamp = String(Date.now());
    const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${body}`);
    return new Request('https://worker.test/dispatch/portrait-motion', {
      method: 'POST',
      headers: { 'x-dispatch-timestamp': timestamp, 'x-dispatch-nonce': nonce, 'x-dispatch-signature': signature },
      body,
    });
  }
  const envWith = (create: ReturnType<typeof vi.fn>) => ({
    PORTRAIT_DISPATCH_SIGNING_SECRET: 'portrait-dispatch-secret',
    PORTRAIT_MOTION_WORKFLOW: { create },
  }) as unknown as Env;
  const body = JSON.stringify({ versionId: VERSION_ID, motionToken: MOTION_TOKEN });

  it('creates motion-<token> and treats an existing instance as an idempotent 202', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: `motion-${MOTION_TOKEN}` })
      .mockRejectedValueOnce(new Error('Workflow instance already exists'));
    const env = envWith(create);

    const first = await worker.fetch(await signed(body), env);
    const second = await worker.fetch(await signed(body, undefined, '50abcc52-5c0d-4b7b-86d4-1b3a0a661401'), env);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: `motion-${MOTION_TOKEN}`,
      params: { versionId: VERSION_ID, motionToken: MOTION_TOKEN },
    }));
  });

  it('rejects a signature from another dispatch secret before creating anything', async () => {
    const create = vi.fn();
    const response = await worker.fetch(await signed(body, 'memory-dispatch-secret'), envWith(create));
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing version id', { motionToken: MOTION_TOKEN }],
    ['a non-UUID version id', { versionId: 'not-a-uuid', motionToken: MOTION_TOKEN }],
    ['a missing motion token', { versionId: VERSION_ID }],
    ['a non-UUID motion token', { versionId: VERSION_ID, motionToken: '../../etc' }],
  ])('rejects %s with 400', async (_label, payload) => {
    const create = vi.fn();
    const response = await worker.fetch(await signed(JSON.stringify(payload)), envWith(create));
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a non-duplicate create failure as 502', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'));
    const response = await worker.fetch(await signed(body), envWith(create));
    expect(response.status).toBe(502);
  });
});
