import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { MemoryBookWorkflow } from '../src/workflow';
import type { GenerationContextResponse, WorkflowDispatchPayload } from '../src/types';

const BOOK_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661112';
const ATTEMPT_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661113';
const MEMORY_1 = '50abcc52-5c0d-4b7b-86d4-1b3a0a661201';
const MEMORY_2 = '50abcc52-5c0d-4b7b-86d4-1b3a0a661202';
const CHILD_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661001';

function fakeStep(): WorkflowStep {
  return {
    do: (async (_name: string, _config: unknown, callback: () => Promise<unknown>) => await callback()) as WorkflowStep['do'],
  } as unknown as WorkflowStep;
}

function baseContext(): GenerationContextResponse {
  return {
    book: {
      id: BOOK_ID,
      familyId: 'family-1',
      childId: CHILD_ID,
      scopeKind: 'age_year',
      windowStart: '2024-10-23',
      windowEndExclusive: '2025-10-23',
      scopeLabel: 'Year One',
      pageBudget: 60,
    },
    child: { id: CHILD_ID, name: 'Enzo', dateOfBirth: '2024-10-23' },
    familyName: 'The Rivas Family',
    configuredLanguage: 'en',
    memories: [
      { id: MEMORY_1, content: 'You took your first steps today!', memory_date: '2025-03-01', memory_type: 'text', emotion: 'joy', topics: [], topic_details: {}, illustration_key: null },
      { id: MEMORY_2, content: null, memory_date: '2025-03-05', memory_type: 'photo', emotion: null, topics: [], topic_details: {}, illustration_key: null },
    ],
    media: [
      { id: 'media-1', memory_id: MEMORY_2, object_key: 'raw.jpg', preview_object_key: 'preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1.2 },
    ],
    tags: [
      { memory_id: MEMORY_1, family_member_id: CHILD_ID },
      { memory_id: MEMORY_2, family_member_id: CHILD_ID },
    ],
    milestones: [
      { memory_id: MEMORY_1, family_member_id: CHILD_ID, milestone_id: 'first-steps', detail: null, out_of_band: false },
    ],
    engagementCounts: { [MEMORY_1]: 1 },
    familyMembers: [{ id: CHILD_ID, name: 'Enzo', date_of_birth: '2024-10-23', nicknames: [] }],
    portraitVersions: [],
    languageEvidenceCaptions: [],
  };
}

function outlineChatResponse() {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          language: 'en',
          spreads: [],
          backbone_highlights: [],
          hero_candidates: [],
          cover_candidates: [MEMORY_2],
          panorama_candidates: [],
          segment_titles: {},
          firsts_title: 'Big and small victories this year',
          firsts_milestones: [{ memory_id: MEMORY_1, milestone_id: 'first-steps', warm_name: 'You took your first steps' }],
          dedication: 'This year you learned to walk.',
          back_cover_line: 'A year of memories.',
          editorial_note: 'A quiet, steady year of growth.',
        }),
      },
    }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  };
}

function coverVerifyChatResponse() {
  return {
    choices: [{
      message: {
        content: JSON.stringify({ verdicts: [{ index: 0, disqualified: false, reason_code: 'ok', reason_detail: 'clear photo of the child' }] }),
      },
    }],
    usage: { prompt_tokens: 500, completion_tokens: 50 },
  };
}

/** Minimal, real, parseable JPEG (SOI + tiny APP0 + SOF0 carrying width/
 * height) -- same construction `dimensions.test.ts` verifies against the
 * real `image-size` package; duplicated here (not imported from another
 * test file, per this suite's own convention of self-contained fixtures)
 * so this integration test can prove the dimension-measurement step's R2
 * reads actually flow into the published manifest, not just that the step
 * runs. */
function buildJpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x0b, 0x08, // SOF0, length 11, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
}

function createBucket(bytesByKey: Record<string, Uint8Array> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      const bytes = bytesByKey[key];
      if (bytes) return { arrayBuffer: async () => bytes.buffer };
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }),
  };
}

function createEnv(overrides: { bridgeResponses?: Record<string, unknown>; bucketBytesByKey?: Record<string, Uint8Array> } = {}) {
  const bridgeCalls: Array<{ operation: string; body: Record<string, unknown> }> = [];
  const bridgeResponses = overrides.bridgeResponses ?? {};

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (url.includes('api.openai.com')) {
      const messages = body.messages as Array<{ content: unknown }>;
      const isVision = Array.isArray(messages?.[1]?.content);
      return new Response(JSON.stringify(isVision ? coverVerifyChatResponse() : outlineChatResponse()), { status: 200 });
    }

    // Bridge call.
    bridgeCalls.push({ operation: body.operation, body });
    if (body.operation in bridgeResponses) {
      return new Response(JSON.stringify(bridgeResponses[body.operation]), { status: 200 });
    }
    switch (body.operation) {
      case 'load_generation_context':
        return new Response(JSON.stringify(baseContext()), { status: 200 });
      case 'ensure_share_tokens':
        return new Response(JSON.stringify({ tokensByMemoryId: {} }), { status: 200 });
      case 'publish':
        return new Response(JSON.stringify({ published: true }), { status: 200 });
      case 'fail':
        return new Response(JSON.stringify({ failed: true }), { status: 200 });
      case 'reconcile':
        return new Response(JSON.stringify({ outcome: 'superseded' }), { status: 200 });
      default:
        return new Response(JSON.stringify({ error: 'unknown op' }), { status: 400 });
    }
  });

  const bucket = createBucket(overrides.bucketBytesByKey);
  const env = {
    ENVIRONMENT: 'test',
    SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-memory-book-bridge',
    DISPATCH_SIGNING_SECRET: 'dispatch-secret',
    SUPABASE_BRIDGE_HMAC_SECRET: 'bridge-secret',
    OPENAI_API_KEY: 'test-key',
    MEMORY_BOOK_PREVIEWS: bucket,
  } as unknown as Env;

  return { env, fetchMock, bridgeCalls, bucket };
}

function workflowWithEnv(env: Env): MemoryBookWorkflow {
  const workflow = Object.create(MemoryBookWorkflow.prototype) as MemoryBookWorkflow;
  (workflow as unknown as { env: Env }).env = env;
  return workflow;
}

describe('MemoryBookWorkflow', () => {
  it('reaches ready and publishes a book_document with a valid outline + manifest', async () => {
    const { env, fetchMock, bridgeCalls } = createEnv();
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );

    expect(result).toEqual({ bookId: BOOK_ID, status: 'ready' });

    const publishCall = bridgeCalls.find((c) => c.operation === 'publish');
    expect(publishCall).toBeDefined();
    const document = publishCall!.body.bookDocument as { outline: Record<string, unknown>; manifest: Record<string, unknown> };
    expect(document.outline.runId).toBe(ATTEMPT_ID);
    expect(document.outline.child).toEqual({ id: CHILD_ID, name: 'Enzo' });
    expect((document.outline.elements as Array<{ kind: string }>).some((e) => e.kind === 'firsts')).toBe(true);
    // Cover-verify kept the sole candidate (verdict: not disqualified).
    expect(document.outline.coverCandidates).toEqual([MEMORY_2]);
    expect((document.manifest.memories as Record<string, unknown>)[MEMORY_1]).toBeDefined();
    expect((document.manifest.memories as Record<string, unknown>)[MEMORY_2]).toBeDefined();

    // Never send bridge calls out of order relative to the CAS discipline:
    // context load happens before publish.
    const operations = bridgeCalls.map((c) => c.operation);
    expect(operations[0]).toBe('load_generation_context');
    expect(operations[operations.length - 1]).toBe('publish');
  });

  it('fails the row with a closed error code, never the raw error message, when context load is rejected', async () => {
    const { env, fetchMock, bridgeCalls } = createEnv({
      bridgeResponses: { load_generation_context: { error: 'Memory book attempt is no longer current', code: 'BOOK_SUPERSEDED' } },
    });
    // The bridge returns 409 for a superseded attempt -- simulate that status.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.includes('api.openai.com')) return new Response('{}', { status: 200 });
      bridgeCalls.push({ operation: body.operation, body });
      if (body.operation === 'load_generation_context') {
        return new Response(JSON.stringify({ error: 'superseded', code: 'BOOK_SUPERSEDED' }), { status: 409 });
      }
      if (body.operation === 'fail') return new Response(JSON.stringify({ failed: true }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );

    expect(result).toEqual({ bookId: BOOK_ID, status: 'failed', code: 'CONTEXT_LOAD_FAILED' });
    const failCall = bridgeCalls.find((c) => c.operation === 'fail');
    expect(failCall?.body.failureReason).toBe('CONTEXT_LOAD_FAILED');
  });

  it('fails with NO_ELIGIBLE_MEMORIES when the scope window has no memories', async () => {
    const { env, fetchMock, bridgeCalls } = createEnv();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.includes('api.openai.com')) return new Response('{}', { status: 200 });
      bridgeCalls.push({ operation: body.operation, body });
      if (body.operation === 'load_generation_context') {
        return new Response(JSON.stringify({ ...baseContext(), memories: [] }), { status: 200 });
      }
      if (body.operation === 'fail') return new Response(JSON.stringify({ failed: true }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );
    expect(result).toEqual({ bookId: BOOK_ID, status: 'failed', code: 'NO_ELIGIBLE_MEMORIES' });
  });

  it('treats a lost CAS (published: false) as superseded, not a failure', async () => {
    const { env, fetchMock } = createEnv({ bridgeResponses: { publish: { published: false } } });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );
    expect(result).toEqual({ bookId: BOOK_ID, status: 'superseded' });
  });

  it('measures original photo dimensions from R2 (the ORIGINAL object_key, not preview) and writes them into the published manifest', async () => {
    // MEMORY_2's media row: object_key 'raw.jpg' (original) vs
    // preview_object_key 'preview.jpg' (the exported/referenced file) --
    // serving real JPEG bytes ONLY under the original key proves the
    // dimension step reads the right object, not accidentally the preview.
    const { env, fetchMock, bridgeCalls, bucket } = createEnv({
      bucketBytesByKey: { 'raw.jpg': buildJpegBytes(4032, 3024) },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );
    expect(result).toEqual({ bookId: BOOK_ID, status: 'ready' });

    const publishCall = bridgeCalls.find((c) => c.operation === 'publish');
    const document = publishCall!.body.bookDocument as { manifest: { memories: Record<string, { assets: Array<Record<string, unknown>> }> } };
    const asset = document.manifest.memories[MEMORY_2].assets[0];
    expect(asset.file).toBe('preview.jpg'); // still the preview file, per V5a's own no-re-download rule.
    expect(asset.originalWidth).toBe(4032); // ...but originalWidth/Height now come from the real original.
    expect(asset.originalHeight).toBe(3024);

    // Confirm it was actually read off the ORIGINAL key.
    expect(bucket.get.mock.calls.some((call: unknown[]) => call[0] === 'raw.jpg')).toBe(true);
  });

  it('share-token audit: a "media" memory carrying a video-poster asset is requested from ensure_share_tokens and reaches the published manifest', async () => {
    const MEMORY_VIDEO = '50abcc52-5c0d-4b7b-86d4-1b3a0a661203';
    const contextWithVideo: GenerationContextResponse = {
      ...baseContext(),
      memories: [
        ...baseContext().memories,
        { id: MEMORY_VIDEO, content: null, memory_date: '2025-03-10', memory_type: 'media', emotion: null, topics: [], topic_details: {}, illustration_key: null },
      ],
      media: [
        ...baseContext().media,
        { id: 'media-video', memory_id: MEMORY_VIDEO, object_key: 'clip.mp4', preview_object_key: 'poster.webp', content_type: 'video/mp4', position: 0, duration_ms: 6000, aspect_ratio: 1.78 },
      ],
    };

    const { env, fetchMock, bridgeCalls } = createEnv({
      bridgeResponses: { ensure_share_tokens: { tokensByMemoryId: { [MEMORY_VIDEO]: 'tok-video-canary' } } },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.includes('api.openai.com')) {
        const messages = body.messages as Array<{ content: unknown }>;
        const isVision = Array.isArray(messages?.[1]?.content);
        if (isVision) return new Response(JSON.stringify(coverVerifyChatResponse()), { status: 200 });
        const base = outlineChatResponse();
        base.choices[0].message.content = JSON.stringify({
          ...JSON.parse(base.choices[0].message.content),
          panorama_candidates: [MEMORY_VIDEO], // makes it "referenced" without needing a full backbone placement.
        });
        return new Response(JSON.stringify(base), { status: 200 });
      }
      bridgeCalls.push({ operation: body.operation, body });
      if (body.operation === 'load_generation_context') return new Response(JSON.stringify(contextWithVideo), { status: 200 });
      if (body.operation === 'ensure_share_tokens') return new Response(JSON.stringify({ tokensByMemoryId: { [MEMORY_VIDEO]: 'tok-video-canary' } }), { status: 200 });
      if (body.operation === 'publish') return new Response(JSON.stringify({ published: true }), { status: 200 });
      if (body.operation === 'fail') return new Response(JSON.stringify({ failed: true }), { status: 200 });
      return new Response(JSON.stringify({ error: 'unknown op' }), { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflowWithEnv(env).run(
      { payload: { bookId: BOOK_ID, attemptId: ATTEMPT_ID } } as WorkflowEvent<WorkflowDispatchPayload>,
      fakeStep(),
    );
    expect(result).toEqual({ bookId: BOOK_ID, status: 'ready' });

    const tokenCall = bridgeCalls.find((c) => c.operation === 'ensure_share_tokens');
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.body.memoryIds as string[]).toContain(MEMORY_VIDEO);

    const publishCall = bridgeCalls.find((c) => c.operation === 'publish');
    const document = publishCall!.body.bookDocument as { manifest: { memories: Record<string, { shareToken: string | null; assets: Array<{ kind: string }> }> } };
    const memory = document.manifest.memories[MEMORY_VIDEO];
    expect(memory.assets).toEqual([expect.objectContaining({ kind: 'video-poster' })]);
    expect(memory.shareToken).toBe('tok-video-canary');
  });
});
