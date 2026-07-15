import { assertEquals } from 'jsr:@std/assert@1';
import { handleDeleteFamilyMember } from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const LEGACY_PHOTO = `${USER_ID}/family/${MEMBER_ID}/photo.webp`;
const LEGACY_PORTRAIT = `${USER_ID}/family/${MEMBER_ID}/portrait.webp`;
const VERSION_PHOTO = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`;

function request(): Request {
  return new Request('http://localhost/delete-family-member', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ familyMemberId: MEMBER_ID }),
  });
}

function dependencies(
  role: 'owner' | 'manager' | 'viewer',
  calls: string[],
  options: { portraitLookupError?: boolean } = {},
) {
  const member = {
    id: MEMBER_ID,
    family_id: FAMILY_ID,
    profile_picture_key: LEGACY_PHOTO,
    illustrated_profile_key: LEGACY_PORTRAIT,
  };
  const client = {
    from(table: string) {
      if (table === 'family_members') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: member, error: null }) }),
          }),
          delete: () => ({
            eq: async () => {
              calls.push('delete-row');
              return { error: null };
            },
          }),
        };
      }
      return {
        select: () => ({
          eq: async () => options.portraitLookupError
            ? ({ data: null, error: { message: 'lookup failed' } })
            : ({ data: [{ profile_picture_key: VERSION_PHOTO }], error: null }),
        }),
      };
    },
  };
  return {
    getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
    createServiceClient: () => client as never,
    getCallerFamilyRole: async () => role,
    listObjectKeys: async (prefix: string) => {
      calls.push(`list:${prefix}`);
      return [VERSION_PHOTO, `${prefix}portrait/55555555-5555-4555-8555-555555555555.webp`];
    },
    deleteObject: async (key: string) => {
      calls.push(`delete:${key}`);
    },
  };
}

Deno.test('delete-family-member rejects unauthenticated requests', async () => {
  const response = await handleDeleteFamilyMember(
    new Request('http://localhost/delete-family-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyMemberId: crypto.randomUUID() }),
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test('delete-family-member rejects unsupported methods', async () => {
  const response = await handleDeleteFamilyMember(
    new Request('http://localhost/delete-family-member', { method: 'GET' }),
  );
  assertEquals(response.status, 405);
});

Deno.test('delete-family-member rejects viewers before listing portrait objects', async () => {
  const calls: string[] = [];
  const response = await handleDeleteFamilyMember(request(), dependencies('viewer', calls));
  assertEquals(response.status, 403);
  assertEquals(calls, []);
});

Deno.test('delete-family-member removes legacy and every version-prefix object before the row', async () => {
  const calls: string[] = [];
  const response = await handleDeleteFamilyMember(request(), dependencies('manager', calls));
  const prefix = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/`;
  assertEquals(response.status, 200);
  assertEquals(calls, [
    `list:${prefix}`,
    `delete:${LEGACY_PHOTO}`,
    `delete:${LEGACY_PORTRAIT}`,
    `delete:${VERSION_PHOTO}`,
    `delete:${prefix}portrait/55555555-5555-4555-8555-555555555555.webp`,
    'delete-row',
  ]);
});

Deno.test('delete-family-member keeps the row and storage when portrait enumeration fails', async () => {
  const calls: string[] = [];
  const response = await handleDeleteFamilyMember(
    request(),
    dependencies('manager', calls, { portraitLookupError: true }),
  );

  assertEquals(response.status, 500);
  assertEquals(calls, []);
});
