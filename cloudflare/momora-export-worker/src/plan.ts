import {
  archiveBaseName,
  fileExtension,
  memoryFolderName,
  memoryMediaFileNames,
  mediaCategory,
  memoryYear,
  renderMemoryText,
  rootFolderName,
  sanitizeSegment,
  uniqueName,
} from './layout';
import { listRows } from './supabase';
import type {
  ArchiveGroup,
  ExportComment,
  ExportFamily,
  ExportMedia,
  ExportMember,
  ExportMemory,
  ExportPlan,
  ExportPortraitVersion,
  ExportProfile,
  ExportTag,
  PlannedEntry,
} from './types';

const MAX_FAMILIES = 100;
const ID_BATCH_SIZE = 100;

export interface ExportRows {
  profile: ExportProfile | null;
  families: ExportFamily[];
  familyMembers: ExportMember[];
  memories: ExportMemory[];
  memoryTags: ExportTag[];
  memoryMedia: ExportMedia[];
  memoryComments: ExportComment[];
  portraitVersions: ExportPortraitVersion[];
  /** user id -> display name, for "Added by" and comment authors. */
  userNames: Record<string, string>;
}

function inFilter(ids: string[]): string {
  return `in.(${ids.join(',')})`;
}

async function listRowsByIds<T>(
  env: Env,
  resource: string,
  select: string,
  column: string,
  ids: string[],
  filters: Record<string, string> = {},
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const batches = Array.from({ length: Math.ceil(unique.length / ID_BATCH_SIZE) }, (_, index) =>
    unique.slice(index * ID_BATCH_SIZE, (index + 1) * ID_BATCH_SIZE));
  const rows: T[] = [];
  // Sequential batches: a big family can have thousands of memories, and
  // PostgREST is happier with a handful of in-flight requests than hundreds.
  for (const batch of batches) {
    rows.push(...await listRows<T>(env, resource, select, { ...filters, [column]: inFilter(batch) }));
  }
  return rows;
}

export async function fetchExportRows(env: Env, ownerUserId: string): Promise<ExportRows> {
  const [profileRows, families] = await Promise.all([
    listRows<ExportProfile>(env, 'user_profiles', 'id,name,timezone,created_at', { id: `eq.${ownerUserId}`, limit: '1' }),
    listRows<ExportFamily>(env, 'families', 'id,owner_id,name,illustration_style,created_at', {
      owner_id: `eq.${ownerUserId}`,
      deleted_at: 'is.null',
      order: 'created_at.asc',
      limit: String(MAX_FAMILIES),
    }),
  ]);
  const familyIds = families.map((family) => family.id);
  if (familyIds.length === 0) {
    return {
      profile: profileRows[0] ?? null,
      families,
      familyMembers: [],
      memories: [],
      memoryTags: [],
      memoryMedia: [],
      memoryComments: [],
      portraitVersions: [],
      userNames: {},
    };
  }

  const familyMembers = await listRowsByIds<ExportMember>(env, 'family_members', 'id,family_id,user_id,name,nicknames,date_of_birth,gender,profile_picture_key,illustrated_profile_key,illustrated_profile_status,additional_info,is_user_profile,created_at', 'family_id', familyIds, { order: 'created_at.asc' });
  const memories = await listRowsByIds<ExportMemory>(env, 'memories', 'id,family_id,user_id,memory_type,content,audio_transcript,link_previews,memory_date,emotion,illustration_key,illustration_status,media_key,media_content_type,created_at', 'family_id', familyIds, { order: 'memory_date.asc,created_at.asc' });
  const portraitVersions = await listRowsByIds<ExportPortraitVersion>(env, 'family_member_portrait_versions', 'id,family_id,family_member_id,user_id,reference_date,date_source,profile_picture_key,illustrated_profile_key,illustrated_profile_status,created_at', 'family_id', familyIds, { order: 'created_at.asc' });

  const memoryIds = memories.map((memory) => memory.id);
  const memoryTags = memoryIds.length > 0
    ? await listRowsByIds<ExportTag>(env, 'memory_family_members', 'memory_id,family_member_id', 'memory_id', memoryIds)
    : [];
  const memoryMedia = memoryIds.length > 0
    ? await listRowsByIds<ExportMedia>(env, 'memory_media', 'id,memory_id,object_key,content_type,duration_ms,position,created_at', 'memory_id', memoryIds, { order: 'memory_id.asc,position.asc' })
    : [];
  const memoryComments = memoryIds.length > 0
    ? await listRowsByIds<ExportComment>(env, 'memory_comments', 'id,memory_id,user_id,content,created_at', 'memory_id', memoryIds, { order: 'created_at.asc' })
    : [];

  const userIds = [
    ...memories.map((memory) => memory.user_id),
    ...memoryComments.map((comment) => comment.user_id),
  ].filter((id): id is string => Boolean(id));
  const profiles = userIds.length > 0
    ? await listRowsByIds<{ id: string; name: string }>(env, 'user_profiles', 'id,name', 'id', userIds)
    : [];

  return {
    profile: profileRows[0] ?? null,
    families,
    familyMembers,
    memories,
    memoryTags,
    memoryMedia,
    memoryComments,
    portraitVersions,
    userNames: Object.fromEntries(profiles.map((profile) => [profile.id, profile.name])),
  };
}

function byDateThenCreated(a: ExportMemory, b: ExportMemory): number {
  return `${a.memory_date}:${a.created_at}`.localeCompare(`${b.memory_date}:${b.created_at}`);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = map.get(value);
    if (list) list.push(item);
    else map.set(value, [item]);
  }
  return map;
}

/**
 * Lays the rows out as archive groups: per family, one group per memory
 * year (oldest first), then one "Family & portraits" group, which is built
 * last because its manifest.json/README.txt reference every other archive.
 * Pure -- no I/O -- so the layout is unit-testable.
 */
export function buildExportPlan(jobId: string, ownerUserId: string, rows: ExportRows, exportedAt: string): ExportPlan {
  const membersByFamily = groupBy(rows.familyMembers, (member) => member.family_id);
  const memoriesByFamily = groupBy(rows.memories, (memory) => memory.family_id);
  const versionsByMember = groupBy(rows.portraitVersions, (version) => version.family_member_id);
  const tagsByMemory = groupBy(rows.memoryTags, (tag) => tag.memory_id);
  const mediaByMemory = groupBy(rows.memoryMedia, (media) => media.memory_id);
  const commentsByMemory = groupBy(rows.memoryComments, (comment) => comment.memory_id);
  const memberNames = new Map(rows.familyMembers.map((member) => [member.id, member.name]));
  const nameForUser = (userId: string | null) => (userId ? rows.userNames[userId] ?? null : null);

  const groups: ArchiveGroup[] = [];
  const familyData: ExportPlan['familyData'] = {};
  const familyRoots: ExportPlan['familyRoots'] = {};
  const usedRootNames = new Set<string>();

  for (const family of rows.families) {
    const root = uniqueName(rootFolderName(family.name), usedRootNames);
    familyRoots[family.id] = root;
    const members = membersByFamily.get(family.id) ?? [];
    const memories = [...(memoriesByFamily.get(family.id) ?? [])].sort(byDateThenCreated);
    const memoryIds = new Set(memories.map((memory) => memory.id));
    familyData[family.id] = {
      familyMembers: members,
      memories,
      memoryTags: rows.memoryTags.filter((tag) => memoryIds.has(tag.memory_id)),
      memoryMedia: rows.memoryMedia.filter((media) => memoryIds.has(media.memory_id)),
      memoryComments: rows.memoryComments.filter((comment) => memoryIds.has(comment.memory_id)),
      portraitVersions: rows.portraitVersions.filter((version) => version.family_id === family.id),
    };

    // An object key only ever lands in one place, even when several rows
    // reference it (e.g. a member's current portrait is also a version).
    const seenKeys = new Set<string>();

    for (const [year, yearMemories] of groupBy(memories, memoryYear)) {
      const entries: PlannedEntry[] = [];
      const usedFolders = new Set<string>();
      for (const memory of yearMemories) {
        const folder = `${root}/${year}/${uniqueName(memoryFolderName(memory), usedFolders)}`;
        const modifiedAt = `${memory.memory_date.slice(0, 10)}T12:00:00.000Z`;
        const comments = (commentsByMemory.get(memory.id) ?? []).map((comment) => ({
          content: comment.content,
          created_at: comment.created_at,
          authorName: nameForUser(comment.user_id) ?? 'A former member',
        }));
        entries.push({
          type: 'text',
          path: `${folder}/memory.txt`,
          modifiedAt,
          memoryId: memory.id,
          text: renderMemoryText(memory, {
            postedBy: nameForUser(memory.user_id),
            taggedNames: (tagsByMemory.get(memory.id) ?? [])
              .map((tag) => memberNames.get(tag.family_member_id))
              .filter((name): name is string => Boolean(name)),
            comments,
          }),
        });

        const media: Array<{ objectKey: string; contentType: string | null }> = [...(mediaByMemory.get(memory.id) ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((row) => ({ objectKey: row.object_key, contentType: row.content_type }));
        // Legacy rows predating memory_media only carry memories.media_key.
        if (media.length === 0 && memory.media_key) {
          media.push({ objectKey: memory.media_key, contentType: memory.media_content_type });
        }
        const names = memoryMediaFileNames(media);
        media.forEach((item, index) => {
          if (seenKeys.has(item.objectKey)) return;
          seenKeys.add(item.objectKey);
          const category = mediaCategory(item.contentType);
          entries.push({
            type: 'object',
            path: `${folder}/${names[index]}`,
            objectKey: item.objectKey,
            kind: category === 'photo' ? 'memory_photo'
              : category === 'video' ? 'memory_video'
                : category === 'audio' ? 'memory_audio'
                  : 'memory_media',
            modifiedAt,
            memoryId: memory.id,
          });
        });

        if (memory.illustration_key && !seenKeys.has(memory.illustration_key)) {
          seenKeys.add(memory.illustration_key);
          entries.push({
            type: 'object',
            path: `${folder}/illustration.${fileExtension(memory.illustration_key, 'image/webp')}`,
            objectKey: memory.illustration_key,
            kind: 'memory_illustration',
            modifiedAt,
            memoryId: memory.id,
          });
        }
      }
      groups.push({
        id: `${family.id}:${year}`,
        familyId: family.id,
        kind: 'year',
        baseName: archiveBaseName(family.name, year),
        entries,
      });
    }

    const familyEntries: PlannedEntry[] = [];
    const usedMemberFolders = new Set<string>();
    for (const member of members) {
      const folder = `${root}/Family/${uniqueName(sanitizeSegment(member.name, 'Family member'), usedMemberFolders)}`;
      const modifiedAt = member.created_at;
      if (member.profile_picture_key && !seenKeys.has(member.profile_picture_key)) {
        seenKeys.add(member.profile_picture_key);
        familyEntries.push({
          type: 'object',
          path: `${folder}/profile-photo.${fileExtension(member.profile_picture_key, 'image/jpeg')}`,
          objectKey: member.profile_picture_key,
          kind: 'family_photo',
          modifiedAt,
          familyMemberId: member.id,
        });
      }
      if (member.illustrated_profile_key && !seenKeys.has(member.illustrated_profile_key)) {
        seenKeys.add(member.illustrated_profile_key);
        familyEntries.push({
          type: 'object',
          path: `${folder}/portrait.${fileExtension(member.illustrated_profile_key, 'image/webp')}`,
          objectKey: member.illustrated_profile_key,
          kind: 'family_portrait',
          modifiedAt,
          familyMemberId: member.id,
        });
      }
      const usedVersionNames = new Set<string>();
      for (const version of versionsByMember.get(member.id) ?? []) {
        const date = (version.reference_date ?? version.created_at).slice(0, 10);
        const versionModifiedAt = version.created_at;
        const add = (objectKey: string | null, label: 'photo' | 'portrait', fallbackType: string) => {
          if (!objectKey || seenKeys.has(objectKey)) return;
          seenKeys.add(objectKey);
          const stem = uniqueName(`${date} ${label}`, usedVersionNames);
          familyEntries.push({
            type: 'object',
            path: `${folder}/Portraits over time/${stem}.${fileExtension(objectKey, fallbackType)}`,
            objectKey,
            kind: label === 'photo' ? 'portrait_photo' : 'portrait_illustration',
            modifiedAt: versionModifiedAt,
            familyMemberId: member.id,
            portraitVersionId: version.id,
          });
        };
        add(version.profile_picture_key, 'photo', 'image/jpeg');
        add(version.illustrated_profile_key, 'portrait', 'image/webp');
      }
    }
    groups.push({
      id: `${family.id}:family`,
      familyId: family.id,
      kind: 'family',
      baseName: archiveBaseName(family.name, 'Family & portraits'),
      entries: familyEntries,
    });
  }

  return {
    jobId,
    exportedAt,
    ownerUserId,
    profile: rows.profile,
    families: rows.families,
    familyData,
    familyRoots,
    groups,
  };
}
