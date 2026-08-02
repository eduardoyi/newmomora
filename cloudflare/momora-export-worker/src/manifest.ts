import { listRows } from './supabase';
import type {
  ExportAsset,
  ExportFamily,
  ExportManifest,
  ExportMedia,
  ExportMember,
  ExportMemory,
  ExportPortraitVersion,
  ExportProfile,
  ExportTag,
} from './types';

const MAX_FAMILIES = 100;
const MAX_ASSETS = 10000;
// ZIP32 offsets are 32-bit. Keep a bounded archive so a pathological video
// library cannot produce a corrupt archive or exceed Worker streaming limits.
const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
const ID_BATCH_SIZE = 100;

interface AssetCandidate {
  objectKey: string;
  kind: ExportAsset['kind'];
  contentType: string | null;
  familyId: string;
  memoryId?: string;
  familyMemberId?: string;
  portraitVersionId?: string;
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
  const rows = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / ID_BATCH_SIZE) }, (_, index) => {
      const batch = ids.slice(index * ID_BATCH_SIZE, (index + 1) * ID_BATCH_SIZE);
      return listRows<T>(env, resource, select, { ...filters, [column]: inFilter(batch) });
    }),
  );
  return rows.flat();
}

function addCandidate(candidates: Map<string, AssetCandidate>, candidate: AssetCandidate): void {
  if (!candidate.objectKey || candidates.has(candidate.objectKey)) return;
  candidates.set(candidate.objectKey, candidate);
}

function extension(objectKey: string, contentType: string | null): string {
  const fromKey = objectKey.split('/').pop()?.split('.').pop()?.toLowerCase();
  if (fromKey && /^[a-z0-9]{1,8}$/.test(fromKey)) return fromKey;
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'video/mp4') return 'mp4';
  return 'bin';
}

export interface ExportSnapshot {
  manifest: ExportManifest;
  candidates: AssetCandidate[];
  assets: ExportAsset[];
}

export async function buildExportSnapshot(env: Env, ownerUserId: string, media: MomoraExportR2Bucket): Promise<ExportSnapshot> {
  const [profileRows, families] = await Promise.all([
    listRows<ExportProfile>(env, 'user_profiles', 'id,name,timezone,illustration_style,created_at', { id: `eq.${ownerUserId}`, limit: '1' }),
    listRows<ExportFamily>(env, 'families', 'id,owner_id,name,illustration_style,created_at', {
      owner_id: `eq.${ownerUserId}`,
      deleted_at: 'is.null',
      order: 'created_at.asc',
      limit: String(MAX_FAMILIES),
    }),
  ]);
  const familyIds = families.map((family) => family.id);
  const candidates = new Map<string, AssetCandidate>();
  let familyMembers: ExportMember[] = [];
  let memories: ExportMemory[] = [];
  let memoryTags: ExportTag[] = [];
  let memoryMedia: ExportMedia[] = [];
  let portraitVersions: ExportPortraitVersion[] = [];

  if (familyIds.length > 0) {
    [familyMembers, memories, portraitVersions] = await Promise.all([
      listRowsByIds<ExportMember>(env, 'family_members', 'id,family_id,user_id,name,nicknames,date_of_birth,gender,profile_picture_key,illustrated_profile_key,illustrated_profile_status,additional_info,is_user_profile,created_at', 'family_id', familyIds, { order: 'created_at.asc' }),
      listRowsByIds<ExportMemory>(env, 'memories', 'id,family_id,user_id,content,memory_date,emotion,illustration_key,illustration_status,media_key,media_content_type,created_at', 'family_id', familyIds, { order: 'memory_date.asc,created_at.asc' }),
      listRowsByIds<ExportPortraitVersion>(env, 'family_member_portrait_versions', 'id,family_id,family_member_id,user_id,reference_date,date_source,profile_picture_key,illustrated_profile_key,illustrated_profile_status,generation_output_key,created_at', 'family_id', familyIds, { order: 'created_at.asc' }),
    ]);

    familyMembers.sort((a, b) => a.created_at.localeCompare(b.created_at));
    memories.sort((a, b) => `${a.memory_date}:${a.created_at}`.localeCompare(`${b.memory_date}:${b.created_at}`));
    portraitVersions.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const memoryIds = memories.map((memory) => memory.id);
    if (memoryIds.length > 0) {
      [memoryTags, memoryMedia] = await Promise.all([
        listRowsByIds<ExportTag>(env, 'memory_family_members', 'memory_id,family_member_id', 'memory_id', memoryIds),
        listRowsByIds<ExportMedia>(env, 'memory_media', 'id,memory_id,object_key,content_type,duration_ms,position,preview_object_key,preview_content_type,created_at', 'memory_id', memoryIds, { order: 'memory_id.asc,position.asc' }),
      ]);
      memoryMedia.sort((a, b) => `${a.memory_id}:${a.position}`.localeCompare(`${b.memory_id}:${b.position}`));
    }
  }

  const memoryFamilyIds = new Map(memories.map((memory) => [memory.id, memory.family_id]));

  for (const member of familyMembers) {
    if (member.profile_picture_key) addCandidate(candidates, { objectKey: member.profile_picture_key, kind: 'family_photo', contentType: 'image/webp', familyId: member.family_id, familyMemberId: member.id });
    if (member.illustrated_profile_key) addCandidate(candidates, { objectKey: member.illustrated_profile_key, kind: 'family_portrait', contentType: 'image/webp', familyId: member.family_id, familyMemberId: member.id });
  }
  for (const version of portraitVersions) {
    addCandidate(candidates, { objectKey: version.profile_picture_key, kind: 'portrait_photo', contentType: 'image/jpeg', familyId: version.family_id, familyMemberId: version.family_member_id, portraitVersionId: version.id });
    if (version.illustrated_profile_key) addCandidate(candidates, { objectKey: version.illustrated_profile_key, kind: 'portrait_illustration', contentType: 'image/webp', familyId: version.family_id, familyMemberId: version.family_member_id, portraitVersionId: version.id });
    if (version.generation_output_key) addCandidate(candidates, { objectKey: version.generation_output_key, kind: 'portrait_attempt', contentType: 'image/webp', familyId: version.family_id, familyMemberId: version.family_member_id, portraitVersionId: version.id });
  }
  for (const memory of memories) {
    if (memory.media_key) addCandidate(candidates, { objectKey: memory.media_key, kind: 'memory_media', contentType: memory.media_content_type, familyId: memory.family_id, memoryId: memory.id });
    if (memory.illustration_key) addCandidate(candidates, { objectKey: memory.illustration_key, kind: 'memory_illustration', contentType: 'image/webp', familyId: memory.family_id, memoryId: memory.id });
  }
  for (const asset of memoryMedia) {
    const familyId = memoryFamilyIds.get(asset.memory_id) ?? '';
    addCandidate(candidates, { objectKey: asset.object_key, kind: 'memory_media', contentType: asset.content_type, familyId, memoryId: asset.memory_id });
    if (asset.preview_object_key) addCandidate(candidates, { objectKey: asset.preview_object_key, kind: 'memory_media_preview', contentType: asset.preview_content_type, familyId, memoryId: asset.memory_id });
  }

  const candidateList = [...candidates.values()].filter((candidate) => candidate.familyId);
  if (candidateList.length > MAX_ASSETS) throw new Error('export_asset_limit');
  const assets: ExportAsset[] = [];
  const missingAssets: string[] = [];
  let totalBytes = 0;
  let index = 0;
  for (const candidate of candidateList) {
    const object = await media.head(candidate.objectKey);
    const path = `assets/${String(index + 1).padStart(6, '0')}.${extension(candidate.objectKey, candidate.contentType)}`;
    index += 1;
    const asset: ExportAsset = {
      ...candidate,
      path,
      exists: Boolean(object),
      bytes: object?.size,
    };
    totalBytes += object?.size ?? 0;
    if (totalBytes > MAX_EXPORT_BYTES) throw new Error('export_too_large');
    assets.push(asset);
    if (!object) missingAssets.push(path);
  }

  return {
    manifest: {
      format: 'momora-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      ownerUserId,
      profile: profileRows[0] ?? null,
      families,
      familyMembers,
      memories,
      memoryTags,
      memoryMedia,
      portraitVersions,
      assets: assets.map(({ objectKey: _objectKey, ...publicAsset }) => publicAsset),
      missingAssets,
    },
    candidates: candidateList,
    assets,
  };
}

export function assetEntryName(asset: ExportAsset): string {
  return asset.path;
}
