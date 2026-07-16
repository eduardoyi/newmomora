import { assertEquals } from 'jsr:@std/assert@1';
import {
  getCallerFamilyRoles,
  isManagerRole,
  resolveReferencedStorageKeys,
  resolveStorageKeyFamilyIds,
} from './family-access.ts';
import {
  buildFamilyPhotoKey,
  buildFamilyPortraitKey,
  buildMemoryIllustrationKey,
  buildMemoryMediaAssetKey,
  buildMemoryMediaKey,
  buildPortraitVersionAttemptKey,
  buildPortraitVersionPhotoKey,
  parseStorageKey,
} from './storage-keys.ts';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDER_ID = '44444444-4444-4444-8444-444444444444';
const FAMILY_A = '55555555-5555-4555-8555-555555555555';
const FAMILY_B = '66666666-6666-4666-8666-666666666666';
const MEMORY_ID = '77777777-7777-4777-8777-777777777777';
const MEMBER_ID = '88888888-8888-4888-8888-888888888888';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const ILLUSTRATION_GENERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakeSupabase(options: {
  families: Array<{ id: string; owner_id: string; deleted_at: string | null }>;
  memberships: Array<{ family_id: string; role: string }>;
  memories?: Array<{ id: string; family_id: string }>;
  familyMembers?: Array<{ id: string; family_id: string }>;
}) {
  return {
    from(table: string) {
      if (table === 'families') {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: options.families.filter((f) => ids.includes(f.id)),
              error: null,
            }),
          }),
        };
      }

      if (table === 'family_memberships') {
        return {
          select: () => ({
            eq: () => ({
              in: async (_col: string, ids: string[]) => ({
                data: options.memberships.filter((m) => ids.includes(m.family_id)),
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'memories') {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: (options.memories ?? []).filter((m) => ids.includes(m.id)),
              error: null,
            }),
          }),
        };
      }

      if (table === 'family_members') {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: (options.familyMembers ?? []).filter((m) => ids.includes(m.id)),
              error: null,
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

Deno.test('getCallerFamilyRoles resolves owner/manager/viewer roles', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [
      { family_id: FAMILY_A, role: 'owner' },
    ],
  });

  const roles = await getCallerFamilyRoles(supabase as never, [FAMILY_A], OWNER_ID);
  assertEquals(roles.get(FAMILY_A), 'owner');
});
Deno.test('getCallerFamilyRoles returns null for a non-member', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [],
  });

  const roles = await getCallerFamilyRoles(supabase as never, [FAMILY_A], OUTSIDER_ID);
  assertEquals(roles.get(FAMILY_A), null);
});

Deno.test('getCallerFamilyRoles hides a soft-deleted family from non-owners', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: '2026-01-01T00:00:00Z' }],
    memberships: [{ family_id: FAMILY_A, role: 'manager' }],
  });

  const managerRoles = await getCallerFamilyRoles(supabase as never, [FAMILY_A], MANAGER_ID);
  assertEquals(managerRoles.get(FAMILY_A), null);
});

Deno.test('getCallerFamilyRoles keeps a soft-deleted family visible to its owner', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: '2026-01-01T00:00:00Z' }],
    memberships: [{ family_id: FAMILY_A, role: 'owner' }],
  });

  const ownerRoles = await getCallerFamilyRoles(supabase as never, [FAMILY_A], OWNER_ID);
  assertEquals(ownerRoles.get(FAMILY_A), 'owner');
});

Deno.test('getCallerFamilyRoles batches across multiple families in one pair of queries', async () => {
  const supabase = fakeSupabase({
    families: [
      { id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null },
      { id: FAMILY_B, owner_id: OUTSIDER_ID, deleted_at: null },
    ],
    memberships: [
      { family_id: FAMILY_A, role: 'viewer' },
    ],
  });

  const roles = await getCallerFamilyRoles(supabase as never, [FAMILY_A, FAMILY_B], VIEWER_ID);
  assertEquals(roles.get(FAMILY_A), 'viewer');
  assertEquals(roles.get(FAMILY_B), null);
});

Deno.test('isManagerRole accepts owner and manager, rejects viewer and null', () => {
  assertEquals(isManagerRole('owner'), true);
  assertEquals(isManagerRole('manager'), true);
  assertEquals(isManagerRole('viewer'), false);
  assertEquals(isManagerRole(null), false);
});

Deno.test('parseStorageKey extracts kind/ownerUserId/entityId for all four key shapes', () => {
  assertEquals(parseStorageKey(buildFamilyPhotoKey(OWNER_ID, MEMBER_ID)), {
    kind: 'family_photo',
    ownerUserId: OWNER_ID,
    entityId: MEMBER_ID,
  });
  assertEquals(parseStorageKey(buildFamilyPortraitKey(OWNER_ID, MEMBER_ID)), {
    kind: 'family_portrait',
    ownerUserId: OWNER_ID,
    entityId: MEMBER_ID,
  });
  assertEquals(parseStorageKey(buildMemoryIllustrationKey(
    OWNER_ID,
    MEMORY_ID,
    ILLUSTRATION_GENERATION_ID,
  )), {
    kind: 'memory_illustration',
    ownerUserId: OWNER_ID,
    entityId: MEMORY_ID,
  });
  assertEquals(parseStorageKey(buildMemoryMediaKey(OWNER_ID, MEMORY_ID, 'jpg')), {
    kind: 'memory_media',
    ownerUserId: OWNER_ID,
    entityId: MEMORY_ID,
  });
  assertEquals(
    parseStorageKey(buildMemoryMediaAssetKey(OWNER_ID, MEMORY_ID, MEMBER_ID, 'mp4')),
    { kind: 'memory_media', ownerUserId: OWNER_ID, entityId: MEMORY_ID },
  );
  assertEquals(parseStorageKey(buildPortraitVersionPhotoKey(OWNER_ID, MEMBER_ID, VERSION_ID)), {
    kind: 'portrait_version_photo',
    ownerUserId: OWNER_ID,
    entityId: MEMBER_ID,
    portraitVersionId: VERSION_ID,
  });
  assertEquals(
    parseStorageKey(buildPortraitVersionAttemptKey(OWNER_ID, MEMBER_ID, VERSION_ID, MEMORY_ID)),
    {
      kind: 'portrait_version_portrait',
      ownerUserId: OWNER_ID,
      entityId: MEMBER_ID,
      portraitVersionId: VERSION_ID,
      attemptId: MEMORY_ID,
    },
  );
});

Deno.test('parseStorageKey rejects unknown shapes', () => {
  assertEquals(parseStorageKey(`${OWNER_ID}/unknown/path.jpg`), null);
  assertEquals(parseStorageKey('not-even-a-real-key'), null);
});

Deno.test(
  'resolveStorageKeyFamilyIds resolves by the entity id parsed from the key, not by object_key references',
  async () => {
    // A memory_media key whose uid prefix belongs to a *different* user than
    // the memory's creator (e.g. a manager uploaded new media under their own
    // prefix while editing another member's memory). Authorization must still
    // resolve via memories.id -> family_id, ignoring the uid segment.
    const supabase = fakeSupabase({
      families: [],
      memberships: [],
      memories: [{ id: MEMORY_ID, family_id: FAMILY_A }],
    });

    const [resolved] = await resolveStorageKeyFamilyIds(supabase as never, [
      buildMemoryMediaAssetKey(MANAGER_ID, MEMORY_ID, MEMBER_ID, 'jpg'),
    ]);

    assertEquals(resolved.familyId, FAMILY_A);
  },
);

Deno.test('resolveStorageKeyFamilyIds resolves family-member keys via family_members.family_id', async () => {
  const supabase = fakeSupabase({
    families: [],
    memberships: [],
    familyMembers: [{ id: MEMBER_ID, family_id: FAMILY_A }],
  });

  const [resolved] = await resolveStorageKeyFamilyIds(supabase as never, [
    buildFamilyPhotoKey(OWNER_ID, MEMBER_ID),
  ]);

  assertEquals(resolved.familyId, FAMILY_A);
});

Deno.test('resolveStorageKeyFamilyIds denies unresolvable keys (no owning row)', async () => {
  const supabase = fakeSupabase({ families: [], memberships: [], memories: [] });

  const [resolved] = await resolveStorageKeyFamilyIds(supabase as never, [
    buildMemoryIllustrationKey(OWNER_ID, MEMORY_ID, ILLUSTRATION_GENERATION_ID),
  ]);

  assertEquals(resolved.familyId, null);
});

Deno.test('resolveStorageKeyFamilyIds denies unparsable keys', async () => {
  const supabase = fakeSupabase({ families: [], memberships: [] });

  const [resolved] = await resolveStorageKeyFamilyIds(supabase as never, ['garbage/key.jpg']);

  assertEquals(resolved.parsed, null);
  assertEquals(resolved.familyId, null);
});

// Storage-function authorization matrix (plan §13): member vs non-member
// vs viewer-write-attempt. get-upload-url / upload-media / delete-storage-object
// gate on isManagerRole(role); get-media-url / analyze-emotion gate on
// membership alone (any role, including viewer).
Deno.test('storage write authorization: owner and manager allowed, viewer and non-member denied', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [
      { family_id: FAMILY_A, role: 'owner' },
    ],
  });

  const ownerRole = await getCallerFamilyRoles(supabase as never, [FAMILY_A], OWNER_ID);
  assertEquals(isManagerRole(ownerRole.get(FAMILY_A) ?? null), true);

  const managerSupabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [{ family_id: FAMILY_A, role: 'manager' }],
  });
  const managerRole = await getCallerFamilyRoles(managerSupabase as never, [FAMILY_A], MANAGER_ID);
  assertEquals(isManagerRole(managerRole.get(FAMILY_A) ?? null), true);

  const viewerSupabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [{ family_id: FAMILY_A, role: 'viewer' }],
  });
  const viewerRole = await getCallerFamilyRoles(viewerSupabase as never, [FAMILY_A], VIEWER_ID);
  assertEquals(isManagerRole(viewerRole.get(FAMILY_A) ?? null), false);

  const outsiderSupabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [],
  });
  const outsiderRole = await getCallerFamilyRoles(outsiderSupabase as never, [FAMILY_A], OUTSIDER_ID);
  assertEquals(isManagerRole(outsiderRole.get(FAMILY_A) ?? null), false);
});

Deno.test('storage read authorization (get-media-url): any member role including viewer is allowed, non-member denied', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [{ family_id: FAMILY_A, role: 'viewer' }],
  });

  const roles = await getCallerFamilyRoles(supabase as never, [FAMILY_A], VIEWER_ID);
  // get-media-url only requires *some* role, not manager+.
  assertEquals(roles.get(FAMILY_A) !== null, true);

  const outsiderSupabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null }],
    memberships: [],
  });
  const outsiderRoles = await getCallerFamilyRoles(outsiderSupabase as never, [FAMILY_A], OUTSIDER_ID);
  assertEquals(outsiderRoles.get(FAMILY_A), null);
});

// Workstream C2 (performance-optimizations plan): resolveReferencedStorageKeys
// must admit preview_object_key, not just object_key -- otherwise
// get-media-url 400s on every preview key (the feature is dead) and
// delete-storage-object refuses to delete previews (a leak).
function fakeSupabaseForReferencedStorageKeys(options: {
  memories?: Array<{ id: string; media_key: string | null; illustration_key: string | null }>;
  mediaAssets?: Array<{ memory_id: string; object_key: string; preview_object_key: string | null }>;
}) {
  return {
    from(table: string) {
      if (table === 'memories') {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: (options.memories ?? []).filter((m) => ids.includes(m.id)),
              error: null,
            }),
          }),
        };
      }

      if (table === 'memory_media') {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: (options.mediaAssets ?? []).filter((a) => ids.includes(a.memory_id)),
              error: null,
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

Deno.test(
  'resolveReferencedStorageKeys admits a referenced preview_object_key alongside object_key',
  async () => {
    const supabase = fakeSupabaseForReferencedStorageKeys({
      memories: [{ id: MEMORY_ID, media_key: null, illustration_key: null }],
      mediaAssets: [
        {
          memory_id: MEMORY_ID,
          object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`,
          preview_object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1-preview.jpg`,
        },
      ],
    });

    const resolvedKeys = [
      {
        objectKey: `${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`,
        parsed: parseStorageKey(`${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`),
        familyId: FAMILY_A,
      },
    ];

    const referenced = await resolveReferencedStorageKeys(supabase as never, resolvedKeys);

    assertEquals(referenced.has(`${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`), true);
    assertEquals(
      referenced.has(`${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1-preview.jpg`),
      true,
    );
  },
);

Deno.test(
  'resolveReferencedStorageKeys does not admit a preview key when the row has none',
  async () => {
    const supabase = fakeSupabaseForReferencedStorageKeys({
      memories: [{ id: MEMORY_ID, media_key: null, illustration_key: null }],
      mediaAssets: [
        {
          memory_id: MEMORY_ID,
          object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`,
          preview_object_key: null,
        },
      ],
    });

    const resolvedKeys = [
      {
        objectKey: `${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`,
        parsed: parseStorageKey(`${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1.jpg`),
        familyId: FAMILY_A,
      },
    ];

    const referenced = await resolveReferencedStorageKeys(supabase as never, resolvedKeys);

    assertEquals(
      referenced.has(`${OWNER_ID}/memories/${MEMORY_ID}/media/asset-1-preview.jpg`),
      false,
    );
  },
);

Deno.test('resolveStorageKeyFamilyIds batches one query per entity type across many keys', async () => {
  let memoriesQueryCount = 0;
  let familyMembersQueryCount = 0;

  const supabase = {
    from(table: string) {
      if (table === 'memories') {
        memoriesQueryCount += 1;
        return {
          select: () => ({
            in: async () => ({ data: [{ id: MEMORY_ID, family_id: FAMILY_A }], error: null }),
          }),
        };
      }

      if (table === 'family_members') {
        familyMembersQueryCount += 1;
        return {
          select: () => ({
            in: async () => ({ data: [{ id: MEMBER_ID, family_id: FAMILY_A }], error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  await resolveStorageKeyFamilyIds(supabase as never, [
    buildMemoryMediaKey(OWNER_ID, MEMORY_ID, 'jpg'),
    buildMemoryIllustrationKey(OWNER_ID, MEMORY_ID, ILLUSTRATION_GENERATION_ID),
    buildFamilyPhotoKey(OWNER_ID, MEMBER_ID),
    buildFamilyPortraitKey(OWNER_ID, MEMBER_ID),
  ]);

  assertEquals(memoriesQueryCount, 1);
  assertEquals(familyMembersQueryCount, 1);
});
