import { assertEquals } from 'jsr:@std/assert@1';
import { handleDeletePortraitVersion } from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_KEY = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`;

function request(): Request {
  return new Request('http://localhost/delete-portrait-version', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portraitVersionId: VERSION_ID }),
  });
}

function dependencies(options: {
  role?: 'owner' | 'manager' | 'viewer' | null;
  sourceKey?: string;
  claimError?: { message: string } | null;
  listedKeys?: string[];
  calls?: string[];
}) {
  const calls = options.calls ?? [];
  const version = {
    id: VERSION_ID,
    family_id: FAMILY_ID,
    family_member_id: MEMBER_ID,
    profile_picture_key: options.sourceKey ?? SOURCE_KEY,
    deletion_token: null,
  };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: version, error: null }) }),
      }),
    }),
    rpc: async (name: string) => {
      calls.push(name);
      if (name === 'claim_family_member_portrait_deletion' && options.claimError) {
        return { data: null, error: options.claimError };
      }
      return { data: name === 'finish_family_member_portrait_deletion' ? true : version, error: null };
    },
  };
  return {
    getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
    createServiceClient: () => client as never,
    getCallerFamilyRole: async () => options.role ?? 'owner',
    listObjectKeys: async (prefix: string) => {
      calls.push(`list:${prefix}`);
      return options.listedKeys ?? [SOURCE_KEY];
    },
    deleteObject: async (key: string) => {
      calls.push(`delete:${key}`);
    },
  };
}

Deno.test('delete-portrait-version rejects unauthenticated requests', async () => {
  const response = await handleDeletePortraitVersion(
    new Request('http://localhost/delete-portrait-version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portraitVersionId: crypto.randomUUID() }),
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test('delete-portrait-version rejects unsupported methods', async () => {
  const response = await handleDeletePortraitVersion(
    new Request('http://localhost/delete-portrait-version', { method: 'GET' }),
  );
  assertEquals(response.status, 405);
});

Deno.test('delete-portrait-version rejects viewers before claiming deletion', async () => {
  const calls: string[] = [];
  const response = await handleDeletePortraitVersion(
    request(),
    dependencies({ role: 'viewer', calls }),
  );
  assertEquals(response.status, 403);
  assertEquals(calls, []);
});

Deno.test('delete-portrait-version rejects a source key that does not match its version row', async () => {
  const response = await handleDeletePortraitVersion(
    request(),
    dependencies({ sourceKey: `${USER_ID}/family/${MEMBER_ID}/photo.webp` }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, 'validation_error');
});

Deno.test('delete-portrait-version maps last-usable claim rejection without touching R2', async () => {
  const calls: string[] = [];
  const response = await handleDeletePortraitVersion(
    request(),
    dependencies({ claimError: { message: 'The last usable portrait cannot be deleted' }, calls }),
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, 'DELETE_NOT_ALLOWED');
  assertEquals(calls, ['claim_family_member_portrait_deletion']);
});

Deno.test('delete-portrait-version deletes the complete prefix before finalizing', async () => {
  const calls: string[] = [];
  const portraitKey = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/55555555-5555-4555-8555-555555555555.webp`;
  const response = await handleDeletePortraitVersion(
    request(),
    dependencies({ listedKeys: [SOURCE_KEY, portraitKey], calls }),
  );
  assertEquals(response.status, 200);
  assertEquals(calls, [
    'claim_family_member_portrait_deletion',
    `list:${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/`,
    `delete:${SOURCE_KEY}`,
    `delete:${portraitKey}`,
    'finish_family_member_portrait_deletion',
  ]);
});
