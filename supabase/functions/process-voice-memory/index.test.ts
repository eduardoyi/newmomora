import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  handleProcessVoiceMemoryWithDependencies,
  resolveVoiceFamilyId,
  type ProcessVoiceMemoryDependencies,
} from './index.ts';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ONBOARDING_REQUEST_ID = '33333333-3333-4333-8333-333333333333';

interface VoiceTestCalls {
  events: string[];
  reservationArgs: Record<string, unknown>[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  transcriptionPrompts: string[];
  transcriptionContexts: unknown[];
  cleanupContexts: unknown[];
  cleanupSystemPrompts: string[];
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/process-voice-memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDependencies(input: Partial<ProcessVoiceMemoryDependencies> = {}): {
  dependencies: ProcessVoiceMemoryDependencies;
  calls: VoiceTestCalls;
} {
  const calls: VoiceTestCalls = {
    events: [],
    reservationArgs: [],
    rpcCalls: [],
    transcriptionPrompts: [],
    transcriptionContexts: [],
    cleanupContexts: [],
    cleanupSystemPrompts: [],
  };
  const dependencies: ProcessVoiceMemoryDependencies = {
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: true }),
    createServiceClient: () => ({
      rpc: async (name, args) => {
        if (name === 'assert_billing_write_access') {
          return { data: true, error: null };
        }
        calls.events.push(name === 'reserve_onboarding_voice_attempt' ? 'reserve' : 'mark-cleanup');
        calls.rpcCalls.push({ name, args });
        if (name === 'reserve_onboarding_voice_attempt') {
          calls.reservationArgs.push(args);
          return { data: [{ reserved: true, request_id: ONBOARDING_REQUEST_ID, attempts_used: 1 }], error: null };
        }
        return { data: true, error: null };
      },
    }),
    getCanonicalFamilyMembers: async () => [{ id: 'canonical-sarah', name: 'Sarah', nicknames: ['Sally'] }],
    getFamilyRole: async () => 'owner',
    transcribeAudio: async (_audio, prompt, options) => {
      calls.events.push('transcribe');
      calls.transcriptionPrompts.push(prompt);
      calls.transcriptionContexts.push(options.usageContext);
      return 'Sarah made a tower';
    },
    chatJson: async <T>(system: string, _transcript: string, options: { usageContext: unknown }) => {
      calls.events.push('cleanup');
      calls.cleanupContexts.push(options.usageContext);
      calls.cleanupSystemPrompts.push(system);
      return { cleanedText: 'Sarah made a tower', mentionedUserSelf: false } as T;
    },
    ...input,
  };
  return { dependencies, calls };
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test('process-voice-memory rejects unauthenticated requests', async () => {
  const { dependencies } = makeDependencies({ getAuthenticatedUser: async () => null });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ audioBase64: 'AQID', familyMembers: [] }),
    dependencies,
  );
  assertEquals(response.status, 401);
  assertEquals(await readBody(response), { error: 'Unauthorized', code: 'unauthorized' });
});

Deno.test('onboarding voice is anonymous-only and never reserves or calls OpenAI for a permanent account', async () => {
  const { dependencies, calls } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'] }),
    dependencies,
  );
  assertEquals(response.status, 403);
  assertEquals(await readBody(response), {
    error: 'Onboarding voice requires an anonymous session', code: 'ONBOARDING_ANONYMOUS_REQUIRED',
  });
  assertEquals(calls.events, []);
});

Deno.test('onboarding voice validates name hints before reserving an attempt', async () => {
  const invalidHints: unknown[] = [undefined, 'not-an-array', [''], ['   '], [42], Array(7).fill('Maya'), ['x'.repeat(51)]];
  for (const nameHints of invalidHints) {
    const { dependencies, calls } = makeDependencies();
    const response = await handleProcessVoiceMemoryWithDependencies(
      makeRequest({ mode: 'onboarding', audioBase64: 'AQID', ...(nameHints === undefined ? {} : { nameHints }) }),
      dependencies,
    );
    assertEquals(response.status, 400);
    assertEquals(await readBody(response), {
      error: 'nameHints must contain at most 6 non-empty names of 50 characters or fewer', code: 'validation_error',
    });
    assertEquals(calls.events, []);
  }
});

Deno.test('onboarding voice rejects a mixed family context before reserving an attempt', async () => {
  const { dependencies, calls } = makeDependencies();
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({
      mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'], familyId: FAMILY_ID,
      familyMembers: [{ id: 'not-accepted', name: 'Maya' }],
    }),
    dependencies,
  );
  assertEquals(response.status, 400);
  assertEquals(await readBody(response), {
    error: 'Onboarding voice cannot include family context', code: 'validation_error',
  });
  assertEquals(calls.events, []);
});

Deno.test('onboarding voice reserves before OpenAI, uses hints only for prompting, and records system-cost attribution', async () => {
  const { dependencies, calls } = makeDependencies();
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['  Maya  ', 'Leo'] }),
    dependencies,
  );
  assertEquals(response.status, 200);
  assertEquals(await readBody(response), {
    cleanedText: 'Sarah made a tower', mentionedMemberIds: [],
  });
  assertEquals(calls.events, ['reserve', 'transcribe', 'mark-cleanup', 'cleanup']);
  assertEquals(calls.reservationArgs, [{ p_actor_user_id: USER_ID }]);
  assertEquals(calls.rpcCalls[1], {
    name: 'mark_onboarding_voice_cleanup_expected',
    args: { p_request_id: ONBOARDING_REQUEST_ID, p_actor_user_id: USER_ID },
  });
  assertStringIncludes(calls.transcriptionPrompts[0], 'Maya');
  assertStringIncludes(calls.transcriptionPrompts[0], 'Leo');
  assertEquals(calls.transcriptionContexts, [{
    attributionScope: 'onboarding', familyId: null,
    onboardingRequestId: ONBOARDING_REQUEST_ID, operation: 'transcription',
  }]);
  assertEquals(calls.cleanupContexts, [{
    attributionScope: 'onboarding', familyId: null,
    onboardingRequestId: ONBOARDING_REQUEST_ID, operation: 'voice_cleanup',
  }]);
});

Deno.test('onboarding voice accepts an empty hint list', async () => {
  const { dependencies, calls } = makeDependencies();
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: [] }),
    dependencies,
  );
  assertEquals(response.status, 200);
  assertEquals(calls.events, ['reserve', 'transcribe', 'mark-cleanup', 'cleanup']);
});

Deno.test('onboarding reservation denial prevents all OpenAI calls', async () => {
  const { dependencies, calls } = makeDependencies({
    createServiceClient: () => ({
      rpc: async () => ({ data: [{ reserved: false, request_id: null, attempts_used: 2 }], error: null }),
    }),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'] }),
    dependencies,
  );
  assertEquals(response.status, 429);
  assertEquals(await readBody(response), {
    error: 'Onboarding voice limit reached', code: 'ONBOARDING_VOICE_LIMIT_REACHED',
  });
  assertEquals(calls.events, []);
});

Deno.test('onboarding reservation RPC errors or malformed results fail closed before OpenAI', async () => {
  for (const rpcResult of [
    { data: null, error: { message: 'database unavailable' } },
    { data: 'true', error: null },
    { data: { allowed: true }, error: null },
  ]) {
    const { dependencies, calls } = makeDependencies({
      createServiceClient: () => ({ rpc: async () => rpcResult }),
    });
    const response = await handleProcessVoiceMemoryWithDependencies(
      makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'] }),
      dependencies,
    );
    assertEquals(response.status, 503);
    assertEquals(await readBody(response), {
      error: 'Onboarding voice is temporarily unavailable', code: 'ONBOARDING_VOICE_RESERVATION_FAILED',
    });
    assertEquals(calls.events, []);
  }
});

Deno.test('onboarding cleanup marker denial, error, or malformed result prevents the cleanup provider call', async () => {
  for (const markerResult of [
    { data: false, error: null },
    { data: null, error: { message: 'database unavailable' } },
    { data: 'true', error: null },
  ]) {
    const { dependencies, calls } = makeDependencies({
      createServiceClient: () => ({
        rpc: async (name) => name === 'reserve_onboarding_voice_attempt'
          ? { data: [{ reserved: true, request_id: ONBOARDING_REQUEST_ID, attempts_used: 1 }], error: null }
          : markerResult,
      }),
    });
    const response = await handleProcessVoiceMemoryWithDependencies(
      makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'] }),
      dependencies,
    );
    assertEquals(response.status, 503);
    assertEquals(await readBody(response), {
      error: 'Onboarding voice is temporarily unavailable', code: 'ONBOARDING_VOICE_CLEANUP_RESERVATION_FAILED',
    });
    assertEquals(calls.events, ['transcribe']);
  }
});

Deno.test('family voice remains the default, uses the canonical roster, and records family attribution', async () => {
  const { dependencies, calls } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({
      audioBase64: 'AQID', familyId: FAMILY_ID,
      familyMembers: [{ id: 'attacker-controlled', name: 'Not Sarah' }],
    }),
    dependencies,
  );
  assertEquals(response.status, 200);
  assertEquals(await readBody(response), {
    cleanedText: 'Sarah made a tower', description: '', mentionedMemberIds: ['canonical-sarah'],
  });
  assertEquals(calls.events, ['transcribe', 'cleanup']);
  assertStringIncludes(calls.transcriptionPrompts[0], 'Sarah');
  assertEquals(calls.transcriptionPrompts[0].includes('Not Sarah'), false);
  assertEquals(calls.transcriptionContexts, [{
    attributionScope: 'family', familyId: FAMILY_ID, actorUserId: USER_ID, operation: 'transcription',
  }]);
  assertEquals(calls.cleanupContexts, [{
    attributionScope: 'family', familyId: FAMILY_ID, actorUserId: USER_ID, operation: 'voice_cleanup',
  }]);
});

Deno.test('family voice caption context carries names, nicknames, and derived age labels — never the birth date', async () => {
  const { dependencies, calls } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
    getCanonicalFamilyMembers: async () => [
      { id: 'canonical-sarah', name: 'Sarah', nicknames: ['Sally'], date_of_birth: '2023-03-15' },
      { id: 'canonical-max', name: 'Max' },
    ],
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ audioBase64: 'AQID', familyId: FAMILY_ID }),
    dependencies,
  );
  assertEquals(response.status, 200);
  const prompt = calls.cleanupSystemPrompts[0];
  assertStringIncludes(prompt, 'Family members:');
  assertStringIncludes(prompt, 'Sarah');
  assertStringIncludes(prompt, 'Sally');
  assertStringIncludes(prompt, 'Max');
  // Derived age label present (exact wording owned by describeAgeAtDate);
  // the raw date_of_birth must never reach the model.
  assertStringIncludes(prompt.toLowerCase(), 'old');
  assertEquals(prompt.includes('2023-03-15'), false);
  assertStringIncludes(prompt, 'canonical name');
  // Onboarding stays context-free: dictate-only path builds the prompt
  // without members (covered by the onboarding tests' unchanged shape).
});

Deno.test('process-voice-memory rejects empty audio before any reservation or provider call', async () => {
  const { dependencies, calls } = makeDependencies();
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: '', nameHints: [] }),
    dependencies,
  );
  assertEquals(response.status, 400);
  assertEquals(await readBody(response), { error: 'audioBase64 is required', code: 'validation_error' });
  assertEquals(calls.events, []);
});

Deno.test('process-voice-memory rejects malformed base64 before any RPC or provider call in either mode', async () => {
  for (const body of [
    { mode: 'onboarding', audioBase64: '%%%', nameHints: [] },
    { audioBase64: '%%%', familyId: FAMILY_ID },
  ]) {
    const { dependencies, calls } = makeDependencies({
      getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: body.mode === 'onboarding' }),
    });
    const response = await handleProcessVoiceMemoryWithDependencies(makeRequest(body), dependencies);
    assertEquals(response.status, 400);
    assertEquals(await readBody(response), { error: 'Invalid audio payload', code: 'validation_error' });
    assertEquals(calls.events, []);
  }
});

Deno.test('legacy voice family resolution falls back from a stale active family to exactly one authorized membership', async () => {
  const calls: string[] = [];
  const result = await resolveVoiceFamilyId({
    supabase: {
      from(table) {
        return {
          select: () => ({
            eq: () => table === 'user_profiles'
              ? { maybeSingle: async () => ({ data: { active_family_id: 'stale-family' }, error: null }) }
              : { limit: async () => ({ data: [{ family_id: 'remaining-family' }], error: null }) },
          }),
        };
      },
    },
    userId: 'user-id',
    getFamilyRole: async (familyId) => {
      calls.push(familyId);
      return familyId === 'remaining-family' ? 'editor' : null;
    },
  });
  assertEquals(result, { familyId: 'remaining-family' });
  assertEquals(calls, ['stale-family', 'remaining-family']);
});

Deno.test('family voice returns the AI description alongside cleanedText for usable speech', async () => {
  const { dependencies } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
    chatJson: async <T>() => ({
      cleanedText: 'Sarah made a tower',
      description: 'Sarah building a block tower',
      mentionedUserSelf: false,
    } as T),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ audioBase64: 'AQID', familyId: FAMILY_ID }),
    dependencies,
  );
  assertEquals(response.status, 200);
  assertEquals(await readBody(response), {
    cleanedText: 'Sarah made a tower',
    description: 'Sarah building a block tower',
    mentionedMemberIds: ['canonical-sarah'],
  });
});

Deno.test('family voice returns an empty description for unusable speech, never an error', async () => {
  const { dependencies } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
    chatJson: async <T>() => ({
      cleanedText: '',
      description: '',
      mentionedUserSelf: false,
    } as T),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ audioBase64: 'AQID', familyId: FAMILY_ID }),
    dependencies,
  );
  assertEquals(response.status, 200);
  const body = await readBody(response);
  assertEquals(body.description, '');
});

Deno.test('family voice clamps an oversized description to 120 characters', async () => {
  const overlong = 'x'.repeat(200);
  const { dependencies } = makeDependencies({
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
    chatJson: async <T>() => ({
      cleanedText: 'Sarah made a tower',
      description: overlong,
      mentionedUserSelf: false,
    } as T),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ audioBase64: 'AQID', familyId: FAMILY_ID }),
    dependencies,
  );
  assertEquals(response.status, 200);
  const body = await readBody(response);
  assertEquals(body.description, 'x'.repeat(120));
});

Deno.test('family voice defaults a missing or malformed description to an empty string', async () => {
  for (const malformedDescription of [undefined, null, 42, ['not', 'a', 'string'], { nested: true }]) {
    const { dependencies } = makeDependencies({
      getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }),
      chatJson: async <T>() => ({
        cleanedText: 'Sarah made a tower',
        description: malformedDescription,
        mentionedUserSelf: false,
      } as T),
    });
    const response = await handleProcessVoiceMemoryWithDependencies(
      makeRequest({ audioBase64: 'AQID', familyId: FAMILY_ID }),
      dependencies,
    );
    assertEquals(response.status, 200);
    const body = await readBody(response);
    assertEquals(body.description, '');
  }
});

Deno.test('onboarding voice response shape is unchanged by the family-mode description feature (no description field)', async () => {
  const { dependencies } = makeDependencies({
    chatJson: async <T>() => ({
      cleanedText: 'Sarah made a tower',
      description: 'this must never leak into onboarding responses',
      mentionedUserSelf: false,
    } as T),
  });
  const response = await handleProcessVoiceMemoryWithDependencies(
    makeRequest({ mode: 'onboarding', audioBase64: 'AQID', nameHints: ['Maya'] }),
    dependencies,
  );
  assertEquals(response.status, 200);
  assertEquals(await readBody(response), {
    cleanedText: 'Sarah made a tower', mentionedMemberIds: [],
  });
});

Deno.test('legacy voice family resolution refuses ambiguous memberships after a stale active family', async () => {
  const result = await resolveVoiceFamilyId({
    supabase: {
      from(table) {
        return {
          select: () => ({
            eq: () => table === 'user_profiles'
              ? { maybeSingle: async () => ({ data: { active_family_id: 'stale-family' }, error: null }) }
              : { limit: async () => ({ data: [{ family_id: 'family-a' }, { family_id: 'family-b' }], error: null }) },
          }),
        };
      },
    },
    userId: 'user-id',
    getFamilyRole: async () => null,
  });
  assertEquals(result, { code: 'FAMILY_CONTEXT_REQUIRED' });
});
