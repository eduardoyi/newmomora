import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import type { FamilyRole } from '../_shared/family-access.ts';
import {
  DEFAULT_DEPENDENCIES,
  type GetMediaUrlDependencies,
  handleGetMediaUrl,
} from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const VALID_KEY = `${USER_ID}/memories/44444444-4444-4444-8444-444444444444/media.jpg`;
const VALID_KEY_2 = `${USER_ID}/memories/55555555-5555-4555-8555-555555555555/media.jpg`;
// Simulates a re-keyed object: the entity's family resolves fine, but the
// owning row no longer references THIS exact key (a backfill moved it to a
// fresh key and deleted the old one) -- the production incident this fix
// targets.
const STALE_KEY = `${USER_ID}/memories/66666666-6666-4666-8666-666666666666/media.jpg`;
const UNPARSEABLE_KEY = 'not-a-valid-object-key';
const FOREIGN_KEY = `${USER_ID}/memories/77777777-7777-4777-8777-777777777777/media.jpg`;

function request(keys: unknown): Request {
  return new Request('http://localhost/get-media-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ keys }),
  });
}

function deps(options: {
  familyIdByKey?: Record<string, string | null>;
  rolesByFamilyId?: Record<string, FamilyRole | null>;
  referencedKeys?: string[];
  calls?: string[];
} = {}): GetMediaUrlDependencies {
  const { familyIdByKey = {}, rolesByFamilyId = {}, referencedKeys = [], calls } = options;
  const referenced = new Set(referencedKeys);

  return {
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false }) as never,
    createServiceClient: () => ({}) as never,
    resolveStorageKeyFamilyIds: async (_client, keys) => {
      calls?.push('resolveStorageKeyFamilyIds');
      return keys.map((objectKey) => ({
        objectKey,
        parsed: null,
        familyId: familyIdByKey[objectKey] ?? null,
      }));
    },
    getCallerFamilyRoles: async (_client, familyIds) => {
      calls?.push('getCallerFamilyRoles');
      return new Map(familyIds.map((id) => [id, rolesByFamilyId[id] ?? null]));
    },
    resolveReferencedStorageKeys: async () => {
      calls?.push('resolveReferencedStorageKeys');
      return referenced;
    },
    createPresignedGetUrls: async (keys) => {
      calls?.push('createPresignedGetUrls');
      return Object.fromEntries(keys.map((key) => [key, `https://signed.example/${key}`]));
    },
  };
}

Deno.test('get-media-url rejects unauthenticated requests', async () => {
  const response = await handleGetMediaUrl(
    new Request('http://localhost/get-media-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['user-id/family/member/photo.webp'] }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('get-media-url rejects unsupported methods', async () => {
  const response = await handleGetMediaUrl(
    new Request('http://localhost/get-media-url', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});

Deno.test('get-media-url rejects an empty key list with 400 (malformed request, not a partial batch)', async () => {
  const calls: string[] = [];
  const response = await handleGetMediaUrl(request([]), deps({ calls }));

  assertEquals(response.status, 400);
  assertEquals(calls, []);
});

Deno.test('get-media-url rejects more than MAX_KEYS with 400', async () => {
  const calls: string[] = [];
  const tooManyKeys = Array.from({ length: 51 }, (_, i) => `${VALID_KEY}-${i}`);
  const response = await handleGetMediaUrl(request(tooManyKeys), deps({ calls }));

  assertEquals(response.status, 400);
  assertEquals(calls, []);
});

Deno.test('get-media-url rejects a non-string key entry with 400', async () => {
  const calls: string[] = [];
  const response = await handleGetMediaUrl(request([VALID_KEY, 123]), deps({ calls }));

  assertEquals(response.status, 400);
  assertEquals(calls, []);
});

Deno.test('get-media-url rejects invalid JSON body with 400', async () => {
  const response = await handleGetMediaUrl(
    new Request('http://localhost/get-media-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{not json',
    }),
    deps(),
  );

  assertEquals(response.status, 400);
});

Deno.test('get-media-url: mixed batch returns 200 with only the valid, still-referenced key', async () => {
  const response = await handleGetMediaUrl(
    request([VALID_KEY, STALE_KEY]),
    deps({
      familyIdByKey: { [VALID_KEY]: FAMILY_ID, [STALE_KEY]: FAMILY_ID },
      rolesByFamilyId: { [FAMILY_ID]: 'owner' },
      // STALE_KEY's family resolves, but its owning row no longer points at
      // this exact key -- the re-keyed/deleted-object case.
      referencedKeys: [VALID_KEY],
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.keys(body.urls), [VALID_KEY]);
  assertEquals(body.urls[VALID_KEY], `https://signed.example/${VALID_KEY}`);
  assertEquals(typeof body.expiresIn, 'number');
});

Deno.test('get-media-url: an unparseable key is omitted, not batch-failing', async () => {
  const response = await handleGetMediaUrl(
    request([UNPARSEABLE_KEY, VALID_KEY]),
    deps({
      familyIdByKey: { [VALID_KEY]: FAMILY_ID },
      rolesByFamilyId: { [FAMILY_ID]: 'owner' },
      referencedKeys: [VALID_KEY],
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.keys(body.urls), [VALID_KEY]);
});

Deno.test('get-media-url: a key belonging to a family the caller is not a member of is omitted', async () => {
  const response = await handleGetMediaUrl(
    request([FOREIGN_KEY, VALID_KEY]),
    deps({
      familyIdByKey: { [FOREIGN_KEY]: FOREIGN_FAMILY_ID, [VALID_KEY]: FAMILY_ID },
      // Caller has no role in FOREIGN_FAMILY_ID.
      rolesByFamilyId: { [FOREIGN_FAMILY_ID]: null, [FAMILY_ID]: 'owner' },
      referencedKeys: [FOREIGN_KEY, VALID_KEY],
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.keys(body.urls), [VALID_KEY]);
});

Deno.test('get-media-url: every key denied returns 200 with an empty urls map (not an error)', async () => {
  const calls: string[] = [];
  const response = await handleGetMediaUrl(
    request([UNPARSEABLE_KEY, STALE_KEY]),
    deps({
      familyIdByKey: { [STALE_KEY]: FAMILY_ID },
      rolesByFamilyId: { [FAMILY_ID]: 'owner' },
      referencedKeys: [],
      calls,
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.urls, {});
  assertEquals(typeof body.expiresIn, 'number');
  // Presigning is skipped entirely when nothing survives authorization.
  assertEquals(calls.includes('createPresignedGetUrls'), false);
});

Deno.test('get-media-url: an all-good batch is unchanged -- every key comes back with a URL', async () => {
  const response = await handleGetMediaUrl(
    request([VALID_KEY, VALID_KEY_2]),
    deps({
      familyIdByKey: { [VALID_KEY]: FAMILY_ID, [VALID_KEY_2]: FAMILY_ID },
      rolesByFamilyId: { [FAMILY_ID]: 'owner' },
      referencedKeys: [VALID_KEY, VALID_KEY_2],
    }),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.keys(body.urls).sort(), [VALID_KEY, VALID_KEY_2].sort());
});

Deno.test('get-media-url: omission is logged as counts + a small id sample, on one line', async () => {
  const originalLog = console.log;
  const logged: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    const response = await handleGetMediaUrl(
      request([UNPARSEABLE_KEY, VALID_KEY]),
      deps({
        familyIdByKey: { [VALID_KEY]: FAMILY_ID },
        rolesByFamilyId: { [FAMILY_ID]: 'owner' },
        referencedKeys: [VALID_KEY],
      }),
    );
    assertEquals(response.status, 200);
  } finally {
    console.log = originalLog;
  }

  assertEquals(logged.length, 1);
  assertEquals(logged[0].length, 1);
  const line = String(logged[0][0]);
  assertEquals(line.includes('requested=2'), true);
  assertEquals(line.includes('served=1'), true);
  assertEquals(line.includes('omitted=1'), true);
});

Deno.test('WP-SEC: the real default wiring uses the anonymous-rejecting auth chokepoint, not the permissive one', () => {
  assertStrictEquals(DEFAULT_DEPENDENCIES.getAuthenticatedUser, getAuthenticatedNonAnonymousUser);
});
