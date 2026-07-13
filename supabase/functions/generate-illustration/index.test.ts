import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleGenerateIllustration } from './index.ts';

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
}

const TEST_ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_ANON_KEY: 'test-anon-key',
  OPENAI_API_KEY: 'test-openai-key',
} as const;

async function withMockedIllustrationNetwork(
  content: string,
  run: (result: MockNetworkResult) => Promise<void>,
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
          illustration_status: 'pending',
          updated_at: '2026-07-12T00:00:00.000Z',
          memory_type: 'text_illustration',
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
        return jsonResponse([{ family_id: FAMILY_ID, role: 'owner' }]);
      }

      if (table === 'memory_family_members') {
        return jsonResponse([{ family_member_id: MEMBER_ID }]);
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
