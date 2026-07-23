import { assertEquals } from 'jsr:@std/assert@1';
import {
  collectFamilyStorageKeys,
  deleteOwnedFamilies,
  handleHardDeleteExpiredAccounts,
  resolveReferencedKeys,
} from './index.ts';

Deno.test('hard-delete-expired-accounts rejects missing cron secret', async () => {
  const response = await handleHardDeleteExpiredAccounts(
    new Request('http://localhost/hard-delete-expired-accounts', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
const FAMILY_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_FAMILY_ID = '66666666-6666-4666-8666-666666666666';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER_ID = '22222222-2222-4222-8222-222222222222';

function createMultiFamilyDeleteSupabase(calls: string[]) {
  const claimedFences: Array<{ familyId: string; token: string }> = [];
  const releasedFences: Array<{ familyId: string; token: string }> = [];
  const finalizedFences: Array<{ familyId: string; token: string }> = [];
  const familyIds = [FAMILY_ID, SECOND_FAMILY_ID];

  return {
    claimedFences,
    releasedFences,
    finalizedFences,
    client: {
      from(table: string) {
        if (table === 'families') {
          return {
            select: () => ({
              eq: async () => ({ data: familyIds.map((id) => ({ id })), error: null }),
            }),
          };
        }

        if (
          table === 'memories' || table === 'family_members' ||
          table === 'memory_illustration_jobs' || table === 'portrait_generation_jobs'
        ) {
          return {
            select: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          };
        }

        if (table === 'family_member_portrait_versions') {
          return {
            select: () => ({
              eq: async (_column: string, familyId: string) => ({
                data: [{
                  profile_picture_key: `${familyId}/family/member/portraits/version/photo.jpg`,
                  illustrated_profile_key: null,
                  generation_output_key: null,
                }],
                error: null,
              }),
            }),
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_family_deletion_fence') {
          const fence = {
            familyId: args.p_family_id as string,
            token: args.p_delete_token as string,
          };
          claimedFences.push(fence);
          calls.push(`claim:${fence.familyId}`);
          return { data: true, error: null };
        }
        if (name === 'release_family_deletion_fence') {
          const fence = {
            familyId: args.p_family_id as string,
            token: args.p_delete_token as string,
          };
          releasedFences.push(fence);
          calls.push(`release:${fence.familyId}`);
          return { data: true, error: null };
        }
        if (name === 'finish_owned_family_deletion_fences') {
          const fences = (args.p_fences as Array<{ family_id: string; delete_token: string }>).map((fence) => ({
            familyId: fence.family_id,
            token: fence.delete_token,
          }));
          finalizedFences.push(...fences);
          calls.push('finalize');
          return { data: true, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
  };
}

Deno.test('hard-delete preflights every owned family before deleting R2 and releases all exact fences on a later listing failure', async () => {
  const calls: string[] = [];
  const fixture = createMultiFamilyDeleteSupabase(calls);

  const deleted = await deleteOwnedFamilies(fixture.client as never, OWNER_ID, {
    listObjectKeys: async (prefix) => {
      calls.push(`list:${prefix}`);
      if (prefix.startsWith(`${SECOND_FAMILY_ID}/`)) throw new Error('second family listing failed');
      return [`${prefix}generated.webp`];
    },
    deleteObject: async (key) => {
      calls.push(`delete:${key}`);
    },
  });

  assertEquals(deleted, false);
  assertEquals(calls.some((call) => call.startsWith('delete:')), false);
  assertEquals(calls.includes('finalize'), false);
  assertEquals(
    fixture.releasedFences.sort((a, b) => a.familyId.localeCompare(b.familyId)),
    fixture.claimedFences.sort((a, b) => a.familyId.localeCompare(b.familyId)),
  );
});

Deno.test('hard-delete lists every owned family before its first R2 deletion and finalizes all exact fences once', async () => {
  const calls: string[] = [];
  const fixture = createMultiFamilyDeleteSupabase(calls);

  const deleted = await deleteOwnedFamilies(fixture.client as never, OWNER_ID, {
    listObjectKeys: async (prefix) => {
      calls.push(`list:${prefix}`);
      return [`${prefix}generated.webp`];
    },
    deleteObject: async (key) => {
      calls.push(`delete:${key}`);
    },
  });

  assertEquals(deleted, true);
  const lastListIndex = Math.max(...calls
    .map((call, index) => call.startsWith('list:') ? index : -1));
  const firstDeleteIndex = calls.findIndex((call) => call.startsWith('delete:'));
  assertEquals(firstDeleteIndex > lastListIndex, true);
  assertEquals(calls.filter((call) => call === 'finalize').length, 1);
  assertEquals(
    fixture.finalizedFences.sort((a, b) => a.familyId.localeCompare(b.familyId)),
    fixture.claimedFences.sort((a, b) => a.familyId.localeCompare(b.familyId)),
  );
});

Deno.test('hard-delete defers the whole account before R2 when an owned family has fresh generation work', async () => {
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      if (table === 'families') {
        return {
          select: () => ({
            eq: async () => ({ data: [{ id: FAMILY_ID }], error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      calls.push(`rpc:${name}`);
      if (name === 'claim_family_deletion_fence') {
        return { data: null, error: { message: 'Fresh illustration generation is still active' } };
      }
      return { data: true, error: null };
    },
  };

  const deleted = await deleteOwnedFamilies(supabase as never, OWNER_ID, {
    listObjectKeys: async () => {
      calls.push('list');
      return [];
    },
    deleteObject: async () => {
      calls.push('delete');
    },
  });

  assertEquals(deleted, false);
  assertEquals(calls, ['rpc:claim_family_deletion_fence']);
});

Deno.test('hard-delete does not delete profile or auth when an owned family purge is deferred', async () => {
  const calls: string[] = [];
  const previousSecret = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-cron-secret');
  try {
    const supabase = {
      from(table: string) {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              not: () => ({
                lte: async () => ({ data: [{ id: OWNER_ID }], error: null }),
              }),
            }),
            delete: () => ({
              eq: async () => {
                calls.push('delete-profile');
                return { error: null };
              },
            }),
          };
        }
        if (table === 'families') {
          return {
            select: () => ({
              eq: async () => ({ data: [{ id: FAMILY_ID }], error: null }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (name: string) => {
        calls.push(`rpc:${name}`);
        return name === 'claim_family_deletion_fence'
          ? { data: null, error: { message: 'Fresh portrait generation is still active' } }
          : { data: true, error: null };
      },
      auth: {
        admin: {
          deleteUser: async () => {
            calls.push('delete-auth');
            return { error: null };
          },
        },
      },
    };
    const response = await handleHardDeleteExpiredAccounts(
      new Request('http://localhost/hard-delete-expired-accounts', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      {
        createServiceClient: () => supabase as never,
        listObjectKeys: async (prefix) => {
          calls.push(`list:${prefix}`);
          return [];
        },
      },
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { success: true, deletedCount: 0 });
    assertEquals(calls, [
      'rpc:claim_account_hard_deletion',
      `list:${OWNER_ID}/`,
      'rpc:claim_family_deletion_fence',
    ]);
  } finally {
    if (previousSecret === undefined) Deno.env.delete('CRON_SECRET');
    else Deno.env.set('CRON_SECRET', previousSecret);
  }
});

function createFinalizationSupabase(options: { refreshed: boolean; authError?: { message: string } | null }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              not: () => ({
                lte: async () => ({ data: [{ id: OWNER_ID }], error: null }),
              }),
            }),
          };
        }
        if (table === 'families') {
          return {
            select: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (name: string) => {
        calls.push(`rpc:${name}`);
        if (name === 'claim_account_hard_deletion') return { data: true, error: null };
        if (name === 'finish_owned_family_deletion_fences') return { data: true, error: null };
        if (name === 'refresh_account_hard_deletion_claim') return { data: options.refreshed, error: null };
        if (name === 'release_account_hard_deletion_claim') return { data: true, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
      auth: {
        admin: {
          deleteUser: async () => {
            calls.push('delete-auth');
            return { error: options.authError ?? null };
          },
        },
      },
    },
  };
}

Deno.test('hard-delete refuses to delete Auth after the exact finalization token is lost', async () => {
  const previousSecret = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-cron-secret');
  try {
    const fixture = createFinalizationSupabase({ refreshed: false });
    const response = await handleHardDeleteExpiredAccounts(
      new Request('http://localhost/hard-delete-expired-accounts', {
        method: 'POST', headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      {
        createServiceClient: () => fixture.client as never,
        listObjectKeys: async () => [],
      },
    );

    assertEquals(await response.json(), { success: true, deletedCount: 0 });
    assertEquals(fixture.calls, [
      'rpc:claim_account_hard_deletion',
      'rpc:finish_owned_family_deletion_fences',
      'rpc:refresh_account_hard_deletion_claim',
    ]);
  } finally {
    if (previousSecret === undefined) Deno.env.delete('CRON_SECRET');
    else Deno.env.set('CRON_SECRET', previousSecret);
  }
});

Deno.test('hard-delete keeps the profile retryable and releases only its exact claim when Auth deletion fails', async () => {
  const previousSecret = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-cron-secret');
  try {
    const fixture = createFinalizationSupabase({
      refreshed: true,
      authError: { message: 'temporary GoTrue failure' },
    });
    const response = await handleHardDeleteExpiredAccounts(
      new Request('http://localhost/hard-delete-expired-accounts', {
        method: 'POST', headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      {
        createServiceClient: () => fixture.client as never,
        listObjectKeys: async () => [],
      },
    );

    assertEquals(await response.json(), { success: true, deletedCount: 0 });
    assertEquals(fixture.calls, [
      'rpc:claim_account_hard_deletion',
      'rpc:finish_owned_family_deletion_fences',
      'rpc:refresh_account_hard_deletion_claim',
      'delete-auth',
      'rpc:release_account_hard_deletion_claim',
    ]);
  } finally {
    if (previousSecret === undefined) Deno.env.delete('CRON_SECRET');
    else Deno.env.set('CRON_SECRET', previousSecret);
  }
});

function fakeSupabaseForCollect(options: {
  memories: Array<{ id: string; media_key: string | null; illustration_key: string | null }>;
  mediaAssets: Array<{ object_key: string; preview_object_key?: string | null }>;
  members: Array<{ profile_picture_key: string | null; illustrated_profile_key: string | null }>;
  portraitVersions?: Array<{
    profile_picture_key: string;
    illustrated_profile_key: string | null;
    generation_output_key: string | null;
  }>;
  memoryJobs?: Array<{ output_key: string | null }>;
  portraitJobs?: Array<{ output_key: string | null }>;
  portraitVersionsError?: { message: string } | null;
}) {
  return {
    from(table: string) {
      if (table === 'memories') {
        return {
          select: () => ({
            eq: async () => ({ data: options.memories, error: null }),
          }),
        };
      }

      if (table === 'memory_media') {
        return {
          select: () => ({
            in: async () => ({ data: options.mediaAssets, error: null }),
          }),
        };
      }

      if (table === 'family_members') {
        return {
          select: () => ({
            eq: async () => ({ data: options.members, error: null }),
          }),
        };
      }

      if (table === 'family_member_portrait_versions') {
        return {
          select: () => ({
            eq: async () => ({
              data: options.portraitVersions ?? [],
              error: options.portraitVersionsError ?? null,
            }),
          }),
        };
      }

      if (table === 'memory_illustration_jobs') {
        return {
          select: () => ({
            eq: async () => ({ data: options.memoryJobs ?? [], error: null }),
          }),
        };
      }

      if (table === 'portrait_generation_jobs') {
        return {
          select: () => ({
            eq: async () => ({ data: options.portraitJobs ?? [], error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

Deno.test(
  'collectFamilyStorageKeys gathers keys across every creator, not just the owner (cross-creator collection)',
  async () => {
    // The owner created a memory with a photo under their own uid prefix;
    // a different member created a memory with a video, and that same
    // member's child profile photo lives under the OTHER member's uid
    // prefix (e.g. after a manager replaced a child's photo). All of these
    // must be collected before the family's rows are deleted.
    const supabase = fakeSupabaseForCollect({
      memories: [
        {
          id: 'memory-1',
          media_key: `${OWNER_ID}/memories/memory-1/media.jpg`,
          illustration_key: null,
        },
        {
          id: 'memory-2',
          media_key: `${OTHER_MEMBER_ID}/memories/memory-2/media.mp4`,
          illustration_key: `${OWNER_ID}/memories/memory-2/illustration.webp`,
        },
      ],
      mediaAssets: [
        { object_key: `${OWNER_ID}/memories/memory-1/media/asset-1.jpg` },
        { object_key: `${OTHER_MEMBER_ID}/memories/memory-2/media/asset-1.mp4` },
      ],
      members: [
        {
          profile_picture_key: `${OTHER_MEMBER_ID}/family/member-1/photo.webp`,
          illustrated_profile_key: `${OWNER_ID}/family/member-1/portrait.webp`,
        },
      ],
    });

    const keys = await collectFamilyStorageKeys(supabase as never, FAMILY_ID);

    assertEquals(keys.sort(), [
      `${OTHER_MEMBER_ID}/family/member-1/photo.webp`,
      `${OTHER_MEMBER_ID}/memories/memory-2/media.mp4`,
      `${OTHER_MEMBER_ID}/memories/memory-2/media/asset-1.mp4`,
      `${OWNER_ID}/family/member-1/portrait.webp`,
      `${OWNER_ID}/memories/memory-1/media.jpg`,
      `${OWNER_ID}/memories/memory-1/media/asset-1.jpg`,
      `${OWNER_ID}/memories/memory-2/illustration.webp`,
    ].sort());
  },
);

Deno.test('collectFamilyStorageKeys de-duplicates keys referenced from multiple columns', async () => {
  const sharedKey = `${OWNER_ID}/memories/memory-1/media.jpg`;
  const supabase = fakeSupabaseForCollect({
    memories: [{ id: 'memory-1', media_key: sharedKey, illustration_key: null }],
    mediaAssets: [{ object_key: sharedKey }],
    members: [],
  });

  const keys = await collectFamilyStorageKeys(supabase as never, FAMILY_ID);
  assertEquals(keys, [sharedKey]);
});

Deno.test('collectFamilyStorageKeys includes unpublished durable workflow output keys', async () => {
  const supabase = fakeSupabaseForCollect({
    memories: [],
    mediaAssets: [],
    members: [],
    memoryJobs: [{ output_key: `${OWNER_ID}/memories/memory-1/illustration-attempt.webp` }],
    portraitJobs: [{ output_key: `${OWNER_ID}/family/member-1/portraits/version-1/portrait/attempt.webp` }],
  });

  const keys = await collectFamilyStorageKeys(supabase as never, FAMILY_ID);
  assertEquals(keys.sort(), [
    `${OWNER_ID}/family/member-1/portraits/version-1/portrait/attempt.webp`,
    `${OWNER_ID}/memories/memory-1/illustration-attempt.webp`,
  ].sort());
});

Deno.test(
  'collectFamilyStorageKeys includes preview_object_key alongside object_key (Workstream C2)',
  async () => {
    const supabase = fakeSupabaseForCollect({
      memories: [{ id: 'memory-1', media_key: null, illustration_key: null }],
      mediaAssets: [
        {
          object_key: `${OWNER_ID}/memories/memory-1/media/asset-1.jpg`,
          preview_object_key: `${OWNER_ID}/memories/memory-1/media/asset-1-preview.jpg`,
        },
      ],
      members: [],
    });

    const keys = await collectFamilyStorageKeys(supabase as never, FAMILY_ID);

    assertEquals(keys.sort(), [
      `${OWNER_ID}/memories/memory-1/media/asset-1-preview.jpg`,
      `${OWNER_ID}/memories/memory-1/media/asset-1.jpg`,
    ]);
  },
);

Deno.test('collectFamilyStorageKeys fails closed when portrait enumeration fails', async () => {
  const supabase = fakeSupabaseForCollect({
    memories: [],
    mediaAssets: [],
    members: [],
    portraitVersionsError: { message: 'lookup failed' },
  });

  let message = '';
  try {
    await collectFamilyStorageKeys(supabase as never, FAMILY_ID);
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertEquals(message, 'Portrait version storage lookup failed: lookup failed');
});

function fakeSupabaseForReferenced(referencedByTable: {
  memory_media?: string[];
  memory_media_preview?: string[];
  media_key?: string[];
  illustration_key?: string[];
  profile_picture_key?: string[];
  illustrated_profile_key?: string[];
  version_profile_picture_key?: string[];
  version_illustrated_profile_key?: string[];
  generation_output_key?: string[];
  memory_job_output_key?: string[];
  portrait_job_output_key?: string[];
  errorTable?: string;
}) {
  return {
    from(table: string) {
      if (table === 'memory_media') {
        return {
          select: (col: string) => ({
            in: async (_col: string, keys: string[]) => {
              const isPreviewQuery = col === 'preview_object_key';
              const field = isPreviewQuery ? 'preview_object_key' : 'object_key';
              const fixtureField = isPreviewQuery ? 'memory_media_preview' : 'memory_media';
              return {
                data: keys
                  .filter((key) => (referencedByTable[fixtureField] ?? []).includes(key))
                  .map((key) => ({ [field]: key })),
                error:
                  referencedByTable.errorTable === `${table}.${field}`
                    ? { message: 'lookup failed' }
                    : null,
              };
            },
          }),
        };
      }

      if (table === 'memories') {
        return {
          select: (col: string) => ({
            in: async (_col: string, keys: string[]) => {
              const field = col as 'media_key' | 'illustration_key';
              return {
                data: keys
                  .filter((key) => (referencedByTable[field] ?? []).includes(key))
                  .map((key) => ({ [field]: key })),
                error: referencedByTable.errorTable === `${table}.${field}`
                  ? { message: 'lookup failed' }
                  : null,
              };
            },
          }),
        };
      }

      if (table === 'family_members') {
        return {
          select: (col: string) => ({
            in: async (_col: string, keys: string[]) => {
              const field = col as 'profile_picture_key' | 'illustrated_profile_key';
              return {
                data: keys
                  .filter((key) => (referencedByTable[field] ?? []).includes(key))
                  .map((key) => ({ [field]: key })),
                error: referencedByTable.errorTable === `${table}.${field}`
                  ? { message: 'lookup failed' }
                  : null,
              };
            },
          }),
        };
      }

      if (table === 'family_member_portrait_versions') {
        return {
          select: (col: string) => ({
            in: async (_col: string, keys: string[]) => {
              const sourceField = col as
                | 'profile_picture_key'
                | 'illustrated_profile_key'
                | 'generation_output_key';
              const fixtureField =
                sourceField === 'profile_picture_key'
                  ? 'version_profile_picture_key'
                  : sourceField === 'illustrated_profile_key'
                    ? 'version_illustrated_profile_key'
                    : 'generation_output_key';
              return {
                data: keys
                  .filter((key) => (referencedByTable[fixtureField] ?? []).includes(key))
                  .map((key) => ({ [sourceField]: key })),
                error: referencedByTable.errorTable === `${table}.${sourceField}`
                  ? { message: 'lookup failed' }
                  : null,
              };
            },
          }),
        };
      }

      if (table === 'memory_illustration_jobs' || table === 'portrait_generation_jobs') {
        return {
          select: () => ({
            in: async (_col: string, keys: string[]) => {
              const fixtureField = table === 'memory_illustration_jobs'
                ? 'memory_job_output_key'
                : 'portrait_job_output_key';
              return {
                data: keys
                  .filter((key) => (referencedByTable[fixtureField] ?? []).includes(key))
                  .map((key) => ({ output_key: key })),
                error: referencedByTable.errorTable === `${table}.output_key`
                  ? { message: 'lookup failed' }
                  : null,
              };
            },
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

Deno.test(
  'resolveReferencedKeys: non-owner objects still referenced by a surviving row are kept (survive cleanup)',
  async () => {
    const survivingKey = `${OTHER_MEMBER_ID}/memories/memory-3/media.jpg`;
    const orphanedKey = `${OTHER_MEMBER_ID}/memories/memory-4/media.jpg`;

    const supabase = fakeSupabaseForReferenced({
      memory_media: [survivingKey],
    });

    const referenced = await resolveReferencedKeys(supabase as never, [survivingKey, orphanedKey]);

    assertEquals(referenced.has(survivingKey), true);
    assertEquals(referenced.has(orphanedKey), false);
  },
);

Deno.test(
  'resolveReferencedKeys: a live preview object is NOT collected as an orphan (Workstream C2, mandatory)',
  async () => {
    // A surviving memory_media row references both an original and its
    // preview key. Before C2, resolveReferencedKeys only ever queried
    // object_key -- a preview key would never equal any row's object_key,
    // so it would look unreferenced and be deleted alongside genuine
    // orphans on the very next non-owner account hard-delete.
    const survivingOriginalKey = `${OTHER_MEMBER_ID}/memories/memory-5/media/asset-1.jpg`;
    const survivingPreviewKey = `${OTHER_MEMBER_ID}/memories/memory-5/media/asset-1-preview.jpg`;
    const orphanedKey = `${OTHER_MEMBER_ID}/memories/memory-6/media/asset-1.jpg`;

    const supabase = fakeSupabaseForReferenced({
      memory_media: [survivingOriginalKey],
      memory_media_preview: [survivingPreviewKey],
    });

    const referenced = await resolveReferencedKeys(supabase as never, [
      survivingOriginalKey,
      survivingPreviewKey,
      orphanedKey,
    ]);

    assertEquals(referenced.has(survivingOriginalKey), true);
    assertEquals(referenced.has(survivingPreviewKey), true);
    assertEquals(referenced.has(orphanedKey), false);
  },
);

Deno.test('resolveReferencedKeys retains legacy, version, and durable job output keys', async () => {
  const mediaAssetKey = 'a/memories/1/media/x.jpg';
  const memoryMediaKey = 'a/memories/2/media.jpg';
  const illustrationKey = 'a/memories/3/illustration.webp';
  const photoKey = 'a/family/1/photo.webp';
  const portraitKey = 'a/family/1/portrait.webp';
  const versionPhotoKey = 'a/family/1/portraits/2/photo.jpg';
  const versionPortraitKey = 'a/family/1/portraits/2/portrait/3.webp';
  const activeAttemptKey = 'a/family/1/portraits/2/portrait/4.webp';
  const activeMemoryJobKey = 'a/memories/4/illustration-attempt.webp';
  const activePortraitJobKey = 'a/family/1/portraits/2/portrait/5.webp';

  const supabase = fakeSupabaseForReferenced({
    memory_media: [mediaAssetKey],
    media_key: [memoryMediaKey],
    illustration_key: [illustrationKey],
    profile_picture_key: [photoKey],
    illustrated_profile_key: [portraitKey],
    version_profile_picture_key: [versionPhotoKey],
    version_illustrated_profile_key: [versionPortraitKey],
    generation_output_key: [activeAttemptKey],
    memory_job_output_key: [activeMemoryJobKey],
    portrait_job_output_key: [activePortraitJobKey],
  });

  const referenced = await resolveReferencedKeys(supabase as never, [
    mediaAssetKey,
    memoryMediaKey,
    illustrationKey,
    photoKey,
    portraitKey,
    versionPhotoKey,
    versionPortraitKey,
    activeAttemptKey,
    activeMemoryJobKey,
    activePortraitJobKey,
  ]);

  assertEquals(referenced.size, 10);
});

Deno.test('resolveReferencedKeys returns an empty set for an empty key list without querying', async () => {
  const supabase = {
    from() {
      throw new Error('should not query when keys is empty');
    },
  };

  const referenced = await resolveReferencedKeys(supabase as never, []);
  assertEquals(referenced.size, 0);
});

Deno.test('resolveReferencedKeys fails closed when any retention lookup fails', async () => {
  const supabase = fakeSupabaseForReferenced({ errorTable: 'family_member_portrait_versions.profile_picture_key' });

  let message = '';
  try {
    await resolveReferencedKeys(supabase as never, ['user/family/member/portraits/version/photo.jpg']);
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertEquals(message, 'Referenced storage lookup failed: lookup failed');
});
