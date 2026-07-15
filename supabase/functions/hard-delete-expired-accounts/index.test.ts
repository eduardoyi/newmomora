import { assertEquals } from 'jsr:@std/assert@1';
import { collectFamilyStorageKeys, handleHardDeleteExpiredAccounts, resolveReferencedKeys } from './index.ts';

Deno.test('hard-delete-expired-accounts rejects missing cron secret', async () => {
  const response = await handleHardDeleteExpiredAccounts(
    new Request('http://localhost/hard-delete-expired-accounts', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
const FAMILY_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER_ID = '22222222-2222-4222-8222-222222222222';

function fakeSupabaseForCollect(options: {
  memories: Array<{ id: string; media_key: string | null; illustration_key: string | null }>;
  mediaAssets: Array<{ object_key: string }>;
  members: Array<{ profile_picture_key: string | null; illustrated_profile_key: string | null }>;
  portraitVersions?: Array<{
    profile_picture_key: string;
    illustrated_profile_key: string | null;
    generation_output_key: string | null;
  }>;
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
  media_key?: string[];
  illustration_key?: string[];
  profile_picture_key?: string[];
  illustrated_profile_key?: string[];
  version_profile_picture_key?: string[];
  version_illustrated_profile_key?: string[];
  generation_output_key?: string[];
  errorTable?: string;
}) {
  return {
    from(table: string) {
      if (table === 'memory_media') {
        return {
          select: () => ({
            in: async (_col: string, keys: string[]) => ({
              data: keys
                .filter((key) => (referencedByTable.memory_media ?? []).includes(key))
                .map((key) => ({ object_key: key })),
              error: referencedByTable.errorTable === table ? { message: 'lookup failed' } : null,
            }),
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

Deno.test('resolveReferencedKeys checks legacy, memory, and portrait-version reference columns', async () => {
  const mediaAssetKey = 'a/memories/1/media/x.jpg';
  const memoryMediaKey = 'a/memories/2/media.jpg';
  const illustrationKey = 'a/memories/3/illustration.webp';
  const photoKey = 'a/family/1/photo.webp';
  const portraitKey = 'a/family/1/portrait.webp';
  const versionPhotoKey = 'a/family/1/portraits/2/photo.jpg';
  const versionPortraitKey = 'a/family/1/portraits/2/portrait/3.webp';
  const activeAttemptKey = 'a/family/1/portraits/2/portrait/4.webp';

  const supabase = fakeSupabaseForReferenced({
    memory_media: [mediaAssetKey],
    media_key: [memoryMediaKey],
    illustration_key: [illustrationKey],
    profile_picture_key: [photoKey],
    illustrated_profile_key: [portraitKey],
    version_profile_picture_key: [versionPhotoKey],
    version_illustrated_profile_key: [versionPortraitKey],
    generation_output_key: [activeAttemptKey],
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
  ]);

  assertEquals(referenced.size, 8);
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
