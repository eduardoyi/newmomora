import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  commitIllustrationGeneration,
  defaultInvokeGenerateIllustration,
  getIllustrationImageRequestOptions,
  handleGenerateIllustration,
  ILLUSTRATION_GENERATION_TIMEOUT_MS,
  isFreshMatchingWorkflowJob,
} from './index.ts';
import { signedPortraitMemoryRetriggerHeaders } from '../_shared/portrait-memory-retrigger.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
// Real 1x1 PNG bytes. The production reference loader decodes downloaded
// images before constructing the OpenAI multipart request, so sentinel bytes
// such as [1, 2, 3] do not exercise the image-prompt path reliably.
const TINY_IMAGE_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);

interface MockNetworkResult {
  openAiChatPrompts: string[];
  openAiChatSystemPrompts: string[];
  openAiImagePrompts: string[];
  portraitLoads: number;
  memoryPatches: Array<{ payload: Record<string, unknown>; url: string }>;
}

const TEST_ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  OPENAI_API_KEY: 'test-openai-key',
} as const;

async function withMockedIllustrationNetwork(
  content: string,
  run: (result: MockNetworkResult) => Promise<void>,
  taggedMemberIds: string[] = [MEMBER_ID],
  memoryOverrides: Record<string, unknown> = {},
  options: {
    // Overrides the default single ready-portrait row. A function is called
    // once per query, so a test can hand back different rows for the
    // deferral path's initial check vs. the self-retrigger's post-reset
    // recheck.
    portraitVersions?: Record<string, unknown>[] | (() => Record<string, unknown>[]);
    membershipRows?: Array<{ family_id: string; role: string }>;
  } = {},
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map(
    Object.keys(TEST_ENV).map((key) => [key, Deno.env.get(key)]),
  );
  const result: MockNetworkResult = {
    openAiChatPrompts: [],
    openAiChatSystemPrompts: [],
    openAiImagePrompts: [],
    portraitLoads: 0,
    memoryPatches: [],
  };

  for (const [key, value] of Object.entries(TEST_ENV)) {
    Deno.env.set(key, value);
  }

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === '/auth/v1/user') {
      return jsonResponse({
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'parent@example.com',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-07-12T00:00:00.000Z',
      });
    }

    if (url.origin === 'https://supabase.test' && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      const select = url.searchParams.get('select') ?? '';

      if (request.method === 'PATCH') {
        const payload = await request.json();
        if (table === 'memories') {
          result.memoryPatches.push({ payload, url: url.toString() });
        }
        if (payload.illustration_generation_attempt_id && select.includes('id')) {
          return jsonResponse({ id: MEMORY_ID });
        }
        return jsonResponse([]);
      }

      if (table === 'memories') {
        return jsonResponse({
          id: MEMORY_ID,
          family_id: FAMILY_ID,
          content,
          memory_date: '2026-07-12',
          emotion: 'joy',
          illustration_key: null,
          illustration_generation_id: null,
          illustration_generation_attempt_id: null,
          illustration_status: 'pending',
          updated_at: '2026-07-12T00:00:00.000Z',
          memory_type: 'text_illustration',
          ...memoryOverrides,
        });
      }

      if (table === 'families' && select.includes('owner_id')) {
        return jsonResponse([
          { id: FAMILY_ID, owner_id: USER_ID, deleted_at: null },
        ]);
      }

      if (table === 'families' && select === 'illustration_style') {
        return jsonResponse({ illustration_style: 'default' });
      }

      if (table === 'family_memberships') {
        return jsonResponse(options.membershipRows ?? [{ family_id: FAMILY_ID, role: 'owner' }]);
      }

      if (table === 'memory_family_members') {
        return jsonResponse(taggedMemberIds.map((family_member_id) => ({ family_member_id })));
      }

      if (table === 'family_members') {
        return jsonResponse([
          {
            id: MEMBER_ID,
            name: 'Avery',
            nicknames: ['cheeky monkey'],
            date_of_birth: '2020-01-01',
            gender: null,
            additional_info: null,
            illustrated_profile_key: `${USER_ID}/family-members/${MEMBER_ID}/portrait.webp`,
            illustrated_profile_status: 'ready',
            profile_picture_key: null,
          },
        ]);
      }

      if (table === 'family_member_portrait_versions') {
        if (options.portraitVersions) {
          const rows =
            typeof options.portraitVersions === 'function'
              ? options.portraitVersions()
              : options.portraitVersions;
          return jsonResponse(rows);
        }
        return jsonResponse([
          {
            id: '55555555-5555-4555-8555-555555555555',
            family_member_id: MEMBER_ID,
            reference_date: '2026-01-01',
            profile_picture_key: `${USER_ID}/family/${MEMBER_ID}/portraits/55555555-5555-4555-8555-555555555555/photo.jpg`,
            illustrated_profile_key: `${USER_ID}/family/${MEMBER_ID}/portraits/55555555-5555-4555-8555-555555555555/portrait/66666666-6666-4666-8666-666666666666.webp`,
            illustrated_profile_status: 'ready',
            deletion_token: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ]);
      }

      throw new Error(`Unexpected Supabase request: ${request.method} ${url}`);
    }

    if (url.href === 'https://api.openai.com/v1/chat/completions') {
      const body = await request.json();
      result.openAiChatPrompts.push(body.messages[1].content);
      result.openAiChatSystemPrompts.push(body.messages[0].content);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                safeDescription: body.messages[1].content,
                expressionStyle: 'neutral',
              }),
            },
          },
        ],
      });
    }

    if (url.href === 'https://api.openai.com/v1/images/edits') {
      const body = await request.formData();
      result.openAiImagePrompts.push(String(body.get('prompt')));
      return new Response('mocked image failure', { status: 503 });
    }

    if (url.href === 'https://api.openai.com/v1/images/generations') {
      const body = await request.json();
      result.openAiImagePrompts.push(body.prompt);
      return new Response('mocked image failure', { status: 503 });
    }

    throw new Error(`Unexpected network request: ${request.method} ${url}`);
  };

  try {
    await run(result);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticatedRequest(): Request {
  return new Request('http://localhost/generate-illustration', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-jwt',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ memoryId: MEMORY_ID }),
  });
}

async function internalPortraitRecoveryRequest(
  input: { actorUserId?: string; familyId?: string } = {},
): Promise<Request> {
  const rawBody = JSON.stringify({
    memoryId: MEMORY_ID,
    requestIntent: 'recovery',
    actorUserId: input.actorUserId ?? USER_ID,
    familyId: input.familyId ?? FAMILY_ID,
  });
  return new Request('http://localhost/generate-illustration', {
    method: 'POST',
    headers: await signedPortraitMemoryRetriggerHeaders(rawBody),
    body: rawBody,
  });
}

Deno.test('generate-illustration rejects unauthenticated requests', async () => {
  const response = await handleGenerateIllustration(
    new Request('http://localhost/generate-illustration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: '22222222-2222-4222-8222-222222222222' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('generate-illustration reserves 30 seconds after its 120-second pre-finalization deadline', () => {
  assertEquals(ILLUSTRATION_GENERATION_TIMEOUT_MS, 120_000);
});

Deno.test('workflow reuse requires a matching attempt and holds the lease through 5:30', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assertEquals(isFreshMatchingWorkflowJob({
    memoryAttemptId: attemptId,
    jobAttemptId: attemptId,
    startedAt: new Date(now - 5 * 60_000 - 29_000).toISOString(),
    now,
  }), true);
  // A legacy status reset does not change the attempt token, so it reuses.
  assertEquals(isFreshMatchingWorkflowJob({
    memoryAttemptId: attemptId,
    jobAttemptId: attemptId,
    startedAt: new Date(now - 5 * 60_000 - 30_000).toISOString(),
    now,
  }), false);
  // An edit/tag invalidation clears the attempt, so the old job is promptly
  // superseded instead of being returned as a fake queued success.
  assertEquals(isFreshMatchingWorkflowJob({
    memoryAttemptId: null,
    jobAttemptId: attemptId,
    startedAt: new Date(now - 60_000).toISOString(),
    now,
  }), false);
});

Deno.test('generate-illustration uses medium only for three-or-more references and never hedges', () => {
  assertEquals(getIllustrationImageRequestOptions(1), {
    quality: undefined,
    outputFormat: 'webp',
    outputCompression: 85,
    fallbackHedgeDelayMs: undefined,
  });
  assertEquals(getIllustrationImageRequestOptions(3), {
    quality: 'medium',
    outputFormat: 'webp',
    outputCompression: 85,
    fallbackHedgeDelayMs: undefined,
  });
});

Deno.test(
  'defaultInvokeGenerateIllustration treats a fulfilled 409 as a benign race, not an error, and drains the body',
  async () => {
    const originalFetch = globalThis.fetch;
    const originalSupabaseUrl = Deno.env.get('SUPABASE_URL');
    Deno.env.set('SUPABASE_URL', 'https://supabase.test');
    let bodyConsumed = false;

    globalThis.fetch = (async () => {
      const response = new Response(JSON.stringify({ code: 'GENERATION_IN_PROGRESS' }), {
        status: 409,
      });
      const originalText = response.text.bind(response);
      response.text = async () => {
        bodyConsumed = true;
        return originalText();
      };
      return response;
    }) as typeof fetch;

    try {
      // GENERATION_IN_PROGRESS/GENERATION_SUPERSEDED are normal race
      // outcomes for a self-retrigger (e.g. the portrait's own retrigger, or
      // a concurrent call, already claimed this memory) -- must not throw.
      await defaultInvokeGenerateIllustration(MEMORY_ID, 'Bearer test-jwt');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSupabaseUrl === undefined) {
        Deno.env.delete('SUPABASE_URL');
      } else {
        Deno.env.set('SUPABASE_URL', originalSupabaseUrl);
      }
    }

    assertEquals(bodyConsumed, true);
  },
);

Deno.test(
  'defaultInvokeGenerateIllustration throws (loggable) for a fulfilled 500 and still drains the body',
  async () => {
    const originalFetch = globalThis.fetch;
    const originalSupabaseUrl = Deno.env.get('SUPABASE_URL');
    Deno.env.set('SUPABASE_URL', 'https://supabase.test');
    let bodyConsumed = false;

    globalThis.fetch = (async () => {
      const response = new Response(JSON.stringify({ code: 'internal_error' }), { status: 500 });
      const originalText = response.text.bind(response);
      response.text = async () => {
        bodyConsumed = true;
        return originalText();
      };
      return response;
    }) as typeof fetch;

    let thrownMessage: string | undefined;
    try {
      await defaultInvokeGenerateIllustration(MEMORY_ID, 'Bearer test-jwt');
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : undefined;
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSupabaseUrl === undefined) {
        Deno.env.delete('SUPABASE_URL');
      } else {
        Deno.env.set('SUPABASE_URL', originalSupabaseUrl);
      }
    }

    // selfRetriggerAfterDeferral's catch is what actually logs this; a
    // genuine failure status must still surface as a thrown error so it
    // doesn't silently vanish.
    assertEquals(thrownMessage, 'Self-retrigger invoke failed with status 500');
    assertEquals(bodyConsumed, true);
  },
);

Deno.test('illustration commit publishes, swaps, then deletes the old object', async () => {
  const events: string[] = [];
  await commitIllustrationGeneration({
    oldKey: 'old.webp',
    newKey: 'new.webp',
    bytes: new Uint8Array([1]),
    put: async (key) => { events.push(`put:${key}`); },
    commitDatabase: async () => { events.push('commit'); return true; },
    reconcileDatabase: async () => false,
    remove: async (key) => { events.push(`delete:${key}`); },
  });
  assertEquals(events, ['put:new.webp', 'commit', 'delete:old.webp']);
});

Deno.test('illustration commit failure removes only the new object', async () => {
  const events: string[] = [];
  let message = '';
  try {
    await commitIllustrationGeneration({
      oldKey: 'old.webp',
      newKey: 'new.webp',
      bytes: new Uint8Array([1]),
      put: async (key) => { events.push(`put:${key}`); },
      commitDatabase: async () => { events.push('commit'); throw new Error('db failed'); },
      reconcileDatabase: async () => false,
      remove: async (key) => { events.push(`delete:${key}`); },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertEquals(message, 'db failed');
  assertEquals(events, ['put:new.webp', 'commit', 'delete:new.webp']);
});

Deno.test('superseded illustration attempt removes only its new object', async () => {
  const events: string[] = [];
  try {
    await commitIllustrationGeneration({
      oldKey: 'old.webp',
      newKey: 'stale.webp',
      bytes: new Uint8Array([1]),
      put: async (key) => { events.push(`put:${key}`); },
      commitDatabase: async () => { events.push('cas:false'); return false; },
      reconcileDatabase: async () => false,
      remove: async (key) => { events.push(`delete:${key}`); },
    });
  } catch {
    // Expected: another attempt owns the DB token.
  }
  assertEquals(events, ['put:stale.webp', 'cas:false', 'delete:stale.webp']);
});

Deno.test('ambiguous commit error keeps committed bytes after reconciliation', async () => {
  const events: string[] = [];
  await commitIllustrationGeneration({
    oldKey: 'old.webp',
    newKey: 'new.webp',
    bytes: new Uint8Array([1]),
    put: async (key) => { events.push(`put:${key}`); },
    commitDatabase: async () => { events.push('commit:error-after-write'); throw new Error('timeout'); },
    reconcileDatabase: async () => { events.push('reconcile:committed'); return true; },
    remove: async (key) => { events.push(`delete:${key}`); },
  });
  assertEquals(events, [
    'put:new.webp',
    'commit:error-after-write',
    'reconcile:committed',
    'delete:old.webp',
  ]);
});

Deno.test('ambiguous commit and reconciliation errors keep the new object', async () => {
  const events: string[] = [];
  try {
    await commitIllustrationGeneration({
      oldKey: 'old.webp',
      newKey: 'new.webp',
      bytes: new Uint8Array([1]),
      put: async (key) => { events.push(`put:${key}`); },
      commitDatabase: async () => { events.push('commit:error'); throw new Error('timeout'); },
      reconcileDatabase: async () => { events.push('reconcile:error'); throw new Error('offline'); },
      remove: async (key) => { events.push(`delete:${key}`); },
    });
  } catch {
    // Unknown DB outcome deliberately retains the unique object as an orphan.
  }
  assertEquals(events, ['put:new.webp', 'commit:error', 'reconcile:error']);
});
Deno.test('generate-illustration rejects more than six tagged members', async () => {
  const taggedMemberIds = Array.from(
    { length: 7 },
    (_, index) => `${index + 1}0000000-0000-4000-8000-000000000000`,
  );

  await withMockedIllustrationNetwork(
    'Everyone gathered for a family picnic.',
    async (network) => {
      const response = await handleGenerateIllustration(authenticatedRequest());
      const body = await response.json();

      assertEquals(response.status, 400);
      assertEquals(body.code, 'ILLUSTRATION_MEMBER_LIMIT');
      assertEquals(network.openAiChatPrompts.length, 0);
      assertEquals(network.openAiImagePrompts.length, 0);
    },
    taggedMemberIds,
  );
});

Deno.test('generate-illustration strips URLs from safety and image prompts', async () => {
  await withMockedIllustrationNetwork(
    'A joyful picnic https://example.com/photos under the old oak tree.',
    async (network) => {
      const response = await handleGenerateIllustration(authenticatedRequest(), {
        getObjectBytes: async () => {
          network.portraitLoads += 1;
          return TINY_IMAGE_BYTES;
        },
      });
      const body = await response.json();

      // The mock deliberately fails image generation after capturing its
      // prompts; the regression assertion is that every outbound AI input
      // was sanitized before that downstream failure.
      assertEquals(response.status, 500);
      assertEquals(body.code, 'GENERATION_FAILED');
      assertEquals(network.openAiChatPrompts.length, 1);
      assertEquals(network.portraitLoads, 1);
      assertEquals(network.openAiImagePrompts.length > 0, true);
      assertEquals(network.openAiChatPrompts[0].includes('https://'), false);
      assertEquals(
        network.openAiImagePrompts.every((prompt) => !prompt.includes('https://')),
        true,
      );
      assertStringIncludes(network.openAiChatPrompts[0], 'A joyful picnic');
      assertEquals(
        network.openAiImagePrompts.every((prompt) => prompt.includes('A joyful picnic')),
        true,
      );
    },
  );
});

Deno.test('generate-illustration never leaks a family member nickname into the image prompt', async () => {
  await withMockedIllustrationNetwork(
    'A joyful afternoon building a blanket fort in the living room.',
    async (network) => {
      const response = await handleGenerateIllustration(authenticatedRequest(), {
        getObjectBytes: async () => {
          network.portraitLoads += 1;
          return TINY_IMAGE_BYTES;
        },
      });
      await response.json();

      // Mocked image edit call always fails after capturing its prompt (see
      // withMockedIllustrationNetwork); the assertion is on what was sent.
      assertEquals(network.openAiImagePrompts.length > 0, true);
      assertEquals(
        network.openAiImagePrompts.every((prompt) => !prompt.toLowerCase().includes('monkey')),
        true,
      );
      assertEquals(network.openAiChatSystemPrompts.length, 1);
      assertStringIncludes(
        network.openAiChatSystemPrompts[0],
        'Nickname mapping: cheeky monkey → Avery.',
      );
      assertStringIncludes(network.openAiChatSystemPrompts[0], 'canonical name');
    },
  );
});

Deno.test('generate-illustration rejects URL-only content before OpenAI or image work', async () => {
  await withMockedIllustrationNetwork('  https://example.com/photos  ', async (network) => {
    const response = await handleGenerateIllustration(authenticatedRequest(), {
      getObjectBytes: async () => {
        network.portraitLoads += 1;
        return TINY_IMAGE_BYTES;
      },
    });
    const body = await response.json();

    assertEquals(response.status, 400);
    assertEquals(body.code, 'EMPTY_CONTENT');
    assertEquals(network.openAiChatPrompts, []);
    assertEquals(network.openAiImagePrompts, []);
    assertEquals(network.portraitLoads, 0);
  });
});

Deno.test(
  'generate-illustration clears its claimed attempt when the safety provider exceeds the pre-finalization deadline',
  async () => {
    await withMockedIllustrationNetwork('A quiet afternoon drawing with crayons.', async (network) => {
      const response = await handleGenerateIllustration(authenticatedRequest(), {
        chatJson: async <T>(
          _systemPrompt: string,
          _userPrompt: string,
          options: { signal?: AbortSignal } = {},
        ) => {
          await new Promise<void>((_resolve, reject) => {
            const rejectAsAborted = () => {
              reject(new DOMException('Aborted', 'AbortError'));
            };

            if (options.signal?.aborted) {
              rejectAsAborted();
              return;
            }

            options.signal?.addEventListener('abort', rejectAsAborted, {
              once: true,
            });
          });

          return {} as T;
        },
        generationTimeoutMs: 10,
        createId: () => 'attempt-token',
      });
      const body = await response.json();

      assertEquals(response.status, 504);
      assertEquals(body.code, 'GENERATION_TIMEOUT');
      assertEquals(network.openAiImagePrompts, []);
      assertEquals(
        network.memoryPatches.some(
          ({ payload, url }) =>
            payload.illustration_status === 'failed' &&
            payload.illustration_generation_attempt_id === null &&
            url.includes('illustration_generation_attempt_id=eq.attempt-token') &&
            url.includes('illustration_status=eq.generating'),
        ),
        true,
      );
    });
  },
);

Deno.test('generate-illustration restores a retained illustration when the deadline expires', async () => {
  await withMockedIllustrationNetwork(
    'A quiet afternoon drawing with crayons.',
    async (network) => {
      const response = await handleGenerateIllustration(authenticatedRequest(), {
        chatJson: async <T>(
          _systemPrompt: string,
          _userPrompt: string,
          options: { signal?: AbortSignal } = {},
        ) => {
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });

          return {} as T;
        },
        generationTimeoutMs: 10,
      });
      const body = await response.json();

      assertEquals(response.status, 504);
      assertEquals(body.code, 'GENERATION_TIMEOUT');
      assertEquals(
        network.memoryPatches.some(
          ({ payload, url }) =>
            payload.illustration_status === 'ready' &&
            payload.illustration_generation_attempt_id === null &&
            url.includes('illustration_generation_attempt_id=eq.') &&
            url.includes('illustration_status=eq.generating'),
        ),
        true,
      );
    },
    [MEMBER_ID],
    {
      illustration_key: 'existing-illustration.webp',
      illustration_generation_id: '77777777-7777-4777-8777-777777777777',
    },
  );
});

// --- Portrait-deferral tests (WS2a) ---------------------------------------

function freshUnclaimedPendingPortraitRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    family_member_id: MEMBER_ID,
    reference_date: '2026-01-01',
    profile_picture_key: `${USER_ID}/family/${MEMBER_ID}/portraits/55555555-5555-4555-8555-555555555555/photo.jpg`,
    illustrated_profile_key: null,
    illustrated_profile_status: 'pending',
    deletion_token: null,
    generation_token: null,
    generation_started_at: null,
    // Well within the three-minute unclaimed-pending grace window.
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function readyPortraitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    family_member_id: MEMBER_ID,
    reference_date: '2026-01-01',
    profile_picture_key: `${USER_ID}/family/${MEMBER_ID}/portraits/55555555-5555-4555-8555-555555555555/photo.jpg`,
    illustrated_profile_key: `${USER_ID}/family/${MEMBER_ID}/portraits/55555555-5555-4555-8555-555555555555/portrait/66666666-6666-4666-8666-666666666666.webp`,
    illustrated_profile_status: 'ready',
    deletion_token: null,
    generation_token: null,
    generation_started_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface SelfRetriggerCall {
  memoryId: string;
  authHeader: string;
}

function trackedRetriggerDependencies(): {
  invokeGenerateIllustration: (memoryId: string, authHeader: string) => Promise<void>;
  waitUntil: (task: Promise<void>) => void;
  calls: SelfRetriggerCall[];
  backgroundTask: () => Promise<void> | undefined;
} {
  const calls: SelfRetriggerCall[] = [];
  let backgroundTask: Promise<void> | undefined;
  return {
    invokeGenerateIllustration: async (memoryId, authHeader) => {
      calls.push({ memoryId, authHeader });
    },
    waitUntil: (task) => {
      backgroundTask = task;
    },
    calls,
    backgroundTask: () => backgroundTask,
  };
}

Deno.test(
  'generate-illustration defers a keyless memory when a fresh in-flight portrait exists',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 409);
        assertEquals(body.code, 'PORTRAITS_NOT_READY');
        assertEquals(
          network.memoryPatches.some(
            ({ payload, url }) =>
              payload.illustration_status === 'pending' &&
              payload.illustration_generation_attempt_id === null &&
              url.includes('illustration_generation_attempt_id=eq.') &&
              url.includes('illustration_status=eq.generating'),
          ),
          true,
        );

        // The recheck sees the same still-fresh row, so no retrigger fires
        // yet -- the portrait pipeline's own completion is what resumes it.
        await retrigger.backgroundTask();
        assertEquals(retrigger.calls.length, 0);
      },
      [MEMBER_ID],
      {},
      { portraitVersions: () => [freshUnclaimedPendingPortraitRow()] },
    );
  },
);

Deno.test(
  'generate-illustration defers but restores a retained illustration when a fresh in-flight portrait exists',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 409);
        assertEquals(body.code, 'PORTRAITS_NOT_READY');
        assertEquals(
          network.memoryPatches.some(
            ({ payload, url }) =>
              payload.illustration_status === 'ready' &&
              payload.illustration_generation_attempt_id === null &&
              url.includes('illustration_generation_attempt_id=eq.') &&
              url.includes('illustration_status=eq.generating'),
          ),
          true,
        );

        // A retained illustration isn't parked at 'pending', so nothing
        // needs to resume it -- no self-retrigger should be scheduled.
        assertEquals(retrigger.backgroundTask(), undefined);
        assertEquals(retrigger.calls.length, 0);
      },
      [MEMBER_ID],
      {
        illustration_key: 'existing-illustration.webp',
        illustration_generation_id: '77777777-7777-4777-8777-777777777777',
      },
      { portraitVersions: () => [freshUnclaimedPendingPortraitRow()] },
    );
  },
);

Deno.test(
  'generate-illustration treats a stale claimed portrait as NO_PORTRAITS, not a deferral',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 400);
        assertEquals(body.code, 'NO_PORTRAITS');
        assertEquals(
          network.memoryPatches.some(
            ({ payload, url }) =>
              payload.illustration_status === 'failed' &&
              payload.illustration_generation_attempt_id === null &&
              url.includes('illustration_generation_attempt_id=eq.') &&
              url.includes('illustration_status=eq.generating'),
          ),
          true,
        );
        assertEquals(retrigger.backgroundTask(), undefined);
        assertEquals(retrigger.calls.length, 0);
      },
      [MEMBER_ID],
      {},
      {
        portraitVersions: () => [
          freshUnclaimedPendingPortraitRow({
            illustrated_profile_status: 'generating',
            generation_token: 'stale-attempt-token',
            // Past the RPC's own 5:30 reclaim window.
            generation_started_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          }),
        ],
      },
    );
  },
);

Deno.test(
  'generate-illustration treats a deletion-claimed portrait as NO_PORTRAITS, not a deferral',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 400);
        assertEquals(body.code, 'NO_PORTRAITS');
        assertEquals(
          network.memoryPatches.some(
            ({ payload, url }) =>
              payload.illustration_status === 'failed' &&
              payload.illustration_generation_attempt_id === null &&
              url.includes('illustration_generation_attempt_id=eq.') &&
              url.includes('illustration_status=eq.generating'),
          ),
          true,
        );
        assertEquals(retrigger.backgroundTask(), undefined);
        assertEquals(retrigger.calls.length, 0);
      },
      [MEMBER_ID],
      {},
      { portraitVersions: () => [freshUnclaimedPendingPortraitRow({ deletion_token: 'deletion-token' })] },
    );
  },
);

Deno.test(
  'generate-illustration self-retriggers exactly once when the post-reset recheck finds a ready portrait',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 409);
        assertEquals(body.code, 'PORTRAITS_NOT_READY');
        assertEquals(
          network.memoryPatches.some(
            ({ payload }) =>
              payload.illustration_status === 'pending' && payload.illustration_generation_attempt_id === null,
          ),
          true,
        );

        await retrigger.backgroundTask();
        assertEquals(retrigger.calls.length, 1);
        assertEquals(retrigger.calls[0].memoryId, MEMORY_ID);
        assertEquals(retrigger.calls[0].authHeader, 'Bearer test-jwt');
      },
      [MEMBER_ID],
      {},
      {
        portraitVersions: (() => {
          let call = 0;
          return () => {
            call += 1;
            // First read: the deferral's own check, still generating.
            // Second read: the finally block's post-reset self-retrigger
            // recheck, now ready.
            return call === 1 ? [freshUnclaimedPendingPortraitRow()] : [readyPortraitRow()];
          };
        })(),
      },
    );
  },
);

Deno.test('signed portrait memory recovery revalidates the initiating actor for the exact family', async () => {
  const previous = Deno.env.get('PORTRAIT_MEMORY_RETRIGGER_SECRET');
  Deno.env.set('PORTRAIT_MEMORY_RETRIGGER_SECRET', 'portrait-retrigger-test-secret');
  try {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async () => {
        const response = await handleGenerateIllustration(
          await internalPortraitRecoveryRequest({
            actorUserId: '99999999-9999-4999-8999-999999999999',
          }),
        );
        assertEquals(response.status, 403);
        assertEquals((await response.json()).code, 'forbidden');
      },
      [MEMBER_ID],
      {},
      { membershipRows: [] },
    );
  } finally {
    if (previous === undefined) Deno.env.delete('PORTRAIT_MEMORY_RETRIGGER_SECRET');
    else Deno.env.set('PORTRAIT_MEMORY_RETRIGGER_SECRET', previous);
  }
});

Deno.test('signed portrait memory recovery preserves the portrait-deferral self-retrigger race closer', async () => {
  const previous = Deno.env.get('PORTRAIT_MEMORY_RETRIGGER_SECRET');
  Deno.env.set('PORTRAIT_MEMORY_RETRIGGER_SECRET', 'portrait-retrigger-test-secret');
  try {
    await withMockedIllustrationNetwork(
      'A quiet afternoon drawing with crayons.',
      async (network) => {
        let backgroundTask: Promise<void> | undefined;
        const redispatches: Array<{ body: string; headers: HeadersInit }> = [];
        const response = await handleGenerateIllustration(
          await internalPortraitRecoveryRequest(),
          {
            waitUntil: (task) => { backgroundTask = task; },
            fetch: (async (_input, init) => {
              redispatches.push({ body: String(init?.body), headers: init?.headers ?? {} });
              return new Response(null, { status: 202 });
            }) as typeof fetch,
          },
        );
        assertEquals(response.status, 409);
        assertEquals((await response.json()).code, 'PORTRAITS_NOT_READY');
        assertEquals(
          network.memoryPatches.some(({ payload }) =>
            payload.illustration_status === 'pending' && payload.illustration_generation_attempt_id === null
          ),
          true,
        );
        await backgroundTask;
        assertEquals(redispatches.length, 1);
        assertEquals(JSON.parse(redispatches[0].body), {
          memoryId: MEMORY_ID,
          requestIntent: 'recovery',
          actorUserId: USER_ID,
          familyId: FAMILY_ID,
        });
        assertEquals(
          Boolean((redispatches[0].headers as Record<string, string>)['x-portrait-retrigger-signature']),
          true,
        );
      },
      [MEMBER_ID],
      {},
      {
        portraitVersions: (() => {
          let call = 0;
          return () => {
            call += 1;
            return call === 1 ? [freshUnclaimedPendingPortraitRow()] : [readyPortraitRow()];
          };
        })(),
      },
    );
  } finally {
    if (previous === undefined) Deno.env.delete('PORTRAIT_MEMORY_RETRIGGER_SECRET');
    else Deno.env.set('PORTRAIT_MEMORY_RETRIGGER_SECRET', previous);
  }
});

Deno.test(
  'generate-illustration leaves NO_PORTRAITS/failed unchanged when no member has any portrait version',
  async () => {
    await withMockedIllustrationNetwork(
      'A quiet afternoon with no names mentioned.',
      async (network) => {
        const retrigger = trackedRetriggerDependencies();
        const response = await handleGenerateIllustration(authenticatedRequest(), {
          invokeGenerateIllustration: retrigger.invokeGenerateIllustration,
          waitUntil: retrigger.waitUntil,
        });
        const body = await response.json();

        assertEquals(response.status, 400);
        assertEquals(body.code, 'NO_PORTRAITS');
        assertEquals(
          network.memoryPatches.some(
            ({ payload, url }) =>
              payload.illustration_status === 'failed' &&
              payload.illustration_generation_attempt_id === null &&
              url.includes('illustration_generation_attempt_id=eq.') &&
              url.includes('illustration_status=eq.generating'),
          ),
          true,
        );
        assertEquals(retrigger.backgroundTask(), undefined);
        assertEquals(retrigger.calls.length, 0);
      },
      [],
      {},
      { portraitVersions: () => [] },
    );
  },
);
