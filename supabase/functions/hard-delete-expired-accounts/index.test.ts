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

function fakeSupabaseForReferenced(referencedByTable: {
  memory_media?: string[];
  media_key?: string[];
  illustration_key?: string[];
  profile_picture_key?: string[];
  illustrated_profile_key?: string[];
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
              error: null,
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
                error: null,
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
                error: null,
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

Deno.test('resolveReferencedKeys checks all five reference columns', async () => {
  const mediaAssetKey = 'a/memories/1/media/x.jpg';
  const memoryMediaKey = 'a/memories/2/media.jpg';
  const illustrationKey = 'a/memories/3/illustration.webp';
  const photoKey = 'a/family/1/photo.webp';
  const portraitKey = 'a/family/1/portrait.webp';

  const supabase = fakeSupabaseForReferenced({
    memory_media: [mediaAssetKey],
    media_key: [memoryMediaKey],
    illustration_key: [illustrationKey],
    profile_picture_key: [photoKey],
    illustrated_profile_key: [portraitKey],
  });

  const referenced = await resolveReferencedKeys(supabase as never, [
    mediaAssetKey,
    memoryMediaKey,
    illustrationKey,
    photoKey,
    portraitKey,
  ]);

  assertEquals(referenced.size, 5);
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
