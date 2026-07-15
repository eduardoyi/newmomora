import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import { deleteStorageObject, getUploadUrl, uploadToPresignedUrl } from '@/services/media';
import { prepareProfilePhotoForUpload } from '@/utils/profile-photo';
import {
  validatePortraitReferenceDate,
  type FamilyMemberPortraitVersion,
  type PortraitDateSource,
} from '@/utils/portrait-versions';
import { buildFamilyPortraitVersionPhotoKey } from '@/utils/storage-keys';

export interface PortraitVersionServiceError {
  message: string;
  code?: string;
}

export interface CreatePortraitVersionInput {
  userId: string;
  familyId: string;
  familyMemberId: string;
  photoUri: string;
  photoContentType: string;
  referenceDate: string;
  dateSource: Exclude<PortraitDateSource, 'legacy_unknown'>;
  dateOfBirth?: string | null;
  versionId?: string;
}

function mapError(error: { message: string; code?: string }): PortraitVersionServiceError {
  return { message: error.message, code: error.code };
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function normalizeRpcRow(data: unknown): FamilyMemberPortraitVersion | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as FamilyMemberPortraitVersion) : null;
}

export async function fetchFamilyPortraitVersions(
  familyId: string,
): Promise<{ data: FamilyMemberPortraitVersion[] | null; error: PortraitVersionServiceError | null }> {
  const { data, error } = await (supabase as any)
    .from('family_member_portrait_versions')
    .select('*')
    .eq('family_id', familyId)
    .order('reference_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []) as FamilyMemberPortraitVersion[], error: null };
}

export async function createPortraitVersion(
  input: CreatePortraitVersionInput,
): Promise<{ data: FamilyMemberPortraitVersion | null; error: PortraitVersionServiceError | null }> {
  const dateError = validatePortraitReferenceDate(input.referenceDate, {
    dateOfBirth: input.dateOfBirth,
  });
  if (dateError) return { data: null, error: { message: dateError, code: 'validation_error' } };

  const versionId = input.versionId ?? createUuid();
  const objectKey = buildFamilyPortraitVersionPhotoKey(input.userId, input.familyMemberId, versionId);
  const preparedPhoto = await prepareProfilePhotoForUpload(input.photoUri);
  const { data: uploadData, error: uploadUrlError } = await getUploadUrl(
    objectKey,
    preparedPhoto.contentType,
    input.familyId,
  );
  if (uploadUrlError || !uploadData) {
    return { data: null, error: uploadUrlError ?? { message: 'Upload URL was not returned' } };
  }

  const { error: uploadError } = await uploadToPresignedUrl(
    uploadData.uploadUrl,
    preparedPhoto.uri,
    preparedPhoto.contentType,
  );
  if (uploadError) return { data: null, error: uploadError };

  const { data, error } = await (supabase as any).rpc('create_family_member_portrait_version', {
    version_id: versionId,
    target_family_member_id: input.familyMemberId,
    portrait_reference_date: input.referenceDate,
    portrait_date_source: input.dateSource,
    source_profile_picture_key: objectKey,
  });

  if (error) {
    await deleteStorageObject(objectKey);
    return { data: null, error: mapError(error) };
  }

  const version = normalizeRpcRow(data);
  if (!version) {
    await deleteStorageObject(objectKey);
    return { data: null, error: { message: 'Portrait version was not created' } };
  }

  return { data: version, error: null };
}

export async function updatePortraitVersionDate(
  portraitVersionId: string,
  referenceDate: string,
  options: { dateOfBirth?: string | null } = {},
): Promise<{ data: FamilyMemberPortraitVersion | null; error: PortraitVersionServiceError | null }> {
  const dateError = validatePortraitReferenceDate(referenceDate, options);
  if (dateError) return { data: null, error: { message: dateError, code: 'validation_error' } };

  const { data, error } = await (supabase as any).rpc(
    'update_family_member_portrait_version_date',
    { target_version_id: portraitVersionId, portrait_reference_date: referenceDate },
  );
  if (error) return { data: null, error: mapError(error) };

  const version = normalizeRpcRow(data);
  return version
    ? { data: version, error: null }
    : { data: null, error: { message: 'Portrait version was not updated' } };
}

export async function generatePortraitVersion(
  portraitVersionId: string,
): Promise<{ error: PortraitVersionServiceError | null }> {
  const { error } = await invokeEdgeFunction('generate-portrait-illustration', {
    portraitVersionId,
  });
  return { error };
}

export async function deletePortraitVersion(
  portraitVersionId: string,
): Promise<{ error: PortraitVersionServiceError | null }> {
  const { error } = await invokeEdgeFunction('delete-portrait-version', { portraitVersionId });
  return { error };
}
